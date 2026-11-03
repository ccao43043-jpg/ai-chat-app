package com.aichat.app;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.Reader;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Iterator;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * JS <-> 原生桥：网络请求（支持流式）、本地文件存储、剪贴板、保存图片。
 * 所有网络请求在原生层发出，因此不存在浏览器 CORS 限制。
 * API Key 只在请求头中使用，不会写入日志。
 */
public class NativeBridge {
    private final Activity activity;
    private final WebView webView;
    private final ExecutorService pool = Executors.newCachedThreadPool();
    private final Map<String, HttpURLConnection> conns = new ConcurrentHashMap<>();
    private final Map<String, Boolean> cancelled = new ConcurrentHashMap<>();
    private final File dataDir;
    private final SecretStore secrets;

    public NativeBridge(Activity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
        this.dataDir = new File(activity.getFilesDir(), "store");
        if (!dataDir.exists()) dataDir.mkdirs();
        this.secrets = new SecretStore(activity);
    }

    void shutdown() {
        for (HttpURLConnection c : conns.values()) { try { c.disconnect(); } catch (Exception ignored) {} }
        pool.shutdownNow();
    }

    private void js(final String code) {
        activity.runOnUiThread(() -> webView.evaluateJavascript(code, null));
    }

    private static String q(String s) { return JSONObject.quote(s == null ? "" : s); }

    // ---------------- 网络 ----------------

    /** 发起 HTTP 请求。回调：__nativeHttp.onStart(id,status) / onChunk(id,text) / onEnd(id) / onError(id,msg) */
    @JavascriptInterface
    public void request(final String id, final String method, final String url, final String headersJson,
                        final String body, final int timeoutSec) {
        pool.execute(() -> doRequest(id, method, url, headersJson, body, timeoutSec));
    }

    @JavascriptInterface
    public void cancel(String id) {
        cancelled.put(id, true);
        HttpURLConnection c = conns.get(id);
        if (c != null) pool.execute(() -> { try { c.disconnect(); } catch (Exception ignored) {} });
    }

    // ---------------- v0.9.0：密钥安全存储 + 按服务商注入认证 ----------------

    private static boolean validKind(String kind) { return "provider_key".equals(kind) || "search_key".equals(kind); }
    private static String regId(String kind, String id) { return "search_key".equals(kind) ? "search:" + id : id; }
    private static String secretName(String regId) {
        return regId.startsWith("search:") ? "search_key:" + regId.substring(7) : "provider_key:" + regId;
    }

    /** scheme://host[:port]（小写、去默认端口）；含用户信息或非 http(s) 时返回 null。与 secure.js originOf 一致 */
    static String originOf(String u) {
        try {
            if (u == null) return null;
            URI x = new URI(u.trim());
            String scheme = x.getScheme(), host = x.getHost();
            if (scheme == null || host == null || x.getRawUserInfo() != null) return null;
            scheme = scheme.toLowerCase(Locale.ROOT);
            if (!"http".equals(scheme) && !"https".equals(scheme)) return null;
            int port = x.getPort();
            if (("http".equals(scheme) && port == 80) || ("https".equals(scheme) && port == 443)) port = -1;
            return scheme + "://" + host.toLowerCase(Locale.ROOT) + (port > 0 ? ":" + port : "");
        } catch (Exception e) { return null; }
    }

    /** 登记服务商 Base URL 与认证方式；主机变化时删除旧密钥并返回 "cleared"，否则 "ok" */
    @JavascriptInterface
    public String registerProvider(String id, String baseUrl, String authType) {
        if (id == null || id.isEmpty()) return "error";
        secrets.putReg(id, baseUrl == null ? "" : baseUrl, authType == null ? "bearer" : authType);
        String name = secretName(id);
        String bound = secrets.origin(name), now = originOf(baseUrl);
        if (secrets.has(name) && bound != null && !bound.equals(now)) { secrets.remove(name); return "cleared"; }
        return "ok";
    }

