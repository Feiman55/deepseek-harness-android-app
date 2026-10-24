/**
 * Android Shizuku / Root 特权工具插件：给 DeepSeek Harness 提供特权 shell 能力。
 *
 * 特权通道（二选一，由 MainActivity 探测后通过环境变量告知）：
 *   - ROOT_AVAILABLE=1  ：设备有 root（su 可用），走 su -c 通道
 *   - SHIZUKU_AVAILABLE=1：Shizuku 已授权，走 app_process rish 通道
 * 两者都未授予时（ROOT_AVAILABLE != 1 且 SHIZUKU_AVAILABLE != 1），
 * **不注册特权工具** —— AI 的工具列表里没有 shizuku_shell，自然不会反复尝试调用；
 * 此时文件读写走 DSH 自带的 fs/bash 工具（只需"所有文件访问权限"，无需特权）。
 *
 * 默认在已授权的通道下自动执行（无需逐次审批）。
 * 如需恢复"每次确认"，在 MainActivity 里给 node 设置环境变量 SHIZUKU_APPROVE=ask。
 *
 * 注意：使用异步 spawn 而非 spawnSync，避免同步阻塞 node 事件循环，
 * 否则命令执行期间整个 DSH 后端（HTTP/WebSocket）会卡死，前端报 "Failed to fetch"。
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { spawn } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";

const name = "tool-shizuku";
const inject = ["tools"];

const APP_PROC = "/system/bin/app_process";
const SHIZUKU_LOADER = "rikka.shizuku.shell.ShizukuShellLoader";
const MAX_STDOUT = 8000;
const MAX_STDERR = 2000;

/** 特权通道是否可用（root 或 Shizuku 任一授予即可）。 */
function privilegedAvailable() {
  return process.env.ROOT_AVAILABLE === "1" || process.env.SHIZUKU_AVAILABLE === "1";
}

/**
 * 剥离会污染系统 app_process 链接的环境变量。
 * DSH 运行时为了加载 Node 自带的 .so 会设置 LD_LIBRARY_PATH（内含自定义 libz.so，
 * SONAME=libz.so.1），而 /system/bin/app_process 是系统二进制，必须用系统库
 * （/apex 的 libunwindstack.so 需要 SONAME=libz.so）。原样继承 process.env 会让
 * 系统链接器报 "cannot find libz.so from verneed[1]"。
 */
function sanitizeEnv(env) {
  const clean = { ...env };
  delete clean.LD_LIBRARY_PATH;
  delete clean.LD_PRELOAD;
  delete clean.LD_DEBUG;
  return clean;
}

/**
 * 确保 rish dex 只读。Android 15 的 ART 拒绝加载"当前 uid 可写"的 dex
 * （logcat: Writable dex file ... is not allowed → Abort）。MainActivity 从 assets
 * 提取的 dex 默认是 600（属主可写），所以每次执行前强制 chmod 444。
 */
function ensureDexReadOnly(dex) {
  try {
    if (dex && existsSync(dex)) chmodSync(dex, 0o444);
  } catch (_) {
    // 尽力而为：chmod 失败不阻断，让 app_process 的报错自然暴露。
  }
}

/** 异步调用 rish 执行一条 shell 命令（不阻塞事件循环，内部函数）。 */
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
        env: { ...sanitizeEnv(process.env), RISH_APPLICATION_ID: appId || "com.deepseek.harness" },
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (e) {
      resolve({ ok: false, exit_code: -1, stdout: "", stderr: "", error: String(e && e.message || e) });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch (_) {}
    }, timeout);

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
      const killed = signal === "SIGKILL" && code === null;
      if (killed) {
        finish(false, -1, "命令超时（" + timeout + "ms）被强制终止");
      } else {
        finish(code === 0, code ?? -1, undefined);
      }
    });
  });
}

/** 异步调用 su 执行一条 shell 命令（root 通道，与 shizukuCmd 相同的结果结构）。 */
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
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch (_) {}
    }, timeout);

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
      const killed = signal === "SIGKILL" && code === null;
      if (killed) {
        finish(false, -1, "命令超时（" + timeout + "ms）被强制终止");
      } else {
        finish(code === 0, code ?? -1, undefined);
      }
    });
  });
}

/**
 * 经 **App 进程**（Shizuku API 通道）执行特权命令：POST 127.0.0.1:<notifyPort>/shell。
 *
 * 为什么不再直接用引擎内 rish：Shizuku 服务端校验「某包是否被授权」时要回头问 Shizuku 应用本体，
 * 而 ColorOS 会冻结/查杀 Shizuku 应用（真机日志：OplusHansManager “F exit()”、NativeFreezeManager、
 * “excessive binder traffic during cached state”），于是 rish 子进程等不到响应，只能抛
 * “Request timeout…”。App 进程内的 Shizuku API 通道实测稳定（虚拟屏核心就是它拉起的）。
 *
 * 返回结构与 shizukuCmd 一致；另外多一个 transport 字段：true = 压根没谈到 App（旧 APK / 服务未起）。
 */
