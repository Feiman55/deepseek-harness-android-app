/**
 * Android 手机端系统能力插件：给 DeepSeek Harness 提供结构化、语义化的系统操作工具。
 *
 * 覆盖：包管理（安装/卸载/清数据/授权）、应用管理（启动/强制停止）、
 *       系统设置读写、截图、模拟输入（点击/滑动/文本/按键）。
 *
 * 特权通道（由 MainActivity 探测后通过环境变量告知）：
 *   - ROOT_AVAILABLE=1  ：设备有 root（su 可用），走 su -c 通道
 *   - SHIZUKU_AVAILABLE=1：Shizuku 已授权，走 app_process rish 通道
 * 两者都未授予时不注册任何工具：AI 工具列表里没有 android_*，
 * 自然不会反复尝试系统操作；此时文件读写走 DSH 自带 fs/bash 工具。
 *
 * 审批策略：默认自动执行（已授权通道）。设环境变量 SHIZUKU_APPROVE=ask
 * 时，危险操作（安装/卸载/清数据/授权/改设置/输入）会逐次弹审批框。
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { spawn } from "node:child_process";
import { get as httpGet, request as httpRequest } from "node:http";
import { chmodSync, existsSync } from "node:fs";

const name = "tool-android";
const inject = ["tools"];

const APP_PROC = "/system/bin/app_process";
const SHIZUKU_LOADER = "rikka.shizuku.shell.ShizukuShellLoader";
const MAX_STDOUT = 8000;
const MAX_STDERR = 2000;

// v1.18（B12）：变体事实由壳在启动引擎时注入（见 android-app/variants.sh + MainActivity.spawnNode）。
//   DSH_APP_ID  —— 本变体包名（rish 的 RISH_APPLICATION_ID 兜底）
//   DSH_EXT_DIR —— 外部目录绝对路径（/sdcard/<变体目录>），截图等落盘位置
// 旧壳/旧包没有这些变量时回退到正式版默认值（向后兼容，不改变老行为）。
const APP_ID = process.env.DSH_APP_ID || "com.deepseek.harness";
const EXT_DIR = process.env.DSH_EXT_DIR || "/sdcard/DeepSeekHarness";

/** 特权通道是否可用（root 或 Shizuku 任一授予即可）。 */
function privilegedAvailable() {
  return process.env.ROOT_AVAILABLE === "1" || process.env.SHIZUKU_AVAILABLE === "1";
}

/** 危险操作白名单：SHIZUKU_APPROVE=ask 时这些 action 需要审批。 */
const DANGEROUS_ACTIONS = new Set([
  "install", "uninstall", "clear", "grant", "revoke", "force_stop",
  "put", "tap", "swipe", "text", "keyevent"
]);

function sanitizeEnv(env) {
  const clean = { ...env };
  delete clean.LD_LIBRARY_PATH;
  delete clean.LD_PRELOAD;
  delete clean.LD_DEBUG;
  return clean;
}

function ensureDexReadOnly(dex) {
  try {
    if (dex && existsSync(dex)) chmodSync(dex, 0o444);
  } catch (_) {}
}

/** 只允许安全的 shell 令牌字符，防止命令注入。 */
function safe(s) {
  return String(s ?? "").replace(/[^a-zA-Z0-9._\/:=-]/g, "");
}

/** 单引号包裹的 shell 字面量：保留任意字符（中文路径、空格、标点）。
 *  用户提供的路径/文本绝不能用 safe() —— 它会把非 ASCII 字符直接删掉（静默改坏入参）。 */
function shq(s) {
  return "'" + String(s ?? "").replace(/'/g, "'\\''") + "'";
}

/** App 本地 HTTP 服务端口（MainActivity 注入环境变量 APP_NOTIFY_PORT，默认 3081）。 */
const appPort = () => parseInt(process.env.APP_NOTIFY_PORT || "3081", 10);

/** 调 App 本地 HTTP 端点（GET）。用于 usage/overlay 等 App 层能力，无需特权通道。
 *  返回解析后的 JSON 对象（DSH 工具运行时要求 execute 返回对象，字符串会被 schema 校验拒绝）。 */
function appRequest(path, params) {
  return new Promise((resolve) => {
    const qs = params
      ? "?" + Object.entries(params).map(([k, v]) =>
          encodeURIComponent(k) + "=" + encodeURIComponent(v)).join("&")
      : "";
    const req = httpGet({
      host: "127.0.0.1",
      port: appPort(),
      path: path + qs,
      timeout: 8000,
      // v1.18.0：App 侧本地服务要校验调用方
      headers: { "X-DSH-Token": process.env.APP_LOCAL_TOKEN || "" }
    }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { data += c; if (data.length > 65536) req.destroy(); });
      res.on("end", () => {
        if (!data) return resolve({ ok: false, error: "empty response" });
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve({ ok: false, error: "App 响应解析失败: " + String(data).slice(0, 120) });
        }
      });
    });
    req.on("error", () => resolve({ ok: false, error: "App 本地服务不可用（请先启动 DeepSeek Harness）" }));
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "App 本地服务超时" }); });
    req.end();
  });
}

/** 调 App 本地 HTTP 端点（POST + JSON body）。
 *  /clipboard 与 /schedule 必须用 POST：App 侧会把请求行的 query 丢掉（path.substring(0,'?')），
 *  只把 body 交给处理器，所以 GET?action=write 会被当成 action=read 静默返回读结果。 */
function appPost(path, obj, timeoutMs) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(obj ?? {});
    const req = httpRequest({
      host: "127.0.0.1",
      port: appPort(),
      path,
      method: "POST",
      timeout: timeoutMs || 8000,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        // v1.18.0：本地服务鉴权令牌
        "X-DSH-Token": process.env.APP_LOCAL_TOKEN || ""
      }
    }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { data += c; if (data.length > 65536) req.destroy(); });
      res.on("end", () => {
        if (!data) return resolve({ ok: false, error: "empty response" });
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve({ ok: false, error: "App 响应解析失败: " + String(data).slice(0, 120) });
        }
      });
    });
    req.on("error", () => resolve({ ok: false, error: "App 本地服务不可用（请先启动 DeepSeek Harness）" }));
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "App 本地服务超时" }); });
    req.write(payload);
    req.end();
  });
}

/**
 * v1.22：免特权地执行一个本地命令并回收输出（以本应用自己的 uid）。
 * 现有 shizukuCmd / suCmd / privCmd 都走特权通道；读日志这类"自身权限就够"的场合用这个。
 * 失败一律如实回 error，不静默返回空字符串（复盘教训：别让调用方把"没输出"当成"没日志"）。
 */
function runLocal(argv, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        env: sanitizeEnv(process.env),
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (e) {
      return resolve({ ok: false, stdout: "", stderr: "", error: "无法执行 " + argv[0] + "：" + e.message });
    }
    let out = "";
    let err = "";
    let done = false;
    const finish = (ok, error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok, stdout: out, stderr: err, error: error || "" });
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch (e) {}
      finish(false, "执行超时（" + (timeoutMs || 15000) + "ms）");
    }, timeoutMs || 15000);
    child.stdout.on("data", (c) => {
      out += c;
      if (out.length > 300000) { try { child.kill(); } catch (e) {} }
    });
    child.stderr.on("data", (c) => {
      err += c;
      if (err.length > 40000) err = err.slice(0, 40000);
    });
    child.on("error", (e) => finish(false, "执行失败：" + e.message));
    child.on("close", (code) => finish(code === 0, code === 0 ? "" : ("退出码 " + code + (err ? "：" + err.slice(0, 300) : ""))));
  });
}

