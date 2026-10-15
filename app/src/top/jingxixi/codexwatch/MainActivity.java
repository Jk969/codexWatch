package top.jingxixi.codexwatch;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentValues;
import android.content.Context;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebChromeClient;
import android.webkit.ValueCallback;
import android.window.OnBackInvokedCallback;
import android.window.OnBackInvokedDispatcher;
import android.widget.TextView;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

public class MainActivity extends Activity {

    public static final String EXTRA_CHAT_ID = "chatId";

    private WebView mWebView;
    private ValueCallback<Uri[]> mFileCallback;
    private OnBackInvokedCallback mBackCallback;
    private static final int FILE_PICKER = 1002;
    private final Map<String, SaveSession> mSaves = new ConcurrentHashMap<>();

    /** 手机下载文件的分块暂存 */
    private static class SaveSession {
        final String name;
        final String mime;
        final java.io.ByteArrayOutputStream buf = new java.io.ByteArrayOutputStream();
        SaveSession(String name, String mime) { this.name = name; this.mime = mime; }
    }

    /** 写入下载目录的结果:saved=文件已落盘;uri=可直接 ACTION_VIEW 的内容 Uri(旧系统为 null) */
    private static class SaveResult {
        boolean saved;
        Uri uri;
    }

    /** 写入公共下载目录:API29+ 走 MediaStore(无需权限);旧版退回应用外部专属目录 */
    private SaveResult writeDownloadEx(String name, byte[] data, String mime) {
        SaveResult out = new SaveResult();
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                ContentValues v = new ContentValues();
                v.put(MediaStore.Downloads.DISPLAY_NAME, name);
                v.put(MediaStore.MediaColumns.MIME_TYPE, mime == null || mime.isEmpty() ? "application/octet-stream" : mime);
                v.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/CodexWatch");
                v.put(MediaStore.MediaColumns.IS_PENDING, 1);
                Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                if (uri == null) return out;
                try (OutputStream os = getContentResolver().openOutputStream(uri)) {
                    if (os == null) return out;
                    os.write(data);
                    os.flush();
                }
                ContentValues done = new ContentValues();
                done.put(MediaStore.MediaColumns.IS_PENDING, 0);
                getContentResolver().update(uri, done, null, null);
                out.saved = true;
                out.uri = uri;
                return out;
            }
            File dir = new File(getExternalFilesDir(null), "downloads");
            if (!dir.exists() && !dir.mkdirs()) return out;
            File outF = new File(dir, name);
            if (outF.exists()) {
                String base = name, ext = "";
                int dot = name.lastIndexOf('.');
                if (dot >= 0) { base = name.substring(0, dot); ext = name.substring(dot); }
                int n = 1;
                while (outF.exists()) outF = new File(dir, base + "-" + (n++) + ext);
            }
            try (FileOutputStream fos = new FileOutputStream(outF)) { fos.write(data); }
            out.saved = true; // file:// 在 targetSdk24+ 禁止跨应用打开,旧系统仅保存
            return out;
        } catch (Throwable t) {
            return out;
        }
    }

    private boolean writeDownload(String name, byte[] data, String mime) {
        SaveResult r = writeDownloadEx(name, data, mime);
        return r.saved;
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= 33) {
            mBackCallback = new OnBackInvokedCallback() {
                @Override public void onBackInvoked() { handleNativeBack(); }
            };
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    OnBackInvokedDispatcher.PRIORITY_DEFAULT, mBackCallback);
        }

        // 最先安装崩溃日志:未捕获异常 -> files/crash-log.txt(保留最近5份)
        try {
            GatewayService.installCrashHandler(this);
        } catch (Throwable ignored) {
        }

        // API33+ 通知权限(防御 ROM 差异,失败不连累启动)
        try {
            if (Build.VERSION.SDK_INT >= 33) {
                if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                        != PackageManager.PERMISSION_GRANTED) {
                    requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1001);
                }
            }
        } catch (Throwable ignored) {
        }

        // 启动前台网关服务;任何 FGS 限制/校验异常都不允许连累主进程闪退
        try {
            GatewayService.start(this);
        } catch (Throwable ignored) {
        }

        try {
            mWebView = new WebView(this);
            setupWebView(mWebView);
            setContentView(mWebView);
        } catch (Throwable t) {
            // WebView 初始化失败兜底:纯文本提示,绝不闪退
            try {
                TextView tv = new TextView(this);
                tv.setText("CodexWatch WebView 初始化失败,请更新系统 WebView 组件后重试。\n"
                        + String.valueOf(t));
                tv.setPadding(32, 48, 32, 48);
                setContentView(tv);
            } catch (Throwable ignored) {
            }
        }

        try {
            handleDeepLink(getIntent());
        } catch (Throwable ignored) {
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void setupWebView(WebView wv) {
        WebSettings s = wv.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);

        wv.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                try {
                    Uri u = request.getUrl();
                    String scheme = u.getScheme() == null ? "" : u.getScheme();
                    if ("http".equals(scheme) || "https".equals(scheme)) {
                        // 外部 http(s) 链接交给系统浏览器
                        try {
                            startActivity(new Intent(Intent.ACTION_VIEW, u));
                        } catch (Throwable ignored) {
                        }
                        return true;
                    }
                } catch (Throwable ignored) {
                }
                return false; // file:// data: 等本地内容交回 WebView 自行加载
            }
        });

        wv.addJavascriptInterface(new JsBridge(), "CWApp");
        // 使用系统文档选择器，支持相册和文件，无需全盘存储权限。
        wv.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                    FileChooserParams params) {
                if (mFileCallback != null) mFileCallback.onReceiveValue(null);
                mFileCallback = callback;
                Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
                pick.addCategory(Intent.CATEGORY_OPENABLE);
                String[] types = params.getAcceptTypes();
                pick.setType(types.length == 1 && !types[0].isEmpty() ? types[0] : "*/*");
                if (types.length > 1) pick.putExtra(Intent.EXTRA_MIME_TYPES, types);
                pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                try { startActivityForResult(Intent.createChooser(pick, "选择图片或文件"), FILE_PICKER); }
                catch (Exception e) { mFileCallback.onReceiveValue(null); mFileCallback = null; }
                return true;
            }
        });
        wv.loadUrl("file:///android_asset/www/index.html");
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        try {
            handleDeepLink(intent);
        } catch (Throwable ignored) {
        }
    }

    private void handleDeepLink(Intent intent) {
        if (intent == null) return;
        String chatId = intent.getStringExtra(EXTRA_CHAT_ID);
        if (chatId == null) return;
        final String safe = chatId.replace("\\", "\\\\").replace("'", "\\'");
        evalJs("window.__cwdeeplink && __cwdeeplink('" + safe + "')");
    }

    @Override
    protected void onResume() {
        super.onResume();
        try {
            if (mWebView != null) {
                mWebView.resumeTimers();
                mWebView.onResume();
            }
            GatewayService.attach(this); // 挂接回调并排空环形缓冲重放
        } catch (Throwable ignored) {
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        try {
            GatewayService.detach();
            // 通知由原生服务处理，页面不可见时停止 JS 计时器及渲染。
            if (mWebView != null) {
                mWebView.onPause();
                mWebView.pauseTimers();
            }
        } catch (Throwable ignored) {
        }
    }

    @Override
    public void onBackPressed() {
        handleNativeBack();
    }

    private void handleNativeBack() {
        if (mWebView == null) { moveTaskToBack(true); return; }
        // SPA 没有浏览器页面历史，先让页面关闭菜单、子面板和聊天。
        mWebView.evaluateJavascript("Boolean(window.__cwback && window.__cwback())",
                new ValueCallback<String>() {
                    @Override public void onReceiveValue(String handled) {
                        if ("true".equals(handled)) return;
                        if (mWebView != null && mWebView.canGoBack()) mWebView.goBack();
                        else moveTaskToBack(true);
                    }
                });
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != FILE_PICKER || mFileCallback == null) return;
        Uri[] uris = null;
        if (resultCode == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                int n = data.getClipData().getItemCount();
                uris = new Uri[n];
                for (int i = 0; i < n; i++) uris[i] = data.getClipData().getItemAt(i).getUri();
            } else if (data.getData() != null) uris = new Uri[]{data.getData()};
        }
        mFileCallback.onReceiveValue(uris);
        mFileCallback = null;
    }

    @Override
    protected void onDestroy() {
        if (mFileCallback != null) { mFileCallback.onReceiveValue(null); mFileCallback = null; }
        if (Build.VERSION.SDK_INT >= 33 && mBackCallback != null) {
            getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback(mBackCallback);
        }
        try {
            GatewayService.detach();
        } catch (Throwable ignored) {
        }
        super.onDestroy();
    }

    /** 服务线程调用:注入 JS(始终 post 到主线程执行,内部自捕获) */
    public void evalJs(final String expr) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    if (mWebView != null) {
                        mWebView.evaluateJavascript(expr, null);
                    }
                } catch (Throwable ignored) {
                }
            }
        });
    }

    /** 注入给 WebView 的 JS 桥对象:window.CWApp(所有方法自捕获,不让异常串到 WebView 线程) */
    private class JsBridge {

        @JavascriptInterface
        public String getVersion() {
            return "1.3.5";
        }

        @JavascriptInterface
        public String getConfig() {
            try {
                return GatewayService.readConfig(MainActivity.this).toString();
            } catch (Throwable t) {
                return "{\"endpoint\":\"wss://pcphone.jingxixi.top/ws\",\"token\":\"\"}";
            }
        }

        @JavascriptInterface
        public void setConfig(String json) {
            try {
                JSONObject in = new JSONObject(json);
                JSONObject cur = GatewayService.readConfig(MainActivity.this);
                if (in.has("endpoint")) cur.put("endpoint", in.optString("endpoint"));
                if (in.has("token")) cur.put("token", in.optString("token"));
                GatewayService.writeConfig(MainActivity.this, cur);
            } catch (Throwable ignored) {
                // 解析失败则忽略
            }
        }

        @JavascriptInterface
        public void send(String json) {
            try {
                GatewayService.sendOrQueue(MainActivity.this, json);
            } catch (Throwable ignored) {
            }
        }

        @JavascriptInterface
        public boolean isConnected() {
            try {
                return GatewayService.isConnectedStatic();
            } catch (Throwable t) {
                return false;
            }
        }

        @JavascriptInterface
        public void requestConnect() {
            try {
                GatewayService.requestConnectNow(MainActivity.this);
            } catch (Throwable ignored) {
            }
        }

        @JavascriptInterface
        public void disconnect() {
            try {
                GatewayService.requestDisconnect();
            } catch (Throwable ignored) {
            }
        }

        @JavascriptInterface
        public void notifyLocal(String title, String body, String chatId) {
            try {
                GatewayService.postTaskNotification(MainActivity.this, title, body, chatId, 0);
            } catch (Throwable ignored) {
            }
        }

        @JavascriptInterface
        public void setMutedChats(String json) {
            try {
                GatewayService.writeMutedChats(MainActivity.this, json);
            } catch (Throwable ignored) {
            }
        }

        @JavascriptInterface
        public boolean copyText(String text) {
            try {
                ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                if (clipboard == null) return false;
                clipboard.setPrimaryClip(ClipData.newPlainText("CodexWatch", text));
                return true;
            } catch (Throwable ignored) {
                return false;
            }
        }

        // ---- 手机下载电脑文件:分块传输,避免单次大字符串跨 JS 桥 ----
        @JavascriptInterface
        public String saveFileBegin(String name, String mime) {
            try {
                String safe = name == null ? "" : name.replaceAll("[\\\\/:*?\"<>|\\x00-\\x1f]", "_").trim();
                if (safe.isEmpty() || ".".equals(safe)) safe = "codexwatch-file";
                String id = UUID.randomUUID().toString();
                mSaves.put(id, new SaveSession(safe, mime));
                return id;
            } catch (Throwable ignored) {
                return "";
            }
        }

        @JavascriptInterface
        public boolean saveFileChunk(String id, String base64) {
            SaveSession s = mSaves.get(id);
            if (s == null) return false;
            try {
                byte[] d = Base64.decode(base64, Base64.DEFAULT);
                if (d == null || d.length == 0) return false;
                s.buf.write(d);
                return true;
            } catch (Throwable t) {
                mSaves.remove(id);
                return false;
            }
        }

        @JavascriptInterface
        public boolean saveFileEnd(String id) {
            SaveSession s = mSaves.remove(id);
            if (s == null) return false;
            try {
                return writeDownload(s.name, s.buf.toByteArray(), s.mime);
            } catch (Throwable ignored) {
                return false;
            }
        }

        /** 保存后调起系统「用其他应用打开」(apk 会进入安装器);返回 opened/saved/"" */
        @JavascriptInterface
        public String saveFileEndAndOpen(String id) {
            final SaveSession s = mSaves.remove(id);
            if (s == null) return "";
            try {
                SaveResult r = writeDownloadEx(s.name, s.buf.toByteArray(), s.mime);
                if (!r.saved) return "";
                if (r.uri == null) return "saved";
                final Uri uri = r.uri;
                final String mime = s.mime == null || s.mime.isEmpty() ? "application/octet-stream" : s.mime;
                runOnUiThread(new Runnable() {
                    @Override public void run() {
                        try {
                            Intent it = new Intent(Intent.ACTION_VIEW);
                            it.setDataAndType(uri, mime);
                            it.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                            it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                            startActivity(it);
                        } catch (Throwable ignored) {
                        }
                    }
                });
                return "opened";
            } catch (Throwable ignored) {
                return "saved";
            }
        }

        @JavascriptInterface
        public void saveFileAbort(String id) {
            mSaves.remove(id);
        }

        @JavascriptInterface
        public void exitApp() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        finish();
                    } catch (Throwable ignored) {
                    }
                }
            });
        }
    }
}
