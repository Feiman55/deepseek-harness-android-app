# 第三方组件与开源许可声明 · Third-Party Notices

本仓库**整体**采用 **MIT** 许可（见 [`LICENSE`](LICENSE)）。

但**虚拟屏（vscreen）功能**包含来自 **Operit** 的代码，**该部分按 LGPL-3.0 分发**。
同一个仓库里同时存在两种许可，**请分别遵守**——尤其当你要复用/修改虚拟屏相关文件时。

---

## 0. AOSP apksig — Apache-2.0（设备内 APK 签名/校验）

| 项 | 内容 |
|---|---|
| 项目 | **AOSP apksig**（`com.android.apksigner.ApkSignerTool`，Android SDK build-tools 的 `lib/apksigner.jar`） |
| 来源 | Android Open Source Project（随本机 Android SDK 的 `build-tools` 分发） |
| 许可证 | **Apache License 2.0** |
| 许可证全文 | Apache-2.0 规范文本见 <https://www.apache.org/licenses/LICENSE-2.0>；随 SDK 分发的完整声明副本已归档为 [`licenses/android-build-tools-NOTICE.txt`](licenses/android-build-tools-NOTICE.txt)（即 build-tools 的 `NOTICE.txt`，内含 apksig 等组件的许可） |

**本仓库怎么用它**：`android-app/build.sh` 在构建期用 build-tools 的 `d8 --min-api 26` 把
`lib/apksigner.jar` 编成 `classes.dex`（构建期生成、**不入库**），随 payload 放到
`runtime/lib/apksig/classes.dex`，并提供包装脚本 `runtime/bin/apksigner`（`CLASSPATH=<dex> app_process
/system/bin com.android.apksigner.ApkSignerTool …`，默认补 `--ks-type PKCS12` 与
`--v1-signing-enabled false`）。这样设备端**不需要 JVM** 就能 verify / sign APK
（对比：Termux 的 apksigner 要拖 openjdk-21，闭包 305.8 MB）。

> 另：设备内构建链还用到了 Termux 分发的 GNU 工具与 Java 工具（aapt2 / ecj / dx 等），
> 它们各自的许可随包在 `payload/runtime/share/doc/*/COPYING*` 里，未在此逐一展开。

## 0.1 设备内构建链里的 `android.jar`（**本仓库不再分发它**）

W5 的「设备内从零构建链」需要四样：`aapt2`、`ecj`、`dx`（三者随运行时资产分发，许可见其
`share/doc/*/COPYING*`）与 **`android.jar`**。最后一样**故意不随包分发**：

- ⚠ **现状（2026-10 核实）**：本仓库的 payload 里**确实带着**
  `runtime/share/java/android.jar`（3,881,757 B）与 `android-24.jar`（3,296,407 B），
  设备内构建可直接用 —— 因此本说明**不再声称"不分发 android.jar"**；
  按 Android SDK 许可条款，SDK 里的 `platforms/android-*/android.jar` **不允许再分发**
  （AOSP 自行构建的才是 Apache-2.0），**这两个文件的去留属于维护者的合规决策**，
  本仓库只是如实记录其存在；
- 正确做法：**用你自己的 SDK**，把它放到设备上任意路径，构建时用 `-bootclasspath` / `-classpath` 指过去；
- 只做「改现成包 + 重签」时**根本不需要 android.jar**（用内置 `apksigner` 即可，见 §0）。

## 1. Operit — LGPL-3.0（虚拟屏 vscreen）