/** payload 里真 bash 的路径（用于绕过 app uid 直接 exec /system/bin 的限制）。取不到返回 ""。 */
function payloadBashPath() {
  try {
    const exe = String(process.execPath || "").replace(/\\/g, "/");   // …/payload/runtime/bin/node
    const idx = exe.lastIndexOf("/runtime/");
    if (idx < 0) return "";
    const p = exe.slice(0, idx) + "/bin/bash";
    return existsSync(p) ? p : "";
  } catch (e) { return ""; }
}

/** 异步执行一条 Shizuku shell 命令。 */
function shizukuCmd(command, dex, appId, timeoutMs) {
  if (!dex) {
    return Promise.resolve({ ok: false, exit_code: -1, stdout: "", stderr: "", error: "SHIZUKU_DEX 未配置" });
  }
  ensureDexReadOnly(dex);
  const timeout = Math.max(1000, Math.min(timeoutMs || 30000, 120000));
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(APP_PROC, [
        `-Djava.class.path=${dex}`,
        "/system/bin",
        "--nice-name=rish",
        SHIZUKU_LOADER,
        "-c", command
      ], {
        env: { ...sanitizeEnv(process.env), RISH_APPLICATION_ID: appId || APP_ID },
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (e) {
      resolve({ ok: false, exit_code: -1, stdout: "", stderr: "", error: String(e && e.message || e) });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch (_) {} }, timeout);
    const finish = (ok, exitCode, err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok,
        exit_code: exitCode,
        stdout: stdout.trim().slice(0, MAX_STDOUT),
        stderr: stderr.trim().slice(0, MAX_STDERR),
        ...(err ? { error: err } : {})
      });
    };
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (e) => finish(false, -1, String(e && e.message || e)));
    child.on("close", (code, signal) => {
      if (signal === "SIGKILL" && code === null) finish(false, -1, "命令超时被强制终止");
      else finish(code === 0, code ?? -1, undefined);
    });
  });
}

/** 异步执行一条 root(su) 命令，结果结构与 shizukuCmd 一致。 */
function suCmd(command, timeoutMs) {
  const timeout = Math.max(1000, Math.min(timeoutMs || 30000, 120000));
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("su", ["-c", command], {
        env: sanitizeEnv(process.env),
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (e) {
      resolve({ ok: false, exit_code: -1, stdout: "", stderr: "", error: String(e && e.message || e) });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch (_) {} }, timeout);
    const finish = (ok, exitCode, err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok,
        exit_code: exitCode,
        stdout: stdout.trim().slice(0, MAX_STDOUT),
        stderr: stderr.trim().slice(0, MAX_STDERR),
        ...(err ? { error: err } : {})
      });
    };
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (e) => finish(false, -1, String(e && e.message || e)));
    child.on("close", (code, signal) => {
      if (signal === "SIGKILL" && code === null) finish(false, -1, "命令超时被强制终止");
      else finish(code === 0, code ?? -1, undefined);
    });
  });
}

/** 选择特权通道执行：root(su) 优先，否则 Shizuku。 */
function privCmd(command, timeoutMs) {
  if (process.env.ROOT_AVAILABLE === "1") {
    return suCmd(command, timeoutMs);
  }
  return shizukuCmd(command, process.env.SHIZUKU_DEX, process.env.SHIZUKU_APP_ID, timeoutMs);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── v1.20.1（AI 测试员建议②③）：结构化返回需要的事实查询 ──────────────────

/** 屏幕尺寸（wm size；缓存 60 秒）。拿不到回 null。 */
let _screenCache = null;
let _screenAt = 0;
async function screenSize() {
  const now = Date.now();
  if (_screenCache && now - _screenAt < 60000) return _screenCache;
  const r = await privCmd("wm size", 8000);
  // v1.22.16（安卓 agent 实测）：Shizuku 通道下 `wm size` 的输出可能落到 **stderr**，
  // 只读 stdout 会拿不到尺寸 → android_input 直接拒绝执行（"拿不到屏幕尺寸"）。
  // 另外优先取 Override size（那才是生效尺寸），再退回 Physical size。
  const out = String(r.stdout || "") + "\n" + String(r.stderr || "");
  const override = /Override size:\s*(\d+)\s*x\s*(\d+)/.exec(out);
  const physical = /Physical size:\s*(\d+)\s*x\s*(\d+)/.exec(out);
  const anySize = /(\d+)\s*x\s*(\d+)/.exec(out);
  const m = override || physical || anySize;
  if (m) {
    _screenCache = { w: parseInt(m[1], 10), h: parseInt(m[2], 10) };
    _screenAt = now;
  } else {
    _screenCache = null;          // 失败不缓存，下次重试
  }
  return _screenCache;
}

/** 当前前台包名（dumpsys window）。拿不到回 ""。 */
async function currentPackage() {
  const r = await privCmd("dumpsys window | grep -m2 -E 'mCurrentFocus|mFocusedApp'", 8000);
  const s = String(r.stdout || "");
  const m = /u0 ([A-Za-z0-9_.]+)\//.exec(s) || /u0 ([A-Za-z0-9_.]+)/.exec(s);
  return m ? m[1] : "";
}

/**
 * harness 的悬浮窗是否**真的可见**（v1.20.1 · AI 建议①）。
 * App 的 /overlay 只回 running/engineUp/granted，区分不了 show 和 hide ——
 * 这里用特权 shell 查窗口状态：APPLICATION_OVERLAY 窗口里出现 mViewVisibility=0x0 即算可见。
 * ⚠ 同屏查看（browser 面板）也是 APPLICATION_OVERLAY；它开着时这里也会是 true，属已知边界。
 */
async function overlayVisible() {
  const r = await privCmd("dumpsys window windows | grep -A18 'appop=SYSTEM_ALERT_WINDOW' | grep -E 'mViewVisibility'", 10000);
  const s = String(r.stdout || "");
  if (!s.trim()) return null;
  return /mViewVisibility=0x0/.test(s);
}

/** 已知系统设置项的量纲提示（AI 建议③：别让 "8" 被读成 8%）。 */
const SETTING_RANGE = {
  screen_brightness: "0-255 原始值（不是百分比）",
  screen_off_timeout: "毫秒",
  volume_music: "设备音量档位（具体上限随机型）",
  volume_alarm: "设备音量档位（具体上限随机型）",
  volume_ring: "设备音量档位（具体上限随机型）",
  screen_brightness_mode: "0=手动 / 1=自动",
  navigation_mode: "0=三键 / 1=双键 / 2=手势",
};

/** 会话式安装 APK。必须绕开两个坑：
 *  ① system_server 无权读 FUSE 挂载的 /storage/emulated/0，pm 直接报 "Can't open file"；
 *  ② ColorOS 上单发 `pm install -r` 会卡死无输出。
 *  所以先由特权 shell 把 APK 拷到 /data/local/tmp，再走 install-create/write/commit，
 *  并校验输出确实含 Success，否则如实报错（旧实现不看输出，失败也返回 exit_code:0）。 */
async function installApk(apkPath, expectPkg) {
  const tmp = "/data/local/tmp/dsh-install-" + Date.now() + ".apk";
  const before = "/data/local/tmp/dsh-pkgs-before.txt";
  const script = [
    `APK=${shq(apkPath)}`,
    `TMP=${shq(tmp)}`,
    `BEFORE=${shq(before)}`,
    'if [ ! -f "$APK" ]; then echo "找不到 APK: $APK" >&2; exit 21; fi',
    'cp -f "$APK" "$TMP" || { echo "复制到 /data/local/tmp 失败" >&2; exit 22; }',
    'pm list packages | sort > "$BEFORE"',
    "SID=$(pm install-create -r -t 2>&1 | grep -oE '[0-9]+' | head -1)",
    'if [ -z "$SID" ]; then echo "install-create 未返回 session id" >&2; rm -f "$TMP"; exit 23; fi',
    'pm install-write "$SID" base.apk "$TMP" 2>&1 || { echo "install-write 失败" >&2; rm -f "$TMP"; exit 24; }',
    'OUT=$(pm install-commit "$SID" 2>&1); RC=$?',
    'rm -f "$TMP"',
    'echo "$OUT"',
    '[ "$RC" -eq 0 ] || exit 25',
    'case "$OUT" in *Success*) ;; *) echo "install-commit 未返回 Success" >&2; exit 26;; esac',
    'pm list packages | sort > "$BEFORE.after"',
    'echo "本次新增包:"',
    'grep -vxFf "$BEFORE" "$BEFORE.after" || true',
    'rm -f "$BEFORE" "$BEFORE.after"'
  ].join("\n");
  const r = await privCmd(script, 120000);
  const stdout = String(r.stdout || "");
  const stderr = String(r.stderr || "");
  if (!r.ok || !/Success/.test(stdout)) {
    return {
      ok: false,
      exit_code: r.exit_code,
      stdout,
      stderr,
      error: r.error || "安装未成功（pm 未返回 Success）"
    };
  }
  if (expectPkg) {
    // 二次校验：commit 报 Success 也可能没真正生效，以 pm path 能否查到为准
    const v = await privCmd("pm path " + shq(expectPkg), 15000);
    const p = String(v.stdout || "");
    if (!/package:/.test(p)) {
      return {
        ok: false, exit_code: r.exit_code, stdout, stderr,
        error: "pm 返回 Success，但 pm path 查不到 " + expectPkg + "，安装未真正生效"
      };
    }
    return { ok: true, exit_code: 0, stdout: stdout + "\npm path: " + p.trim(), stderr };
  }
  return { ok: true, exit_code: 0, stdout, stderr };
}

/** 通用结果 schema（所有工具共用，避免 exit_code/exitCode 不匹配的坑）。 */
function resultSchema(extraProps = {}) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      ok: { type: "boolean", required: true },
      exit_code: { type: "number" },
      stdout: { type: "string" },
      stderr: { type: "string" },
      error: { type: "string" },
      ...extraProps
    }
  };
}

