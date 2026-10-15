package top.jingxixi.codexwatch;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.net.ConnectivityManager;
import android.net.NetworkInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import org.java_websocket.client.WebSocketClient;
import org.java_websocket.handshake.ServerHandshake;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileWriter;
import java.io.PrintWriter;
import java.net.URI;
import java.net.URLEncoder;
import java.text.SimpleDateFormat;
import java.util.ArrayDeque;
import java.util.Date;
import java.util.Locale;

/**
 * 前台网关服务:持有 wss 长连接(Java-WebSocket),指数退避永久重连;
 * 消息/状态通过 evaluateJavascript 回调 WebView;WebView 不可用时进环形缓冲(200 条)。
 *
 * Android 14~16 防御:
 * - startForeground(dataSync) 三级降级(带 type -> 不带 type -> stopSelf),异常绝不逃逸;
 * - 所有 PendingIntent 强制 FLAG_IMMUTABLE;
 * - 未捕获异常写入 files/crash-log.txt(保留最近5份)后交回系统默认处理;
 * - 服务/广播/通知调用全部自捕获,不让前台服务异常连累同进程的 Activity。
 */
public class GatewayService extends Service {

    public static final String CH_SERVICE = "service";
    public static final String CH_TASK_DONE = "task_done";
    public static final String EXTRA_CHAT_ID = "chatId";
    static final String ACTION_CONNECT = "top.jingxixi.codexwatch.CONNECT";

    private static final int NID_SERVICE = 4242;
    private static final int SEND_QUEUE_MAX = 100;
    private static final int JS_RING_MAX = 200;
    private static final String PREFS = "cw_config";
    private static final String DEFAULT_ENDPOINT = "wss://pcphone.jingxixi.top/ws";
    private static final String CRASH_LOG = "crash-log.txt";

    // ---- 进程级共享状态 ----
    static volatile GatewayService sInstance;
    static volatile MainActivity sMain;
    static volatile boolean sConnected;
    static volatile String sLastSockError = null;
    static final ArrayDeque<String> sSendQueue = new ArrayDeque<String>();
    static final ArrayDeque<String> sJsRing = new ArrayDeque<String>();

    private volatile WebSocketClient mClient;
    private volatile boolean mConnecting = false;
    private volatile boolean mUserQuit = false;
    private volatile boolean mDownHandled = false;
    private int mReconnectAttempt = 0;
    private ConnectivityReceiver mReceiver;
    private final Handler mHandler = new Handler(Looper.getMainLooper());
    private final Runnable mReconnectRun = new Runnable() {
        @Override
        public void run() {
            connectNow();
        }
    };

    // ================= 崩溃日志(未捕获异常兜底) =================

    private static volatile boolean sCrashHandlerInstalled = false;

    /** 进程级安装默认 UncaughtExceptionHandler;MainActivity 与本服务 onCreate 各调一次(幂等) */
    public static void installCrashHandler(final Context ctx) {
        if (sCrashHandlerInstalled) return;
        sCrashHandlerInstalled = true;
        final Thread.UncaughtExceptionHandler prev = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler(new Thread.UncaughtExceptionHandler() {
            @Override
            public void uncaughtException(Thread thread, Throwable ex) {
                try {
                    File dir = ctx.getFilesDir();
                    if (dir != null) {
                        rotateCrashLogs(dir);
                        File f = new File(dir, CRASH_LOG);
                        PrintWriter pw = new PrintWriter(new FileWriter(f, false));
                        try {
                            pw.println("time: " + new SimpleDateFormat(
                                    "yyyy-MM-dd HH:mm:ss.SSS", Locale.US).format(new Date()));
                            pw.println("thread: " + thread);
                            pw.println("app: top.jingxixi.codexwatch 1.0  os: API"
                                    + Build.VERSION.SDK_INT + " " + Build.VERSION.RELEASE);
                            pw.println("----");
                            ex.printStackTrace(pw);
                        } finally {
                            pw.close();
                        }
                    }
                } catch (Throwable ignored) {
                }
                // 交回系统默认处理(保持正常崩溃语义,便于系统记录/开发者选项查看)
                if (prev != null) prev.uncaughtException(thread, ex);
            }
        });
    }