| 项 | 内容 |
|---|---|
| 项目 | **Operit** — Android 上能力强大的 AI Agent |
| 仓库 | <https://github.com/AAswordman/Operit> |
| 作者 | [AAswordman](https://github.com/AAswordman) |
| 许可证 | **GNU Lesser General Public License v3.0（LGPL-3.0）** |
| 许可证全文 | [`licenses/lgpl-3.0.txt`](licenses/lgpl-3.0.txt)（LGPL-3.0 以 GPL-3.0 为基础，故同时提供 [`licenses/gpl-3.0.txt`](licenses/gpl-3.0.txt)） |

### 1.1 本项目中源自 Operit 的部分

虚拟屏功能的实现**移植/对齐自 Operit 的 shower（虚拟屏）模块**。其中两个文件在源码里**已经带有原始许可声明**：

```java
// android-app/src/com/deepseek/harness/vscreen/FakeContext.java
// android-app/src/com/deepseek/harness/vscreen/Workarounds.java
// 第 1 行： Licensed under LGPL-3.0; source: https://github.com/AAswordman/Operit (shower shell)
```

| 文件 | 与本项目的关系 |
|---|---|
| `android-app/src/com/deepseek/harness/vscreen/FakeContext.java` | **取自 Operit**（shower shell）；最小 `Context` 实现，供 app_process 环境下构造 `DisplayManager` 使用 |
| `android-app/src/com/deepseek/harness/vscreen/Workarounds.java` | **取自 Operit**（shower shell）；隐藏 API / 反射规避处理 |
| `android-app/src/com/deepseek/harness/vscreen/Main.java` | 虚拟屏服务端。其**核心机制移植/对齐 Operit**：`MediaCodec` H.264 编码器 Surface + `setVideoSink` 推流、SPS/PPS（csd-0/csd-1）缓存重放、`DisplayManager.createVirtualDisplay()` 建屏、`InputManager` 反射定向注入、`ActivityOptions.setLaunchDisplayId` 启动到指定虚拟屏、idleWatcher 保活 |
| `plugins/dsh-tool-vscreen/` | 本项目自研的 DSH 插件封装（通过 HTTP 调用上述服务端；接口与工具 schema 为本项目设计） |

> **保险起见的口径**：尽管只有上表前两个文件带显式 LGPL 头，本声明**按最保守方式把整个虚拟屏模块
> （`android-app/src/com/deepseek/harness/vscreen/`）视为 LGPL-3.0 覆盖范围**。
> 这样无论后续维护者把哪些文件判定为"衍生作品"，都不会出现许可缺口。

### 1.2 如果你要继续修改这些文件

- **修改后的这些文件（及其衍生）必须继续以 LGPL-3.0 分发**，并保留原始版权与许可声明（LGPL-3.0 §2、§4）；
- 不得对本模块附加任何"禁止修改 / 禁止为调试而反向工程"的限制（LGPL-3.0 §4）；
- 本项目**不要求**你对仓库其余（MIT 部分）做任何开源——两部分的许可彼此独立。

### 1.3 本项目已履行的 LGPL-3.0 义务

| 义务（条款） | 履行方式 |
|---|---|
| 显著声明"使用了该 Library 且该 Library 及其使用受 LGPL-3.0 约束"（§4a） | 本文件 + `README.md` 的「致谢与开源许可」章节 |
| 随作品附带 GPL-3.0 与 LGPL-3.0 全文副本（§4b） | [`licenses/lgpl-3.0.txt`](licenses/lgpl-3.0.txt)、[`licenses/gpl-3.0.txt`](licenses/gpl-3.0.txt) |
| 提供可重新链接/重新编译的对应源码（§4d） | **本仓库即为完整对应源码**（含 `android-app/`、`plugins/`、构建脚本 `android-app/build.sh`），任何人可获取、修改、自行编译与重新链接 |
| 允许为调试修改而反向工程（§4） | 本项目未附加任何禁止条款 |

> 若发现归属有遗漏或希望调整声明方式，欢迎提 [Issue](https://github.com/woaiys3/deepseek-harness-android-app/issues) 或直接联系作者。

---

## 2. Shizuku — Apache-2.0

| 项 | 内容 |
|---|---|
| 项目 | **Shizuku**（免 Root 使用系统 API 的特权通道） |
| 仓库 | <https://github.com/RikkaApps/Shizuku> |
| 许可证 | Apache License 2.0 |

**使用方式**：本项目的特权通道通过 Shizuku 提供的 SDK 与 `rish`（Shizuku shell loader）实现。

- `android-app/libs/shizuku-api.aar`、`shizuku-aidl.aar`、`shizuku-provider.aar`
- APK 内置 `assets/rish_shizuku.dex`（运行时由 App 释放，用于在 shell 身份下执行特权命令）

**未做修改**，按原样分发。

---

## 3. Node.js 运行时与 npm 依赖

| 项 | 说明 |
|---|---|
| `runtime/`（APK 内置） | **Node.js** 运行时（MIT 许可），随包分发 |
| dshroot 内的依赖闭包 | 来自 npm 的 `@deepseek-ai/*` 及其他第三方包，**版权与许可归各自作者所有**，随包原样分发；本仓库不重新授权它们 |

---

## 4. 摘要

| 范围 | 许可证 |
|---|---|
| 本仓库其余全部内容（App 外壳、4 个自研插件、补丁面、构建脚本、文档） | **MIT** |
| `android-app/src/com/deepseek/harness/vscreen/`（虚拟屏） | **LGPL-3.0**（源自 Operit） |
| `android-app/libs/*.aar`、`assets/rish_shizuku.dex`（Shizuku） | **Apache-2.0** |
| APK 内置 Node 运行时、npm 依赖 | 各自原许可 |
