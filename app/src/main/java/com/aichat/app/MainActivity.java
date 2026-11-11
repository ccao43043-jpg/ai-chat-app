package com.aichat.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.provider.MediaStore;
import android.util.Log;
import android.webkit.ConsoleMessage;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

public class MainActivity extends Activity {
    private static final int REQ_FILE = 1001;
    private WebView webView;
    private NativeBridge bridge;
    private ValueCallback<Uri[]> fileCallback;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        webView = new WebView(this);
        setContentView(webView);

        WebView.setWebContentsDebuggingEnabled(true);
        SharedPreferences cachePrefs = getSharedPreferences("aichat_webview", MODE_PRIVATE);
        String ver = "";
        try { ver = getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (Exception ignored) {}
        String lastVer = cachePrefs.getString("cache_ver", "");
        if (ver != null && !ver.isEmpty() && !ver.equals(lastVer)) {
            webView.clearCache(true);
            cachePrefs.edit().putString("cache_ver", ver).apply();
            Log.i("AIChat", "cleared WebView cache on version change " + lastVer + " -> " + ver);
        }

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setTextZoom(100);

        bridge = new NativeBridge(this, webView);
        webView.addJavascriptInterface(bridge, "AndroidBridge");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String scheme = uri.getScheme();
                if ("http".equals(scheme) || "https".equals(scheme)) {
                    // 外部链接交给系统浏览器打开
                    try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); } catch (Exception ignored) {}
                    return true;
                }
                return false;
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage cm) {
                Log.i("AIChatConsole", cm.messageLevel() + " " + cm.sourceId() + ":" + cm.lineNumber() + " " + cm.message());
                return super.onConsoleMessage(cm);
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                boolean multiple = params != null
                        && params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE;
                String[] acceptTypes = params != null ? params.getAcceptTypes() : null;
                boolean imageOnly = isImageOnlyAccept(acceptTypes);

                Intent intent;
                String chooserTitle;
                if (imageOnly) {
                    intent = new Intent(Intent.ACTION_GET_CONTENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType("image/*");
                    if (multiple) intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                    chooserTitle = "选择图片";
                    Intent pick = new Intent(Intent.ACTION_PICK,
                            MediaStore.Images.Media.EXTERNAL_CONTENT_URI);
                    pick.setType("image/*");
                    Intent chooser = Intent.createChooser(intent, chooserTitle);
                    chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[]{pick});
                    try {
                        startActivityForResult(chooser, REQ_FILE);
                    } catch (Exception e) {
                        fileCallback = null;
                        return false;
                    }
                    return true;
                }

                Intent created = null;
                if (params != null) {
                    try { created = params.createIntent(); } catch (Exception ignored) {}
                }
                if (created != null) {
                    intent = created;
                    if (multiple) intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                } else {
                    intent = new Intent(Intent.ACTION_GET_CONTENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType("*/*");
                    if (multiple) intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                }
                chooserTitle = "选择文件";
                try {
                    startActivityForResult(Intent.createChooser(intent, chooserTitle), REQ_FILE);
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }
        });
        webView.loadUrl("file:///android_asset/www/index.html");
    }

    /** HTML accept 仅含 image/*（或 image/jpeg 等）时走相册友好选择器 */
    private static boolean isImageOnlyAccept(String[] acceptTypes) {
        if (acceptTypes == null || acceptTypes.length == 0) return false;
        boolean any = false;
        for (String t : acceptTypes) {
            if (t == null) continue;
            String lower = t.trim().toLowerCase();
            if (lower.isEmpty()) continue;
            any = true;
            if (!(lower.equals("image") || lower.startsWith("image/"))) return false;
        }
        return any;
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE) {
            if (fileCallback == null) return;
            Uri[] result = null;
            if (resultCode == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    int n = data.getClipData().getItemCount();
                    result = new Uri[n];
                    for (int i = 0; i < n; i++) result[i] = data.getClipData().getItemAt(i).getUri();
                } else if (data.getData() != null) {
                    result = new Uri[]{data.getData()};
                }
            }
            fileCallback.onReceiveValue(result);
            fileCallback = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        webView.evaluateJavascript("window.onAndroidBack ? window.onAndroidBack() : false", value -> {
            if (!"true".equals(value)) MainActivity.super.onBackPressed();
        });
    }

    @Override
    protected void onDestroy() {
        if (bridge != null) bridge.shutdown();
        if (webView != null) webView.destroy();
        super.onDestroy();
    }
}