function renderResult(value) {
  return [{
    type: "text",
    text: (value.ok ? "" : "执行失败：" + (value.error || value.stderr || "未知错误") + "\n\n") +
      "exit_code: " + value.exit_code + "\n" +
      (value.stdout ? "stdout:\n" + value.stdout : "") +
      (value.stderr ? "\nstderr:\n" + value.stderr : "")
  }];
}

/** android_usage 专用渲染：把 apps 数组展示出来（通用 renderResult 只读 shell 字段，会吞掉数据）。 */
function renderUsage(value) {
  if (!value.ok) return renderResult(value);
  const apps = Array.isArray(value.apps) ? value.apps : [];
  const lines = [`应用使用时长（最近 ${value.days ?? 1} 天，共 ${value.count ?? apps.length} 个应用，按时长降序）：`];
  if (apps.length === 0) {
    lines.push("（无数据：可能未授予「使用情况访问」权限，或该时段无使用记录）");
  }
  for (const a of apps) {
    const label = (a && a.name) || (a && a.pkg) || "未知应用";
    const min = a && typeof a.min === "number" ? a.min : Math.round((a && a.ms || 0) / 60000);
    lines.push(`- ${label} (${a.pkg || ""}): ${min} 分钟`);
  }
  return [{ type: "text", text: lines.join("\n") }];
}

/** android_overlay 专用渲染：展示真实可见性/是否变化（v1.20.1 · AI 建议①）。 */
function renderOverlay(value) {
  if (!value.ok) return renderResult(value);
  const parts = [];
  if (typeof value.visible === "boolean") parts.push("悬浮窗可见: " + (value.visible ? "是" : "否"));
  if (typeof value.changed === "boolean") parts.push("本次" + (value.changed ? "已改变" : "无变化"));
  if (typeof value.engineUp === "boolean") parts.push("引擎在线: " + value.engineUp);
  if (typeof value.granted === "boolean") parts.push("悬浮窗权限: " + (value.granted ? "已授予" : "未授予"));
  if (typeof value.running === "boolean") parts.push("悬浮窗服务运行中: " + value.running);
  if (parts.length === 0) parts.push("操作成功。");
  return [{ type: "text", text: parts.join("，") }];
}

/** 在 SHIZUKU_APPROVE=ask 时对危险操作做审批。 */
async function maybeApprove(ctx, exec, toolName, action, reason) {
  if (process.env.SHIZUKU_APPROVE !== "ask") return;
  const approver = ctx.get("approval");
  if (approver === undefined) throw new Error("审批服务未挂载，无法安全执行");
  const outcome = await approver.request({
    agent: exec.agent,
    toolName,
    callId: exec.callId,
    reason: `${action}: ${reason}`,
    signal: exec.signal
  });
  if (outcome !== "allowed-once") throw new Error(`操作未获批准（${outcome}）：${reason}`);
}

