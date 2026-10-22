package com.deepseek.harness;

import android.accessibilityservice.GestureDescription;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.Rect;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.Display;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedWriter;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStreamWriter;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executor;
import java.util.concurrent.TimeUnit;

/**
 * 无障碍服务（v1.7.3）：给 AI 提供「看屏幕 + 操作屏幕」能力。
 * 与 node 插件 dsh-tool-accessibility 通过本地 HTTP（127.0.0.1:<a11yPort>）通信。
 * 端口 = 引擎端口 + 101（正式版 3181 / Lite 3183 / 兼容版 3185），三版本共存不冲突。
 * 注意：javac -bootclasspath android.jar 下不能用 lambda/方法引用，全部用显式匿名类。
 *
 * v1.7.3 新增「通用触摸手势引擎」（/gesture /touch /swipe /hold /touch-release /touch-status）：
 *  - 多笔时间轴：一次请求可含 down/move/up/tap/swipe/hold/wait，全部同时注入（真多指）；
 *  - 按住保持：down 后不 up 的手指会一直按住（willContinue），可跨请求延续——"左手按住摇杆，
 *    右手同时点技能"就是 down(0) 之后再来 tap(1)；
 *  - 分数坐标：所有坐标支持 fx/fy（0~1 相对屏幕比例），彻底消除截图缩放误差；
 *  - 安全网：手指按住超时（30s）自动抬起、同 finger 覆盖、release_all 一键复位、
 *    手势失败/服务断开全部复位。
 */
public class AccessibilityService extends android.accessibilityservice.AccessibilityService {

    private static final String TAG = "dsh-a11y";
    private static final String PREFS = "dsh_prefs";
    private static final String KEY_A11Y_PORT = "a11y_port";

    /** 服务是否已连接（用户已在系统设置开启无障碍）。 */
    public static volatile boolean isRunning = false;
    /** 当前活跃窗口的包名。 */
    public static volatile String activePackage = "";

    // v1.22 生命周期时间线（真机 Agent 复盘 P0-3）：
    //   以前「用户没开无障碍」与「服务刚被系统杀掉、正在重连」在插件侧返回的文案完全一样，
    //   模型会把"闪断"误判成"用户关掉了无障碍"（复盘里就真发生了）。
    //   这里记录连接/断开时刻与次数，由 /status 暴露：
    //     · isRunning=false 且 connectCount==0        → 从没连上过（用户没开）
    //     · isRunning=false 且 lastUnbindAt 很近       → 刚断开（被杀/被关/闪断中）
    //     · isRunning=true  且 connectedAgoMs 很小     → 刚重连（闪断恢复 —— **危险信号**：
    //        复盘里两次事故前的共同征兆就是无障碍先反复闪断，随后点击/输入成片失败）
    public static volatile long lastConnectedAt = 0L;
    public static volatile long lastUnbindAt = 0L;
    public static volatile int connectCount = 0;
    public static volatile String lastUnbindReason = "";

    private static final int MAX_NODES = 250;
    private static final int MAX_DEPTH = 40;
    private static final int MAX_TEXT_LEN = 120;
    private static final int SOCKET_TIMEOUT_MS = 8000;

    /** 手势引擎：最大手指数（多数设备 getMaxStrokeCount() ≥ 10）。 */
    private static final int MAX_FINGERS = 8;
    /** 手指按住保持超时（毫秒），超过自动抬起，防止 AI 失控后手指一直压着屏幕。 */
    private static final long HOLD_TIMEOUT_MS = 30000;
    /** 单次手势时间轴总长上限（毫秒）。 */
    private static final long MAX_GESTURE_TOTAL_MS = 120000;

    private final Object gestureLock = new Object();
    /** 当前手势预计占用到什么时候（ms 时间戳）；> now 时新的注入请求直接快速失败，不再闷等超时。 */
    private volatile long gestureBusyUntil = 0L;
    private final boolean[] fingerDown = new boolean[MAX_FINGERS];
    private final float[] fingerX = new float[MAX_FINGERS];
    private final float[] fingerY = new float[MAX_FINGERS];
    private final long[] fingerDownAt = new long[MAX_FINGERS];
    private int screenW = 0;
    private int screenH = 0;

    private ServerSocket serverSocket;

    private static class StrokeDesc {
        Path path;
        long startTime;
        long duration;
        boolean willContinue;
        /** true = 这笔是上一笔的延续（用 continueStroke 接上，避免中间出现 UP）。 */
        boolean continuation = false;
        StrokeDesc(Path p, long s, long d, boolean wc) {
            path = p;
            startTime = s;
            duration = d;
            willContinue = wc;
        }
    }

    @Override
    public void onServiceConnected() {
        isRunning = true;
        // v1.22：记录连接时刻与次数（用于区分"从没开过"与"刚重连/闪断"）
        lastConnectedAt = System.currentTimeMillis();
        connectCount = connectCount + 1;
        lastUnbindReason = "";
        Log.i(TAG, "accessibility service connected");
        // 端口必须由包名决定，不能信 dsh_prefs 里的 a11y_port：该 pref 跨版本持久化，升级后旧包
        // 写下的 3181 仍会被读到 → 正式版与 Lite 的无障碍服务都往 3181 绑，后连的那个 bind 失败
        // 且静默，先连的那个应答 —— 插件于是拿到“另一个包”的截图/节点（跨包路径必然 EACCES）。
        int port = 3181;
        try {
            // v1.18（B12）：端口一律由变体表派生（BuildVariant），不再 contains() 猜包名。
            // 无障碍端口 = 引擎端口 + 101（社区版 3086 + 101 = 3187）。
            port = BuildVariant.ENGINE_PORT + 101;
            SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
            if (prefs.getInt(KEY_A11Y_PORT, port) != port) {
                prefs.edit().putInt(KEY_A11Y_PORT, port).apply(); // 顺手纠正历史脏值
            }
        } catch (Throwable t) {
            Log.w(TAG, "derive a11y port failed", t);
        }
        startServer(port);
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        if (event != null && event.getPackageName() != null) {
            activePackage = event.getPackageName().toString();
        }
    }

    @Override
    public void onInterrupt() {
        Log.w(TAG, "accessibility service interrupted");
        releaseAllFingers();
    }

    @Override
    public boolean onUnbind(android.content.Intent intent) {
        isRunning = false;
        // v1.22：记录断开时刻（"刚断开"与"从没开过"要能分开）
        lastUnbindAt = System.currentTimeMillis();
        lastUnbindReason = "onUnbind（系统解绑：用户关闭无障碍 / 服务被回收）";
        releaseAllFingers();
        stopServer();
        return super.onUnbind(intent);
    }

    private void stopServer() {
        try {
            if (serverSocket != null) serverSocket.close();
        } catch (Throwable ignored) {
        }
        serverSocket = null;
    }

    private void startServer(final int port) {
        new Thread(new Runnable() {
            @Override
            public void run() {
                ServerSocket ss = null;
                try {
                    ss = new ServerSocket();
                    ss.setReuseAddress(true);
                    ss.bind(new InetSocketAddress("127.0.0.1", port));
                    serverSocket = ss;
                    Log.i(TAG, "a11y server listening on " + port);
                    while (!Thread.currentThread().isInterrupted()) {
                        try {
                            final Socket s = ss.accept();
                            handleConnection(s);
                        } catch (Throwable t) {
                            try { Thread.sleep(100); } catch (Throwable ignored) {}
                        }
                    }
                } catch (Throwable t) {
                    Log.w(TAG, "a11y server stopped", t);
                } finally {
                    try { if (ss != null) ss.close(); } catch (Throwable ignored) {}
                }
            }
        }, "a11y-server").start();
    }

    private String parsePath(String head) {
        int sp1 = head.indexOf(' ');
        int sp2 = sp1 >= 0 ? head.indexOf(' ', sp1 + 1) : -1;
        if (sp1 >= 0 && sp2 > sp1) return head.substring(sp1 + 1, sp2);
        return "/";
    }

    private String queryParam(String path, String key) {
        int q = path.indexOf('?');
        if (q < 0) return "";
        String query = path.substring(q + 1);
        for (String pair : query.split("&")) {
            int eq = pair.indexOf('=');
            if (eq > 0) {
                String k = pair.substring(0, eq);
                if (k.equals(key)) {
                    try {
                        return java.net.URLDecoder.decode(pair.substring(eq + 1), "UTF-8");
                    } catch (Exception ignored) {
                        return pair.substring(eq + 1);
                    }
                }
            }
        }
        return "";
    }

    private double parseDoubleSafe(String s, double def) {
        try {
            return Double.parseDouble(s);
        } catch (Throwable t) {
            return def;
        }
    }

