# 内核树来源（A2′）

这个目录是 **DSH 内核树的冻结安装输入**：`package.json` 只声明一个根依赖，

```
@deepseek-ai/dsh@0.2.0-rc.2      （官方 npm registry 上的官方包）
```

`package-lock.json` 锁住整棵树（610 条、609 条带 `integrity`，零 dev / 零 optional）。
安装由 `tools/fetch-kernel.sh` 完成，产出 Android 侧的 `dshroot/lib`：

```bash
bash tools/fetch-kernel.sh <输出目录>          # 输出目录 = dshroot/lib
# 等价于：
npm ci --os=android --cpu=arm64 --omit=optional --omit=dev --ignore-scripts
```

## 为什么是"官方 npm + 我们这份 lock"，而不是"官方 git tag + 官方 pnpm-lock"

2026-10-14 实测（阶段 0 探针）：

- 上游 Release APK 里那份 payload 的 `dshroot` 是 **npm** 装的：它的
  `…/@deepseek-ai/dsh/node_modules/.package-lock.json`（`lockfileVersion=3`、
  530 包全部带 integrity、dev=0、optional=0）就是它的真实锁定文件；
  树里没有任何 pnpm 痕迹（`.pnpm/`、`.modules.yaml`、`pnpm-lock.yaml` 全为 0 条）。
- 官方仓库 `deepseek-ai/deepseek-harness` @ `dsh-v0.2.0-rc.2` 的 `pnpm-lock.yaml`
  与那份 payload 的依赖树**差 37 个第三方包版本**（payload 普遍更新，例如 `glob` 13.0.6
  vs 10.5.0、`chalk` 5.6.2 vs 4.1.2）—— 所以"clone 官方 tag + `pnpm --frozen-lockfile`"
  会装出**另一棵树**，还要跑一遍 monorepo 构建（tsc/tsdown/web，十几分钟）。
- 因此这里采用「官方 npm 包 + 一次性从 payload 提升出来的 lock」：
  实测 `npm ci` 9 秒装出 530 包，与 payload 的内核子树逐包对照
  **532 路径版本一致 / 0 版本不同**，只剩 4 个我们自己的插件与 1 个 node-pty。

## 这份 lock 的来历（诚实说明）

一次性从上游 payload 的隐藏 lock 提升而来，并补了 80 条 npm 报缺的"平台可选依赖"条目：

1. 取 `…/@deepseek-ai/dsh/node_modules/.package-lock.json`（530 条）；
2. 加根条目与 `node_modules/@deepseek-ai/dsh`（tarball + integrity 取自官方 registry）；
3. 530 条整体加前缀成 `node_modules/@deepseek-ai/dsh/node_modules/…`；
4. `npm ci` 报缺的 80 条平台包（ripgrep / libreoffice-kit / node-addon-system 的各平台变体）
   从官方 registry 补进来，标 `optional: true`。

之后**不再需要上游 APK**：所有包都由官方 registry 的 tarball + integrity 驱动。

## 与补丁层的关系

官方包是**干净**的（15 条 Android 补丁签名里只有 1 条天然命中），所以内核树必须叠加
本仓库的补丁层 `dsh-patches/overlay/`（由 `android-app/build.sh` 在构建期应用）：

- 13 个内核补丁文件（`dsh-fs-local`、`dsh-app-boot`、`dsh-ptc-runtime-node`、`dsh-llm-deepseek`、
  `dsh-storage-json`、`libreoffice-kit`、`node-addon-system`、`node-addon-require-builtin` 等）；
- `node-pty`：npm 装的那份**没有 Android 预编译**，必须由 overlay 覆盖**嵌套路径**
  （`…/@deepseek-ai/dsh/node_modules/node-pty`）—— 因为 `dsh-subprocess-local` 解析时命中的是它，
  而不是 hoisted 的 `lib/node_modules/node-pty`。overlay 里那份是 Termux 构建的
  AArch64 N-API 产物（ELF machine `0xb7`）。
