/**
 * 虚拟屏幕插件（v1.11）：给 AI 提供真正的独立虚拟屏（createVirtualDisplay）能力。
 *
 * v1.11（2026-10-18，AI 试用反馈）：动作可验证 / 参数不踩空——
 *   · launch 透出 package/component/displayId，并用启动前后截图 sha256 回 screenChanged（不再「假成功」）；
 *   · see 支持 waitMs 轮询 + errorCode（no_display / not_rendered / no_frame），用 status 的 hasFrame 判别；
 *   · create 接受 orientation=0/1/"0"/portrait 并回 displayId/尺寸/dpi；key 支持 KEYCODE_BACK 等别名。
 *
 * v1.10 架构：虚拟屏服务由 App 进程内嵌启动（打开 App 即自动运行，监听 8999）——
 * 不再需要 root/Shizuku 启动特权进程（shell/app_process 在 Android 15 enforcing 下
 * createVirtualDisplay 被 Binder 拒：Bad fd）。预览是 App 内 H264 悬浮窗（建屏自动弹出，
 * 可拖动/缩放），AI 通过本插件的 see 拿截图，tap/swipe/key/launch 通过 Shizuku
 * `input -d` / `am start --display` 注入（App 域注入被 InputDispatcher 拒）。
 *
 * 本插件职责：
 *   1）等待 App 已启动的 server（打开 App 一次即可，无需授权特权）；
 *   2）把 8 个工具（create/status/launch/see/tap/swipe/key/close）映射到 server 的 HTTP API。
 *
 * 依赖：App 已安装并打开过一次；Android 11+（createVirtualDisplay）。
 * 注意：DSH 工具输出校验为 additionalProperties:false——execute 返回的每个字段
 * 都必须在 output.schema 中显式声明，否则结果会被判定为非法输出（历史踩坑）。
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { get as httpGet, request as httpRequest } from "node:http";

const name = "tool-vscreen";
const inject = ["tools"];

const APP_PROC = "/system/bin/app_process";
const VS_DEX = "/data/local/tmp/vscreen_shizuku.jar"; // server jar 位置（特权可读）
// v1.18（B12）：桥/核心端口与主类随变体（由壳注入 env，见 android-app/variants.sh）。
//   official 8999/8998 · lite 9009/9008 · compat 9019/9018 · community 9029/9028
// 每个变体一段独立端口，同一设备上两个变体同时运行虚拟屏不再互斥（原为硬编码 8999/8998）。
const APP_ID = process.env.DSH_APP_ID || "com.deepseek.harness";
const SERVER_PORT = Number(process.env.DSH_VS_BRIDGE_PORT || 8999);
const CORE_PORT = Number(process.env.DSH_VS_CORE_PORT || 8998);
const SERVER_MAIN = APP_ID + ".vscreen.Main";
const MAX_STDOUT = 8000;
const MAX_STDERR = 2000;
const START_TIMEOUT_MS = 12000; // 等 server 起来

const GUIDE_NO_PRIV =
  "虚拟屏需要系统特权（root 或 Shizuku）：请在 App 权限页授权 Shizuku（或 root），然后重试。";
const GUIDE_NO_SERVER =
  "虚拟屏幕服务不可用：可能未授权特权，或服务启动失败。请确认已授权 Shizuku/root 后重试。";

/** 特权通道是否可用（root 或 Shizuku 任一授予即可）。 */
function privilegedAvailable() {
  return process.env.ROOT_AVAILABLE === "1" || process.env.SHIZUKU_AVAILABLE === "1";
}

/** 剥离会污染系统 app_process 链接的环境变量（DSH 的 LD_LIBRARY_PATH 会弄坏 app_process）。 */
function sanitizeEnv(env) {
  const clean = { ...env };
  delete clean.LD_LIBRARY_PATH;
  delete clean.LD_PRELOAD;
  delete clean.LD_DEBUG;
  return clean;
}

/** 确保 dex 只读（Android 15 ART 拒绝 uid 可写的 dex）。 */
function ensureDexReadOnly(dex) {
  try {
    if (dex && existsSync(dex)) chmodSync(dex, 0o444);
  } catch (_) {}
}

