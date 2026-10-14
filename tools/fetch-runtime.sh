#!/usr/bin/env bash
# 取 arm64 运行时资产（B2）：node/python/npm/pnpm/git/bash/bin/rish + profile 脚手架。
#
# 为什么需要它：内核树已经改成"官方 registry 冻结安装"（tools/fetch-kernel.sh），但构建还需要
# arm64 的运行时二进制，而它们**不在** DSH 官方仓库里（官方 primary-runtime 只有 win/mac/linux
# 五个 target，没有 android）。所以我们把它做成一枚 sha256 pin 住的资产：
#
#   runtime/  node 26.4.0（Termux 构建）+ rg/curl + 共享库（含 LINKS.txt 的 soname 别名）
#   python/   python 3.12 + 预装包        npm/ pnpm/ git/ bash/ bin/ rish/
#   .dsh/     默认 profile 脚手架（cordis.patch.yml / settings.yaml / profiles/web/*）
#
# 用法：
#   bash tools/fetch-runtime.sh <输出目录>            # 解出 runtime/ python/ … .dsh/
#   环境变量：
#     DSH_RUNTIME_ARCHIVE  用本地归档（离线/镜像场景），仍会校验 sha256
#     DSH_RUNTIME_SHA256   覆盖期望的 sha256（换资产时显式接受）
#     DSH_RUNTIME_URL      覆盖下载地址
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-}"
# ── 资产 pin（换资产时同时改这里与 README 里的说明）──────────────────────────
RUNTIME_REPO="blue-soda/deepseek-harness-android-app"
RUNTIME_TAG="runtime-arm64-node26.4.0-tools2"
RUNTIME_ASSET="dsh-android-runtime-arm64-tools2.tar.gz"
RUNTIME_SHA256_DEFAULT="f056e948704d67c2d97f4310148319c83252241701dcb8a9dd4e2a83113f2b3f"
RUNTIME_URL="${DSH_RUNTIME_URL:-https://github.com/$RUNTIME_REPO/releases/download/$RUNTIME_TAG/$RUNTIME_ASSET}"
WANT_SHA="${DSH_RUNTIME_SHA256:-$RUNTIME_SHA256_DEFAULT}"

[ -n "$OUT" ] || { echo "用法：bash tools/fetch-runtime.sh <输出目录>" >&2; exit 1; }
mkdir -p "$OUT"

sha_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}';
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}';
  else echo ""; fi
}

ARCHIVE="${DSH_RUNTIME_ARCHIVE:-}"
if [ -n "$ARCHIVE" ]; then
  [ -f "$ARCHIVE" ] || { echo "!! 找不到本地运行时归档：$ARCHIVE" >&2; exit 1; }
  echo "   使用本地归档：$ARCHIVE"
else
  CACHE="$REPO/.cache"
  mkdir -p "$CACHE"
  ARCHIVE="$CACHE/$RUNTIME_ASSET"
  GOT=""
  [ -f "$ARCHIVE" ] && GOT="$(sha_of "$ARCHIVE")"
  if [ "$GOT" = "$WANT_SHA" ]; then
    echo "   命中缓存：$ARCHIVE"
  else
    [ -f "$ARCHIVE" ] && { echo "   缓存 sha256 不符，重新下载"; rm -f "$ARCHIVE"; }
    # ── 多源下载：官方优先，代理兜底；**每一路都验 sha256**，不符就换下一路 ──
    #   代理链来自 config/mirrors.env（单一真源）；代理形式是"前缀 + 官方 URL"。
    PROXIES=""
    if [ -f "$REPO/config/mirrors.env" ]; then
      # shellcheck disable=SC1091
      . "$REPO/config/mirrors.env"
      PROXIES="${GH_RELEASE_PROXIES:-}"
    fi
    CANDIDATES="$RUNTIME_URL"
    for _p in $PROXIES; do CANDIDATES="$CANDIDATES ${_p}${RUNTIME_URL}"; done
    # DSH_RUNTIME_URL 显式指定时只用它（尊重调用方）
    [ -n "${DSH_RUNTIME_URL:-}" ] && CANDIDATES="$RUNTIME_URL"

    OK=0
    TRIED=""
    for _u in $CANDIDATES; do
      echo "   下载：$_u"
      if curl -L --fail --retry 2 --retry-delay 2 -C - -o "$ARCHIVE.part" "$_u" 2>/dev/null; then
        _got="$(sha_of "$ARCHIVE.part")"
        if [ "$_got" = "$WANT_SHA" ]; then
          mv -f "$ARCHIVE.part" "$ARCHIVE"
          OK=1
          echo "   ✓ 下载完成且 sha256 校验通过（源：$(printf '%s' "$_u" | cut -c1-56)…）"
          break
        fi
        TRIED="$TRIED
     · $(printf '%s' "$_u" | cut -c1-56)… → 下载成功但 sha256 不符（$_got）"
        rm -f "$ARCHIVE.part"
      else
        TRIED="$TRIED
     · $(printf '%s' "$_u" | cut -c1-56)… → 下载失败"
        rm -f "$ARCHIVE.part"
      fi
    done
    if [ "$OK" != "1" ]; then
      echo "!! 运行时资产从所有源都取不到（每一路都试过并校验）：$TRIED" >&2
      echo "   可手动下载后用 DSH_RUNTIME_ARCHIVE=<文件> 指定；或把可用的代理加进 config/mirrors.env" >&2
      exit 1
    fi
  fi
fi

GOT="$(sha_of "$ARCHIVE")"
[ -n "$GOT" ] || { echo "!! 缺少 sha256sum/shasum，无法校验运行时资产" >&2; exit 1; }
if [ "$GOT" != "$WANT_SHA" ]; then
  echo "!! 运行时资产 sha256 不符" >&2
  echo "   期望：$WANT_SHA" >&2
  echo "   实际：$GOT" >&2
  echo "   确认无误后用 DSH_RUNTIME_SHA256=$GOT 显式接受（并更新脚本里的 pin）" >&2
  exit 1
fi
echo "   sha256 校验通过：$GOT"

echo "   解包到：$OUT"
tar xzf "$ARCHIVE" -C "$OUT"
[ -d "$OUT/runtime/bin" ] || { echo "!! 解包后缺 runtime/bin（归档结构不对？）" >&2; exit 1; }
[ -f "$OUT/runtime/bin/node" ] || { echo "!! 解包后缺 runtime/bin/node" >&2; exit 1; }
[ -d "$OUT/.dsh" ] || { echo "!! 解包后缺 .dsh（profile 脚手架）" >&2; exit 1; }
echo "   内容：$(du -sh "$OUT" 2>/dev/null | cut -f1) · node $("$OUT/runtime/bin/node" -v 2>/dev/null || echo '（宿主上无法执行，正常）')"
echo "== fetch-runtime: OK =="