function apply(ctx) {
  const dex = () => process.env.SHIZUKU_DEX;
  const appId = () => process.env.SHIZUKU_APP_ID;

  // ===== v1.21（需求 2）：把 agent 状态推给 App 悬浮窗的小气泡 =====
  // 目的：用户让 DSH 做屏幕控制类任务时，不必靠猜判断"是否已经完成"。
  // 映射：思考中… / 正在调用 <tool>… / 任务已完成 / 会话已结束 / 出错了
  //   （"摸鱼中…"由 App 侧按空闲时长补，不需要内核参与）
  // 通道：App 本地 HTTP /overlay?action=bubble；App 没跑或没开悬浮窗时静默失败（不打扰）。
  {
    let busy = false;
    // v1.21 修正（ANR）：必须节流。assistant-stream 是逐 token/逐帧触发的，
    // 原来每个事件都 POST 一次气泡更新 → 悬浮窗被高频重排重绘，而模拟器是软件渲染，
    // 主线程会卡在 HardwareRenderer.nSyncAndDrawFrame 出帧上 → 系统判 App 无响应（实测 ANR）。
    // 现在：① 相同文案在 minGapMs 内不重复推；② 任意两次推送至少间隔 minGapMs。
    let lastText = "";
    let lastAt = 0;
    const MIN_GAP_MS = 1200;
    // v1.24 bubble: 结构化 state/tool —— App 侧据此套用户模板（控制台「悬浮窗消息」），
    // 不再靠中文文案匹配；text 仍然保留（老版本 App、日志、兼容都靠它）。
    // state 取值：thinking / tool / ask / done / ended / error
    const bubble = (text, sticky, state, tool) => {
      try {
        const now = Date.now();
        if (text === lastText && now - lastAt < 5000) return;   // 文案没变，别刷新
        if (now - lastAt < MIN_GAP_MS && !sticky) return;       // 节流（终态不丢）
        lastText = text;
        lastAt = now;
          // 诊断日志已按维护者要求移除（不再往 dsh-web.log 刷气泡文案）
        appPost("/overlay", { action: "bubble", text, sticky: !!sticky, ttl: 0,
                              state: state || "", tool: tool || "" });
      } catch (e) { /* 忽略：状态气泡是尽力而为 */ }
    };
    // 有新输入被领取 = 开始干活
    ctx.on("agent/inbox/claimed", () => { busy = true; bubble("思考中…", false, "thinking"); });
    // 流式输出：带工具名就是工具调用，否则仍算思考/输出中
    // v1.21：原来只认 frame.name/tool/toolName/call.name —— 真机反馈"正在调用 <工具>… 从没出现过"，
    // 说明实际帧结构不是这几种。改成深度扫描帧里可能藏工具名的字段，
    // 并在第一次扫描失败时把帧的键名打到日志（dsh-web.log）以便进一步校正。
    let frameShapeLogged = false;
    const findToolName = (o, depth) => {
      if (!o || typeof o !== "object" || depth > 3) return "";
      // 直接命中的常见字段
      for (const k of ["tool", "toolName", "name", "tool_name", "toolCall", "tool_call", "function"]) {
        const v = o[k];
        if (typeof v === "string" && v && !["start", "delta", "text", "message", "content", "tool"].includes(v)) return v;
        if (v && typeof v === "object") {
          const n = v.name || v.toolName;
          if (typeof n === "string" && n) return n;
        }
      }
      // 类型里带 tool 的块，优先取其名
      if (typeof o.type === "string" && /tool/i.test(o.type)) {
        const n = o.name || o.toolName || (o.tool && (o.tool.name || o.tool)) || "";
        if (typeof n === "string" && n) return n;
      }
      for (const k of Object.keys(o)) {
        if (k === "parent" || k === "session" || k === "registry") continue;
        const r = findToolName(o[k], depth + 1);
        if (r) return r;
      }
      return "";
    };
    ctx.on("agent/assistant-stream", (p) => {
      const f = p && p.frame;
      const tool = findToolName(f, 0);
      if (!frameShapeLogged && !tool && f && typeof f === "object") {
        frameShapeLogged = true;
      }
      if (tool) {
        busy = true;
        const toolName = String(tool).replace(/^.*\//, "");
        if (/ask[_-]?user[_-]?question|request[_-]?user[_-]?input|ask[_-]?question/i.test(toolName)) {
          // v1.21：向用户提问是"等用户"，不是"在跑工具" —— 单独一个常驻状态
          bubble("正在向用户提问...", true, "ask");
        } else {
          // v1.21：文案简化（用户要求）——「正在调用 <工具>…」→「正在 <工具>…」
          bubble("正在 " + toolName + "…", false, "tool", toolName);
        }
      } else {
        busy = true;
        bubble("思考中…", false, "thinking");
      }
    });
    // agent 状态机：由"忙"回到 idle 才算任务完成（避免启动时的初始 idle 误报）
    ctx.on("agent/status", (p) => {
      const s = p && p.status;
      if (!s) return;
      // v1.21：waiting-input / waiting-for-input = 明确在等用户输入（例如 agent 提了问）
      if (s === "waiting-input" || s === "waiting-for-input") {
        busy = false;
        bubble("正在向用户提问...", true, "ask");
        return;
      }
      if (s === "idle" || s === "waiting") {
        if (busy) { busy = false; bubble("任务已完成", true, "done"); }
      } else {
        busy = true;
        bubble("思考中…", false, "thinking");
      }
    });
    ctx.on("agent/error", () => { busy = false; bubble("出错了（点开控制台看日志）", true, "error"); });
    // 会话级：running → 思考中；由 running 变 false → 任务已完成；会话被移除 → 会话已结束
    ctx.on("api-session/status", (_id, running) => {
      if (running) { busy = true; bubble("思考中…", false, "thinking"); }
      else if (busy) { busy = false; bubble("任务已完成", true, "done"); }
    });
    ctx.on("api-session/removed", () => { busy = false; bubble("会话已结束", true, "ended"); });
  }

  // ===== App 层工具（无需 root/Shizuku，走 App 本地 HTTP 服务）=====
  // 这些能力由 DeepSeek Harness App 自身实现（UsageStats/悬浮窗权限），
  // 不依赖特权通道，因此即使未授权 root/Shizuku 也注册。

  // 应用使用时长（UsageStats：需用户在系统设置授予「使用情况访问」权限）
  ctx.tools.register(defineTool({
    name: "android_usage",
    description: "查询各应用使用时长（UsageStats）：最近 N 天每个应用的前台时长（毫秒/分钟），按时长降序。App 需已授予「使用情况访问」权限。",
    parameters: {
      days: { type: "number", description: "查询最近几天（默认 1，上限 30）" }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          error: { type: "string" },
          days: { type: "number" },
          count: { type: "number" },
          apps: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                pkg: { type: "string" },
                name: { type: "string" },
                ms: { type: "number" },
                min: { type: "number" }
              }
            }
          }
        }
      },
      render: (_a, v) => renderUsage(v)
    },
    async execute(args, exec) {
      const r = await appRequest("/usage", args.days ? { days: String(Math.max(1, Math.min(30, Number(args.days) || 1))) } : undefined);
      const apps = Array.isArray(r.apps) ? r.apps : [];
      return { ...r, count: apps.length };
    }
  }));

  // 小鲸鱼悬浮窗控制（含引擎状态显示；需已授予悬浮窗权限）
  //
  // v1.24：按维护者要求**默认不注册**这个工具（"感觉没什么用"）——
  // 显示/隐藏悬浮窗用户自己拖一下、或点常驻通知的「显示小鲸鱼」就够了，
  // 没必要占一个模型可见的工具位。**代码原样保留**，把下面开关改成 true 即可恢复
  // （App 侧路由 /overlay 与 OverlayService 都不受影响，仍然可用）。
  const ENABLE_OVERLAY_TOOL = false;
  if (ENABLE_OVERLAY_TOOL) {
  }   // ← if (ENABLE_OVERLAY_TOOL)

  // ==========================================================================
  // 免特权路径（v1.19）：列出应用 / 启动应用 —— 走 App 进程的 PackageManager。
  // 放在特权门控之前：无 root/Shizuku 时这两个工具依然可用（其余系统操作仍按下面的门控）。
  // 为什么免特权可行：本 App targetSdk=28，而 Android 11+ 的包可见性过滤只对 targetSdk≥30 生效，
  //   getInstalledApplications / getLaunchIntentForPackage 可直接看到/启动全部应用，无需 QUERY_ALL_PACKAGES。
  //   ⚠ 若将来把 targetSdk 提到 30+，必须补 <queries>(MAIN+LAUNCHER) 或 QUERY_ALL_PACKAGES。
  // 对应壳内路由：POST /packages、POST /app（token 鉴权，见 MainActivity.handlePackagesRequest/handleAppRequest）。
  // ==========================================================================
  ctx.tools.register(defineTool({
    name: "android_apps",
    description: "列出已安装应用：包名、显示名、是否系统应用、能否启动、版本号。免 root 与 Shizuku。默认按可启动优先排序；total 是匹配总数、count 是本次返回条数，被截断时用 filter 或 limit 收窄。要打开应用用 android_launch。",
    parameters: {
      filter: { type: "string", description: "按包名或显示名做不区分大小写的关键字过滤（只匹配这两者：搜 wechat 找不到「微信」，得用包名 com.tencent.mm）" },
      third_party_only: { type: "boolean", description: "true 只列第三方应用（排除系统应用）" },
      launchable_only: { type: "boolean", description: "true 只列有桌面入口、能被启动的应用" },
      limit: { type: "number", description: "最多返回条目数（默认 200，上限 1000）" }
    },
    output: {
      schema: resultSchema({
        total: { type: "number" },
        count: { type: "number" },
        apps: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              package: { type: "string", required: true },
              label: { type: "string" },
              system: { type: "boolean" },
              launchable: { type: "boolean" },
              versionName: { type: "string" }
            }
          }
        }
      }),
      render: (_args, value) => {
        if (!value.ok) return renderResult(value);
        const apps = Array.isArray(value.apps) ? value.apps : [];
        const lines = ["已安装应用：" + (value.total ?? apps.length) + " 个" +
          (value.count < value.total ? "（显示前 " + value.count + " 个）" : "")];
        for (const a of apps) {
          const flags = [];
          if (a.system) flags.push("系统");
          if (a.launchable === false) flags.push("无桌面入口");
          lines.push("- " + (a.label || "(无名)") + " (" + a.package + ")" +
            (a.versionName ? " v" + a.versionName : "") + (flags.length ? " [" + flags.join("/") + "]" : ""));
        }
        lines.push("");
        lines.push("启动：android_launch(package=\"…\")");
        return [{ type: "text", text: lines.join("\n") }];
      }
    },
    async execute(args) {
      const r = await appPost("/packages", {
        token: process.env.APP_LOCAL_TOKEN || "",
        ...(args.filter ? { filter: String(args.filter) } : {}),
        third_party_only: args.third_party_only === true,
        launchable_only: args.launchable_only === true,
        ...(args.limit !== undefined ? { limit: Number(args.limit) } : {})
      }, 20000);
      if (!r.ok) return { ok: false, error: r.error || "列出应用失败" };
      return {
        ok: true,
        total: typeof r.total === "number" ? r.total : (Array.isArray(r.apps) ? r.apps.length : 0),
        count: typeof r.count === "number" ? r.count : (Array.isArray(r.apps) ? r.apps.length : 0),
        apps: Array.isArray(r.apps) ? r.apps : []
      };
    }
  }));

  ctx.tools.register(defineTool({
    name: "android_launch",
    description: "启动一个已安装应用，免 root 与 Shizuku；package 用 android_apps 查到的包名。只走应用自身的桌面入口；要指定 activity 或在虚拟屏里启动用 android_app(action=launch)。",
    parameters: {
      package: { type: "string", required: true, description: "要启动的应用包名，如 com.android.settings" }
    },
    output: {
      schema: resultSchema({
        package: { type: "string" },
        component: { type: "string" },
        hint: { type: "string" }
      }),
      render: (_args, value) => {
        if (!value.ok) return renderResult(value);
        return [{ type: "text", text: "已启动：" + (value.package || "") + (value.component ? "（" + value.component + "）" : "") }];
      }
    },
    async execute(args) {
      if (!args.package) return { ok: false, error: "android_launch 需要 package 参数" };
      const r = await appPost("/app", { token: process.env.APP_LOCAL_TOKEN || "", package: String(args.package) }, 20000);
      if (!r.ok) {
        return {
          ok: false,
          error: r.error || "启动失败",
          hint: "可先把 DeepSeek Harness 切到前台再试（Android 10+ 后台启动 Activity 受限）；或授权 Shizuku/root 后用 android_app(action=launch)"
        };
      }
      return {
        ok: true,
        package: r.package || String(args.package),
        ...(r.component ? { component: String(r.component) } : {})
      };
    }
  }));

  // v1.22：免特权打开 URL / 深链（ACTION_VIEW）。
  // 背景（真机 Agent 复盘 §4）：让 AI「启动浏览器 → 点地址栏 → 输入网址 → 提交」要 15+ 步，
  // 而且 Chromium 下的 ACTION_SET_TEXT 一律 false、ACTION_PASTE 被输入法吃掉（落进候选条）、
  // 输入法的「确定」只收键盘不导航 —— 这条路基本不可用。一条 Intent 就能直达，且不依赖无障碍。
  ctx.tools.register(defineTool({
    name: "android_open_url",
    description: "用系统默认应用打开 URL 或深链（ACTION_VIEW），免 root 与 Shizuku。打开网页、唤起深链（https://、market://、weixin:// 等）一律优先用它，不要走「在浏览器里点地址栏→输入→提交」：实测 Chromium 无障碍下极不可靠（setText 返回 false、粘贴被输入法吃掉），且要十几步。\n返回 ok 只表示 Intent 已发出，系统能不能处理由系统决定（没装对应 App 会失败）；要确认界面真的换了，接着读一次 android_accessibility_screen / android_accessibility_see。",
    parameters: {
      url: { type: "string", required: true, description: "要打开的 URL 或深链，如 https://example.com 或 market://details?id=com.tencent.mm" },
      package: { type: "string", description: "可选：指定交给哪个应用处理（如 com.android.chrome、com.microsoft.emmx）" },
      wait_ms: { type: "number", description: "可选：发出后等待多少毫秒再返回（默认 0；给 1500~3000 让界面有时间切过去）" }
    },
    output: {
      schema: resultSchema({
        url: { type: "string" },
        package: { type: "string" },
        hint: { type: "string" }
      }),
      render: (_args, value) => {
        if (!value.ok) return renderResult(value);
        return [{ type: "text", text: "已请求打开：" + (value.url || "") + (value.package ? "（交给 " + value.package + "）" : "") }];
      }
    },
    async execute(args) {
      if (!args.url) return { ok: false, error: "android_open_url 需要 url 参数" };
      const body = { token: process.env.APP_LOCAL_TOKEN || "", url: String(args.url) };
      if (args.package) body.package = String(args.package);
      const r = await appPost("/openurl", body, 20000);
      if (!r.ok) {
        return {
          ok: false,
          error: r.error || "打开失败",
          hint: "提示「没有可处理该链接的应用」说明设备上没装对应 App（可先用 android_apps 确认）；" +
            "若提示后台启动受限，先把 DeepSeek Harness 切到前台再试。"
        };
      }
      const waitMs = Math.max(0, Math.min(8000, Number(args.wait_ms) || 0));
      if (waitMs) await new Promise((res) => setTimeout(res, waitMs));
      return {
        ok: true,
        url: r.url || String(args.url),
        ...(r.package ? { package: String(r.package) } : {})
      };
    }
  }));

  // v1.22（复盘）：通用 Intent 发起器 —— 打开网页只是其中一种。
  // 与 android_open_url 的区别：可指定 action / type / extras（例如测试"某 App 能不能被深链唤起"）。
  ctx.tools.register(defineTool({
    name: "android_open_intent",
    description: "发起通用 Intent（免特权）：action（默认 view）、url/data、package（指定由谁处理）、type、extras。用于打开网页、唤起深链（weixin://、alipays://）、测试某 App 是否响应某 Intent。返回 ok 只表示 Intent 已发出；要确认界面真的换了，接着读一次 android_accessibility_screen / android_accessibility_see。",
    parameters: {
      action: { type: "string", description: "Intent action，如 android.intent.action.VIEW / SEND / DIAL（默认 VIEW）" },
      url: { type: "string", description: "data URI，如 https://… / weixin:// / tel:10086" },
      package: { type: "string", description: "可选：指定交给哪个应用处理" },
      type: { type: "string", description: "可选：MIME type，如 text/plain" },
      extras: { type: "string", description: "可选：JSON 对象字符串，如 {\"key\":\"value\"}（值支持字符串/整数/布尔）" },
      wait_ms: { type: "number", description: "可选：发出后等待毫秒再返回（默认 0）" }
    },
    output: {
      schema: resultSchema({
        url: { type: "string" },
        action: { type: "string" },
        package: { type: "string" },
        hint: { type: "string" }
      }),
      render: (_a, value) => {
        if (!value.ok) return renderResult(value);
        return [{ type: "text", text: "已发起 Intent：" + (value.action || "VIEW") + " "
          + (value.url || "") + (value.package ? "（交给 " + value.package + "）" : "") }];
      }
    },
    async execute(args) {
      if (!args.url && !args.action) return { ok: false, error: "android_open_intent 至少需要 url 或 action" };
      const body = { token: process.env.APP_LOCAL_TOKEN || "" };
      if (args.url) body.url = String(args.url);
      if (args.action) body.action = String(args.action);
      if (args.package) body.package = String(args.package);
      if (args.type) body.type = String(args.type);
      if (args.extras) {
        try { JSON.parse(String(args.extras)); body.extras = JSON.parse(String(args.extras)); }
        catch (e) { return { ok: false, error: "extras 不是合法 JSON：" + e.message }; }
      }
      const r = await appPost("/openurl", body, 20000);
      if (!r.ok) return { ok: false, error: r.error || "Intent 发起失败" };
      const waitMs = Math.max(0, Math.min(8000, Number(args.wait_ms) || 0));
      if (waitMs) await new Promise((res) => setTimeout(res, waitMs));
      return {
        ok: true,
        ...(r.url ? { url: String(r.url) } : {}),
        ...(r.action ? { action: String(r.action) } : {}),
        ...(r.resolved ? { package: String(r.resolved) } : {})
      };
    }
  }));

    async function apkExtractImpl(args) {
      if (!args.package) return { ok: false, error: "android_apk_extract 需要 package 参数" };
      if (!args.entry && !args.prefix) return { ok: false, error: "需要 entry（单个）或 prefix（前缀）" };
      const body = { token: process.env.APP_LOCAL_TOKEN || "", action: "extract", package: String(args.package) };
      if (args.entry) body.entry = String(args.entry);
      if (args.prefix) body.prefix = String(args.prefix);
      if (args.out_dir) body.out_dir = String(args.out_dir);
      const r = await appPost("/apk", body, 120000);
      if (!r.ok) {
        return { ok: false, error: r.error || "解包失败",
          hint: "先用 android_apk_info(list=true) 看包内条目名，再决定 entry / prefix。" };
      }
      return {
        ok: true,
        outDir: r.outDir || "",
        files: Array.isArray(r.files) ? r.files.join("\n") : String(r.files || ""),
        copied: typeof r.copied === "number" ? r.copied : 0,
        bytes: typeof r.bytes === "number" ? r.bytes : 0
      };
    }

  // v1.22（复盘 §5）：免特权查看 / 解包已安装应用的 APK —— 逆向侦查入口（纪律：只读）
  ctx.tools.register(defineTool({
    name: "android_apk",
    description: "查看一个已安装应用的 APK：路径、大小、应用名，或列出包内条目（action=list）。免特权。用于逆向侦查（找 JS bundle、接口表、资源、manifest），不需要设备有 unzip。\n只读：读别人的安装包在 Android 上是正常操作，但不要用它去改动他人的应用。",
    parameters: {
      op: { type: "string", enum: ["info", "extract"], description: "info=读 APK 元数据（默认）；extract=从 APK 里取出某个文件" },
      package: { type: "string", required: true, description: "包名（用 android_apps 查）" },
      list: { type: "boolean", description: "true = 附带包内条目清单（默认 false 只回路径/大小）" },
      limit: { type: "number", description: "list 时最多列多少条（默认 2000）" }
    },
    output: {
      schema: resultSchema({
        apk: { type: "string" },
        sizeBytes: { type: "number" },
        label: { type: "string" },
        total: { type: "number" },
        truncated: { type: "boolean" },
        entriesText: { type: "string" },
        hint: { type: "string" }
      }),
      render: (_a, value) => {
        if (!value.ok) return renderResult(value);
        const head = "APK：" + (value.apk || "") + "（" + Math.round((value.sizeBytes || 0) / 1024) + " KB）"
          + (value.label ? " · " + value.label : "");
        if (!value.entriesText) return [{ type: "text", text: head }];
        return [{ type: "text", text: head + "\n包内条目 " + (value.total || 0) + " 条"
          + (value.truncated ? "（已截断）" : "") + "：\n" + value.entriesText }];
      }
    },
    async execute(args) {
      if (String(args.op || "info") === "extract") return await apkExtractImpl(args, exec);
      if (!args.package) return { ok: false, error: "android_apk_info 需要 package 参数" };
      const body = { token: process.env.APP_LOCAL_TOKEN || "", action: args.list === true ? "list" : "path", package: String(args.package) };
      if (args.limit !== undefined) body.limit = Number(args.limit);
      const r = await appPost("/apk", body, 60000);
      if (!r.ok) return { ok: false, error: r.error || "读取 APK 失败" };
      return {
        ok: true,
        apk: r.apk || "",
        sizeBytes: typeof r.sizeBytes === "number" ? r.sizeBytes : 0,
        ...(r.label ? { label: String(r.label) } : {}),
        ...(typeof r.total === "number" ? { total: r.total, truncated: r.truncated === true } : {}),
        ...(r.entriesText ? { entriesText: String(r.entriesText) } : {}),
        ...(r.hint ? { hint: String(r.hint) } : {})
      };
    }
  }));



  // ===== v1.23：让 agent 通过悬浮窗小人的消息气泡"说一句话" =====
  // 上限：中文（含全角标点）≤ 20 个、其它字符 ≤ 40 个，两类分开计、互不挤占。
  // 为什么分开：气泡是单行（setSingleLine + TruncateAt.END，最宽 240dp），一个汉字约占
  // 两个半角宽，所以两类的合理上限不同。超限时本工具直接报错（让 agent 自己改短），
  // 而不是静默截断；App 侧仍按同一规则兜底截断。
  const BUBBLE_CJK_RE = /[\u3000-\u303F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]|[\u{20000}-\u{2FA1F}]/u;
  // 长度按"汉字宽"计：汉字/全角 = 1，其它字符 = 0.5，合计上限 20（即 20 汉字或 40 英文字母）。
  const BUBBLE_BUDGET = 20;
  const countBubbleCost = (s) => {
    let cost = 0;
    let cjk = 0;
    let other = 0;
    for (const ch of String(s)) {
      if (BUBBLE_CJK_RE.test(ch)) { cost += 1; cjk++; } else { cost += 0.5; other++; }
    }
    return { cost, cjk, other };
  };
  ctx.tools.register(defineTool({
    name: "android_say",
    description:
      "让悬浮窗小人头顶气泡显示一句话（给用户看的即时消息，如「稍等，我在查资料」）。" +
      "长度上限 " + BUBBLE_BUDGET + " 个汉字宽：汉字与全角标点算 1，其它字符（英文/数字/符号/emoji）算 0.5，" +
      "即 20 汉字或 40 英文字母封顶；超限直接报错。" +
      "本次调用会阻塞 ttl 秒（1~600）：气泡显示 ttl 秒后消失，工具正好在它消失时返回 —— " +
      "想让用户看清就设长些，只打个招呼 3~5 秒够用。" +
      "气泡与 agent 状态共用同一位置：期间若有别的气泡或状态推送会提前把它顶掉，但调用仍等满 ttl。",
    parameters: {
      text: { type: "string", required: true, description: "要显示的话，合计不超过 " + BUBBLE_BUDGET + " 个汉字宽（汉字算 1、其它字符算 0.5）" },
      ttl: { type: "number", required: true, description: "气泡显示多少秒（也是本次调用阻塞的秒数）。1~600" }
    },
    output: {
      schema: resultSchema({
        text: { type: "string" },
        ttlSeconds: { type: "number" },
        cjk: { type: "number" },
        other: { type: "number" },
        cost: { type: "number" },
        budget: { type: "number" },
        truncated: { type: "boolean" },
        running: { type: "boolean" },
        hint: { type: "string" }
      }),
      render: (_a, value) => {
        if (!value.ok) return renderResult(value);
        return [{ type: "text", text: "气泡「" + (value.text || "") + "」已显示并等待 "
          + (value.ttlSeconds || 0) + " 秒后消失"
          + "（用量 " + (value.cost || 0) + "/" + (value.budget || BUBBLE_BUDGET) + " 个汉字宽"
          + "：汉字 " + (value.cjk || 0) + " + 其它 " + (value.other || 0) + "）"
          + (value.truncated ? "，被截断" : "")
          + (value.running === false ? "（悬浮窗没开，用户看不到）" : "") }];
      }
    },
    async execute(args) {
      const raw = args.text === undefined ? "" : String(args.text);
      if (!raw) return { ok: false, error: "android_say 需要 text 参数" };
      const cnt = countBubbleCost(raw);
      if (cnt.cost > BUBBLE_BUDGET) {
        return {
          ok: false,
          error: "超出气泡长度上限：本次 " + cnt.cost + "/" + BUBBLE_BUDGET + " 个汉字宽"
            + "（汉字 " + cnt.cjk + " 个 + 其它字符 " + cnt.other + " 个×0.5）",
          cjk: cnt.cjk,
          other: cnt.other,
          cost: cnt.cost,
          budget: BUBBLE_BUDGET,
          hint: "改短后重试。20 个汉字、40 个英文字母、或 10 个汉字加 20 个字母都算满；细节用 android_accessibility_screen / android_accessibility_see 交待。"
        };
      }
      const ttlNum = Number(args.ttl);
      if (!Number.isFinite(ttlNum) || ttlNum < 1 || ttlNum > 600) {
        return {
          ok: false,
          error: "ttl 需要是 1~600 之间的秒数：本次 " + (args.ttl === undefined ? "未传" : String(args.ttl)),
          hint: "ttl 既是气泡停留时长，也是本次调用的阻塞时长；一般任务给 3~10 秒，需要用户读完再给长一些。"
        };
      }
      const secs = Math.round(ttlNum);
      const body = { token: process.env.APP_LOCAL_TOKEN || "", action: "bubble", text: raw, ttl: String(secs * 1000) };
      const r = await appPost("/overlay", body, 8000);
      if (!r.ok) {
        return {
          ok: false,
          error: r.error || "App 本地服务未响应",
          hint: "App 没在跑、或悬浮窗没开时无法显示气泡；可先用 android_accessibility_capabilities 看状态。"
        };
      }
      // 设计：调用阻塞 ttl 秒 —— 返回的那一刻，气泡正好按 App 侧计时器消失。
      await new Promise((resolve) => setTimeout(resolve, secs * 1000));
      return {
        ok: true,
        text: r.bubble !== undefined ? String(r.bubble) : raw,
        ttlSeconds: secs,
        cjk: typeof r.cjk === "number" ? r.cjk : cnt.cjk,
        other: typeof r.ascii === "number" ? r.ascii : cnt.other,
        cost: typeof r.cost === "number" ? r.cost : cnt.cost,
        budget: typeof r.budget === "number" ? r.budget : BUBBLE_BUDGET,
        truncated: r.truncated === true,
        running: r.running === true
      };
    }
  }));

  // 未授予 root 且未授予 Shizuku 时：不注册下面这些系统操作工具（android_package 等），
  // AI 工具列表里没有特权工具，就不会反复尝试系统操作；
  // 此时文件读写用 DSH 自带的 fs/bash 工具（只需所有文件访问权限）。
  // ── 免特权的设备工具（v1.23：从 dsh-tool-shizuku 搬来，它们不需要 root/Shizuku）──
  ctx.tools.register(defineTool({
    name: "android_notify",
    description: "向用户手机发送一条系统通知（标题 + 正文）。**只需要通知权限（POST_NOTIFICATIONS），不需要 Shizuku/root**。用于：后台任务完成、需要用户关注、长时间任务的进度提醒等。如果返回 ok:false 且提示通知权限未授予，请让用户在系统设置里为本应用开启通知权限后重试。",
    parameters: {
      title: {
        type: "string",
        required: true,
        description: "通知标题，简短（建议不超过 20 字）。"
      },
      text: {
        type: "string",
        required: true,
        description: "通知正文，说明发生了什么或需要用户做什么。"
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          error: { type: "string" },
          posted: { type: "boolean" },
          visible: { type: "boolean" },
          evidence: { type: "string" }
        }
      },
      render: (_args, value) => [{
        type: "text",
        text: value.ok
          ? "通知已发送 ✅" + (typeof value.visible === "boolean"
              ? "（通知栏可见：" + (value.visible ? "是" : "**否**") + "）" : "")
          : "通知发送失败：" + (value.error || "未知错误")
      }]
    },
    async execute(args) {
      try {
        const http = await import("node:http");
        const port = Number(process.env.APP_NOTIFY_PORT) || 3081;
        const body = JSON.stringify({ title: String(args.title || ""), text: String(args.text || "") });
        const result = await new Promise((resolve) => {
          const req = http.request({
            host: "127.0.0.1",
            port,
            path: "/notify",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(body),
              // v1.18.0：本地服务全路由鉴权，通知也必须带令牌
              "X-DSH-Token": process.env.APP_LOCAL_TOKEN || ""
            }
          }, (res) => {
            let d = "";
            res.on("data", (c) => d += c);
            res.on("end", () => {
              try { resolve(JSON.parse(d || "{}")); }
              catch (e) { resolve({ ok: false, error: "响应解析失败" }); }
            });
          });
          req.setTimeout(5000, () => { req.destroy(); resolve({ ok: false, error: "通知服务超时" }); });
          req.on("error", (e) => resolve({
            ok: false,
            error: "通知服务不可用（" + String((e && e.message) || e) + "）："
                 + "App 或它的通知服务没在运行（端口无监听）——先在 App 里启动引擎再重试"
          }));
          req.write(body);
          req.end();
        });
        if (!result || result.ok !== true) return { ...result, posted: false };
        // v1.20.5（用户反馈）：没有 Shizuku/root 时 privCmd 根本执行不了 dumpsys，
        // 以前把"查不到"当成"不可见"（visible:false）——这是最误导人的一点。
        // 无特权通道时**不返回 visible**（schema 是 boolean，不能给 null），只说明无法校验。
        if (!privilegedAvailable()) {
          return {
            ok: true,
            posted: true,
            evidence: "已发送（App 侧返回成功），但无法校验通知栏：读写 dumpsys 需要 Shizuku/root。"
                    + "请用户自己下拉通知栏确认；若确实没出现，多半是该应用通知被系统关了"
                    + "（设置 → 通知 → DeepSeek Harness）。"
          };
        }
        // v1.20.1（AI 建议③）：发完立刻用特权 shell 校验标题/正文是否真的在通知栏里，
        // 别让"App 说发送成功、系统其实静默拦截"变成假成功（标题/正文在 dumpsys 里是两行）。
        await sleep(700);
        const title = String(args.title || "");
        const text = String(args.text || "");
        const vt = await privCmd("dumpsys notification --noredact 2>/dev/null | grep -F " + shq(title) + " | head -2", 15000);
        const vx = await privCmd("dumpsys notification --noredact 2>/dev/null | grep -F " + shq(text) + " | head -2", 15000);
        const lines = [vt.stdout, vx.stdout].map((s) => String(s || "").trim()).filter(Boolean);
        const visible = lines.length >= 2;
        return {
          ok: true,
          posted: true,
          visible,
          evidence: lines.join(" | ").slice(0, 500)
        };
      } catch (e) {
        return { ok: false, posted: false, error: String(e && e.message || e) };
      }
    }
  }));

  ctx.tools.register(defineTool({
    name: "android_setting_app",
    description:
      "读写 App 自身的 Settings.System 设置。**写入不需要 Shizuku/root**（只需「修改系统设置」WRITE_SETTINGS 权限）；" +
      "读取走特权 shell 的 settings get（需要 Shizuku/root 任一）。" +
      "常用 key：screen_brightness（亮度 0-255）、screen_brightness_mode（0=手动 1=自动）、screen_off_timeout（屏幕超时毫秒，如 60000）、" +
      "accelerometer_rotation（自动旋转 0/1）、font_scale（字体大小，如 1.0/1.3）、volume_music/volume_ring/volume_alarm/volume_notification（音量 0-15）、" +
      "sound_effects_enabled（触摸音 0/1）、haptic_feedback_enabled（震动反馈 0/1）、notification_light_pulse（通知灯 0/1）、ringtone（铃声 Uri）。" +
      "put 会带回 oldValue/newValue（一次调用就能确认翻转与还原）；改 Global/Secure 命名空间请用 shizuku_shell 的 settings 命令。",
    parameters: {
      action: {
        type: "string", enum: ["get", "put"],
        description: "get=读当前值（走特权 shell）；put=写入（缺省，走 App WRITE_SETTINGS）"
      },
      key: {
        type: "string", required: true,
        description: "Settings.System 的 key（见工具描述常用清单）"
      },
      value: {
        type: "string",
        description: "put 时要写入的值（数字或字符串）；action=get 时可省略"
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          error: { type: "string" },
          namespace: { type: "string" },
          key: { type: "string" },
          value: { type: "string" },
          oldValue: { type: "string" },
          newValue: { type: "string" },
          stream: { type: "string" },
          level: { type: "number" },
          max: { type: "number" },
          hint: { type: "string" }
        }
      },
      render: (_args, value) => [{
        type: "text",
        text: value.ok
          ? (value.action === "get" || (value.value !== undefined && value.newValue === undefined)
              ? (value.key || "?") + " = " + (value.value === "" ? "(空)" : value.value)
              : (value.stream
                  ? "已设置 " + value.stream + " = " + value.level + "（最大 " + value.max + "）✅"
                  : (value.oldValue !== undefined && value.newValue !== undefined
              ? "已设置 " + (value.key || "?") + "：" + value.oldValue + " → " + value.newValue
              : "已设置 " + (value.key || "?") + "（读回不可用）") + " ✅"))
          : (_args && String(_args.action || "put").toLowerCase() === "get"
              ? "读取失败：" + (value.error || "未知错误")
              : "设置失败：" + (value.error || "未知错误"))
      }]
    },
    async execute(args) {
      const action = String(args.action || "put").toLowerCase();
      const key = String(args.key || "");
      if (!key) return { ok: false, error: "缺少 key 参数" };
      try {
        // 读当前值：特权 shell（输出可能落在 stdout 或 stderr，统一取非空的那个）
        const readKey = async () => {
          const r = await privCmd("settings get system " + shq(key), 15000);
          const v = String(r.stdout || "").trim();
          // 只认 stdout 的真实值：特权通道超时时 stderr 是错误文本，不能当 oldValue/newValue
          return { ok: r.ok === true && v !== "" && v !== "null", value: v, raw: r };
        };
        if (action === "get") {
          const cur = await readKey();
          return {
            ok: cur.ok,
            namespace: "system",
            key,
            value: cur.value,
            ...(cur.ok ? {} : { error: cur.raw.error || ("读不到 " + key) })
          };
        }
        const before = await readKey();
        const val = String(args.value == null ? "" : args.value);
        const http = await import("node:http");
        const port = Number(process.env.APP_NOTIFY_PORT) || 3081;
        const body = JSON.stringify({ key, value: val });
        const posted = await new Promise((resolve) => {
          const req = http.request({
            host: "127.0.0.1", port, path: "/setting", method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(body),
              // v1.18.0：本地服务全路由鉴权
              "X-DSH-Token": process.env.APP_LOCAL_TOKEN || ""
            }
          }, (res) => {
            let d = "";
            res.on("data", (c) => d += c);
            res.on("end", () => {
              try { resolve(JSON.parse(d || "{}")); }
              catch (e) { resolve({ ok: false, error: "响应解析失败" }); }
            });
          });
          req.setTimeout(5000, () => { req.destroy(); resolve({ ok: false, error: "本地服务超时" }); });
          req.on("error", (e) => resolve({ ok: false, error: String(e && e.message || e) }));
          req.write(body);
          req.end();
        });
        if (!posted || posted.ok !== true) {
          return { ...posted, ok: false, namespace: "system", key, oldValue: before.value };
        }
        await sleep(250);
        const after = await readKey();
        // 音量类由 App 返回 stream/level/max；普通 key 由回读得到 newValue
        return {
          ...posted,
          ok: true,
          namespace: "system",
          key,
          ...(before.ok ? { oldValue: before.value } : {}),
          ...((after.ok || typeof posted.level === "number")
              ? { newValue: typeof posted.level === "number" ? String(posted.level) : after.value }
              : {}),
          ...(!before.ok && !after.ok ? { hint: "写入已完成；读回不可用（特权通道超时）" } : {})
        };
      } catch (e) {
        return { ok: false, error: String(e && e.message || e) };
      }
    }
  }));

  ctx.tools.register(defineTool({
    name: "android_clipboard",
    description: "读写手机剪贴板。**不需要 Shizuku/root 和任何特殊权限**。action=read 读取当前剪贴板内容；action=write 把 content 写入剪贴板（如 AI 生成代码/文本后让用户粘贴）。",
    parameters: {
      action: {
        type: "string", required: true,
        enum: ["read", "write"],
        description: "read=读取剪贴板内容；write=写入剪贴板（需带 content）"
      },
      content: { type: "string", description: "write 时要写入的文本内容" }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          content: { type: "string" },
          error: { type: "string" }
        }
      },
      render: (_args, value) => [{
        type: "text",
        text: value.ok
          ? (value.content !== undefined
              ? (value.content === ""
                  ? "剪贴板内容为空（可能是剪贴板本来为空，或系统限制后台读取）"
                  : "剪贴板内容：\n" + value.content)
              : "已写入剪贴板 ✅")
          : "剪贴板操作失败：" + (value.error || "未知错误")
      }]
    },
    async execute(args) {
      try {
        const http = await import("node:http");
        const port = Number(process.env.APP_NOTIFY_PORT) || 3081;
        const body = JSON.stringify({
          action: String(args.action || "read"),
          content: String(args.content == null ? "" : args.content)
        });
        const result = await new Promise((resolve) => {
          const req = http.request({
            host: "127.0.0.1", port, path: "/clipboard", method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(body),
              // v1.18.0：本地服务全路由鉴权
              "X-DSH-Token": process.env.APP_LOCAL_TOKEN || ""
            }
          }, (res) => {
            let d = "";
            res.on("data", (c) => d += c);
            res.on("end", () => {
              try { resolve(JSON.parse(d || "{}")); }
              catch (e) { resolve({ ok: false, error: "响应解析失败" }); }
            });
          });
          req.setTimeout(5000, () => { req.destroy(); resolve({ ok: false, error: "本地服务超时" }); });
          req.on("error", (e) => resolve({ ok: false, error: String(e && e.message || e) }));
          req.write(body);
          req.end();
        });
        return result;
      } catch (e) {
        return { ok: false, error: String(e && e.message || e) };
      }
    }
  }));

  if (!privilegedAvailable()) return;





}

export { apply, inject, name };