/** 异步执行一条特权 shell 命令（root 或 Shizuku 通道，返回统一结构）。 */
function privShell(command, timeoutMs) {
  const timeout = Math.max(1000, Math.min(timeoutMs || 30000, 120000));
  const target = process.env.ROOT_AVAILABLE === "1" ? "su" : APP_PROC;
  return new Promise((resolve) => {
    let child;
    try {
      if (process.env.ROOT_AVAILABLE === "1") {
        child = spawn("su", ["-c", command], { env: sanitizeEnv(process.env), stdio: ["ignore", "pipe", "pipe"] });
      } else {
        ensureDexReadOnly(process.env.SHIZUKU_DEX);
        child = spawn(APP_PROC, [
          `-Djava.class.path=${process.env.SHIZUKU_DEX}`,
          "/system/bin",
          "--nice-name=rish",
          "rikka.shizuku.shell.ShizukuShellLoader",
          "-c", command
        ], { env: { ...sanitizeEnv(process.env), RISH_APPLICATION_ID: process.env.SHIZUKU_APP_ID || APP_ID }, stdio: ["ignore", "pipe", "pipe"] });
      }
    } catch (e) {
      resolve({ ok: false, exit_code: -1, stdout: "", stderr: "", error: String(e && e.message || e) });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch (_) {} }, timeout);
    const finish = (ok, code, err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, exit_code: code, stdout: stdout.trim().slice(0, MAX_STDOUT), stderr: stderr.trim().slice(0, MAX_STDERR), ...(err ? { error: err } : {}) });
    };
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (e) => finish(false, -1, String(e && e.message || e)));
    child.on("close", (code, signal) => {
      const killed = signal === "SIGKILL" && code === null;
      if (killed) finish(false, -1, "命令超时（" + timeout + "ms）被强制终止");
      else finish(code === 0, code ?? -1, undefined);
    });
  });
}

/** 后台启动 vscreen server（如果还没起来）。 */
async function ensureServer() {
  if (await serverAlive()) return { ok: true };

  // v1.10：插件自己不拉起服务端——App 打开的桥（VsreenBridgeService，监听本变体桥端口）会负责拉起。
  // 注意：这里“插件无需特权”≠“功能无需特权”。桥要用 Shizuku/root 把**核心**（本变体核心端口）
  // 以 shell 身份拉起来，所以虚拟屏整体仍需 Shizuku 或 root；无它时核心起不来、全功能不可用。
  // （但**不需要无障碍**：点击走 shell 的 `input -d <displayId>`，截图走 ImageReader 直接从虚拟屏取帧。）
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    if (await serverAlive()) return { ok: true };
  }
  const logTail = await readLogTail(60);
  return {
    ok: false,
    error:
      "虚拟屏服务未就绪（" + (logTail ? "日志：" + logTail + "；" : "") +
      "）。请先打开一次 DeepSeek Harness App（App 会自动启动虚拟屏服务，无需授权特权）后重试。"
  };
}

/** 读取 /data/local/tmp/vscreen.log 末尾 N 字符（特权通道读，失败返回空串）。 */
async function readLogTail(maxChars) {
  try {
    const r = await privShell(`tail -c ${maxChars} /data/local/tmp/vscreen.log 2>/dev/null || echo __NOLOG__`, 4000);
    const out = (r.stdout || "").trim();
    if (!out || out.includes("__NOLOG__") || out.includes("No such file")) return "";
    return out.replace(/\n/g, " | ");
  } catch (_) {
    return "";
  }
}

/** 探测 server 是否在监听。 */
function serverAlive() {
  return new Promise((resolve) => {
    const req = httpGet({
      host: "127.0.0.1",
      port: SERVER_PORT,
      path: "/vscreen/status",
      timeout: 1500,
      // v1.18.0：8999 桥要校验调用方
      headers: { "X-DSH-Token": process.env.APP_LOCAL_TOKEN || "" }
    }, (res) => {
      let d = ""; res.setEncoding("utf8");
      res.on("data", (c) => { d += c; if (d.length > 4096) req.destroy(); });
      res.on("end", () => resolve(true));
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.end();
  });
}

/** 调 server HTTP API，返回 JSON。 */
function vsReq(path, timeoutMs) {
  return new Promise((resolve) => {
    const req = httpGet({
      host: "127.0.0.1",
      port: SERVER_PORT,
      path,
      timeout: timeoutMs || 8000,
      // v1.18.0：8999 桥要校验调用方
      headers: { "X-DSH-Token": process.env.APP_LOCAL_TOKEN || "" }
    }, (res) => {
      let d = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { d += c; if (d.length > 1024 * 1024) req.destroy(); });
      res.on("end", () => resolve(safeParse(d)));
    });
    req.on("error", () => resolve({ ok: false, error: GUIDE_NO_SERVER }));
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "虚拟屏服务超时" }); });
    req.end();
  });
}