function appShellCmd(command, timeoutMs) {
  const port = Number(process.env.APP_NOTIFY_PORT) || 3081;
  const token = process.env.APP_LOCAL_TOKEN || "";
  const timeout = Math.max(1000, Math.min(timeoutMs || 30000, 120000));
  const body = JSON.stringify({ command, timeout_ms: timeout, token });
  return new Promise((resolve) => {
    import("node:http").then((http) => {
      const req = http.request({
        host: "127.0.0.1",
        port,
        path: "/shell",
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
      }, (res) => {
        let d = "";
        res.on("data", (c) => d += c);
        res.on("end", () => {
          try {
            const v = JSON.parse(d || "{}");
            resolve(Object.assign({ transport: false }, v));
          } catch (e) {
            resolve({ ok: false, transport: false, error: "App /shell 响应解析失败：" + String(d).slice(0, 200) });
          }
        });
      });
      // 网络层超时 = 命令超时 + 10s 余量（命令超时由 App 侧负责终止）
      req.setTimeout(timeout + 10000, () => { req.destroy(); resolve({ ok: false, transport: true, error: "App /shell 请求超时" }); });
      req.on("error", (e) => resolve({ ok: false, transport: true, error: "连不上 App 本地特权服务：" + String(e && e.message || e) }));
      req.write(body);
      req.end();
    }).catch((e) => resolve({ ok: false, transport: true, error: "加载 http 模块失败：" + String(e) }));
  });
}

/** 选择特权通道执行：root(su) 优先 → App 进程内 Shizuku API → 引擎内 rish（旧 APK 兜底）。 */
function privCmd(command, timeoutMs) {
  if (process.env.ROOT_AVAILABLE === "1") {
    return suCmd(command, timeoutMs);
  }
  return appShellCmd(command, timeoutMs).then((r) => {
    // exit_code 是数字 = App 真的执行过（成功或失败都算有结论），直接采用，不再退 rish。
    // ⚠ transport 是内部字段：工具输出 schema 是 additionalProperties:false，多带一个字段
    // 会让 DSH 判定“非法输出”，模型拿不到真实结果（v1.13.1 首测就是踩了这个坑）。
    if (r && typeof r.exit_code === "number") {
      delete r.transport;
      return r;
    }
    return shizukuCmd(command, process.env.SHIZUKU_DEX, process.env.SHIZUKU_APP_ID, timeoutMs);
  });
}

/** shell 单引号字面量（中文/空格/标点安全；v1.20.1 通知校验用）。 */
function shq(s) {
  return "'" + String(s == null ? "" : s).replace(/'/g, "'\\''") + "'";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function apply(ctx) {
  // v1.23（维护者要求）：无 root/Shizuku 时**整个插件不提供任何工具**。
  // 插件文件仍会被加载，但注册数为 0 —— AI 的工具列表里看不到任何 shizuku_* 工具。
  if (!(process.env.ROOT_AVAILABLE === "1" || process.env.SHIZUKU_AVAILABLE === "1")) return;
  const approval = () => ctx.get("approval");
  const available = privilegedAvailable();

  // 1) 特权 shell（默认自动执行，SHIZUKU_APPROVE=ask 时逐次审批）
  // 未授予 root 且未授予 Shizuku 时**不注册**本工具：AI 工具列表里没有它，
  // 就不会反复尝试特权命令；此时文件读写应使用 DSH 自带的 fs/bash 工具。
  if (available) {
    ctx.tools.register(defineTool({
      name: "shizuku_shell",
      description:
        "通过特权通道（root su 或 Shizuku，二选一，自动选择可用者）以系统 shell 权限执行一条命令，用于普通 bash 工具做不到的、需要系统/root 级权限的操作（例如 pm install/uninstall、am 启动/停止应用、settings 修改系统设置、dumpsys 查询系统状态、grant/revoke 运行时权限等）。" +
        "命令会在已授权的通道下自动执行（默认无需逐次确认）；仅当环境变量 SHIZUKU_APPROVE=ask 时才需要逐次审批。优先用普通 `bash` 工具，只有确实需要系统特权时才用本工具。",
      parameters: {
        command: {
          type: "string",
          required: true,
          description: "要执行的 shell 命令。会以系统/root 权限运行，请写清楚、可审计。"
        },
        timeout_ms: {
          type: "number",
          description: "超时毫秒，默认 30000，最大 120000。"
        }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean", required: true },
            exit_code: { type: "number" },
            stdout: { type: "string" },
            stderr: { type: "string" },
            error: { type: "string" }
          }
        },
        render: (_args, value) => [{
          type: "text",
          text: (value.ok ? "" : "执行失败：" + (value.error || value.stderr || "未知错误") + "\n\n") +
            "exit_code: " + value.exit_code + "\n" +
            (value.stdout ? "stdout:\n" + value.stdout : "") +
            (value.stderr ? "\nstderr:\n" + value.stderr : "")
        }]
      },
      async execute(args, exec) {
        // 审批：默认自动允许。如需每次确认，设 SHIZUKU_APPROVE=ask。
        if (process.env.SHIZUKU_APPROVE === "ask") {
          const approver = approval();
          if (approver === undefined) {
            throw new Error("审批服务未挂载，无法安全执行特权命令");
          }
          const reason = "特权命令：" + args.command;
          const outcome = await approver.request({
            agent: exec.agent,
            toolName: "shizuku_shell",
            callId: exec.callId,
            reason,
            signal: exec.signal
          });
          if (outcome !== "allowed-once") {
            throw new Error(`特权命令未获批准（${outcome}）：${args.command}`);
          }
        }
        return await privCmd(args.command, args.timeout_ms);
      }
    }));
  }

  // 2) 授权状态探测（只读，不审批）。未授权时仍注册：AI 能自查"为什么没有特权工具"，
  //    得到"未授权"后就不会反复尝试特权命令；此时文件操作用 fs/bash 工具。

  // 3) AI 发通知（**不依赖特权**：只需 App 通知权限，走本地 127.0.0.1:3081）
  // 始终注册：即使没有 root/Shizuku，只要用户在系统设置里给了通知权限就能发。

  // 4) 本地设置（**不依赖特权写入**：走 App 的 WRITE_SETTINGS；读值走特权 shell）

  // 5) 剪贴板（**不依赖特权**：读写系统剪贴板，无需任何特殊权限）
}

export { apply, inject, name };