    @JavascriptInterface
    public boolean setSecret(String kind, String id, String value) {
        if (!validKind(kind) || id == null || value == null) return false;
        String rid = regId(kind, id), name = secretName(rid);
        String[] r = secrets.reg(rid);
        if (value.isEmpty()) { secrets.remove(name); return true; }
        if (!secrets.put(name, value)) return false;
        String o = r == null ? null : originOf(r[0]);
        if (o != null) secrets.setOrigin(name, o);
        return true;
    }

    @JavascriptInterface
    public boolean hasSecret(String kind, String id) { return validKind(kind) && id != null && secrets.has(kind + ":" + id); }

    @JavascriptInterface
    public void deleteSecret(String kind, String id) { if (validKind(kind) && id != null) secrets.remove(kind + ":" + id); }

    @JavascriptInterface
    public void clearSecrets() { secrets.clear(); }

    /** 用已存密钥请求：URL 必须与登记的 Base URL 同源；认证头由原生层注入，页面传入的认证头一律丢弃 */
    @JavascriptInterface
    public void requestForProvider(final String id, final String providerId, final String method, final String url,
                                   final String headersJson, final String body, final int timeoutSec) {
        pool.execute(() -> {
            try {
                String[] r = providerId == null ? null : secrets.reg(providerId);
                if (r == null) throw new Exception("服务商未登记");
                String allowed = originOf(r[0]), target = originOf(url);
                if (allowed == null || !allowed.equals(target)) throw new Exception("请求地址与服务商 Base URL 不一致，已拒绝");
                JSONObject h = headersJson == null || headersJson.isEmpty() ? new JSONObject() : new JSONObject(headersJson);
                JSONObject clean = new JSONObject();
                Iterator<String> keys = h.keys();
                while (keys.hasNext()) {
                    String k = keys.next();
                    if (Arrays.asList("authorization", "x-api-key", "x-goog-api-key", "x-subscription-token").contains(k.toLowerCase(Locale.ROOT))) continue;
                    clean.put(k, h.getString(k));
                }
                String name = secretName(providerId);
                String bound = secrets.origin(name);
                String key = (bound == null || bound.equals(allowed)) ? secrets.get(name) : null;
                if (key != null && !key.isEmpty()) {
                    String t = r[1];
                    if ("anthropic".equals(t)) clean.put("x-api-key", key);
                    else if ("gemini".equals(t)) clean.put("x-goog-api-key", key);
                    else if ("brave".equals(t)) clean.put("X-Subscription-Token", key);
                    else clean.put("Authorization", "Bearer " + key);
                }
                doRequest(id, method, url, clean.toString(), body, timeoutSec, true);
            } catch (Exception e) {
                js("window.__nativeHttp.onError(" + q(id) + "," + q(e.getMessage() == null ? "请求失败" : e.getMessage()) + ")");
            }
        });
    }

    @JavascriptInterface
    public void requestForSearch(String id, String searchId, String method, String url, String headersJson, String body, int timeoutSec) {
        requestForProvider(id, "search:" + searchId, method, url, headersJson, body, timeoutSec);
    }

    private void doRequest(String id, String method, String url, String headersJson, String body, int timeoutSec) {
        doRequest(id, method, url, headersJson, body, timeoutSec, false);
    }