function safeParse(raw) {
  try { return JSON.parse(raw); } catch (e) { return { ok: false, error: "响应解析失败: " + String(raw).slice(0, 120) }; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 强制关闭 server（可选）。v1.18（B12）：按变体包名匹配，避免杀掉别的变体的 core。 */
async function killServer() {
  await privShell("pkill -f " + APP_ID + ".vscreen.Main || true", 5000);
}

/** DSH 个别路径可能以缺失 value 调用 render（历史回放/旧参数）；兜底避免整次工具调用失败，并把入参暴露出来便于定位。 */
const renderValue = (value, args) => (value && typeof value === "object" ? value : {
  ok: false,
  error: "工具未返回结果（render 收到空值；入参 " + JSON.stringify(args === void 0 ? null : args) + "）"
});

const renderOp = (_args, value) => {
  value = renderValue(value, _args);
  return [{
    type: "text",
    text: value.ok ? "操作成功。" : "执行失败：" + (value.error || "未知错误")
  }];
};

/** create 渲染：直接把 displayId / 实际尺寸 / dpi 说清楚，省掉创建后再调一次 status。 */
function renderCreate(_args, value) {
  value = renderValue(value, _args);
  if (!value.ok) return [{ type: "text", text: "创建失败：" + (value.error || "未知错误") }];
  const size = (typeof value.width === "number" ? value.width : 0) + "x" + (typeof value.height === "number" ? value.height : 0);
  const lines = ["虚拟屏已就绪：displayId=" + value.displayId + "，" + size + " @" + value.dpi + "dpi"];
  if (value.orientation) lines.push("朝向：" + value.orientation);
  if (value.reused) lines.push("（复用了已存在的同尺寸虚拟屏，未重建）");
  lines.push("下一步：android_vscreen_launch 把 app 启动到这块屏，或 android_vscreen_see 截图。");
  return [{ type: "text", text: lines.join("\n") }];
}

// ==================== v1.11：参数归一 + 可验证 ====================

/** orientation 归一：portrait/landscape 与 0/1（含字符串 "0"/"1"）都收；非法值返回 ""。 */
function normalizeOrientation(raw) {
  if (typeof raw === "number") return raw === 1 ? "landscape" : (raw === 0 ? "portrait" : "");
  const s = String(raw == null ? "" : raw).trim().toLowerCase();
  if (s === "" ) return "";
  if (s === "0" || s === "portrait" || s === "vertical" || s === "v" || s === "p") return "portrait";
  if (s === "1" || s === "landscape" || s === "horizontal" || s === "h" || s === "l") return "landscape";
  return "";
}

const ORIENTATION_ACCEPTED = ["portrait", "landscape", 0, 1];

/** 按键归一：back/home/enter/menu/volume_up/volume_down/app_switch，兼容 KEYCODE_BACK / BACK / 4 等写法。 */
const KEYCODES = { back: 4, home: 3, enter: 66, menu: 82, volume_up: 24, volume_down: 25, app_switch: 187 };
const KEYCODE_BY_NUM = { 4: "back", 3: "home", 66: "enter", 82: "menu", 24: "volume_up", 25: "volume_down", 187: "app_switch" };

function normalizeKey(raw) {
  if (typeof raw === "number") return KEYCODE_BY_NUM[raw] || "";
  let s = String(raw == null ? "" : raw).trim().toLowerCase();
  if (s === "") return "";
  if (s.indexOf("keycode_") === 0) s = s.slice("keycode_".length);
  s = s.replace(/[\s-]+/g, "_");
  if (Object.prototype.hasOwnProperty.call(KEYCODES, s)) return s;
  if (/^\d+$/.test(s) && KEYCODE_BY_NUM[Number(s)]) return KEYCODE_BY_NUM[Number(s)];
  return "";
}

/** 拍一张虚拟屏截图并算 sha256（launch 前后对比「画面到底变没变」）；失败返回 ok:false。 */
async function captureHash() {
  const r = await vsReq("/vscreen/see", 12000);
  if (!r.ok || !r.path) return { ok: false, error: r.error || "截图失败", path: "" };
  try {
    const buf = await readFile(r.path);
    return { ok: true, path: r.path, bytes: buf.length, hash: createHash("sha256").update(buf).digest("hex") };
  } catch (e) {
    return { ok: false, error: "读取截图失败: " + String(e && e.message || e), path: r.path };
  }
}

/** launch 渲染：把「命令成功」和「画面真的变了」分开说，避免假成功。 */
function renderLaunch(_args, value) {
  value = renderValue(value, _args);
  if (!value.ok) return [{ type: "text", text: "启动失败：" + (value.error || "未知错误") }];
  const lines = ["启动已下发：" + (value.package || "?")];
  if (value.component) lines.push("组件：" + value.component);
  if (typeof value.displayId === "number" && value.displayId >= 0) lines.push("虚拟屏 displayId=" + value.displayId);
  if (value.compared === true) {
    lines.push(value.screenChanged
      ? "画面变化：是（虚拟屏画面已刷新）"
      : "画面变化：否（等待 " + value.waitedMs + "ms 后仍与启动前相同）");
  } else {
    lines.push("画面变化：未知（启动前后有一边截不到图）");
  }
  if (value.hint) lines.push("提示：" + value.hint);
  return [{ type: "text", text: lines.join("\n") }];
}

function apply(ctx) {
  const available = privilegedAvailable();
  if (!available) {
    ctx.logger?.warn?.("[tool-vscreen] 未授予 root/Shizuku，虚拟屏工具未注册");
    return;
  }

  // 1) 创建虚拟屏
  ctx.tools.register(defineTool({
    name: "android_vscreen_create",
    description:
      "创建一块独立于主屏的真正虚拟屏（createVirtualDisplay）。之后用 android_vscreen_launch 把 App 启动到虚拟屏，" +
      "用 android_vscreen_see 看虚拟屏画面，用 android_vscreen_tap/swipe/key 在虚拟屏上操作，用户可在悬浮窗实时看到虚拟屏。" +
      "适合游戏/无控件界面（如 Unity）或想不打扰主屏地运行自动化任务。需要 root 或 Shizuku 特权 + Android 11+。" +
      "首次调用会自动启动虚拟屏服务。" +
      "**尺寸固定为手机比例 9:16（竖屏）或 16:9（横屏）**：用 orientation 指定即可（portrait/landscape），" +
      "也可以传 width/height 表示方向（宽>高=横屏），服务端会把尺寸归一化到 9:16/16:9，不会出现 19:9 这类怪比例。" +
      "切换横竖屏需先 android_vscreen_close 再 create。",
    parameters: {
      orientation: {
        oneOf: [
          { type: "string" },
          { type: "number" }
        ],
        description: "朝向：portrait（9:16 竖屏，默认）/ landscape（16:9 横屏），也接受 0=竖屏、1=横屏；不传则按 width/height 判断"
      },
      width: { type: "number", description: "可选。虚拟屏宽度（px），仅用于表示方向（宽>高=横屏）；实际尺寸归一化为 9:16/16:9" },
      height: { type: "number", description: "可选。虚拟屏高度（px），仅用于表示方向（高>宽=竖屏）；实际尺寸归一化为 9:16/16:9" },
      dpi: { type: "number", description: "虚拟屏密度（dpi），缺省 420" }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          error: { type: "string" },
          displayId: { type: "number" },
          width: { type: "number" },
          height: { type: "number" },
          dpi: { type: "number" },
          orientation: { type: "string" },
          reused: { type: "boolean" },
          hint: { type: "string" }
        }
      },
      render: renderCreate
    },
    async execute(args) {
      const started = await ensureServer();
      if (!started.ok) return { ok: false, error: started.error };
      const oriRaw = args.orientation;
      const oriGiven = oriRaw !== void 0 && oriRaw !== null && String(oriRaw).trim() !== "";
      const ori = oriGiven ? normalizeOrientation(oriRaw) : "";
      if (oriGiven && ori === "") {
        return { ok: false, error: "orientation 取值无法识别：" + JSON.stringify(oriRaw) + "（可用：portrait / landscape / 0 / 1）" };
      }
      let w = Number(args.width) || 0;
      let h = Number(args.height) || 0;
      const d = Number(args.dpi) || 0;
      if (!w && !h) {
        // 不传 orientation 时按文档承诺走默认竖屏。这里必须显式给出尺寸，不能"什么都不发"：
        // 否则尺寸完全由服务端默认值决定（旧 core 的默认是 720×1520，并非 9:16）。
        if (ori === "landscape") { w = 1792; h = 1008; } // 16:9
        else { w = 1008; h = 1792; }                     // 9:16（默认竖屏）
      }
      const qs = [];
      if (w) qs.push("width=" + w);
      if (h) qs.push("height=" + h);
      if (d) qs.push("dpi=" + d);
      const r = await vsReq("/vscreen/create" + (qs.length ? "?" + qs.join("&") : ""), 15000);
      if (!r.ok) return { ok: false, error: r.error || "创建失败" };
      const displayId = typeof r.displayId === "number" ? r.displayId : -1;
      cachedDisplayId = displayId;
      return {
        ok: true,
        displayId,
        width: typeof r.width === "number" ? r.width : w,
        height: typeof r.height === "number" ? r.height : h,
        dpi: typeof r.dpi === "number" ? r.dpi : (d || 420),
        orientation: ori || (w > h ? "landscape" : "portrait"),
        reused: r.reused === true,
        hint: "虚拟屏已创建，可用 android_vscreen_launch 或 android_vscreen_see"
      };
    }
  }));

  // 2) 查询虚拟屏状态
  ctx.tools.register(defineTool({
    name: "android_vscreen_status",
    description: "查询当前虚拟屏状态（displayId/尺寸/是否运行）。",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          error: { type: "string" },
          displayId: { type: "number" },
          width: { type: "number" },
          height: { type: "number" },
          running: { type: "boolean" },
          hasFrame: { type: "boolean" }
        }
      },
      render: (a, v) => {
        v = renderValue(v, a);
        if (!v.ok) return [{ type: "text", text: "查询失败：" + (v.error || "未知错误") }];
        if (!(v.displayId >= 0)) {
          return [{ type: "text", text: "虚拟屏未创建（displayId=-1）。可用 android_vscreen_create 创建。" }];
        }
        return [{
          type: "text",
          text: "虚拟屏运行中，displayId=" + v.displayId + "，" + v.width + "x" + v.height +
            "；画面：" + (v.hasFrame ? "已有首帧" : "暂无首帧（app 还没画到这块屏）")
        }];
      }
    },
    async execute() {
      const r = await vsReq("/vscreen/status", 6000);
      if (!r.ok) return { ok: false, error: r.error };
      return {
        ok: true,
        displayId: typeof r.displayId === "number" ? r.displayId : -1,
        width: typeof r.width === "number" ? r.width : 0,
        height: typeof r.height === "number" ? r.height : 0,
        running: r.running === true,
        hasFrame: r.hasFrame === true
      };
    }
  }));

  // 3) 启动应用到虚拟屏
  ctx.tools.register(defineTool({
    name: "android_vscreen_launch",
    description:
      "把应用启动到指定虚拟屏。app 参数填应用包名（如 com.tencent.mm），或应用显示名会尝试解析包名。" +
      "启动成功后该应用只显示在虚拟屏上，主屏不变，且用户可在悬浮窗看到。" +
      "返回 package/component/displayId，并用启动前后的虚拟屏截图对比给出 compared/screenChanged：" +
      "screenChanged=false 表示命令成功但画面没变（目标 app 可能不支持副屏，如起来即退出的 SplashActivity）。",
    parameters: {
      app: { type: "string", description: "应用包名或应用名", required: true }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          error: { type: "string" },
          package: { type: "string" },
          component: { type: "string" },
          launchedActivity: { type: "string" },
          displayId: { type: "number" },
          compared: { type: "boolean" },
          screenChanged: { type: "boolean" },
          waitedMs: { type: "number" },
          hint: { type: "string" }
        }
      },
      render: renderLaunch
    },
    async execute(args) {
      if (!args.app || String(args.app).trim() === "") return { ok: false, error: "app 不能为空" };
      const app = String(args.app).trim();
      // 不在这里查包名：服务端会用已安装应用列表做模糊匹配（插件没有可靠的特权 shell 通道）
      const id = await getDisplayId();
      if (id < 0) return { ok: false, error: "虚拟屏未创建，请先调用 android_vscreen_create" };

      // v1.11：启动前后各拍一张比 sha256 —— 服务端的 ok 只代表 am start 成功，不代表 app 真的画到了副屏。
      const before = await captureHash();
      const t0 = Date.now();
      const r = await vsReq("/vscreen/launch?pkg=" + encodeURIComponent(app), 15000);
      if (!r.ok) return { ok: false, error: r.error || "启动失败" };
      let after = await captureHash();
      // 画面没变 / 还没出帧时再等 800ms 补拍一次（冷启动常见 1~2s）
      if (!after.ok || (before.ok && before.hash === after.hash)) {
        await sleep(800);
        const again = await captureHash();
        if (again.ok) after = again;
      }
      let compared;
      let screenChanged;
      if (!before.ok && after.ok) {
        compared = true;
        screenChanged = true;            // 启动前根本没画面 → 现在有了
      } else if (before.ok && after.ok) {
        compared = true;
        screenChanged = before.hash !== after.hash;
      } else {
        compared = false;                // 有一边拍不到图，不硬判
        screenChanged = false;
      }
      const out = {
        ok: true,
        package: typeof r.package === "string" ? r.package : app,
        component: typeof r.component === "string" ? r.component : "",
        launchedActivity: typeof r.component === "string" ? r.component : "",
        displayId: typeof r.displayId === "number" ? r.displayId : id,
        compared,
        screenChanged,
        waitedMs: Date.now() - t0
      };
      if (compared && !screenChanged) {
        out.hint = "启动命令已成功，但虚拟屏画面与启动前完全相同 —— 目标 app 可能不支持在虚拟屏显示" +
          "（SplashActivity 起来即退出）。可换一个 app，或先用 android_vscreen_see 确认当前画面。";
      }
      return out;
    }
  }));

  // 4) 截图虚拟屏（喂给视觉模型）
  ctx.inject(["attachments"], (imageCtx) => {
    imageCtx.tools.register(defineTool({
      name: "android_vscreen_see",
      description:
        "截取虚拟屏当前画面并把截图作为图片发送给模型查看（server ImageReader 抓帧，无需 MediaProjection 弹窗）。" +
        "返回 screenW/H（虚拟屏逻辑尺寸）与 scaleX/Y；截图上量到的像素 (px,py) → 虚拟屏坐标 = (px×scaleX, py×scaleY)。" +
        "适合 Unity/游戏等无控件界面。建议 grid:true 叠加 4×4 网格按行列定位。" +
        "截图失败时返回 errorCode（no_display=没建屏 / not_rendered=还没首帧 / no_frame=曾经有帧但现在抓不到）" +
        "并提供 hasFrame、displayId、hint；可传 waitMs 让它等首帧（避免自己 sleep 后反复重试）。",
      parameters: {
        grid: { type: "boolean", description: "true 时叠加 4×4 网格线" },
        waitMs: { type: "number", description: "可选：等首帧的最长时间（0~5000ms，默认 0 只试一次）；内部每 300ms 重试，出帧即返回" }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean", required: true },
            error: { type: "string" },
            path: { type: "string" },
            displayId: { type: "number" },
            screenW: { type: "number" },
            screenH: { type: "number" },
            imageW: { type: "number" },
            imageH: { type: "number" },
            scaleX: { type: "number" },
            scaleY: { type: "number" },
            grid: { type: "number" },
            // v1.11：失败可判别 + 等帧统计
            errorCode: { type: "string" },
            hasFrame: { type: "boolean" },
            waitedMs: { type: "number" },
            attempts: { type: "number" },
            hint: { type: "string" },
            image: {
              type: "object",
              additionalProperties: false,
              properties: {
                attachmentId: { type: "string", required: true },
                mediaType: { type: "string", required: true },
                bytes: { type: "number" },
                width: { type: "number" },
                height: { type: "number" },
                name: { type: "string" }
              }
            }
          }
        },
        render: (_args, value) => {
          value = renderValue(value, _args);
          if (!value.ok) {
            const lines = ["截图失败（" + (value.errorCode || "unknown") + "）：" + (value.error || "未知错误")];
            if (typeof value.displayId === "number") {
              lines.push("虚拟屏 displayId=" + value.displayId + "，hasFrame=" + (value.hasFrame === true ? "true" : "false"));
            }
            if (typeof value.waitedMs === "number") {
              lines.push("已等待 " + value.waitedMs + "ms（" + (value.attempts || 0) + " 次尝试）");
            }
            if (value.hint) lines.push("提示：" + value.hint);
            return [{ type: "text", text: lines.join("\n") }];
          }
          const meta = [
            `虚拟屏截图, ${value.image.mediaType}, ${value.image.width}x${value.image.height} px, ${value.image.bytes} bytes`,
            `虚拟屏尺寸 ${value.screenW}x${value.screenH}, 截图尺寸 ${value.imageW}x${value.imageH}, scaleX=${value.scaleX} scaleY=${value.scaleY}${value.grid ? `, 已叠加 ${value.grid}x${value.grid} 网格` : ""}`,
            "图上像素 (px,py) → 虚拟屏坐标 = (px×scaleX, py×scaleY)；分数坐标 fx=px/imageW, fy=py/imageH"
          ].join("\n");
          return [{
            type: "text",
            text: `<path>${value.path}</path>\n<type>image</type>\n<content>\n${meta}\n</content>`
          }, {
            type: "image",
            attachment: {
              attachmentId: value.image.attachmentId,
              mediaType: value.image.mediaType,
              bytes: value.image.bytes,
              width: value.image.width,
              height: value.image.height,
              ...(value.image.name === void 0 ? {} : { name: value.image.name })
            }
          }];
        }
      },
      async execute(args) {
        const attachments = imageCtx.get("attachments");
        if (attachments === void 0) {
          return { ok: false, error: "cannot screenshot: no attachment service is mounted" };
        }
        const waitMs = Math.max(0, Math.min(5000, Math.round(Number(args.waitMs) || 0)));
        const t0 = Date.now();
        let last = null;
        let attempts = 0;
        for (;;) {
          attempts++;
          const r = await vsReq("/vscreen/see", 12000);
          if (r.ok && r.path) {
            let data;
            try {
              data = await readFile(r.path);
            } catch (e) {
              return { ok: false, error: "读取截图失败: " + String(e && e.message || e), errorCode: "read_failed", attempts };
            }
            try {
              const ref = await attachments.saveImage({ data, mediaType: "image/png", name: "vscreen.png" });
              return {
                ok: true,
                path: r.path,
                displayId: typeof r.displayId === "number" ? r.displayId : 0,
                screenW: typeof r.screenW === "number" ? r.screenW : 0,
                screenH: typeof r.screenH === "number" ? r.screenH : 0,
                imageW: typeof r.imageW === "number" ? r.imageW : 0,
                imageH: typeof r.imageH === "number" ? r.imageH : 0,
                scaleX: typeof r.scaleX === "number" ? r.scaleX : 1,
                scaleY: typeof r.scaleY === "number" ? r.scaleY : 1,
                grid: 0,
                hasFrame: true,
                waitedMs: Date.now() - t0,
                attempts,
                image: {
                  attachmentId: ref.attachmentId,
                  mediaType: "image/png",
                  bytes: data.length,
                  width: typeof r.imageW === "number" ? r.imageW : 0,
                  height: typeof r.imageH === "number" ? r.imageH : 0,
                  name: "vscreen.png"
                }
              };
            } catch (e) {
              return { ok: false, error: "保存截图失败: " + String(e && e.message || e), errorCode: "save_failed", attempts };
            }
          }
          last = r;
          if (attempts >= 10 || Date.now() + 300 > t0 + waitMs) break;
          await sleep(300);
        }
        // v1.11：失败定性 —— 用 /vscreen/status 的真实状态区分「没建屏」「还没首帧」「有帧但抓不到」。
        const st = await vsReq("/vscreen/status", 4000);
        const statusOk = st && st.ok === true;
        const displayId = statusOk && typeof st.displayId === "number" ? st.displayId : -1;
        const hasFrame = statusOk && st.hasFrame === true;
        let errorCode = "unavailable";
        let hint = "";
        if (!statusOk) {
          errorCode = "status_unavailable";
          hint = "连虚拟屏服务状态都拿不到：确认 App 已打开、Shizuku/root 已授权。";
        } else if (displayId < 0) {
          errorCode = "no_display";
          hint = "虚拟屏未创建：先调用 android_vscreen_create。";
        } else if (!hasFrame) {
          errorCode = "not_rendered";
          hint = "这块屏还没有任何首帧（刚建屏或 app 正在冷启动）；可带 waitMs 重试，或确认已 launch 目标 app。";
        } else {
          errorCode = "no_frame";
          hint = "这块屏曾经有帧但现在抓不到：目标 app 可能已退出/该屏无窗口；先 android_vscreen_status 或重新 launch 复查。";
        }
        return {
          ok: false,
          error: (last && last.error) || "截图失败",
          errorCode,
          displayId,
          hasFrame,
          waitedMs: Date.now() - t0,
          attempts,
          hint
        };
      }
    }));
  });

  // 5) 点击
  ctx.tools.register(defineTool({
    name: "android_vscreen_tap",
    description: "在虚拟屏上点击（绝对像素坐标，来自 android_vscreen_see 截图 ×scaleX/Y）。",
    parameters: {
      x: { type: "number", description: "点击 x", required: true },
      y: { type: "number", description: "点击 y", required: true }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { ok: { type: "boolean", required: true }, error: { type: "string" } }
      },
      render: renderOp
    },
    async execute(args) {
      const x = Math.round(Number(args.x));
      const y = Math.round(Number(args.y));
      if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, error: "坐标无效" };
      const id = await getDisplayId();
      if (id < 0) return { ok: false, error: "虚拟屏未创建，请先调用 android_vscreen_create" };
      // 走特权服务端 HTTP（服务端本身是 shell uid，不依赖插件的 rish 通道）
      const r = await vsReq(`/vscreen/tap?x=${x}&y=${y}`, 8000);
      return r.ok ? { ok: true } : { ok: false, error: r.error || "点击失败" };
    }
  }));

  // 6) 滑动
  ctx.tools.register(defineTool({
    name: "android_vscreen_swipe",
    description: "在虚拟屏上滑动（绝对像素坐标，起点→终点）。",
    parameters: {
      x1: { type: "number", description: "起点 x", required: true },
      y1: { type: "number", description: "起点 y", required: true },
      x2: { type: "number", description: "终点 x", required: true },
      y2: { type: "number", description: "终点 y", required: true },
      durationMs: { type: "number", description: "滑动时长毫秒（缺省 300）" }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { ok: { type: "boolean", required: true }, error: { type: "string" } }
      },
      render: renderOp
    },
    async execute(args) {
      const nums = [args.x1, args.y1, args.x2, args.y2].map(Number);
      if (nums.some((n) => !Number.isFinite(n))) return { ok: false, error: "坐标无效" };
      const dur = Math.max(0, Math.round(Number(args.durationMs) || 300));
      const id = await getDisplayId();
      if (id < 0) return { ok: false, error: "虚拟屏未创建，请先调用 android_vscreen_create" };
      const r = await vsReq(`/vscreen/swipe?x1=${Math.round(nums[0])}&y1=${Math.round(nums[1])}&x2=${Math.round(nums[2])}&y2=${Math.round(nums[3])}&dur=${dur}`, 12000);
      return r.ok ? { ok: true } : { ok: false, error: r.error || "滑动失败" };
    }
  }));

  // 7) 按键
  ctx.tools.register(defineTool({
    name: "android_vscreen_key",
    description: "向虚拟屏发送按键。key 取值：back / home / enter / menu / volume_up / volume_down / app_switch；" +
      "也接受 KEYCODE_BACK、BACK、4 等别名写法。",
    parameters: {
      key: {
        oneOf: [
          { type: "string" },
          { type: "number" }
        ],
        description: "back/home/enter/menu/volume_up/volume_down/app_switch（也接受 KEYCODE_BACK 这类写法或键码 4）",
        required: true
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          error: { type: "string" },
          key: { type: "string" },
          keycode: { type: "number" },
          accepted: { type: "array", items: { type: "string" } }
        }
      },
      render: (_a, v) => {
        v = renderValue(v, _a);
        if (!v.ok) return [{ type: "text", text: "按键失败：" + (v.error || "未知错误") }];
        return [{ type: "text", text: "按键已发送：" + v.key + "（keycode " + v.keycode + "）" }];
      }
    },
    async execute(args) {
      const k = normalizeKey(args.key);
      if (!k || !(k in KEYCODES)) {
        return {
          ok: false,
          error: "未知按键: " + JSON.stringify(args.key) + "（可用：back/home/enter/menu/volume_up/volume_down/app_switch，" +
            "也接受 KEYCODE_BACK 这类写法或键码 4/3/66/82/24/25/187）",
          accepted: Object.keys(KEYCODES)
        };
      }
      const id = await getDisplayId();
      if (id < 0) return { ok: false, error: "虚拟屏未创建，请先调用 android_vscreen_create" };
      const r = await vsReq(`/vscreen/key?keycode=${KEYCODES[k]}`, 8000);
      return r.ok ? { ok: true, key: k, keycode: KEYCODES[k] } : { ok: false, error: r.error || "按键失败" };
    }
  }));

  // 8) 关闭
  ctx.tools.register(defineTool({
    name: "android_vscreen_close",
    description: "关闭/销毁虚拟屏（释放虚拟屏与抓帧器），虚拟屏上的应用回到主屏。",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { ok: { type: "boolean", required: true }, error: { type: "string" } }
      },
      render: renderOp
    },
    async execute() {
      const r = await vsReq("/vscreen/close", 8000);
      cachedDisplayId = -1;
      return r.ok ? { ok: true } : { ok: false, error: r.error || "关闭失败" };
    }
  }));
}

// ==================== 注入 ====================

/** 虚拟屏 displayId 缓存（create 成功设置 / close 重置 / status 兜底）。 */
let cachedDisplayId = -1;

async function getDisplayId() {
  if (cachedDisplayId >= 0) return cachedDisplayId;
  try {
    const r = await vsReq("/vscreen/status", 4000);
    if (r && r.ok && typeof r.displayId === "number" && r.displayId >= 0) {
      cachedDisplayId = r.displayId;
      return cachedDisplayId;
    }
  } catch (_) {}
  return -1;
}

/** 应用名 → 包名（pm list packages 过滤；找不到原样返回）。 */
async function resolvePackageName(appName) {
  const r = await privShell("pm list packages -3 | grep -i " + appName.replace(/[^a-zA-Z0-9_.]/g, ""), 10000);
  if (r.ok && r.stdout) {
    const lines = r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    if (lines.length === 1) return lines[0].replace("package:", "");
  }
  return appName;
}

export { name, inject, apply };
