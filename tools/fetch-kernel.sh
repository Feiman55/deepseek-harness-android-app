#!/usr/bin/env bash
# 用**官方 npm registry + 仓库内 lock** 冻结安装 DSH 内核树（A2′）。
#
# 为什么不再从上游 APK 里抠 dshroot：
#   实测上游 payload 的 dshroot 是 **npm** 装的（`…/@deepseek-ai/dsh/node_modules/.package-lock.json`，
#   lockfileVersion=3，530 包全带 integrity，零 dev / 零 optional），而官方 tag 的 `pnpm-lock.yaml`
#   与它差 37 个第三方版本 —— 所以"从官方 tag 跑 pnpm frozen"会装出另一棵树。
#   本脚本改用那份**真实 lock 的等价物**（`android-app/kernel/package-lock.json`，一次性从 payload
#   提升 530 条 + 补 80 条平台可选依赖）直接从官方 registry 复刻：9 秒、零漂移、不需要上游 APK。
#
# 用法：
#   bash tools/fetch-kernel.sh <输出目录>        # 输出目录 = Android 侧的 dshroot/lib
#   环境变量：NPM_BIN（默认 npm）、NPM_FLAGS（追加参数）
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
KERNEL_DIR="$REPO/android-app/kernel"
OUT="${1:-}"
NPM_BIN="${NPM_BIN:-npm}"

[ -n "$OUT" ] || { echo "用法：bash tools/fetch-kernel.sh <输出目录>" >&2; exit 1; }
[ -f "$KERNEL_DIR/package.json" ] || { echo "!! 缺 $KERNEL_DIR/package.json" >&2; exit 1; }
[ -f "$KERNEL_DIR/package-lock.json" ] || { echo "!! 缺 $KERNEL_DIR/package-lock.json" >&2; exit 1; }
command -v "$NPM_BIN" >/dev/null 2>&1 || { echo "!! 找不到 npm（内核树由官方 registry 冻结安装，需要 npm）" >&2; exit 1; }

LOCK="$KERNEL_DIR/package-lock.json"

# ── 1. lock 自检（纯 shell，不依赖 node/路径转换）────────────────────────────
N_ENTRIES=$(grep -c '"version":' "$LOCK" || true)
N_INTEG=$(grep -c '"integrity": "sha' "$LOCK" || true)
K_VER=$(sed -n '/"node_modules\/@deepseek-ai\/dsh": {/,/"dependencies"/p' "$LOCK" \
        | sed -n 's/.*"version": "\([^"]*\)".*/\1/p' | head -1)
N_REGISTRY=$(grep -c '"resolved": "https://registry.npmjs.org' "$LOCK" || true)
echo "   lock: version 行 $N_ENTRIES · integrity $N_INTEG · registry tarball $N_REGISTRY · 内核 $K_VER"
[ "$K_VER" = "0.2.0-rc.2" ] || { echo "!! 内核版本不是 0.2.0-rc.2：$K_VER" >&2; exit 1; }
[ "$N_ENTRIES" -ge 600 ] || { echo "!! lock 条目过少（$N_ENTRIES），疑似被截断" >&2; exit 1; }
[ "$N_INTEG" -ge 600 ] || { echo "!! integrity 覆盖不足（$N_INTEG）" >&2; exit 1; }
[ "$N_REGISTRY" -ge 600 ] || { echo "!! 有 tarball 不是来自官方 registry（$N_REGISTRY）" >&2; exit 1; }

# ── 2. 冻结安装（android/arm64 口径，与上游 payload 的安装口径一致）─────────
#   --os=android --cpu=arm64 : 按 Android 选择可选依赖（上游 payload 就是这么装的）
#   --omit=optional --omit=dev --ignore-scripts : 上游 lock 里 dev/optional 均为 0；
#     不在宿主机编译原生产物（预编译由包自带，node-pty 由 overlay 提供）
mkdir -p "$OUT"
cp "$KERNEL_DIR/package.json" "$KERNEL_DIR/package-lock.json" "$OUT/"
( cd "$OUT" && "$NPM_BIN" ci \
    --os=android --cpu=arm64 \
    --omit=optional --omit=dev --ignore-scripts \
    --no-audit --no-fund --loglevel=error ${NPM_FLAGS:-} )
# 安装用的两份元数据不能留在 dshroot/lib 里（会让 lib/ 变成 package root，干扰 Node 解析）
rm -f "$OUT/package.json" "$OUT/package-lock.json"

# ── 3. 结果自检 ──────────────────────────────────────────────────────────────
KROOT="$OUT/node_modules/@deepseek-ai/dsh"
[ -d "$KROOT" ] || { echo "!! 没装出 $KROOT" >&2; exit 1; }
VER=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$KROOT/package.json" | head -1)
N_PKG=$(find "$KROOT/node_modules" -name package.json 2>/dev/null | wc -l | tr -d ' ')
echo "   内核树: node_modules/@deepseek-ai/dsh（版本 $VER，依赖包 $N_PKG 个）"
[ "$VER" = "0.2.0-rc.2" ] || { echo "!! 内核版本异常：$VER" >&2; exit 1; }
[ "$N_PKG" -ge 450 ] || { echo "!! 依赖包数量异常：$N_PKG" >&2; exit 1; }
echo "== fetch-kernel: OK =="