    private void handleConnection(final Socket s) {
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    s.setSoTimeout(SOCKET_TIMEOUT_MS);
                    InputStream in = s.getInputStream();
                    StringBuilder head = new StringBuilder();
                    int c;
                    while ((c = in.read()) != -1) {
                        head.append((char) c);
                        if (head.length() >= 4 && head.substring(head.length() - 4).equals("\r\n\r\n")) break;
                        if (head.length() > 8192) break;
                    }
                    String headStr = head.toString();
                    String path = parsePath(headStr);
                    // 读取 POST body（/gesture 传 JSON）
                    String body = "";
                    int ci = headStr.toLowerCase().indexOf("content-length:");
                    if (ci >= 0) {
                        int eol = headStr.indexOf("\r\n", ci);
                        if (eol > ci) {
                            String v = headStr.substring(ci + 15, eol).trim();
                            try {
                                int len = Integer.parseInt(v);
                                if (len > 0 && len < 262144) {
                                    byte[] buf = new byte[len];
                                    int off = 0;
                                    while (off < len) {
                                        int n = in.read(buf, off, len - off);
                                        if (n < 0) break;
                                        off += n;
                                    }
                                    body = new String(buf, 0, off, "UTF-8");
                                }
                            } catch (Throwable ignored) {
                            }
                        }
                    }
                    String respBody;
                    // v1.18.0：本地服务统一鉴权。127.0.0.1 对设备上所有应用开放，不是访问控制；
                    // 这块能力（读屏 / 截屏 / 注入手势 / 写剪贴板）本应由用户在系统设置里显式授予。
                    if (!LocalAuth.ok(LocalAuth.token(AccessibilityService.this), headStr, path)) {
                        Log.w(TAG, "a11y 请求被拒（令牌缺失或错误）：" + path);
                        respBody = LocalAuth.denied();
                    } else {
                        try {
                            respBody = route(path, body);
                        } catch (Throwable t) {
                            respBody = jsonError("内部错误: " + t.getMessage());
                        }
                    }
                    BufferedWriter w = new BufferedWriter(new OutputStreamWriter(s.getOutputStream(), "UTF-8"));
                    w.write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: "
                            + respBody.getBytes("UTF-8").length + "\r\nConnection: close\r\n\r\n" + respBody);
                    w.flush();
                    s.close();
                } catch (Throwable t) {
                    Log.w(TAG, "a11y connection error", t);
                    try { s.close(); } catch (Throwable ignored) {}
                }
            }
        }, "a11y-conn").start();
    }

    /**
     * 这段文字像不像"工具调用回显"？
     *
     * <p>为什么需要：在 DSH 自己的界面里，一次 tool call 会把参数原样渲染进聊天记录
     * （例如 `TOOL, android_tap {"expect_text": "xxx"}`），于是"扫整棵树找 expect_text"
     * 永远能扫到 —— 校验必然自证成功（用户第二轮实测抓到的假阳性）。
     */
    private boolean looksLikeToolEcho(String s) {
        if (s == null || s.isEmpty()) return false;
        return s.contains("expect_text") || s.contains("expect_timeout")
                || s.contains("android_tap") || s.contains("android_focus_type")
                || s.contains("android_gesture") || s.contains("android_paste_text")
                || s.contains("Tool call") || s.startsWith("TOOL");
    }

    /** 活动窗口里"不像回显"的文本集合（点击前后差异比对用）。 */
    private java.util.HashSet<String> textSet() {
        final java.util.HashSet<String> set = new java.util.HashSet<String>();
        try {
            AccessibilityNodeInfo root = getRootInActiveWindow();
            if (root == null) return set;
            walk(root, new NodeVisitor() {
                @Override
                public void visit(AccessibilityNodeInfo n, int depth) {
                    if (n == null) return;
                    try {
                        CharSequence t = n.getText();
                        CharSequence d = n.getContentDescription();
                        if (t != null && !looksLikeToolEcho(t.toString())) set.add(t.toString());
                        if (d != null && !looksLikeToolEcho(d.toString())) set.add(d.toString());
                    } catch (Throwable ignored) {}
                }
            }, 0);
        } catch (Throwable ignored) {}
        return set;
    }

    /** 等某段文字**新出现**：点击前不存在、且不像工具回显。 */
    private boolean pollForNewText(final java.util.HashSet<String> before, final String needle, long timeoutMs) {
        long end = System.currentTimeMillis() + Math.max(200L, timeoutMs);
        while (System.currentTimeMillis() < end) {
            final boolean[] hit = {false};
            try {
                AccessibilityNodeInfo root = getRootInActiveWindow();
                if (root != null) {
                    walk(root, new NodeVisitor() {
                        @Override
                        public void visit(AccessibilityNodeInfo n, int depth) {
                            if (hit[0] || n == null) return;
                            try {
                                CharSequence t = n.getText();
                                CharSequence d = n.getContentDescription();
                                String s1 = t == null ? "" : t.toString();
                                String s2 = d == null ? "" : d.toString();
                                boolean m1 = s1.contains(needle) && !looksLikeToolEcho(s1) && !before.contains(s1);
                                boolean m2 = s2.contains(needle) && !looksLikeToolEcho(s2) && !before.contains(s2);
                                if (m1 || m2) hit[0] = true;
                            } catch (Throwable ignored) {}
                        }
                    }, 0);
                }
            } catch (Throwable ignored) {}
            if (hit[0]) return true;
            try {
                Thread.sleep(150L);
            } catch (InterruptedException ignored) {
            }
        }
        return false;
    }

    /** 当前活动窗口的"结构指纹"（文本 + 长度）。用于判断一次操作是否真的改变了界面。 */
    private String treeFingerprint() {
        try {
            AccessibilityNodeInfo root = getRootInActiveWindow();
            if (root == null) return "";
            final StringBuilder sb = new StringBuilder(4096);
            walk(root, new NodeVisitor() {
                @Override
                public void visit(AccessibilityNodeInfo n, int depth) {
                    if (n == null) return;
                    try {
                        CharSequence t = n.getText();
                        CharSequence d = n.getContentDescription();
                        if (t != null) sb.append(t).append('|');
                        if (d != null) sb.append(d).append('|');
                    } catch (Throwable ignored) {}
                }
            }, 0);
            return Integer.toHexString(sb.toString().hashCode()) + ":" + sb.length();
        } catch (Throwable t) {
            return "";
        }
    }

    /** 从节点向上找第一个可点击祖先（设置类界面点"行标题文案"是常态）。 */
    private AccessibilityNodeInfo clickableAncestor(AccessibilityNodeInfo node) {
        AccessibilityNodeInfo cur = node;
        for (int i = 0; i < 6 && cur != null; i++) {
            try {
                if (cur.isClickable()) return cur;
                cur = cur.getParent();
            } catch (Throwable t) {
                return null;
            }
        }
        return null;
    }

    /** 轮询控件树，等某段文字出现（expect_text 校验用）。 */
    private boolean pollForText(String needle, long timeoutMs) {
        long end = System.currentTimeMillis() + Math.max(200L, timeoutMs);
        while (System.currentTimeMillis() < end) {
            try {
                if (findNodeByText(needle) != null) return true;
            } catch (Throwable ignored) {}
            try {
                Thread.sleep(150L);
            } catch (InterruptedException ignored) {
            }
        }
        return false;
    }

    private String jsonError(String msg) {
        try {
            JSONObject o = new JSONObject();
            o.put("ok", false);
            o.put("error", msg == null ? "未知错误" : msg);
            return o.toString();
        } catch (Throwable t) {
            return "{\"ok\":false,\"error\":\"json error\"}";
        }
    }

    private String route(String path, String body) throws Exception {
        String base = path;
        int q = path.indexOf('?');
        if (q >= 0) base = path.substring(0, q);

        if (base.equals("/status")) return handleStatus();
        if (base.equals("/dump")) return handleDump();
        if (base.equals("/tap")) return handleTap(path);
        if (base.equals("/input")) return handleInput(path);
        if (base.equals("/back")) return handleGlobalAction(GLOBAL_ACTION_BACK);
        if (base.equals("/home")) return handleGlobalAction(GLOBAL_ACTION_HOME);
        if (base.equals("/scroll")) return handleScroll(path);
        if (base.equals("/screenshot")) return handleScreenshot(path);
        if (base.equals("/pixel")) return handlePixel(path);   // v1.20.2：像素采样（毫秒级）
        if (base.equals("/swipe")) return handleSwipe(path);
        if (base.equals("/hold")) return handleHold(path);
        if (base.equals("/touch")) return handleTouch(path);
        if (base.equals("/touch-release")) return handleTouchRelease();
        if (base.equals("/touch-status")) return handleTouchStatus();
        if (base.equals("/gesture")) return handleGesture(body);
        // v1.22（P1）：触发输入法的「前往 / 发送」（EditorAction），供 android_focus_type 的提交步骤使用
        if (base.equals("/ime-enter")) return handleImeEnter();
        return jsonError("未知路由: " + base);
    }

    // ===================== 屏幕尺寸 / 坐标 =====================

    /** 当前真实屏幕尺寸（物理像素，与无障碍截图同一坐标系）。 */
    private int[] screenSize() {
        try {
            WindowManager wm = (WindowManager) getSystemService(WINDOW_SERVICE);
            DisplayMetrics dm = new DisplayMetrics();
            wm.getDefaultDisplay().getRealMetrics(dm);
            return new int[]{dm.widthPixels, dm.heightPixels};
        } catch (Throwable t) {
            try {
                DisplayMetrics dm = getResources().getDisplayMetrics();
                return new int[]{dm.widthPixels, dm.heightPixels};
            } catch (Throwable t2) {
                return new int[]{0, 0};
            }
        }
    }

    /** JSON 坐标解析：fx/fy（0~1 分数）优先，x/y（像素）兜底。 */
    private int resolveInt(JSONObject op, String fracKey, String pxKey, int screenLen, int def) {
        try {
            if (op.has(fracKey)) {
                double f = op.optDouble(fracKey, -1);
                if (f >= 0 && f <= 1) return (int) Math.round(f * screenLen);
            }
            if (op.has(pxKey)) return op.optInt(pxKey, -1);
        } catch (Throwable ignored) {
        }
        return def;
    }

    /** GET 查询参数坐标解析：fx/fy 优先，x/y 兜底。 */
    private int coordFromParams(String path, String pxKey, String fKey, int screenLen) {
        String p = queryParam(path, pxKey);
        String f = queryParam(path, fKey);
        if (!f.isEmpty()) {
            double d = parseDoubleSafe(f, -1);
            if (d >= 0 && d <= 1) return (int) Math.round(d * screenLen);
        }
        if (!p.isEmpty()) return (int) parseDoubleSafe(p, -1);
        return -1;
    }

    // ===================== 通用触摸手势引擎 =====================

    /** 把单个 op 的坐标（x/y 或 fx/fy）解析为 JSONObject，供合成单步手势用。 */
    private void putCoord(JSONObject op, String pxX, String pxY, String fX, String fY, int sx, int sy) {
        try {
            if (sx >= 0) op.put(pxX, sx);
            if (sy >= 0) op.put(pxY, sy);
        } catch (Throwable ignored) {
        }
    }

    /** 抬起全部按住中的手指（加锁入口，供服务生命周期调用）。 */
    private void releaseAllFingers() {
        synchronized (gestureLock) {
            releaseAllFingersUnlocked();
        }
    }

    /** 抬起全部按住中的手指（调用方必须已持有 gestureLock）。 */
    private void releaseAllFingersUnlocked() {
        boolean any = false;
        for (int f = 0; f < MAX_FINGERS; f++) {
            if (fingerDown[f]) {
                any = true;
                fingerDown[f] = false;
            }
        }
        if (!any) return;
        try {
            GestureDescription.Builder gb = new GestureDescription.Builder();
            for (int f = 0; f < MAX_FINGERS; f++) {
                if (fingerX[f] >= 0 && fingerY[f] >= 0) {
                    // 注意：上面已把 fingerDown 全部置 false，这里用坐标数组判断即可
                    Path p = new Path();
                    p.moveTo(fingerX[f], fingerY[f]);
                    gb.addStroke(new GestureDescription.StrokeDescription(p, 0, 80, false));
                }
            }
            dispatchGesture(gb.build(), null, null);
        } catch (Throwable t) {
            Log.w(TAG, "release all failed", t);
        }
    }

    /**
     * 执行一组手势笔（时间轴编排，全部同时注入）。op 结构：
     *   { "kind": "down"|"move"|"up"|"tap"|"swipe"|"hold"|"wait",
     *     "finger": 0..7,
     *     "x"/"y" 或 "fx"/"fy"（0~1 分数）,
     *     "x2"/"y2" 或 "fx2"/"fy2"（swipe 终点）,
     *     "durationMs": 笔时长（wait=等待毫秒；tap 默认 60；swipe 默认 300；
     *                    hold 默认 500；move 默认 100；up 默认 100） }
     * down 后未 up 的手指保持按住，可跨请求延续；下次请求自动带上延续笔。
     */
    private String executeGesture(JSONArray ops) {
        // v1.19.3 P0：注入是串行的（gestureLock）。以前新请求会一直排队到插件侧 12s 超时，
        // 报错还被改写成"无障碍未开启"；现在直接快速失败并说清原因。
        long busyLeft = gestureBusyUntil - System.currentTimeMillis();
        if (busyLeft > 0) {
            return jsonError("上一条手势仍在执行（预计还需 " + busyLeft
                    + " ms）：坐标注入是串行的，请稍后重试，或把 durationMs 调小");
        }
        synchronized (gestureLock) {
            try {
                int[] size = screenSize();
                if (size[0] <= 0 || size[1] <= 0) return jsonError("无法获取屏幕尺寸");
                // 屏幕尺寸变化（旋转/分辨率切换）→ 旧手指坐标失效，全部复位
                if (screenW != 0 && (size[0] != screenW || size[1] != screenH)) {
                    releaseAllFingersUnlocked();
                }
                screenW = size[0];
                screenH = size[1];

                int n = ops == null ? 0 : ops.length();
                if (n == 0) return jsonError("手势列表为空");

                // ===== 第一遍：解析 + 校验 + 时间轴（此时不修改任何真实状态）=====
                // 虚拟手指状态：模拟本请求内 down/move/up 的演化，用于校验（真实状态不动）
                boolean[] virtualDown = new boolean[MAX_FINGERS];
                System.arraycopy(fingerDown, 0, virtualDown, 0, MAX_FINGERS);
                long now = System.currentTimeMillis();
                boolean[] expired = new boolean[MAX_FINGERS];
                boolean anyExpired = false;
                for (int f = 0; f < MAX_FINGERS; f++) {
                    if (fingerDown[f] && now - fingerDownAt[f] > HOLD_TIMEOUT_MS) {
                        expired[f] = true;
                        anyExpired = true;
                    }
                }
                // v1.20.1（用户实测）：以前只标 expired、**从不释放** →
                //   · touch-status 永远显示"已按住 42 万毫秒"；
                //   · 8 个编号用完后 down 永远报「已超时自动抬起」，彻底没法再按；
                //   · 前台应用收不到 UP，游戏一直以为手指还按着（卡片一直选中、落子失败）。
                // 现在：超时即真正释放（releaseAllFingersUnlocked 会补 UP 手势），
                // 并让本请求按"没有按住的手指"继续处理。
                if (anyExpired) {
                    Log.w(TAG, "按住超时：真正释放残留手指（补 UP）");
                    releaseAllFingersUnlocked();
                    System.arraycopy(fingerDown, 0, virtualDown, 0, MAX_FINGERS);
                    for (int f = 0; f < MAX_FINGERS; f++) expired[f] = false;
                }
                String[] kinds = new String[n];
                int[] fings = new int[n];
                int[] xs = new int[n];
                int[] ys = new int[n];
                int[] x2s = new int[n];
                int[] y2s = new int[n];
                long[] starts = new long[n];
                long[] ends = new long[n];
                long[] holds = new long[n];   // swipe 的「按住阶段」（毫秒）
                // 真实按住且被本请求接管的手指 → 其首个 op 开始时刻（补「保持到 op 开始」的延续笔）
                long[] firstOpStart = new long[MAX_FINGERS];
                for (int f = 0; f < MAX_FINGERS; f++) firstOpStart[f] = -1;
                long t = 0;
                for (int i = 0; i < n; i++) {
                    JSONObject op = ops.getJSONObject(i);
                    String kind = op.optString("kind", "");
                    int finger = op.has("finger") ? op.optInt("finger", -1) : -1;
                    int x = resolveInt(op, "fx", "x", screenW, -1);
                    int y = resolveInt(op, "fy", "y", screenH, -1);
                    int x2 = resolveInt(op, "fx2", "x2", screenW, -1);
                    int y2 = resolveInt(op, "fy2", "y2", screenH, -1);
                    long dur = op.optLong("durationMs", -1);
                    long seg;
                    boolean held = finger >= 0 && finger < MAX_FINGERS && virtualDown[finger];
                    if ("wait".equals(kind)) {
                        seg = Math.max(0, op.optLong("ms", 0));
                    } else if ("down".equals(kind)) {
                        seg = 40;
                        if (finger < 0 || finger >= MAX_FINGERS) return jsonError("down 的 finger 越界（0~7）");
                        if (x < 0 || y < 0) return jsonError("down 需要 x/y 或 fx/fy");
                        if (expired[finger]) return jsonError("down 的手指 " + finger + " 已超时自动抬起，请重新 down");
                        if (held && firstOpStart[finger] < 0) firstOpStart[finger] = t;
                        virtualDown[finger] = true;
                    } else if ("move".equals(kind)) {
                        seg = dur >= 0 ? dur : 100;
                        if (finger < 0 || finger >= MAX_FINGERS) return jsonError("move 的 finger 越界（0~7）");
                        if (!held) return jsonError("move 的手指 " + finger + " 未按住（先 down）");
                        if (expired[finger]) return jsonError("move 的手指 " + finger + " 已超时自动抬起，请重新 down");
                        if (x < 0 || y < 0) return jsonError("move 需要 x/y 或 fx/fy");
                        if (firstOpStart[finger] < 0) firstOpStart[finger] = t;
                    } else if ("up".equals(kind)) {
                        seg = dur >= 0 ? dur : 100;
                        if (finger < 0 || finger >= MAX_FINGERS) return jsonError("up 的 finger 越界（0~7）");
                        // v1.20.1：up 是**幂等**操作 —— 本来就没按住就直接成功，
                        // 不要报错（一次失败的 up 会让调用方以为状态乱了）
                        if (!held) {
                            virtualDown[finger] = false;
                            continue;
                        }
                        if (firstOpStart[finger] < 0) firstOpStart[finger] = t;
                        virtualDown[finger] = false;
                    } else if ("tap".equals(kind)) {
                        seg = dur >= 0 ? dur : 60;
                        if (x < 0 || y < 0) return jsonError("tap 需要 x/y 或 fx/fy");
                        if (held) {
                            if (expired[finger]) return jsonError("tap 的手指 " + finger + " 已超时自动抬起，请重新 down");
                            if (firstOpStart[finger] < 0) firstOpStart[finger] = t;
                            virtualDown[finger] = false;
                        }
                    } else if ("swipe".equals(kind)) {
                        seg = dur >= 0 ? dur : 300;
                        // v1.19.3 P0：拖拽要先"按住"再动，否则第一个 MOVE 就带着整段距离的速度，
                        // 会被应用当成 fling/滚动（游戏里选朝向、画板画线全部失效）。默认 150ms。
                        // v1.20.5（实测定位）：以前默认 150ms，导致**每条 swipe 都被拆成两段**
                // （第一段是"原位按住 150ms"的笔、第二段才移动），而第二段没有真正生效 →
                // 现象就是"注入了、屏幕不动"。诊断日志实锤：500ms 的 swipe 只剩
                // {"start":0,"dur":150,"x0":360,"y0":1200,"x1":362,"y1":1200}。
                // 现在默认 0 = 单笔走完整条路径；需要"长按再拖"时显式传 holdBeforeMoveMs>0。
                holds[i] = Math.max(0, Math.min(2000, op.optLong("holdBeforeMoveMs", 0)));
                        if (x < 0 || y < 0 || x2 < 0 || y2 < 0) {
                            return jsonError("swipe 需要起点(x/y 或 fx/fy)和终点(x2/y2 或 fx2/fy2)");
                        }
                        if (held) {
                            if (expired[finger]) return jsonError("swipe 的手指 " + finger + " 已超时自动抬起，请重新 down");
                            if (firstOpStart[finger] < 0) firstOpStart[finger] = t;
                            virtualDown[finger] = false;
                        }
                    } else if ("hold".equals(kind)) {
                        seg = dur >= 0 ? dur : 500;
                        if (x < 0 || y < 0) return jsonError("hold 需要 x/y 或 fx/fy");
                        if (held) {
                            if (expired[finger]) return jsonError("hold 的手指 " + finger + " 已超时自动抬起，请重新 down");
                            if (firstOpStart[finger] < 0) firstOpStart[finger] = t;
                            virtualDown[finger] = false;
                        }
                    } else {
                        return jsonError("未知手势 kind: " + kind);
                    }
                    kinds[i] = kind;
                    fings[i] = finger;
                    xs[i] = x;
                    ys[i] = y;
                    x2s[i] = x2;
                    y2s[i] = y2;
                    starts[i] = t;
                    ends[i] = t + seg;
                    t += seg;
                }
                long totalT = t;
                if (totalT <= 0) {
                    // v1.20.2（实测）：幂等的 up（手指本来就没按住）不会产生任何笔 →
                    // 时间轴为空是**正常**结果，应返回成功，而不是报"手势时间轴为空"。
                    JSONObject noop = new JSONObject();
                    noop.put("ok", true);
                    noop.put("durationMs", 0);
                    noop.put("held", new JSONArray());
                    noop.put("noop", true);
                    return noop.toString();
                }
                if (totalT > MAX_GESTURE_TOTAL_MS) {
                    return jsonError("手势总时长超限（>" + (MAX_GESTURE_TOTAL_MS / 1000) + "s）；长按请用 down 保持，不要用长 wait");
                }

                // ===== 第二遍准备：生成笔（所有校验已通过，不会中途返回）=====
                GestureDescription.Builder gb = new GestureDescription.Builder();
                List<StrokeDesc> strokes = new ArrayList<StrokeDesc>();

                // 保持中的手指：
                //  - 未接管 → 全程延续笔（保持到手势结束）
                //  - 被接管 → 保持到其首个 op 开始（op 笔接同一指针，避免等待期被系统误抬起）
                //  - 已过期 → 原地抬起笔
                for (int f = 0; f < MAX_FINGERS; f++) {
                    if (!fingerDown[f]) continue;
                    if (expired[f]) {
                        Path p = new Path();
                        p.moveTo(fingerX[f], fingerY[f]);
                        strokes.add(new StrokeDesc(p, 0, 80, false));
                    } else if (firstOpStart[f] < 0) {
                        Path p = new Path();
                        p.moveTo(fingerX[f], fingerY[f]);
                        strokes.add(new StrokeDesc(p, 0, totalT, true));
                    } else if (firstOpStart[f] > 0) {
                        Path p = new Path();
                        p.moveTo(fingerX[f], fingerY[f]);
                        strokes.add(new StrokeDesc(p, 0, firstOpStart[f], true));
                    }
                    // firstOpStart==0：op 笔从 0 开始，无需保持笔
                }

                // 第二遍：逐 op 生成笔（cur 为手指当前坐标；所有校验已通过，不会中途返回）
                float[] curX = new float[MAX_FINGERS];
                float[] curY = new float[MAX_FINGERS];
                System.arraycopy(fingerX, 0, curX, 0, MAX_FINGERS);
                System.arraycopy(fingerY, 0, curY, 0, MAX_FINGERS);

                // v1.19.3 P0：单 op 的 swipe 若要求"按住阶段"，按住笔与移动段分两次 dispatch
                // （continuation 必须在独立 dispatch 里续上，否则系统会取消整条手势）。
                GestureDescription.StrokeDescription pendingHold = null;
                Path pendingMovePath = null;
                long pendingMoveMs = 0;

                for (int i = 0; i < n; i++) {
                    String kind = kinds[i];
                    int finger = fings[i];
                    int x = xs[i];
                    int y = ys[i];
                    int x2 = x2s[i];
                    int y2 = y2s[i];
                    long start = starts[i];
                    long end = ends[i];
                    long seg = end - start;
                    long holdMs = holds[i];
                    boolean held = finger >= 0 && finger < MAX_FINGERS && fingerDown[finger];

                    if ("wait".equals(kind)) {
                        // 无笔，仅占时间轴
                    } else if ("down".equals(kind)) {
                        if (held) {
                            // 已按住 → 视为滑到新位置并继续保持
                            Path path = new Path();
                            path.moveTo(curX[finger], curY[finger]);
                            path.lineTo(x, y);
                            strokes.add(new StrokeDesc(path, start, seg, true));
                        } else {
                            Path path = new Path();
                            path.moveTo(x, y);
                            strokes.add(new StrokeDesc(path, start, totalT - start, true));
                            fingerDownAt[finger] = now;
                        }
                        fingerDown[finger] = true;
                        fingerX[finger] = x;
                        fingerY[finger] = y;
                        curX[finger] = x;
                        curY[finger] = y;
                    } else if ("move".equals(kind)) {
                        Path path = new Path();
                        path.moveTo(curX[finger], curY[finger]);
                        path.lineTo(x, y);
                        strokes.add(new StrokeDesc(path, start, seg, true));
                        fingerX[finger] = x;
                        fingerY[finger] = y;
                        curX[finger] = x;
                        curY[finger] = y;
                    } else if ("up".equals(kind)) {
                        if (!held) {
                            // 幂等：本来就没按住 → 不产生任何笔（也不要发孤立的 UP）
                        } else {
                            Path path = new Path();
                            path.moveTo(curX[finger], curY[finger]);
                            if (x >= 0 && y >= 0) {
                                path.lineTo(x, y); // 先滑到目标位置再抬起
                                fingerX[finger] = x;
                                fingerY[finger] = y;
                            }
                            strokes.add(new StrokeDesc(path, start, seg, false));
                            fingerDown[finger] = false;
                        }
                    } else if ("tap".equals(kind)) {
                        if (held) {
                            // 已按住的手指 tap → 滑到目标并抬起
                            Path path = new Path();
                            path.moveTo(curX[finger], curY[finger]);
                            path.lineTo(x, y);
                            strokes.add(new StrokeDesc(path, start, seg, false));
                            fingerDown[finger] = false;
                            fingerX[finger] = x;
                            fingerY[finger] = y;
                        } else {
                            // 新手指点按（按下即抬起）
                            Path path = new Path();
                            path.moveTo(x, y);
                            strokes.add(new StrokeDesc(path, start, seg, false));
                        }
                    } else if ("swipe".equals(kind)) {
                        if (held) {
                            // 已按住的手指 swipe → 从当前位置滑到终点并抬起
                            Path path = new Path();
                            path.moveTo(curX[finger], curY[finger]);
                            path.lineTo(x2, y2);
                            strokes.add(new StrokeDesc(path, start, seg, false));
                            fingerDown[finger] = false;
                            fingerX[finger] = x2;
                            fingerY[finger] = y2;
                        } else if (holdMs > 0 && holdMs < seg && n == 1) {
                            // 按住阶段：单独一段 dispatch（willContinue 保持指针不抬起）。
                            Path holdPath = new Path();
                            holdPath.moveTo(x, y);
                            holdPath.lineTo(x + 2, y);
                            holdPath.lineTo(x, y);
                            StrokeDesc hs = new StrokeDesc(holdPath, start, holdMs, true);
                            strokes.add(hs);
                            // 移动段：>=20 个采样点，等第一段完成后再 continueStroke 续上
                            Path movePath = new Path();
                            movePath.moveTo(x, y);
                            int samples = Math.max(20, (int) ((seg - holdMs) / 16));
                            for (int s = 1; s <= samples; s++) {
                                float f = s / (float) samples;
                                movePath.lineTo(x + (x2 - x) * f, y + (y2 - y) * f);
                            }
                            pendingMovePath = movePath;
                            pendingMoveMs = seg - holdMs;
                            Log.i(TAG, "swipe hold=" + holdMs + "ms move=" + pendingMoveMs
                                    + "ms samples=" + samples + " -> (" + x2 + "," + y2 + ") [two-phase]");
                        } else if (holdMs > 0 && holdMs < seg) {
                            // 多笔手势里不拆段（continuation 必须独占一次 dispatch），退回单笔
                            Path path = new Path();
                            path.moveTo(x, y);
                            path.lineTo(x2, y2);
                            strokes.add(new StrokeDesc(path, start, seg, false));
                            Log.w(TAG, "multi-op gesture：按住阶段未生效（仅单 op 的 swipe 支持）");
                        } else {
                            Path path = new Path();
                            path.moveTo(x, y);
                            path.lineTo(x2, y2);
                            strokes.add(new StrokeDesc(path, start, seg, false));
                        }
                    } else if ("hold".equals(kind)) {
                        if (held) {
                            // 已按住的手指 hold → 滑到目标位置按住到结束再抬起
                            Path path = new Path();
                            path.moveTo(curX[finger], curY[finger]);
                            path.lineTo(x, y);
                            strokes.add(new StrokeDesc(path, start, seg, false));
                            fingerDown[finger] = false;
                            fingerX[finger] = x;
                            fingerY[finger] = y;
                        } else {
                            // 新手指：按下 → 保持 duration → 抬起
                            Path path = new Path();
                            path.moveTo(x, y);
                            strokes.add(new StrokeDesc(path, start, seg, false));
                        }
                    }
                }

                if (strokes.isEmpty()) return jsonError("手势没有可执行的笔");
                // 注：getMaxStrokeCount() 是 @hide API，public android.jar 没有；固定 8 指远低于设备上限（通常 ≥10）
                if (strokes.size() > MAX_FINGERS + 2) {
                    releaseAllFingersUnlocked();
                    return jsonError("笔画数超限（单次最多 " + (MAX_FINGERS + 2) + " 笔）");
                }
                GestureDescription.StrokeDescription prevStroke = null;
                for (StrokeDesc sd : strokes) {
                    GestureDescription.StrokeDescription ns;
                    if (pendingMovePath != null && sd.willContinue && sd.duration > 0) {
                        // 这是按住笔：记下它，移动段在下一段 dispatch 里续接
                    }
                    if (sd.continuation && prevStroke != null) {
                        // 延续笔：startTime 相对上一笔结束；不会产生中间的 UP
                        ns = prevStroke.continueStroke(sd.path, Math.max(0, sd.startTime),
                                Math.max(1, sd.duration), sd.willContinue);
                    } else {
                        ns = new GestureDescription.StrokeDescription(sd.path, Math.max(0, sd.startTime),
                                Math.max(1, sd.duration), sd.willContinue);
                    }
                    gb.addStroke(ns);
                    prevStroke = ns;
                }
                gestureBusyUntil = System.currentTimeMillis() + totalT + 3000;
                if (pendingMovePath != null) {
                    pendingHold = prevStroke;   // 按住笔 = 刚才最后一笔
                    if (pendingHold == null || !pendingHold.willContinue()) {
                        pendingMovePath = null;   // 拿不到可续接的笔 → 退回"无按住阶段"
                    }
                }
                final GestureDescription gesture = gb.build();
                // v1.20.4 诊断：把每笔的起止时间、时长、路径包围盒一起回给调用方，
                // 用来判定"注入了但无效"到底是坐标没进 path、还是时间轴/其它问题。
                final JSONArray strokeDiag = new JSONArray();
                try {
                    for (int si = 0; si < gesture.getStrokeCount(); si++) {
                        GestureDescription.StrokeDescription sdd = gesture.getStroke(si);
                        android.graphics.RectF rf = new android.graphics.RectF();
                        sdd.getPath().computeBounds(rf, true);
                        JSONObject dj = new JSONObject();
                        dj.put("start", sdd.getStartTime());
                        dj.put("dur", sdd.getDuration());
                        dj.put("x0", (int) rf.left);
                        dj.put("y0", (int) rf.top);
                        dj.put("x1", (int) rf.right);
                        dj.put("y1", (int) rf.bottom);
                        strokeDiag.put(dj);
                    }
                } catch (Throwable ignored) {}
                Log.i(TAG, "gesture diag: strokes=" + strokeDiag);
                // v1.20.3（实测）：本机出现过"onCompleted 正常回调但界面毫无变化"。
                // 注入被接受 ≠ 生效 —— 派发前后各取一次界面指纹，把结论回给调用方。
                final String fpBeforeGesture = treeFingerprint();

                // v1.20.4（实测）：单笔 tap 的手势描述与 gestureTap 完全一致（诊断已证实
                // start=0/dur=60/x0=x1/y0=y1），但只有 gestureTap 那条真正生效。
                // 单笔 tap 直接交给 gestureTap 派发 —— 既是验证，也是修复。
                boolean anyHeld = false;
                for (int f = 0; f < MAX_FINGERS; f++) if (fingerDown[f]) anyHeld = true;
                if (ops.length() == 1 && "tap".equals(kinds[0]) && !anyHeld) {
                    boolean tapOk = gestureTap(xs[0], ys[0]);
                    JSONObject ro = new JSONObject();
                    ro.put("ok", tapOk);
                    ro.put("durationMs", ends[0]);
                    ro.put("held", new JSONArray());
                    ro.put("singleTapVia", "gestureTap");
                    // v1.20.9：注入生效有 1~3 秒延迟 → 等界面稳定再判（不再固定 250ms）
                    boolean[] ch = new boolean[1];
                    long settleMs = waitForUiSettle(fpBeforeGesture, 2000L, ch);
                    ro.put("uiChanged", ch[0]);
                    ro.put("settleMs", settleMs);
                    if (!tapOk) ro.put("error", "触摸注入没有完成（被系统取消/超时/拒绝）");
                    return ro.toString();
                }

                final CountDownLatch latch = new CountDownLatch(1);
                final boolean[] success = {false};
                dispatchGesture(gesture, new GestureResultCallback() {
                    @Override
                    public void onCompleted(GestureDescription g) {
                        success[0] = true;
                        latch.countDown();
                    }

                    @Override
                    public void onCancelled(GestureDescription g) {
                        latch.countDown();
                    }
                }, null);
                boolean done = latch.await(totalT + 5000, TimeUnit.MILLISECONDS);
                if (!done) {
                    releaseAllFingersUnlocked();
                    return jsonError("手势执行超时，已复位所有手指");
                }
                if (!success[0]) {
                    releaseAllFingersUnlocked();
                    return jsonError("手势被系统取消（可能被新手势或手动触摸打断），已复位所有手指");
                }

                // 第二段：把按住笔续成移动段（指针仍按住，不会出现 UP）
                if (pendingHold != null && pendingMovePath != null) {
                    GestureDescription.StrokeDescription cont =
                            pendingHold.continueStroke(pendingMovePath, 0, Math.max(1, pendingMoveMs), false);
                    GestureDescription.Builder gb2 = new GestureDescription.Builder();
                    gb2.addStroke(cont);
                    final CountDownLatch latch2 = new CountDownLatch(1);
                    final boolean[] ok2 = {false};
                    dispatchGesture(gb2.build(), new GestureResultCallback() {
                        @Override
                        public void onCompleted(GestureDescription g) { ok2[0] = true; latch2.countDown(); }
                        @Override
                        public void onCancelled(GestureDescription g) { latch2.countDown(); }
                    }, null);
                    boolean done2 = latch2.await(pendingMoveMs + 5000, TimeUnit.MILLISECONDS);
                    if (!done2 || !ok2[0]) {
                        releaseAllFingersUnlocked();
                        return jsonError("拖拽的移动段被系统取消（按住 " + "笔已注入，移动段未完成）；"
                                + "可减小 durationMs 重试，或改用 android_touch 的 down/move 手动控制");
                    }
                    Log.i(TAG, "swipe move phase completed (" + pendingMoveMs + "ms)");
                }

                // 返回当前按住的手指
                JSONArray held = new JSONArray();
                for (int f = 0; f < MAX_FINGERS; f++) {
                    if (fingerDown[f]) {
                        JSONObject h = new JSONObject();
                        h.put("finger", f);
                        h.put("x", (int) fingerX[f]);
                        h.put("y", (int) fingerY[f]);
                        h.put("fx", fingerX[f] / screenW);
                        h.put("fy", fingerY[f] / screenH);
                        held.put(h);
                    }
                }
                JSONObject o = new JSONObject();
                o.put("ok", true);
                // v1.20.9：等界面稳定再判（注入生效有 1~3 秒延迟）
                boolean[] ch2 = new boolean[1];
                long settleMs = waitForUiSettle(fpBeforeGesture, 2000L, ch2);
                boolean uiChanged = ch2[0];
                o.put("durationMs", totalT);
                o.put("held", held);
                o.put("uiChanged", uiChanged);
                o.put("settleMs", settleMs);
                o.put("strokeCount", gesture.getStrokeCount());
                o.put("strokes", strokeDiag);
                if (!uiChanged) {
                    o.put("hint", "手势已注入完成（onCompleted 正常回调）。uiChanged=false 表示"
                            + "「没能从控件树确认界面变化」—— 控件树对游戏/自绘界面不敏感，"
                            + "不代表没生效。需要确认请用 android_see（截图对比）或 android_pixel 采样。");
                }
                return o.toString();
            } catch (Throwable t) {
                releaseAllFingersUnlocked();
                return jsonError("gesture error: " + t.getMessage());
            } finally {
                gestureBusyUntil = 0L;
            }
        }
    }

    /** /gesture：POST JSON 数组（或 {"strokes": [...]}），执行一组手势笔。 */
    private String handleGesture(String body) {
        try {
            if (body == null || body.trim().isEmpty()) return jsonError("gesture 需要 POST JSON body");
            String s = body.trim();
            JSONArray ops;
            if (s.startsWith("[")) {
                ops = new JSONArray(s);
            } else {
                JSONObject o = new JSONObject(s);
                ops = o.optJSONArray("strokes");
                if (ops == null) return jsonError("gesture body 需要是数组或 {\"strokes\":[...]}");
            }
            return executeGesture(ops);
        } catch (Throwable t) {
            return jsonError("gesture 参数解析失败: " + t.getMessage());
        }
    }

    /** /touch：action=down|move|up|release&finger=N&x/y 或 fx/fy（状态式单指操作）。 */
    private String handleTouch(String path) {
        try {
            String action = queryParam(path, "action");
            String fStr = queryParam(path, "finger");
            if (action.isEmpty()) return jsonError("touch 需要 action=down|move|up|reset");
            if ("reset".equals(action)) {
                // v1.20.1（用户实测）：一次清空**所有**手指（含超时残留），并给前台应用补发 UP。
                // 手指标号用完/卡住时的唯一自救入口。
                synchronized (gestureLock) {
                    releaseAllFingersUnlocked();
                }
                JSONObject o = new JSONObject();
                o.put("ok", true);
                o.put("reset", true);
                o.put("held", new JSONArray());
                return o.toString();
            }
            if (fStr.isEmpty()) return jsonError("touch 需要 finger=0~7");
            int finger = (int) parseDoubleSafe(fStr, -1);
            if (finger < 0 || finger >= MAX_FINGERS) return jsonError("finger 越界（0~7）");
            JSONObject op = new JSONObject();
            op.put("kind", "release".equals(action) ? "up" : action);
            op.put("finger", finger);
            if (!"up".equals(action) && !"release".equals(action)) {
                int x = coordFromParams(path, "x", "fx", screenW == 0 ? screenSize()[0] : screenW);
                int y = coordFromParams(path, "y", "fy", screenH == 0 ? screenSize()[1] : screenH);
                if (x < 0 || y < 0) return jsonError("touch 需要 x/y 或 fx/fy");
                op.put("x", x);
                op.put("y", y);
            }
            JSONArray ops = new JSONArray();
            ops.put(op);
            return executeGesture(ops);
        } catch (Throwable t) {
            return jsonError("touch error: " + t.getMessage());
        }
    }

    /** /touch-release：抬起全部按住的手指。 */
    private String handleTouchRelease() {
        synchronized (gestureLock) {
            try {
                releaseAllFingersUnlocked();
                JSONObject o = new JSONObject();
                o.put("ok", true);
                o.put("held", new JSONArray());
                return o.toString();
            } catch (Throwable t) {
                return jsonError("touch-release error: " + t.getMessage());
            }
        }
    }

    /** /touch-status：查询当前按住的手指。 */
    private String handleTouchStatus() {
        // v1.20.8（实测）：超时释放以前只在"下一个手势请求"里发生，status 会一直显示
        // "已按住 37794ms"。这里也做一次，并真的给前台应用补一个 UP。
        try {
            synchronized (gestureLock) {
                long nowMs = System.currentTimeMillis();
                boolean stale = false;
                for (int f = 0; f < MAX_FINGERS; f++) {
                    if (fingerDown[f] && nowMs - fingerDownAt[f] > HOLD_TIMEOUT_MS) stale = true;
                }
                if (stale) {
                    Log.w(TAG, "touch-status: 清理超时手指（补 UP）");
                    releaseAllFingersUnlocked();
                }
            }
        } catch (Throwable ignored) {}
        try {
            int[] size = screenSize();
            JSONObject o = new JSONObject();
            o.put("ok", true);
            o.put("screenW", size[0]);
            o.put("screenH", size[1]);
            o.put("maxFingers", MAX_FINGERS);
            o.put("holdTimeoutMs", HOLD_TIMEOUT_MS);
            JSONArray held = new JSONArray();
            long now = System.currentTimeMillis();
            for (int f = 0; f < MAX_FINGERS; f++) {
                if (fingerDown[f]) {
                    JSONObject h = new JSONObject();
                    h.put("finger", f);
                    h.put("x", (int) fingerX[f]);
                    h.put("y", (int) fingerY[f]);
                    h.put("fx", screenW > 0 ? fingerX[f] / screenW : 0);
                    h.put("fy", screenH > 0 ? fingerY[f] / screenH : 0);
                    h.put("elapsedMs", now - fingerDownAt[f]);
                    held.put(h);
                }
            }
            o.put("held", held);
            return o.toString();
        } catch (Throwable t) {
            return jsonError("touch-status error: " + t.getMessage());
        }
    }

    /** /swipe：x1/y1→x2/y2（或 fx1/fy1→fx2/fy2），duration 毫秒。 */
    private String handleSwipe(String path) {
        try {
            int[] size = screenSize();
            if (screenW == 0) {
                screenW = size[0];
                screenH = size[1];
            }
            int x1 = coordFromParams(path, "x1", "fx1", screenW);
            int y1 = coordFromParams(path, "y1", "fy1", screenH);
            int x2 = coordFromParams(path, "x2", "fx2", screenW);
            int y2 = coordFromParams(path, "y2", "fy2", screenH);
            if (x1 < 0 || y1 < 0 || x2 < 0 || y2 < 0) {
                return jsonError("swipe 需要起点(x1/y1 或 fx1/fy1)和终点(x2/y2 或 fx2/fy2)");
            }
            long dur = (long) parseDoubleSafe(queryParam(path, "duration"), 300);
            JSONObject op = new JSONObject();
            op.put("kind", "swipe");
            op.put("x", x1);
            op.put("y", y1);
            op.put("x2", x2);
            op.put("y2", y2);
            op.put("durationMs", dur);
            if (!queryParam(path, "finger").isEmpty()) {
                op.put("finger", (int) parseDoubleSafe(queryParam(path, "finger"), 0));
            }
            JSONArray ops = new JSONArray();
            ops.put(op);
            return executeGesture(ops);
        } catch (Throwable t) {
            return jsonError("swipe error: " + t.getMessage());
        }
    }

    /** /hold：x/y（或 fx/fy）按住 duration 毫秒后自动抬起。 */
    private String handleHold(String path) {
        try {
            int[] size = screenSize();
            if (screenW == 0) {
                screenW = size[0];
                screenH = size[1];
            }
            int x = coordFromParams(path, "x", "fx", screenW);
            int y = coordFromParams(path, "y", "fy", screenH);
            if (x < 0 || y < 0) return jsonError("hold 需要 x/y 或 fx/fy");
            long dur = (long) parseDoubleSafe(queryParam(path, "duration"), 500);
            JSONObject op = new JSONObject();
            op.put("kind", "hold");
            op.put("x", x);
            op.put("y", y);
            op.put("durationMs", dur);
            if (!queryParam(path, "finger").isEmpty()) {
                op.put("finger", (int) parseDoubleSafe(queryParam(path, "finger"), 0));
            }
            JSONArray ops = new JSONArray();
            ops.put(op);
            return executeGesture(ops);
        } catch (Throwable t) {
            return jsonError("hold error: " + t.getMessage());
        }
    }

    // ===================== 原有路由（保留 + 增强） =====================

    private String handleStatus() {
        try {
            JSONObject o = new JSONObject();
            o.put("ok", true);
            o.put("running", isRunning);
            o.put("package", activePackage);
            AccessibilityNodeInfo root = getRootInActiveWindow();
            o.put("nodeCount", root == null ? 0 : countNodes(root));
            o.put("apiLevel", Build.VERSION.SDK_INT);
            o.put("canScreenshot", Build.VERSION.SDK_INT >= 30);
            // v1.22（P0-3）：生命周期时间线 —— 让调用方能区分"用户没开"与"刚被系统杀了/闪断"
            long now = System.currentTimeMillis();
            o.put("connectCount", connectCount);
            o.put("connectedAt", lastConnectedAt);
            o.put("unboundAt", lastUnbindAt);
            o.put("unbindReason", lastUnbindReason);
            o.put("connectedAgoMs", lastConnectedAt > 0 ? (now - lastConnectedAt) : -1);
            o.put("unboundAgoMs", lastUnbindAt > 0 ? (now - lastUnbindAt) : -1);
            o.put("everConnected", connectCount > 0);
            // 刚重连（<60s）视为"闪断恢复"信号：真机复盘里它是后续大面积失败的先兆
            o.put("reconnectedRecently", lastConnectedAt > 0 && (now - lastConnectedAt) < 60000);
            return o.toString();
        } catch (Throwable t) {
            return jsonError("status error: " + t.getMessage());
        }
    }

    /**
     * v1.22（P1）：触发输入法的「前往 / 发送」（EditorAction）。
     * 专治复盘 §4：「点输入法的『确定』只是收起键盘，不导航」。
     * 手段：在**聚焦的输入节点**上执行 ACTION_IME_ENTER（API 30+，常量编译期内联，安全性 OK）。
     * 找不到聚焦节点时回退到遍历第一个可编辑且可聚焦的节点；都没有则如实报错。
     * 说明：本接口只负责"发提交"，**不负责确认提交生效** —— 由 android_focus_type 再读一次界面自证。
     */
    private String handleImeEnter() {
        try {
            if (Build.VERSION.SDK_INT < 30) {
                return jsonError("ACTION_IME_ENTER 需要 Android 11+（当前 API " + Build.VERSION.SDK_INT
                        + "）；可退化为点击页面上的提交按钮，或改用 android_input(keyevent) 发回车（需特权）");
            }
            AccessibilityNodeInfo target = null;
            AccessibilityNodeInfo root = getRootInActiveWindow();
            if (root != null) {
                target = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
                if (target == null) {
                    final AccessibilityNodeInfo[] found = {null};
                    walk(root, new NodeVisitor() {
                        @Override
                        public void visit(AccessibilityNodeInfo node, int depth) {
                            if (found[0] == null && node.isEditable() && node.isFocused()) found[0] = node;
                        }
                    }, 0);
                    target = found[0];
                }
            }
            if (target == null) {
                return jsonError("找不到聚焦的输入节点：请先点击输入框（android_tap / android_focus_type 会先做这一步）");
            }
            // v1.22：API 30 的 ACTION_IME_ENTER 只有 AccessibilityAction 对象、没有等价的 int 常量，
            // 而且本项目编译用的 android.jar 里也取不到它 → 改用反射拿 id（编译期无依赖，运行期按 API 判断）。
            int imeEnterId = imeEnterActionId();
            if (imeEnterId <= 0) {
                return jsonError("本机 API " + Build.VERSION.SDK_INT
                        + " 不支持 ACTION_IME_ENTER（需要 Android 11+）；可退化为点击页面上的「前往/搜索/发送」按钮");
            }
            boolean ok = target.performAction(imeEnterId);
            JSONObject o = new JSONObject();
            o.put("ok", ok);
            o.put("method", "ACTION_IME_ENTER");
            if (!ok) {
                // 回退：点界面上那个「前往/搜索/发送」按钮（IME 动作按钮在无障碍树里就是个普通可点击节点）
                AccessibilityNodeInfo btn = findImeActionButton();
                if (btn != null) {
                    boolean clicked = btn.performAction(AccessibilityNodeInfo.ACTION_CLICK);
                    btn.recycle();
                    o.put("ok", clicked);
                    o.put("method", clicked ? "ime-action-button" : "none");
                    if (!clicked) o.put("error", "ACTION_IME_ENTER 被拒绝，且点击「前往/发送」按钮也失败");
                } else {
                    o.put("error", "ACTION_IME_ENTER 被拒绝（该输入框可能不支持 EditorAction，也没找到「前往/搜索/发送」按钮）");
                }
            }
            return o.toString();
        } catch (Throwable t) {
            return jsonError("ime-enter error: " + t.getMessage());
        }
    }

    /** API 30+ 才有 ACTION_IME_ENTER；反射取 id（取不到返回 -1）。 */
    private int imeEnterActionId() {
        if (Build.VERSION.SDK_INT < 30) return -1;
        try {
            java.lang.reflect.Field f = AccessibilityNodeInfo.AccessibilityAction.class
                    .getField("ACTION_IME_ENTER");
            Object action = f.get(null);
            if (action == null) return -1;
            Object id = action.getClass().getMethod("getId").invoke(action);
            return id instanceof Integer ? ((Integer) id).intValue() : -1;
        } catch (Throwable t) {
            Log.w(TAG, "imeEnterActionId failed", t);
            return -1;
        }
    }

    /** 兜底：在活动窗口里找「前往 / 搜索 / 发送 / Go」这类 IME 动作按钮。 */
    private AccessibilityNodeInfo findImeActionButton() {
        final String[] labels = {"前往", "搜索", "发送", "完成", "转到", "Go", "Search", "Send", "Done", "Enter"};
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return null;
        final AccessibilityNodeInfo[] hit = {null};
        walk(root, new NodeVisitor() {
            @Override
            public void visit(AccessibilityNodeInfo node, int depth) {
                if (hit[0] != null || node == null) return;
                if (!node.isClickable()) return;
                CharSequence t = node.getText();
                CharSequence d = node.getContentDescription();
                String s = (t != null ? t.toString() : "") + " " + (d != null ? d.toString() : "");
                for (String lab : labels) {
                    if (s.contains(lab)) { hit[0] = node; return; }
                }
            }
        }, 0);
        return hit[0];
    }

    private int countNodes(AccessibilityNodeInfo root) {
        final int[] count = {0};
        walk(root, new NodeVisitor() {
            @Override
            public void visit(AccessibilityNodeInfo node, int depth) {
                count[0]++;
            }
        }, 0);
        return count[0];
    }

    private interface NodeVisitor {
        void visit(AccessibilityNodeInfo node, int depth);
    }

    private void walk(AccessibilityNodeInfo node, NodeVisitor visitor, int depth) {
        if (node == null || depth > MAX_DEPTH) return;
        visitor.visit(node, depth);
        for (int i = 0; i < node.getChildCount(); i++) {
            try {
                AccessibilityNodeInfo child = node.getChild(i);
                if (child != null) {
                    walk(child, visitor, depth + 1);
                    child.recycle();
                }
            } catch (Throwable ignored) {
            }
        }
    }

    /** 读取屏幕节点树，转 JSON（过滤：只保留有文本/描述/可点击/可输入/可滚动节点）。 */
    private String handleDump() {
        try {
            final AccessibilityNodeInfo root = getRootInActiveWindow();
            JSONObject o = new JSONObject();
            o.put("ok", true);
            if (root == null) {
                o.put("package", activePackage);
                o.put("count", 0);
                o.put("truncated", false);
                o.put("nodes", new JSONArray());
                o.put("note", "当前没有可读取的活动窗口（可能处于锁屏或安全页面）");
                return o.toString();
            }
            final JSONArray nodes = new JSONArray();
            final int[] emitted = {0};
            final boolean[] truncated = {false};
            walk(root, new NodeVisitor() {
                @Override
                public void visit(AccessibilityNodeInfo node, int depth) {
                    if (emitted[0] >= MAX_NODES) {
                        truncated[0] = true;
                        return;
                    }
                    if (node == null) return;
                    try {
                        CharSequence textCs = node.getText();
                        CharSequence descCs = node.getContentDescription();
                        String text = textCs == null ? "" : textCs.toString().trim();
                        String desc = descCs == null ? "" : descCs.toString().trim();
                        boolean clickable = node.isClickable();
                        boolean input = node.isEditable() || "android.widget.EditText".equals(node.getClassName() != null ? node.getClassName().toString() : "");
                        boolean scrollable = node.isScrollable();
                        if (text.isEmpty() && desc.isEmpty() && !clickable && !input && !scrollable) return;
                        Rect bounds = new Rect();
                        node.getBoundsInScreen(bounds);
                        if (bounds.width() <= 0 || bounds.height() <= 0) return;
                        if (text.length() > MAX_TEXT_LEN) text = text.substring(0, MAX_TEXT_LEN) + "…";
                        if (desc.length() > MAX_TEXT_LEN) desc = desc.substring(0, MAX_TEXT_LEN) + "…";
                        JSONObject n = new JSONObject();
                        n.put("text", text);
                        n.put("desc", desc);
                        n.put("cls", node.getClassName() == null ? "" : node.getClassName().toString());
                        n.put("x", bounds.left);
                        n.put("y", bounds.top);
                        n.put("w", bounds.width());
                        n.put("h", bounds.height());
                        n.put("clickable", clickable);
                        n.put("input", input);
                        n.put("checked", node.isChecked());
                        n.put("selected", node.isSelected());
                        n.put("scrollable", scrollable);
                        n.put("depth", depth);
                        nodes.put(n);
                        emitted[0]++;
                    } catch (Throwable ignored) {
                    }
                }
            }, 0);
            o.put("package", root.getPackageName() == null ? "" : root.getPackageName().toString());
            o.put("count", emitted[0]);
            o.put("truncated", truncated[0]);
            o.put("nodes", nodes);
            // v1.7.3：无节点界面（Unity 游戏/自绘 UI）引导 AI 改用截图 + 分数坐标
            if (emitted[0] == 0) {
                o.put("hint", "当前界面没有可读控件（常见于 Unity/游戏/自绘界面）。请改用 android_see 截屏看图，" +
                        "并优先用分数坐标（fx/fy，0~1）点击/滑动——截图会被模型查看器缩放，绝对像素坐标会点偏。");
            }
            return o.toString();
        } catch (Throwable t) {
            return jsonError("dump error: " + t.getMessage());
        }
    }

    /** 从节点向上找最近的可点击祖先（含自身）；找不到返回 null。
     *  v1.13：按钮内部常常是若干不可点击的子 TextView，直接拿最深节点做 ACTION_CLICK 会失败，
     *  退化成投递手势——而手势会被悬浮窗（远程控制/小窗等）吃掉。向上找可点击祖先即可绕过。 */
    private AccessibilityNodeInfo closestClickable(AccessibilityNodeInfo node) {
        Rect nb = new Rect();
        try { node.getBoundsInScreen(nb); } catch (Throwable t) { return null; }
        long nArea = (long) Math.max(1, nb.width()) * Math.max(1, nb.height());
        AccessibilityNodeInfo cur = node;
        for (int i = 0; i < 12 && cur != null; i++) {
            try {
                if (cur.isClickable() && cur.isEnabled()) {
                    if (i == 0) return cur;
                    // 面积护栏：祖先比自己大太多（WebView / 整页容器）时不能当目标，否则 ACTION_CLICK
                    // 会打在该容器中心（点错位置）；这种情况宁可返回 null 走手势。
                    Rect cb = new Rect();
                    cur.getBoundsInScreen(cb);
                    long cArea = (long) Math.max(1, cb.width()) * Math.max(1, cb.height());
                    if (cArea <= nArea * 6) return cur;
                    return null;
                }
                cur = cur.getParent();
            } catch (Throwable t) {
                return null;
            }
        }
        return null;
    }

    /**
     * 等界面稳定（v1.20.9，agent 实测）：注入类手势"生效"有 1~3 秒延迟，
     * 刚注入就取指纹/截图会看到旧画面，表现得像"报了成功但没生效"。
     * 这里轮询控件树指纹：观察到变化后连续两次相同即认为稳定；返回实际等待毫秒数。
     */
    private long waitForUiSettle(String beforeFp, long maxMs, boolean[] changedOut) {
        long start = System.currentTimeMillis();
        String prev = treeFingerprint();
        boolean changed = !beforeFp.equals(prev);
        int same = 0;
        while (System.currentTimeMillis() - start < maxMs) {
            try {
                Thread.sleep(150L);
            } catch (InterruptedException ignored) {
                break;
            }
            String cur = treeFingerprint();
            if (!cur.equals(beforeFp)) changed = true;
            if (cur.equals(prev)) {
                if (++same >= 2) break;
            } else {
                same = 0;
                prev = cur;
            }
        }
        if (changedOut != null && changedOut.length > 0) changedOut[0] = changed;
        return System.currentTimeMillis() - start;
    }

    private AccessibilityNodeInfo findNodeByText(String needle) {
        if (needle == null || needle.isEmpty()) return null;
        final String target = needle.trim().toLowerCase();
        final AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return null;
        final AccessibilityNodeInfo[] best = {null};
        final int[] bestRank = {-1};   // 4=精确且可点击 3=包含且可点击 2=精确 1=包含
        walk(root, new NodeVisitor() {
            @Override
            public void visit(AccessibilityNodeInfo node, int depth) {
                if (node == null || bestRank[0] == 4) return;
                CharSequence textCs = node.getText();
                CharSequence descCs = node.getContentDescription();
                String text = textCs == null ? "" : textCs.toString().trim().toLowerCase();
                String desc = descCs == null ? "" : descCs.toString().trim().toLowerCase();
                // v1.20.9（实测）：这里是"整棵树包含匹配"，会命中我们自己会话记录里的
                // tool-call 回显（例如历史上把 expect_text 的原样字符串留在聊天里）——
                // 于是"点到了那条回显"而不是真实控件。回显类文字一律不当点击目标。
                String rawText = textCs == null ? "" : textCs.toString();
                String rawDesc = descCs == null ? "" : descCs.toString();
                if (looksLikeToolEcho(rawText) || looksLikeToolEcho(rawDesc)) return;
                boolean exact = text.equals(target) || desc.equals(target);
                boolean partial = !exact && ((!text.isEmpty() && text.contains(target))
                        || (!desc.isEmpty() && desc.contains(target)));
                if (!exact && !partial) return;
                AccessibilityNodeInfo clickable = closestClickable(node);
                int rank = exact ? (clickable != null ? 4 : 2) : (clickable != null ? 3 : 1);
                if (clickable != null) {
                    if (rank > bestRank[0]) { bestRank[0] = rank; best[0] = clickable; }
                } else if (best[0] == null && rank > bestRank[0]) {
                    bestRank[0] = rank;
                    best[0] = node;
                }
            }
        }, 0);
        return best[0];
    }

    /** select 取景的匹配结果：命中的节点 + 一共几个候选（让模型一步看清"截到的是谁"）。 */
    private static final class SelectMatch {
        AccessibilityNodeInfo node;
        int count;
        String label;
    }

    /**
     * v1.19（A6 修正）：**区域截图专用**的节点匹配。
     * 与 {@link #findNodeByText} 的区别：那个是给"点击"用的（优先可点击祖先/后代），
     * 实测会把 select="日志" 匹配到按钮「查看日志」而不是标题「日志」（跑真机对话时踩到）。
     * 这里按**文字本身**排序：完全相等 &gt; 更短的包含 &gt; 更长的包含，并支持取第 N 个候选。
     */
    private SelectMatch selectNodeForShot(String needle, int index) {
        if (needle == null || needle.isEmpty()) return null;
        final String target = needle.trim().toLowerCase();
        final AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return null;
        final java.util.ArrayList<Object[]> hits = new java.util.ArrayList<Object[]>();
        walk(root, new NodeVisitor() {
            @Override
            public void visit(AccessibilityNodeInfo node, int depth) {
                if (node == null) return;
                String text = node.getText() == null ? "" : node.getText().toString().trim();
                String desc = node.getContentDescription() == null ? "" : node.getContentDescription().toString().trim();
                String lt = text.toLowerCase(), ld = desc.toLowerCase();
                boolean exact = lt.equals(target) || ld.equals(target);
                boolean partial = !exact && ((!lt.isEmpty() && lt.contains(target)) || (!ld.isEmpty() && ld.contains(target)));
                if (!exact && !partial) return;
                String label = !text.isEmpty() ? text : desc;
                hits.add(new Object[]{node, Integer.valueOf(exact ? 0 : 1), Integer.valueOf(label.length()), label});
            }
        }, 0);
        if (hits.isEmpty()) return null;
        java.util.Collections.sort(hits, new java.util.Comparator<Object[]>() {
            @Override
            public int compare(Object[] a, Object[] b) {
                int r = ((Integer) a[1]).compareTo((Integer) b[1]);
                if (r != 0) return r;
                return ((Integer) a[2]).compareTo((Integer) b[2]);   // 更短的更具体（标题 vs 长段落）
            }
        });
        int idx = Math.max(0, Math.min(index, hits.size() - 1));
        SelectMatch m = new SelectMatch();
        m.node = (AccessibilityNodeInfo) hits.get(idx)[0];
        m.label = (String) hits.get(idx)[3];
        m.count = hits.size();
        return m;
    }

    /** 包含该坐标的**最深可点击节点**（无则退回最深节点）。 */
    private AccessibilityNodeInfo findNodeByPoint(final int x, final int y) {
        final AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return null;
        final AccessibilityNodeInfo[] best = {null};
        final int[] bestDepth = {-1};
        walk(root, new NodeVisitor() {
            @Override
            public void visit(AccessibilityNodeInfo node, int depth) {
                if (node == null) return;
                Rect bounds = new Rect();
                try { node.getBoundsInScreen(bounds); } catch (Throwable t) { return; }
                if (!bounds.contains(x, y)) return;
                AccessibilityNodeInfo clickable = closestClickable(node);
                if (clickable == null) {
                    if (best[0] == null && depth > bestDepth[0]) { bestDepth[0] = depth; best[0] = node; }
                    return;
                }
                if (depth >= bestDepth[0]) { bestDepth[0] = depth; best[0] = clickable; }
            }
        }, 0);
        return best[0];
    }

    /** /tap：text/desc 按文本查找点击；x/y 或 fx/fy 按坐标点击（优先节点 ACTION_CLICK，失败手势）。 */
    private String handleTap(String path) {
        try {
            // v1.21.0：点之前先留一个界面指纹基线，点完后拿它判断"界面是否真的变了"
            String fpStart = treeFingerprint();
            String text = queryParam(path, "text");
            String desc = queryParam(path, "desc");
            String xStr = queryParam(path, "x");
            String yStr = queryParam(path, "y");
            int[] size = screenSize();
            if (screenW == 0) {
                screenW = size[0];
                screenH = size[1];
            }
            int tapX = coordFromParams(path, "x", "fx", screenW);
            int tapY = coordFromParams(path, "y", "fy", screenH);
            JSONObject o = new JSONObject();
            o.put("ok", true);

            AccessibilityNodeInfo target = null;
            String method = "";
            if (!text.isEmpty() || !desc.isEmpty()) {
                target = findNodeByText(!text.isEmpty() ? text : desc);
                method = "node-text";
            } else if (tapX >= 0 && tapY >= 0) {
                target = findNodeByPoint(tapX, tapY);
                method = "node-coord";
            } else {
                return jsonError("tap 需要 text/desc 或 x/y（或 fx/fy）参数");
            }

            // v1.20.2（用户实测）：ACTION_CLICK 在 WebView 里**返回 true 但界面没反应**（假成功）。
            // 所以：命中不可点击的"文案节点"要向上找可点击父行；点完要用界面指纹校验；
            // 校验不通过就自动回退到手势注入；最后按 expect_text 轮询给 verified。
            final String expect = queryParam(path, "expect_text");
            final long expectMs = (long) parseDoubleSafe(queryParam(path, "expect_timeout_ms"), 4000);
            java.util.HashSet<String> textsBefore = textSet();
            AccessibilityNodeInfo clickable = clickableAncestor(target);
            boolean clicked = false;
            int nodeCx = -1, nodeCy = -1;
            if (clickable != null) {
                android.graphics.Rect bnd = new android.graphics.Rect();
                clickable.getBoundsInScreen(bnd);
                nodeCx = bnd.centerX();
                nodeCy = bnd.centerY();
                String before = treeFingerprint();
                clicked = clickable.performAction(AccessibilityNodeInfo.ACTION_CLICK);
                String after = treeFingerprint();
                boolean changed = clicked && before != null && !before.isEmpty() && !before.equals(after);
                o.put("nodeClickAccepted", clicked);
                o.put("nodeClickChangedUi", changed);
                if (clicked && !changed) {
                    // 节点点击被忽略（典型：WebView）→ 用节点中心做手势注入
                    int gx = nodeCx;
                    int gy = nodeCy;
                    if (gx < 0 || gy < 0) { gx = tapX; gy = tapY; }
                    if (gx >= 0 && gy >= 0 && gestureTap(gx, gy)) {
                        clicked = true;
                        method = "gesture-fallback";
                        o.put("method", method);
                    }
                } else if (changed) {
                    o.put("method", method);
                }
            }
            if (clickable == null && target != null) {
                o.put("nodeClickableAncestor", false);
            }
            if (target != null) target.recycle();
            if (!clicked) {
                if (tapX >= 0 && tapY >= 0) {
                    boolean gestureOk = gestureTap(tapX, tapY);
                    o.put("found", gestureOk);
                    o.put("method", gestureOk ? "gesture" : "none");
                    o.put("verified", false);
                    if (!gestureOk) {
                        // v1.20.4：注入没执行完就如实失败，别再说"操作成功"
                        o.put("ok", false);
                        o.put("error", "触摸注入没有完成（dispatchGesture 被取消/超时/拒绝）——"
                                + "前台应用在繁忙时可能吞掉注入的触摸");
                        o.put("hint", "等几秒重试；或先 android_screen 确认界面还响应；"
                                + "内存紧张（<400MB）时更容易失败，可先关掉其它 App。");
                    }
                    if (expect.isEmpty() || !gestureOk) return o.toString();
                } else {
                    o.put("found", false);
                    o.put("method", "none");
                    o.put("verified", false);
                    if (expect.isEmpty()) return o.toString();
                }
            } else {
                o.put("found", true);
                if (clickable != null) o.put("method", method.isEmpty() ? "node" : method);
                if (expect.isEmpty()) o.put("verified", true);
            }
            if (!expect.isEmpty()) {
                boolean hit = pollForNewText(textsBefore, expect, expectMs);
                o.put("verified", hit);
                o.put("verifiedBy", "expect_text");
                if (!hit) {
                    o.put("ok", false);
                    o.put("error", "点击后 " + expectMs + "ms 内没等到文字「" + expect + "」——这次点击可能没生效");
                    o.put("hint", "WebView/自绘界面建议改用 android_gesture（tap 笔）或核对 fx/fy；"
                            + "也可以先 android_see 截图确认当前画面。");
                }
            }
            // v1.21.0（agent 实测）：注入/点击"生效"有 1~3 秒延迟，而且以前只有 /gesture
            // 会回"界面是否变化" —— /tap 这条路漏了，工具输出只剩"操作成功。"。
            // 这里同样轮询控件树等稳定，把结论回给调用方。
            try {
                boolean[] chTap = new boolean[1];
                long confirmMs = waitForUiSettle(fpStart, 2000L, chTap);
                o.put("uiChanged", chTap[0]);
                o.put("settleMs", confirmMs);
                o.put("confirmMs", confirmMs);
            } catch (Throwable ignored) {}
            return o.toString();
        } catch (Throwable t) {
            return jsonError("tap error: " + t.getMessage());
        }
    }

    private boolean gestureTap(final int x, final int y) {
        if (Build.VERSION.SDK_INT < 24) return false;
        try {
            Path path = new Path();
            path.moveTo(x, y);
            GestureDescription.StrokeDescription stroke =
                    new GestureDescription.StrokeDescription(path, 0, 60);
            GestureDescription gesture = new GestureDescription.Builder()
                    .addStroke(stroke)
                    .build();
            // v1.20.4（用户实测）：以前是 `return dispatchGesture(gesture, null, null)` ——
            // 那只是"注入被系统接受"，**不是执行完成**；回调都没接，所以永远报成功。
            // 实测：App 繁忙（内存紧张、节点很多）时 WebView 会静默吞掉触摸，界面一动不动。
            // 现在等回调：onCompleted 才算成功；onCancelled / 超时 / 被拒绝都算失败。
            final java.util.concurrent.CountDownLatch latch = new java.util.concurrent.CountDownLatch(1);
            final boolean[] completed = {false};
            boolean accepted = dispatchGesture(gesture, new GestureResultCallback() {
                @Override
                public void onCompleted(GestureDescription g) {
                    completed[0] = true;
                    latch.countDown();
                }

                @Override
                public void onCancelled(GestureDescription g) {
                    latch.countDown();
                }
            }, null);
            if (!accepted) {
                Log.w(TAG, "gestureTap: 注入被系统拒绝（dispatchGesture=false）");
                return false;
            }
            boolean finished = latch.await(2500, TimeUnit.MILLISECONDS);
            if (!finished) {
                Log.w(TAG, "gestureTap: 等待回调超时（触摸可能被前台应用吞掉）");
                return false;
            }
            if (!completed[0]) {
                Log.w(TAG, "gestureTap: 手势被系统取消（onCancelled）");
                return false;
            }
            return true;
        } catch (Throwable t) {
            Log.w(TAG, "gesture tap failed", t);
            return false;
        }
    }

    /** /input：text= 输入到当前聚焦输入框。mode=set（默认，ACTION_SET_TEXT）或 mode=paste（剪贴板粘贴，
     * 适合 WebView/contenteditable 输入框——setText 只改无障碍节点、不触发前端 input 事件，界面不刷新）。 */
    private String handleInput(String path) {
        try {
            String text = queryParam(path, "text");
            String mode = queryParam(path, "mode");
            boolean paste = "paste".equals(mode);
            JSONObject o = new JSONObject();
            o.put("ok", true);
            AccessibilityNodeInfo target = null;
            AccessibilityNodeInfo root = getRootInActiveWindow();
            // v1.18（A3）：失败时把"是什么情况"与"下一步做什么"分开报（error + hint），
            // 不再只丢一句"未找到可输入的文本框"让模型（和用户）自己猜。
            if (root == null) {
                o.put("ok", false);
                o.put("error", "当前没有活动窗口（无障碍拿不到窗口根节点）");
                o.put("hint", "可能处于锁屏/桌面/动画过渡：先用 android_see 截图确认当前画面，回到目标界面后重试；"
                        + "或先用 android_tap 点击一次目标输入框再输入。");
                return o.toString();
            }
            target = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
            if (target == null) {
                final AccessibilityNodeInfo[] editable = {null};
                walk(root, new NodeVisitor() {
                    @Override
                    public void visit(AccessibilityNodeInfo node, int depth) {
                        if (editable[0] != null) return;
                        if (node != null && (node.isEditable() || node.isFocusable())) editable[0] = node;
                    }
                }, 0);
                target = editable[0];
            }
            if (target == null) {
                o.put("ok", false);
                o.put("error", "当前窗口里没有可编辑/可聚焦的输入框节点");
                o.put("hint", "先用 android_tap 点击目标输入框使其聚焦（并确认软键盘弹出），再调用本工具；"
                        + "中文/WebView 输入框建议改用 android_paste_text（剪贴板粘贴路径）。");
                return o.toString();
            }
            final String fpBefore = treeFingerprint();
            boolean wasFocused = target.isFocused();
            boolean focusIssued = false;
            if (!wasFocused) {
                focusIssued = target.performAction(AccessibilityNodeInfo.ACTION_FOCUS);
            }
            final boolean focusedNow = target.isFocused();
            boolean ok;
            if (paste) {
                // WebView/contenteditable：setText 不触发前端 input 事件 → 用剪贴板粘贴
                android.content.ClipboardManager cm =
                        (android.content.ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                cm.setPrimaryClip(android.content.ClipData.newPlainText("dsh-input", text));
                ok = target.performAction(AccessibilityNodeInfo.ACTION_PASTE);
                o.put("method", "paste");
            } else {
                android.os.Bundle args = new android.os.Bundle();
                args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
                ok = target.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args);
                o.put("method", "set");
            }
            // v1.20.2（用户实测）：SET_TEXT / PASTE 在 WebView 里**返回 true 但框里没字**（假成功）。
            // 读回节点文本 + 比对界面指纹，二者都没变化就如实报失败（不再报"已写入"）。
            String readback = "";
            try {
                CharSequence t2 = target.getText();
                if (t2 != null) readback = t2.toString();
            } catch (Throwable ignored) {}
            // v1.20.3（第二轮反馈）：以前还有"整树指纹变化"兜底，结果聊天里那行
            // `Tool call android_focus_type · CESHI-ABC-2` 被当成证据 → 假阳性。
            // 现在只认**输入节点自身**的读回文本（WebView 里那就是空 → 如实失败）。
            boolean textLanded = ok && !readback.isEmpty() && readback.contains(
                    text.length() > 40 ? text.substring(0, 40) : text);
            o.put("readbackOnly", true);
            o.put("readback", readback.length() > 120 ? readback.substring(0, 120) + "…" : readback);
            o.put("landed", textLanded);
            if (ok && !textLanded) {
                o.put("ok", false);
                o.put("error", readback.isEmpty()
                        ? "输入动作返回成功，但输入框读回文本为空 —— 多半是 WebView 忽略了 a11y 注入"
                        : "输入动作返回成功，但输入框里读回的是「"
                          + (readback.length() > 60 ? readback.substring(0, 60) + "…" : readback)
                          + "」，不含本次写入的文本");
                o.put("hint", "WebView/自绘输入框：先用 android_tap 点中输入框并确认软键盘弹出再试；"
                        + "仍失败说明该系统屏蔽了 a11y 注入，需要 Shizuku/root 的 android_input（本机是否可用见 android_shizuku_status）。");
                return o.toString();
            }
            o.put("focused", focusedNow);
            o.put("previouslyFocused", wasFocused);
            o.put("focusIssued", focusIssued);
            try {
                CharSequence cls = target.getClassName();
                if (cls != null) o.put("targetClass", cls.toString());
                CharSequence pkg = target.getPackageName();
                if (pkg != null) o.put("targetPackage", pkg.toString());
            } catch (Throwable ignored) {}
            if (ok) {
                o.put("error", "");
            } else {
                o.put("error", "输入动作未被执行（" + (paste ? "ACTION_PASTE" : "ACTION_SET_TEXT") + " 返回 false，"
                        + "节点类=" + o.optString("targetClass", "?") + "，聚焦=" + focusedNow + "）");
                o.put("hint", paste
                        ? "该节点/输入法拒绝了粘贴：可先 android_tap 点击输入框并确认键盘弹出；"
                          + "仍失败时用 android_see 截图后点击输入法自带的「粘贴」键（键盘上方一行，屏幕底部约 y≈0.586），"
                          + "或用特权通道 android_input(action=text，需 Shizuku/root)。"
                        : "该节点拒绝无障碍写文本（常见于 WebView/contenteditable）：改用 android_paste_text 走剪贴板粘贴；"
                          + "或先用 android_tap 聚焦并确认键盘弹出后重试。");
            }
            return o.toString();
        } catch (Throwable t) {
            JSONObject o = new JSONObject();
            try {
                o.put("ok", false);
                o.put("error", "input error: " + t.getMessage());
                o.put("hint", "无障碍输入内部异常：可重试一次，或改用 android_paste_text / android_input。");
            } catch (Throwable ignored) {}
            return o.toString();
        }
    }

    /** /scroll：direction=up/down/left/right（优先节点滚动）。 */
    private String handleScroll(String path) {
        try {
            String direction = queryParam(path, "direction");
            JSONObject o = new JSONObject();
            o.put("ok", true);
            o.put("direction", direction);
            AccessibilityNodeInfo root = getRootInActiveWindow();
            if (root == null) return jsonError("当前没有活动窗口");
            final int[] action = {AccessibilityNodeInfo.ACTION_SCROLL_FORWARD};
            if ("up".equals(direction)) action[0] = AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD;
            else if ("down".equals(direction)) action[0] = AccessibilityNodeInfo.ACTION_SCROLL_FORWARD;
            else if ("left".equals(direction)) action[0] = AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD;
            else if ("right".equals(direction)) action[0] = AccessibilityNodeInfo.ACTION_SCROLL_FORWARD;
            else return jsonError("direction 需要 up/down/left/right");
            final AccessibilityNodeInfo[] scroller = {null};
            walk(root, new NodeVisitor() {
                @Override
                public void visit(AccessibilityNodeInfo node, int depth) {
                    if (scroller[0] != null) return;
                    if (node != null && node.isScrollable()) scroller[0] = node;
                }
            }, 0);
            if (scroller[0] != null && scroller[0].performAction(action[0])) {
                o.put("method", "node");
                return o.toString();
            }
            o.put("method", "none");
            o.put("error", "未找到可滚动的区域");
            return o.toString();
        } catch (Throwable t) {
            return jsonError("scroll error: " + t.getMessage());
        }
    }

    private String handleGlobalAction(int action) {
        try {
            JSONObject o = new JSONObject();
            o.put("ok", performGlobalAction(action));
            return o.toString();
        } catch (Throwable t) {
            return jsonError("global action error: " + t.getMessage());
        }
    }

    /** 无障碍截图输出目录：优先外部共享目录 <sdcard>/<pkgRoot>/screenshots/。
     *  原因：截图与读取虽同属 DSH，但多套同源包（正式版/Lite/兼容版）共用同一份插件时，
     *  一旦请求落到另一个包的实例上，路径就落在对方的 /data/user/0/<pkg>/ 私有目录里 —— 按 UID
     *  隔离必然 EACCES，整个"看图"能力挂掉。写到外部目录后任何包都能读，这类失败从结构上消失。
     *  外部目录不可用（未授权存储等）时回退私有 filesDir，同包内读写仍然正常。 */
    private File screenshotDir() {
        try {
            File ext = android.os.Environment.getExternalStorageDirectory();
            if (ext != null) {
                // v1.18（B12）：外部目录名随变体（BuildVariant），不再按包名 contains() 猜。
                // 这样各变体的无障碍截图各写各的目录，不再互相串（原实现会让社区版写进正式版目录）。
                File d = new File(new File(ext, BuildVariant.EXT_DIR_NAME), "screenshots");
                if (d.exists() || d.mkdirs()) return d;
            }
        } catch (Throwable ignored) {}
        File fallback = new File(getFilesDir(), "screenshots");
        if (!fallback.exists()) fallback.mkdirs();
        return fallback;
    }

    /** /screenshot：Android 11+ 无障碍截图，存 PNG 到外部共享目录 <sdcard>/<pkgRoot>/screenshots/，返回路径。
     *  grid=4/8 叠加网格线（帮模型按行列定位）；返回屏幕/图片尺寸与换算系数。 */
    /**
     * /pixel：按**屏幕坐标**采样像素颜色（v1.20.2）。
     *
     * <p>为什么需要：模型看一张图要 1~3s，而"判断某个格子是不是绿色"只需采几个点 ——
     * 毫秒级、零体积。参数 {@code pts=x1,y1;x2,y2}（屏幕坐标），返回 {@code [{x,y,r,g,b,hex}]}。
     */
    private String handlePixel(String path) {
        try {
            final String pts = queryParam(path, "pts");
            if (pts.isEmpty()) return jsonError("pixel 需要 pts=x,y;x,y…（屏幕坐标，分号分隔）");
            final String[] parts = pts.split("[;|]");
            final int n = Math.min(parts.length, 64);
            final int[] px = new int[n];
            final int[] py = new int[n];
            int ok = 0;
            for (int i = 0; i < n; i++) {
                String s = parts[i].trim();
                if (s.isEmpty()) continue;
                String[] xy = s.split("[,\\s]+");
                if (xy.length < 2) continue;
                int vx = (int) parseDoubleSafe(xy[0], -1);
                int vy = (int) parseDoubleSafe(xy[1], -1);
                if (vx < 0 || vy < 0) continue;
                px[ok] = vx;
                py[ok] = vy;
                ok++;
            }
            if (ok == 0) return jsonError("pts 里没有可解析的坐标对");
            final int count = ok;
            final int[] size = screenSize();
            screenW = size[0];
            screenH = size[1];
            final String[] out = new String[1];
            final java.util.concurrent.CountDownLatch latch = new java.util.concurrent.CountDownLatch(1);
            takeScreenshot(0, new java.util.concurrent.Executor() {
                @Override public void execute(Runnable r) { new Thread(r).start(); }
            }, new TakeScreenshotCallback() {
                @Override public void onSuccess(ScreenshotResult sr) {
                    try {
                        Bitmap bmp = Bitmap.wrapHardwareBuffer(sr.getHardwareBuffer(), sr.getColorSpace());
                        Bitmap soft = bmp == null ? null : bmp.copy(Bitmap.Config.ARGB_8888, false);
                        if (soft == null) { out[0] = jsonError("截图转换失败"); latch.countDown(); return; }
                        double sx = (double) soft.getWidth() / screenW;
                        double sy = (double) soft.getHeight() / screenH;
                        JSONArray arr = new JSONArray();
                        for (int i = 0; i < count; i++) {
                            int ix = (int) Math.round(px[i] * sx);
                            int iy = (int) Math.round(py[i] * sy);
                            JSONObject o = new JSONObject();
                            o.put("x", px[i]);
                            o.put("y", py[i]);
                            if (ix < 0 || iy < 0 || ix >= soft.getWidth() || iy >= soft.getHeight()) {
                                o.put("error", "out-of-screen");
                            } else {
                                int c = soft.getPixel(ix, iy);
                                int r = (c >> 16) & 0xFF, g = (c >> 8) & 0xFF, bc = c & 0xFF;
                                o.put("r", r);
                                o.put("g", g);
                                o.put("b", bc);
                                o.put("hex", String.format("#%02X%02X%02X", r, g, bc));
                            }
                            arr.put(o);
                        }
                        JSONObject res = new JSONObject();
                        res.put("ok", true);
                        res.put("screenW", screenW);
                        res.put("screenH", screenH);
                        res.put("pixels", arr);
                        out[0] = res.toString();
                    } catch (Throwable t) {
                        out[0] = jsonError("pixel error: " + t.getMessage());
                    }
                    latch.countDown();
                }

                @Override public void onFailure(int errorCode) {
                    // code=3 = ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT（截图太频繁）
                    out[0] = "{\"__retry\":" + errorCode + "}";
                    latch.countDown();
                }
            });
            latch.await(3000, TimeUnit.MILLISECONDS);
            String first = out[0];
            // v1.20.3：截图间隔限制（code=3）→ 退避 1.2s 重试一次
            if (first != null && first.contains("\"__retry\"")) {
                try { Thread.sleep(1200L); } catch (InterruptedException ignored) {
                }
                return handlePixel(path);
            }
            return first == null ? jsonError("像素采样超时") : first;
        } catch (Throwable t) {
            return jsonError("pixel error: " + t.getMessage());
        }
    }

    private String handleScreenshot(String path) {
        if (Build.VERSION.SDK_INT < 30) {
            return jsonError("截图需要 Android 11+（当前 API " + Build.VERSION.SDK_INT + "）；低版本请用 /dump 读屏幕文本");
        }
        final boolean ticks = "true".equals(queryParam(path, "ticks")) || "1".equals(queryParam(path, "ticks"));
            final boolean wantPng = "true".equals(queryParam(path, "png")) || "1".equals(queryParam(path, "png"))
                    || "png".equals(queryParam(path, "fmt"));
            final String gridStr = queryParam(path, "grid");
        final int grid = "8".equals(gridStr) ? 8 : ("4".equals(gridStr) || "true".equals(gridStr) ? 4 : 0);
        // v1.19（A6）：区域截图参数（屏幕坐标）
        final String selectText = queryParam(path, "select");
        final String region = queryParam(path, "region");
        int selectIndexTmp = 0;
        try {
            String si = queryParam(path, "selectIndex");
            if (!si.isEmpty()) selectIndexTmp = Math.max(0, Integer.parseInt(si.trim()));
        } catch (Throwable ignored) {}
        final int selectIndex = selectIndexTmp;
        int cropPadTmp = 0;
        try {
            String pd = queryParam(path, "pad");
            if (!pd.isEmpty()) cropPadTmp = Math.max(0, Integer.parseInt(pd.trim()));
        } catch (Throwable ignored) {}
        final int cropPad = cropPadTmp;
        // 虚拟屏支持（v1.8）：?display=N 截指定显示（overlay 虚拟屏等）；缺省截主屏
        final String displayStr = queryParam(path, "display");
        int displayId = Display.DEFAULT_DISPLAY;
        if (displayStr != null && !displayStr.isEmpty()) {
            try {
                displayId = Integer.parseInt(displayStr.trim());
            } catch (NumberFormatException e) {
                displayId = Display.DEFAULT_DISPLAY;
            }
        }
        final CountDownLatch latch = new CountDownLatch(1);
        final String[] result = {null};
        Executor executor = new Executor() {
            @Override
            public void execute(Runnable r) {
                new Handler(Looper.getMainLooper()).post(r);
            }
        };
        try {
            takeScreenshot(displayId, executor, new TakeScreenshotCallback() {
                @Override
                public void onSuccess(ScreenshotResult screenshotResult) {
                    try {
                        // API 30-33：ScreenshotResult 提供 HardwareBuffer（+ColorSpace），包成 Bitmap 再转软件位图
                        android.hardware.HardwareBuffer hb = screenshotResult.getHardwareBuffer();
                        Bitmap bmp = Bitmap.wrapHardwareBuffer(hb, screenshotResult.getColorSpace());
                        if (bmp == null) {
                            result[0] = jsonError("截图位图为空");
                        } else {
                            Bitmap soft = bmp.copy(Bitmap.Config.ARGB_8888, true); // isMutable=true：后面要叠网格（new Canvas 需要可变位图）
                            bmp.recycle();
                            if (hb != null) hb.close();
                            // ====================================================
                            // v1.19（A6）区域截图：只截一块，让模型看清小字。
                            //   select=<文字>  → 按无障碍节点取景（节点 bounds 是屏幕坐标，最准）
                            //   region=x,y,w,h → 显式矩形（屏幕坐标）
                            //   pad=N          → select 时的外扩像素（默认 0）
                            // 换算契约（返回给调用方，插件再原样转述给模型）：
                            //   screenX = cropX + ix * scaleX      // ix 是**裁剪图内**的像素
                            //   screenY = cropY + iy * scaleY
                            //   scaleX  = cropW / imageW（screenW/screenH 仍是整屏物理尺寸）
                            // 整屏截图等价于 crop=(0,0,screenW,screenH)，此时 scaleX 与旧版语义一致。
                            // ====================================================
                            int fullW = soft.getWidth(), fullH = soft.getHeight();
                            int[] ssz = screenSize();
                            int scw = ssz[0] > 0 ? ssz[0] : fullW;
                            int sch = ssz[1] > 0 ? ssz[1] : fullH;
                            double imgScaleX = scw > 0 ? (double) fullW / scw : 1.0;   // 截图px / 屏幕px
                            double imgScaleY = sch > 0 ? (double) fullH / sch : 1.0;
                            int cropX = 0, cropY = 0, cropW = scw, cropH = sch;        // 屏幕坐标
                            boolean cropped = false;
                            double selectFx = -1, selectFy = -1;
                            Rect selBounds = null;
                            String selLabel = "";
                            int selCount = 0;
                            if (!selectText.isEmpty()) {
                                SelectMatch sel = selectNodeForShot(selectText, selectIndex);
                                if (sel != null && sel.node != null) {
                                    Rect b = new Rect();
                                    try { sel.node.getBoundsInScreen(b); } catch (Throwable ignored) {}
                                    selLabel = sel.label == null ? "" : sel.label;
                                    selCount = sel.count;
                                    if (b.width() > 0 && b.height() > 0) {
                                        selBounds = b;
                                        cropX = Math.max(0, b.left - cropPad);
                                        cropY = Math.max(0, b.top - cropPad);
                                        cropW = Math.min(scw - cropX, b.width() + cropPad * 2);
                                        cropH = Math.min(sch - cropY, b.height() + cropPad * 2);
                                        selectFx = (b.left + b.right) / 2.0 / scw;
                                        selectFy = (b.top + b.bottom) / 2.0 / sch;
                                        cropped = true;
                                    }
                                }
                                if (!cropped) {
                                    result[0] = jsonError("select 未匹配到可见节点：" + selectText);
                                    latch.countDown();
                                    return;
                                }
                            } else if (!region.isEmpty()) {
                                String[] pp = region.split("[,\\sx]+");
                                if (pp.length < 4) {
                                    result[0] = jsonError("region 需要 4 个数字：x,y,w,h");
                                    latch.countDown();
                                    return;
                                }
                                try {
                                    cropX = Math.max(0, Integer.parseInt(pp[0].trim()));
                                    cropY = Math.max(0, Integer.parseInt(pp[1].trim()));
                                    cropW = Integer.parseInt(pp[2].trim());
                                    cropH = Integer.parseInt(pp[3].trim());
                                } catch (NumberFormatException e) {
                                    result[0] = jsonError("region 解析失败：" + region);
                                    latch.countDown();
                                    return;
                                }
                                if (cropW <= 0 || cropH <= 0) {
                                    result[0] = jsonError("region 宽高必须为正");
                                    latch.countDown();
                                    return;
                                }
                                if (cropX >= scw || cropY >= sch) {
                                    result[0] = jsonError("region 起点超出屏幕（" + scw + "x" + sch + "）");
                                    latch.countDown();
                                    return;
                                }
                                cropW = Math.min(cropW, scw - cropX);
                                cropH = Math.min(cropH, sch - cropY);
                                cropped = true;
                            }
                            if (cropped) {
                                int ix = (int) Math.round(cropX * imgScaleX);
                                int iy = (int) Math.round(cropY * imgScaleY);
                                int iw = (int) Math.round(cropW * imgScaleX);
                                int ih = (int) Math.round(cropH * imgScaleY);
                                ix = Math.max(0, Math.min(ix, fullW - 1));
                                iy = Math.max(0, Math.min(iy, fullH - 1));
                                iw = Math.max(1, Math.min(iw, fullW - ix));
                                ih = Math.max(1, Math.min(ih, fullH - iy));
                                Bitmap sub = Bitmap.createBitmap(soft, ix, iy, iw, ih);
                                soft.recycle();
                                soft = sub;
                            }
                            // 网格叠加（半透明细线，帮模型按行列定位）
                            if (ticks && soft.getWidth() > 0) {
                Canvas tcv = new Canvas(soft);
                Paint tp = new Paint();
                tp.setAntiAlias(true);
                tp.setColor(0x99FFD400);
                tp.setStrokeWidth(1f);
                tp.setTextSize(Math.max(18f, soft.getWidth() / 40f));
                int step = 100;   // 每 100 **屏幕**像素；标签写屏幕坐标
                for (int sx = step; sx < scw; sx += step) {
                    float ix2 = (float) (sx * imgScaleX);
                    if (ix2 <= 0 || ix2 >= soft.getWidth()) continue;
                    tcv.drawLine(ix2, 0, ix2, soft.getHeight(), tp);
                    tcv.drawText(String.valueOf(sx), ix2 + 2, tp.getTextSize() + 2, tp);
                }
                for (int sy = step; sy < sch; sy += step) {
                    float iy2 = (float) (sy * imgScaleY);
                    if (iy2 <= 0 || iy2 >= soft.getHeight()) continue;
                    tcv.drawLine(0, iy2, soft.getWidth(), iy2, tp);
                    tcv.drawText(String.valueOf(sy), 2, iy2 - 3, tp);
                }
            }
            if (grid > 0 && soft.getWidth() > 0) {
                                Canvas cv = new Canvas(soft);
                                Paint paint = new Paint();
                                paint.setColor(0x66FFFFFF);
                                paint.setStrokeWidth(2f);
                                for (int i = 1; i < grid; i++) {
                                    float gx = soft.getWidth() * i / (float) grid;
                                    cv.drawLine(gx, 0, gx, soft.getHeight(), paint);
                                    float gy = soft.getHeight() * i / (float) grid;
                                    cv.drawLine(0, gy, soft.getWidth(), gy, paint);
                                }
                            }
                            File dir = screenshotDir();
                            File out = new File(dir, "screen-" + System.currentTimeMillis() + (wantPng ? ".png" : ".jpg"));
                            FileOutputStream fos = new FileOutputStream(out);
                            if (wantPng) {
                    soft.compress(Bitmap.CompressFormat.PNG, 100, fos);
                } else {
                    soft.compress(Bitmap.CompressFormat.JPEG, 70, fos);
                }
                            fos.flush();
                            fos.close();
                            int[] size = screenSize();
                            JSONObject o = new JSONObject();
                            o.put("ok", true);
                            o.put("path", out.getAbsolutePath());
                            o.put("width", soft.getWidth());
                            o.put("height", soft.getHeight());
                            // 坐标系对齐：屏幕物理尺寸 / 截图尺寸 / 换算系数
                            o.put("screenW", size[0]);
                            o.put("screenH", size[1]);
                            o.put("imageW", soft.getWidth());
                            o.put("imageH", soft.getHeight());
                            // v1.19（A6）：裁剪几何（全部屏幕坐标）+ 精确换算
                            //   screenX = cropX + ix * scaleX ； screenY = cropY + iy * scaleY
                            o.put("cropped", cropped);
                            o.put("cropX", cropX);
                            o.put("cropY", cropY);
                            o.put("cropW", cropW);
                            o.put("cropH", cropH);
                            o.put("scaleX", soft.getWidth() > 0 ? (double) cropW / soft.getWidth() : 1.0);
                            o.put("scaleY", soft.getHeight() > 0 ? (double) cropH / soft.getHeight() : 1.0);
                            if (selBounds != null) {
                                o.put("selectLeft", selBounds.left);
                                o.put("selectTop", selBounds.top);
                                o.put("selectRight", selBounds.right);
                                o.put("selectBottom", selBounds.bottom);
                            }
                            if (selectFx >= 0) {
                                o.put("selectFx", selectFx);   // 命中节点的中心（分数坐标，可直接给 android_tap）
                                o.put("selectFy", selectFy);
                            }
                            if (!selectText.isEmpty() && cropped) {
                                // A6 修正：让模型一眼看到"截到的是谁"，以及共有几个候选（可配 selectIndex 换一个）
                                o.put("selectLabel", selLabel);
                                o.put("selectCount", selCount);
                                o.put("selectIndex", selectIndex);
                            }
                            o.put("grid", grid);
                o.put("ticks", ticks);
                o.put("format", wantPng ? "png" : "jpeg");
                            o.put("bytes", out.length());
                            result[0] = o.toString();
                        }
                    } catch (Throwable t) {
                        result[0] = jsonError("截图保存失败: " + t.getMessage());
                    } finally {
                        latch.countDown();
                    }
                }

                @Override
                public void onFailure(int errorCode) {
                    result[0] = jsonError("截图失败（错误码 " + errorCode + "，安全页面/未授权截图时常见）");
                    latch.countDown();
                }
            });
        } catch (Throwable t) {
            return jsonError("截图调用失败: " + t.getMessage());
        }
        try {
            if (!latch.await(6000, TimeUnit.MILLISECONDS)) {
                return jsonError("截图超时");
            }
        } catch (InterruptedException e) {
            return jsonError("截图被中断");
        }
        return result[0] == null ? jsonError("截图无结果") : result[0];
    }
}