    private void doRequest(String id, String method, String url, String headersJson, String body, int timeoutSec, boolean noRedirect) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(url).openConnection();
            // 带密钥的请求不自动跟随重定向，避免认证头被带到其他主机
            if (noRedirect) conn.setInstanceFollowRedirects(false);
            conns.put(id, conn);
            conn.setRequestMethod(method == null || method.isEmpty() ? "GET" : method);
            conn.setConnectTimeout(30000);
            conn.setReadTimeout((timeoutSec > 0 ? timeoutSec : 300) * 1000);
            conn.setUseCaches(false);
            if (headersJson != null && !headersJson.isEmpty()) {
                JSONObject h = new JSONObject(headersJson);
                Iterator<String> keys = h.keys();
                while (keys.hasNext()) { String k = keys.next(); conn.setRequestProperty(k, h.getString(k)); }
            }
            if (body != null && !body.isEmpty()) {
                conn.setDoOutput(true);
                byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
                conn.setFixedLengthStreamingMode(bytes.length);
                try (OutputStream os = conn.getOutputStream()) { os.write(bytes); }
            }
            int status = conn.getResponseCode();
            js("window.__nativeHttp.onStart(" + q(id) + "," + status + ")");
            InputStream is = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
            if (is != null) {
                try (Reader r = new InputStreamReader(is, StandardCharsets.UTF_8)) {
                    char[] buf = new char[4096];
                    int n;
                    while ((n = r.read(buf)) != -1) {
                        if (Boolean.TRUE.equals(cancelled.get(id))) break;
                        if (n > 0) js("window.__nativeHttp.onChunk(" + q(id) + "," + q(new String(buf, 0, n)) + ")");
                    }
                }
            }
            js("window.__nativeHttp.onEnd(" + q(id) + ")");
        } catch (Exception e) {
            if (Boolean.TRUE.equals(cancelled.get(id))) {
                js("window.__nativeHttp.onEnd(" + q(id) + ")");
            } else {
                String msg = e.getClass().getSimpleName() + (e.getMessage() != null ? ": " + e.getMessage() : "");
                js("window.__nativeHttp.onError(" + q(id) + "," + q(msg) + ")");
            }
        } finally {
            conns.remove(id);
            cancelled.remove(id);
            if (conn != null) { try { conn.disconnect(); } catch (Exception ignored) {} }
        }
    }

    // ---------------- 本地存储（应用私有目录） ----------------

    private File storeFile(String name) {
        String safe = name.replaceAll("[^A-Za-z0-9_.-]", "_");
        return new File(dataDir, safe);
    }

    @JavascriptInterface
    public String storeGet(String name) {
        File f = storeFile(name);
        if (!f.exists()) return null;
        try (InputStream in = new FileInputStream(f)) {
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[8192]; int n;
            while ((n = in.read(buf)) != -1) bos.write(buf, 0, n);
            return new String(bos.toByteArray(), StandardCharsets.UTF_8);
        } catch (Exception e) { return null; }
    }

    /** 写临时文件并 fsync → 旧文件转为 name.bak（只保留一份）→ 改名为正式文件 */
    @JavascriptInterface
    public synchronized boolean storeSet(String name, String value) {
        File f = storeFile(name);
        File tmp = new File(f.getPath() + ".tmp");
        try (FileOutputStream os = new FileOutputStream(tmp)) {
            os.write((value == null ? "" : value).getBytes(StandardCharsets.UTF_8));
            os.getFD().sync();
        } catch (Exception e) { tmp.delete(); return false; }
        boolean jsonl = f.getName().endsWith(".jsonl") || f.getName().endsWith(".bak");
        if (f.exists() && !jsonl) {
            File bak = new File(f.getPath() + ".bak");
            if (bak.exists()) bak.delete();
            if (!f.renameTo(bak)) f.delete();
        }
        return tmp.renameTo(f);
    }

    @JavascriptInterface
    public synchronized void storeDelete(String name) { File f = storeFile(name); f.delete(); new File(f.getPath() + ".bak").delete(); }

    @JavascriptInterface
    public boolean storeExists(String name) { return storeFile(name).exists(); }

    @JavascriptInterface
    public synchronized boolean storeRename(String from, String to) {
        File a = storeFile(from), b = storeFile(to);
        if (!a.exists()) return false;
        if (b.exists()) b.delete();
        return a.renameTo(b);
    }

    @JavascriptInterface
    public String storeList() {
        JSONArray arr = new JSONArray();
        String[] names = dataDir.list();
        if (names != null) for (String n : names) if (!n.endsWith(".tmp")) arr.put(n);
        return arr.toString();
    }

    /** 追加写（JSONL 日志），不重写整个文件 */
    @JavascriptInterface
    public synchronized boolean storeAppend(String name, String text) {
        try (FileOutputStream os = new FileOutputStream(storeFile(name), true)) {
            os.write((text == null ? "" : text).getBytes(StandardCharsets.UTF_8));
            return true;
        } catch (Exception e) { return false; }
    }

    // ---------------- 杂项 ----------------

    @JavascriptInterface
    public void copy(String text) {
        activity.runOnUiThread(() -> {
            ClipboardManager cm = (ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm != null) cm.setPrimaryClip(ClipData.newPlainText("text", text));
            if (Build.VERSION.SDK_INT < 33) Toast.makeText(activity, "已复制", Toast.LENGTH_SHORT).show();
        });
    }

    /** 用系统浏览器打开链接（仅 http/https） */
    @JavascriptInterface
    public void openUrl(final String url) {
        if (url == null) return;
        final Uri uri = Uri.parse(url.trim());
        String scheme = uri.getScheme();
        if (!"http".equalsIgnoreCase(scheme) && !"https".equalsIgnoreCase(scheme)) return;
        activity.runOnUiThread(() -> {
            try {
                android.content.Intent it = new android.content.Intent(android.content.Intent.ACTION_VIEW, uri);
                it.addCategory(android.content.Intent.CATEGORY_BROWSABLE);
                activity.startActivity(it);
            } catch (Exception e) {
                Toast.makeText(activity, "没有可用的浏览器", Toast.LENGTH_SHORT).show();
            }
        });
    }

    /** 读取内置资源（仅限 www/lib/cmaps/，供 pdf.js 加载中文字体映射表），返回 base64；不存在时返回空字符串 */
    @JavascriptInterface
    public String readAsset(String path) {
        if (path == null || !path.startsWith("www/lib/cmaps/") || path.contains("..")) return "";
        try (InputStream in = activity.getAssets().open(path)) {
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            byte[] buf = new byte[16384]; int n;
            while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
            return Base64.encodeToString(bo.toByteArray(), Base64.NO_WRAP);
        } catch (Exception e) {
            return "";
        }
    }

    @JavascriptInterface
    public void toast(String text) {
        activity.runOnUiThread(() -> Toast.makeText(activity, text, Toast.LENGTH_SHORT).show());
    }

    /** 保存图片到相册：src 为 data:URL 或 http(s) URL */
    @JavascriptInterface
    public void saveImage(final String src) {
        pool.execute(() -> {
            try {
                byte[] bytes;
                String mime = "image/png";
                if (src.startsWith("data:")) {
                    int comma = src.indexOf(',');
                    String meta = src.substring(5, comma);
                    mime = meta.split(";")[0];
                    bytes = Base64.decode(src.substring(comma + 1), Base64.DEFAULT);
                } else {
                    HttpURLConnection c = (HttpURLConnection) new URL(src).openConnection();
                    c.setConnectTimeout(30000); c.setReadTimeout(60000);
                    String ct = c.getContentType();
                    if (ct != null && ct.startsWith("image/")) mime = ct.split(";")[0];
                    try (InputStream in = c.getInputStream()) {
                        ByteArrayOutputStream bos = new ByteArrayOutputStream();
                        byte[] buf = new byte[8192]; int n;
                        while ((n = in.read(buf)) != -1) bos.write(buf, 0, n);
                        bytes = bos.toByteArray();
                    }
                }
                String ext = mime.contains("jpeg") || mime.contains("jpg") ? "jpg" : mime.contains("webp") ? "webp" : "png";
                String name = "AIChat_" + System.currentTimeMillis() + "." + ext;
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentValues v = new ContentValues();
                    v.put(MediaStore.Images.Media.DISPLAY_NAME, name);
                    v.put(MediaStore.Images.Media.MIME_TYPE, mime);
                    v.put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/AIChat");
                    ContentResolver cr = activity.getContentResolver();
                    Uri uri = cr.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, v);
                    if (uri == null) throw new Exception("无法创建文件");
                    try (OutputStream os = cr.openOutputStream(uri)) { os.write(bytes); }
                    toast("已保存到 图片/AIChat");
                } else {
                    File dir = activity.getExternalFilesDir(Environment.DIRECTORY_PICTURES);
                    File f = new File(dir, name);
                    try (OutputStream os = new FileOutputStream(f)) { os.write(bytes); }
                    toast("已保存：" + f.getAbsolutePath());
                }
            } catch (Exception e) {
                toast("保存失败：" + e.getMessage());
            }
        });
    }
}