    /** 轮转:crash-log.txt -> .1 -> .2 -> .3 -> .4(连同最新共保留 5 份) */
    private static void rotateCrashLogs(File dir) {
        try {
            File f4 = new File(dir, "crash-log.4.txt");
            if (f4.exists()) { //noinspection ResultOfMethodCallIgnored
                f4.delete();
            }
            for (int i = 3; i >= 1; i--) {
                File src = new File(dir, "crash-log." + i + ".txt");
                File dst = new File(dir, "crash-log." + (i + 1) + ".txt");
                if (src.exists()) { //noinspection ResultOfMethodCallIgnored
                    src.renameTo(dst);
                }
            }
            File cur = new File(dir, CRASH_LOG);
            if (cur.exists()) { //noinspection ResultOfMethodCallIgnored
                cur.renameTo(new File(dir, "crash-log.1.txt"));
            }
        } catch (Throwable ignored) {
        }
    }

    // ================= 生命周期 =================

    @Override
    public void onCreate() {
        super.onCreate();
        sInstance = this;

        installCrashHandler(this);

        try {
            ensureChannels(this);
        } catch (Throwable ignored) {
        }

        // 长连接不能以常驻 CPU 唤醒锁保活；允许手机休眠，恢复前台时补同步。

        try {
            mReceiver = new ConnectivityReceiver();
            IntentFilter f = new IntentFilter(ConnectivityManager.CONNECTIVITY_ACTION);
            if (Build.VERSION.SDK_INT >= 33) {
                registerReceiver(mReceiver, f, Context.RECEIVER_NOT_EXPORTED);
            } else {
                registerReceiver(mReceiver, f);
            }
        } catch (Throwable ignored) {
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // 整体自捕获:任何一处失败都不允许把异常抛回系统(那会连累同进程 Activity = 打开即闪退)
        boolean fg = false;
        try {
            fg = startForegroundCompat();
        } catch (Throwable ignored) {
        }
        if (!fg) {
            // 前台化彻底失败:放弃本次运行,避免 startForegroundService 契约破裂被系统杀进程
            try {
                stopSelf();
            } catch (Throwable ignored) {
            }
            return START_NOT_STICKY;
        }
        try {
            onConnectRequested();
        } catch (Throwable ignored) {
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        if (sInstance == this) sInstance = null;
        try {
            mHandler.removeCallbacksAndMessages(null);
        } catch (Throwable ignored) {
        }
        if (mReceiver != null) {
            try {
                unregisterReceiver(mReceiver);
            } catch (Throwable ignored) {
            }
            mReceiver = null;
        }
        WebSocketClient c = mClient;
        mClient = null;
        if (c != null) {
            try {
                c.close();
            } catch (Throwable ignored) {
            }
        }
        sConnected = false;
        dispatchJs("window.__cwstatus && __cwstatus(" + statusJson(false) + ")");
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    // ================= 静态入口(供 MainActivity / BootReceiver 调用) =================

    public static void start(Context ctx) {
        try {
            Intent i = new Intent(ctx, GatewayService.class);
            i.setAction(ACTION_CONNECT);
            if (Build.VERSION.SDK_INT >= 26) {
                ctx.startForegroundService(i);
            } else {
                ctx.startService(i);
            }
        } catch (Throwable ignored) {
            // Android 12+ 后台 FGS 限制 / ROM 管控:静默,不能连累调用方
        }
    }

    public static boolean isConnectedStatic() {
        GatewayService s = sInstance;
        return sConnected && s != null && s.mClient != null && s.mClient.isOpen();
    }

    /** 发送:已连接直接发;否则入队(上限100),服务未运行先启动服务 */
    public static void sendOrQueue(Context ctx, String json) {
        if (json == null) return;
        try {
            GatewayService s = sInstance;
            if (s != null && sConnected && s.mClient != null) {
                try {
                    s.mClient.send(json);
                    return;
                } catch (Throwable ignored) {
                }
            }
            synchronized (sSendQueue) {
                if (sSendQueue.size() >= SEND_QUEUE_MAX) sSendQueue.pollFirst();
                sSendQueue.addLast(json);
            }
            if (sInstance == null) {
                start(ctx);
            }
        } catch (Throwable ignored) {
        }
    }

    /** 确保服务启动并立即连接 */
    public static void requestConnectNow(Context ctx) {
        // 由 onStartCommand 在主线程连接，避免 JS 桥线程和服务同时创建客户端。
        start(ctx);
    }

    /** 用户登出:关闭连接且暂停自动重连 */
    public static void requestDisconnect() {
        GatewayService s = sInstance;
        if (s != null) {
            try {
                s.disconnectNow();
            } catch (Throwable ignored) {
            }
        }
    }

    // ================= 配置 =================

    public static JSONObject readConfig(Context ctx) {
        JSONObject o = new JSONObject();
        try {
            o.put("endpoint", DEFAULT_ENDPOINT);
            o.put("token", "");
        } catch (Exception ignored) {
        }
        try {
            SharedPreferences sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            String raw = sp.getString("cfg", null);
            if (raw != null) {
                JSONObject saved = new JSONObject(raw);
                if (saved.has("endpoint")) o.put("endpoint", saved.optString("endpoint", DEFAULT_ENDPOINT));
                if (saved.has("token")) o.put("token", saved.optString("token", ""));
            }
        } catch (Throwable ignored) {
        }
        return o;
    }

    public static void writeConfig(Context ctx, JSONObject o) {
        try {
            SharedPreferences sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            sp.edit().putString("cfg", o.toString()).apply();
        } catch (Throwable ignored) {
        }
    }

    /** 网页端设置的免打扰聊天，键为 deviceId/chatId；原生通知需要据此跳过。 */
    public static void writeMutedChats(Context ctx, String json) {
        try {
            JSONArray in = new JSONArray(json);
            JSONArray out = new JSONArray();
            for (int i = 0; i < in.length() && i < 2000; i++) {
                String k = in.optString(i, "");
                if (k.length() > 0 && k.length() < 300) out.put(k);
            }
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("muted", out.toString()).apply();
        } catch (Throwable ignored) {
        }
    }

    static boolean isChatMuted(Context ctx, String deviceId, String chatId) {
        if (chatId == null || chatId.length() == 0) return false;
        try {
            JSONArray arr = new JSONArray(ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("muted", "[]"));
            String suffix = "/" + chatId;
            for (int i = 0; i < arr.length(); i++) {
                String k = arr.optString(i, "");
                // 旧中继补发的离线通知没有 deviceId，只能按聊天 ID 匹配。
                if (deviceId != null && deviceId.length() > 0 ? k.equals(deviceId + suffix) : k.endsWith(suffix)) return true;
            }
        } catch (Throwable ignored) {
        }
        return false;
    }

    // ================= WebView 挂接/回调 =================

    static void dispatchJs(String expr) {
        try {
            MainActivity m = sMain;
            if (m != null) {
                m.evalJs(expr);
                return;
            }
            // WebView 未 attach:进环形缓冲(200 条)
            synchronized (sJsRing) {
                if (sJsRing.size() >= JS_RING_MAX) sJsRing.pollFirst();
                sJsRing.addLast(expr);
            }
        } catch (Throwable ignored) {
        }
    }

    static void attach(MainActivity a) {
        sMain = a;
        ArrayDeque<String> drained = new ArrayDeque<String>();
        synchronized (sJsRing) {
            drained.addAll(sJsRing);
            sJsRing.clear();
        }
        for (String expr : drained) {
            a.evalJs(expr); // evalJs 内部自捕获
        }
        a.evalJs("window.__cwstatus && __cwstatus(" + statusJson(isConnectedStatic()) + ")");
        // 回到前台立即重试，不受后台较长的退避等待影响。
        GatewayService service = sInstance;
        if (service != null && !isConnectedStatic()) service.onConnectRequested();
    }

    static void detach() {
        sMain = null;
    }

    static String statusJson(boolean connected) {
        String err = sLastSockError == null ? "" : sLastSockError.replace("\\", "\\\\").replace("\"", "'").replace("\n", " ");
        if (err.length() > 120) err = err.substring(0, 120);
        return "{\"connected\":" + connected + ",\"error\":\"" + err + "\",\"ts\":" + System.currentTimeMillis() + "}";
    }

    // ================= 连接管理 =================

    void onConnectRequested() {
        mUserQuit = false;
        mHandler.removeCallbacks(mReconnectRun);
        mReconnectAttempt = 0;
        connectNow();
    }

    void disconnectNow() {
        mUserQuit = true;
        mHandler.removeCallbacks(mReconnectRun);
        WebSocketClient c = mClient;
        mClient = null;
        mConnecting = false;
        if (c != null) {
            try {
                c.close();
            } catch (Throwable ignored) {
            }
        }
        boolean was = sConnected;
        sConnected = false;
        if (was) dispatchJs("window.__cwstatus && __cwstatus(" + statusJson(false) + ")");
        updateServiceNotif();
    }

    void connectNow() {
        if (mUserQuit) return;
        if (sConnected) return;
        // 挂起中的旧连接直接丢弃重建(用户手动重连/退避定时器触发)
        if (mConnecting) {
            WebSocketClient stale = mClient;
            mClient = null;
            mConnecting = false;
            if (stale != null) { try { stale.close(); } catch (Throwable ignored) {} try { stale.closeConnection(1000, "reconnect"); } catch (Throwable ignored) {} }
        }
        if (!networkOnline()) return; // 无网时等待 CONNECTIVITY_ACTION 广播触发
        connectInternal();
    }

    private synchronized void connectInternal() {
        if (mClient != null && (sConnected || mConnecting)) return;
        JSONObject cfg;
        try {
            cfg = readConfig(this);
        } catch (Throwable t) {
            return;
        }
        String endpoint = cfg.optString("endpoint", DEFAULT_ENDPOINT);
        String token = cfg.optString("token", "");
        if (endpoint.length() == 0 || token.length() == 0) {
            updateServiceNotif();
            return;
        }
        String sep = endpoint.indexOf('?') >= 0 ? "&" : "?";
        String url = endpoint + sep + "token=" + URLEncoder.encode(token) + "&power=balanced";

        try {
            mDownHandled = false;
            mConnecting = true;
            updateServiceNotif();
            mClient = new WebSocketClient(new URI(url)) {
                @Override
                public void onOpen(ServerHandshake handshake) {
                    GatewayService.this.onSocketOpen(this);
                }

                @Override
                public void onMessage(String message) {
                    if (mClient == this) GatewayService.this.onSocketMessage(message);
                }

                @Override
                public void onClose(int code, String reason, boolean remote) {
                    GatewayService.this.onSocketDown(this, "close " + code + (reason == null ? "" : " " + reason));
                }

                @Override
                public void onError(Exception ex) {
                    String msg = ex == null ? "unknown" : (String.valueOf(ex.getClass().getSimpleName()) + ": " + String.valueOf(ex.getMessage()));
                    GatewayService.this.onSocketDown(this, msg);
                }
            };
            // 非唤醒型心跳；不再每 20 秒检查网络，系统休眠期间允许计时器延后。
            mClient.setConnectionLostTimeout(180);
            mClient.connect();
        } catch (Throwable e) {
            // 构造失败也要反馈页面，不能只退避重试而永久显示无原因的未连接。
            onSocketDown(e.getClass().getSimpleName() + ": " + String.valueOf(e.getMessage()));
        }
    }

    private void onSocketOpen(final WebSocketClient source) {
        mHandler.post(new Runnable() {
            @Override
            public void run() {
                if (mClient != source || !source.isOpen()) return;
                try {
                    mConnecting = false;
                    sConnected = true;
                    sLastSockError = null;
                    mReconnectAttempt = 0;
                    flushSendQueue();
                } catch (Throwable ignored) {
                }
                updateServiceNotif();
                dispatchJs("window.__cwstatus && __cwstatus(" + statusJson(true) + ")");
            }
        });
    }

    private void onSocketDown() {
        onSocketDown(null);
    }

    private void onSocketDown(final String why) {
        onSocketDown(mClient, why);
    }

    private void onSocketDown(final WebSocketClient source, final String why) {
        mHandler.post(new Runnable() {
            @Override
            public void run() {
                if (mClient != source) return; // 旧连接的关闭/错误不能覆盖新连接状态。
                if (mDownHandled) return; // onClose/onError 只处理一次
                mDownHandled = true;
                mConnecting = false;
                boolean was = sConnected;
                sConnected = false;
                if (why != null && why.length() > 0) sLastSockError = why;
                if (was || sLastSockError != null) {
                    dispatchJs("window.__cwstatus && __cwstatus(" + statusJson(false) + ")");
                }
                updateServiceNotif();
                try {
                    scheduleReconnect();
                } catch (Throwable ignored) {
                }
            }
        });
    }

    /** 前台快速重试；后台失败从 30 秒退避至 5 分钟，避免差网络下持续联网。 */
    private void scheduleReconnect() {
        if (mUserQuit) return;
        long base = sMain == null ? 30000L : 2000L;
        long cap = sMain == null ? 300000L : 60000L;
        long delay = Math.min(cap, base * (1L << Math.min(mReconnectAttempt, 5)));
        mReconnectAttempt++;
        mHandler.removeCallbacks(mReconnectRun);
        mHandler.postDelayed(mReconnectRun, delay);
    }

    private void flushSendQueue() {
        WebSocketClient c = mClient;
        if (c == null || !sConnected) return;
        while (true) {
            String msg;
            synchronized (sSendQueue) {
                msg = sSendQueue.peekFirst();
            }
            if (msg == null) break;
            try {
                c.send(msg);
            } catch (Throwable e) {
                break; // 连接已失效,留在队列里待下次 onOpen 重发
            }
            synchronized (sSendQueue) {
                sSendQueue.pollFirst();
            }
        }
    }

    private void onSocketMessage(String message) {
        // 1) 原样回调 WebView
        dispatchJs("window.__cwonmessage && __cwonmessage(" + message + ")");
        // 2) 实时通知位于 dev_frame.d，离线补发是顶层 notify，均须原生处理。
        try {
            JSONObject d = NotificationEnvelope.decode(message);
            if (d != null) {
                    String title = d.optString("title");
                    String body = d.has("body") ? d.optString("body") : "";
                    String chatId = d.has("chatId") ? d.optString("chatId") : null;
                    if (isChatMuted(this, d.optString("deviceId", ""), chatId)) return;
                    String eventId = d.optString("nid", "");
                    int nid = eventId.length() == 0 ? 0 : ((d.optString("deviceId", "") + ":" + eventId).hashCode() & 0x7fffffff);
                    if (nid == NID_SERVICE) nid++;
                    postTaskNotification(this, title, body, chatId, nid);
            }
        } catch (Throwable ignored) {
        }
    }

    private boolean networkOnline() {
        try {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return true;
            NetworkInfo ni = cm.getActiveNetworkInfo();
            return ni != null && ni.isConnected();
        } catch (Throwable e) {
            return true;
        }
    }

    private class ConnectivityReceiver extends BroadcastReceiver {
        @Override
        public void onReceive(Context context, Intent intent) {
            try {
                if (mUserQuit) return;
                if (networkOnline()) {
                    // 网络恢复:立即重试,退避归零
                    mReconnectAttempt = 0;
                    mHandler.removeCallbacks(mReconnectRun);
                    connectNow();
                }
            } catch (Throwable ignored) {
            }
        }
    }

    // ================= 通知 =================

    static void ensureChannels(Context ctx) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        try {
            NotificationChannel svc = new NotificationChannel(CH_SERVICE, "后台守护服务",
                    NotificationManager.IMPORTANCE_LOW);
            svc.setDescription("CodexWatch 常驻服务状态");
            svc.setSound(null, null); // 静音
            svc.setShowBadge(false);
            nm.createNotificationChannel(svc);
        } catch (Throwable ignored) {
        }
        try {
            NotificationChannel task = new NotificationChannel(CH_TASK_DONE, "任务完成提醒",
                    NotificationManager.IMPORTANCE_HIGH); // 默认提示音
            task.setDescription("Codex 任务完成通知");
            task.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
            nm.createNotificationChannel(task);
        } catch (Throwable ignored) {
        }
    }

    /** 唯一的 PendingIntent 出口:一律 FLAG_IMMUTABLE(API31+ 缺失直接 SecurityException) */
    static PendingIntent activityPending(Context ctx, String chatId) {
        Intent i = new Intent(ctx, MainActivity.class);
        i.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        int rc = 0;
        if (chatId != null) {
            i.putExtra(EXTRA_CHAT_ID, chatId);
            i.setAction("top.jingxixi.codexwatch.DEEPLINK." + chatId);
            rc = chatId.hashCode();
        }
        return PendingIntent.getActivity(ctx, rc, i,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    static Notification buildServiceNotification(Context ctx, String text) {
        try {
            ensureChannels(ctx);
            Notification.Builder b;
            if (Build.VERSION.SDK_INT >= 26) {
                b = new Notification.Builder(ctx, CH_SERVICE);
            } else {
                b = new Notification.Builder(ctx);
                b.setPriority(Notification.PRIORITY_LOW);
            }
            b.setSmallIcon(R.mipmap.ic_launcher)
                    .setContentTitle("CodexWatch 正在守护任务")
                    .setContentText(text)
                    .setOngoing(true)
                    .setOnlyAlertOnce(true)
                    .setContentIntent(activityPending(ctx, null));
            return b.build();
        } catch (Throwable t) {
            return fallbackNotification(ctx, text);
        }
    }

    /** 极简兜底通知:不依赖渠道/资源,任何环境下可构造 */
    @SuppressWarnings("deprecation")
    static Notification fallbackNotification(Context ctx, String text) {
        Notification.Builder b = new Notification.Builder(ctx.getApplicationContext());
        b.setSmallIcon(android.R.drawable.sym_def_app_icon)
                .setContentTitle("CodexWatch")
                .setContentText(text == null ? "" : text)
                .setOngoing(true);
        return b.build();
    }

    private String hostOf() {
        try {
            JSONObject cfg = readConfig(this);
            return URI.create(cfg.optString("endpoint", DEFAULT_ENDPOINT)).getHost();
        } catch (Throwable e) {
            return "";
        }
    }

    private void updateServiceNotif() {
        try {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            String text;
            if (sConnected) {
                String h = hostOf();
                text = h.length() > 0 ? "已连接 " + h : "已连接";
            } else if (mUserQuit) {
                text = "已断开连接(已登出)";
            } else {
                text = "正在连接,自动重试中…";
            }
            nm.notify(NID_SERVICE, buildServiceNotification(this, text));
        } catch (Throwable ignored) {
        }
    }

    /**
     * 前台化(三级降级,返回是否成功):
     * 1) API29+ 带 FOREGROUND_SERVICE_TYPE_DATA_SYNC(Android 15/16 校验收紧,可能抛
     *    SecurityException / ForegroundServiceStartNotAllowedException / InvalidForegroundServiceTypeException);
     * 2) 失败 -> 降级为不带 type 的 startForeground(id, notification);
     * 3) 再失败 -> 返回 false,由 onStartCommand stopSelf,绝不让异常逃逸。
     */
    private boolean startForegroundCompat() {
        Notification n = buildServiceNotification(this, sConnected ? "已连接" : "正在连接…");
        if (Build.VERSION.SDK_INT >= 29) {
            try {
                startForeground(NID_SERVICE, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
                return true;
            } catch (Throwable t1) {
                // dataSync 类型被拒(6 小时预算耗尽 / ROM 更严校验):降级不带 type
            }
            try {
                startForeground(NID_SERVICE, n);
                return true;
            } catch (Throwable t2) {
                return false;
            }
        }
        try {
            startForeground(NID_SERVICE, n);
            return true;
        } catch (Throwable t3) {
            return false;
        }
    }

    /** 发"任务完成"通知(渠道 task_done,高优先级带提示音);nid==0 时按 hash(chatId) 生成 */
    static void postTaskNotification(Context ctx, String title, String body, String chatId, int nid) {
        if (title == null || title.length() == 0) return;
        try {
            NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            ensureChannels(ctx);
            int id = (nid != 0) ? nid
                    : (chatId == null ? 0 : (chatId.hashCode() & 0x7fffffff));
            Notification.Builder b;
            if (Build.VERSION.SDK_INT >= 26) {
                b = new Notification.Builder(ctx, CH_TASK_DONE);
            } else {
                b = new Notification.Builder(ctx);
                b.setPriority(Notification.PRIORITY_HIGH);
                b.setDefaults(Notification.DEFAULT_SOUND);
            }
            b.setSmallIcon(R.mipmap.ic_launcher)
                    .setContentTitle(title)
                    .setContentText(body == null ? "" : body)
                    .setAutoCancel(true)
                    .setVisibility(Notification.VISIBILITY_PRIVATE)
                    .setCategory(Notification.CATEGORY_STATUS)
                    .setWhen(System.currentTimeMillis())
                    .setContentIntent(activityPending(ctx, chatId));
            nm.notify(id, b.build());
        } catch (Throwable ignored) {
        }
    }
}
