package com.aichat.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * v0.9.0：API Key 安全存储。用 Android Keystore 中不可导出的 AES-256-GCM 密钥加密后存入 SharedPreferences。
 * 明文只在原生层发请求时短暂出现，永远不会返回给 WebView。
 */
final class SecretStore {
    private static final String ALIAS = "aichat_secrets_v1";
    private static final String PREFS = "aichat_secrets";
    private final SharedPreferences prefs;

    SecretStore(Context ctx) { prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE); }

    private SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        KeyStore.Entry e = ks.getEntry(ALIAS, null);
        if (e instanceof KeyStore.SecretKeyEntry) return ((KeyStore.SecretKeyEntry) e).getSecretKey();
        KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        kg.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256).build());
        return kg.generateKey();
    }

    synchronized boolean put(String name, String value) {
        try {
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.ENCRYPT_MODE, key());
            byte[] iv = c.getIV();
            byte[] ct = c.doFinal(value.getBytes(StandardCharsets.UTF_8));
            String enc = Base64.encodeToString(iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(ct, Base64.NO_WRAP);
            return prefs.edit().putString("s:" + name, enc).commit();
        } catch (Exception e) { return false; }
    }

    synchronized String get(String name) {
        String enc = prefs.getString("s:" + name, null);
        if (enc == null) return null;
        try {
            int i = enc.indexOf(':');
            byte[] iv = Base64.decode(enc.substring(0, i), Base64.NO_WRAP);
            byte[] ct = Base64.decode(enc.substring(i + 1), Base64.NO_WRAP);
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, iv));
            return new String(c.doFinal(ct), StandardCharsets.UTF_8);
        } catch (Exception e) { return null; }
    }

    synchronized boolean has(String name) { return prefs.contains("s:" + name); }
    synchronized void remove(String name) { prefs.edit().remove("s:" + name).remove("o:" + name).commit(); }
    synchronized void clear() {
        SharedPreferences.Editor ed = prefs.edit();
        for (String k : prefs.getAll().keySet()) if (k.startsWith("s:") || k.startsWith("o:")) ed.remove(k);
        ed.commit();
    }
    /** 密钥绑定的源（scheme://host:port） */
    synchronized void setOrigin(String name, String origin) { prefs.edit().putString("o:" + name, origin).commit(); }
    synchronized String origin(String name) { return prefs.getString("o:" + name, null); }

    /** 服务商登记（非机密）：id → baseUrl \n authType */
    synchronized void putReg(String id, String baseUrl, String authType) { prefs.edit().putString("r:" + id, baseUrl + "\n" + authType).commit(); }
    synchronized String[] reg(String id) {
        String v = prefs.getString("r:" + id, null);
        if (v == null) return null;
        int i = v.indexOf('\n');
        return new String[]{ v.substring(0, i), v.substring(i + 1) };
    }
}
