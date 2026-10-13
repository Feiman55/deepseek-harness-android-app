#!/system/bin/sh
# mirror-probe —— 打印"设备侧到底哪些源可达"的可粘贴表格（W7）
#
# 为什么需要：可达性因网络而异（实测：一边 github/raw 可达而 gitee 不可达，另一边正相反）。
# 这份输出就是 config/mirrors.env 排序的真实依据 —— 贴进 issue 即可复现诊断。
#
# 用法：adb push tools/diag/mirror-probe.sh /data/local/tmp/ && adb shell sh /data/local/tmp/mirror-probe.sh
PKG="${1:-com.deepseek.harness.community}"
P="/data/data/$PKG/files/payload"
CURL="$P/runtime/bin/curl"
[ -x "$CURL" ] || CURL="$(command -v curl || echo curl)"

echo "== mirror-probe =="
echo "包名: $PKG"
echo "curl: $CURL ($("$CURL" --version 2>/dev/null | head -1))"
echo

echo "== 1) 各源可达性（HEAD，8 秒超时）=="
printf '%-46s %-8s %-8s\n' "URL" "HTTP" "耗时ms"
for u in \
  https://registry.npmmirror.com/@deepseek-ai%2fdsh \
  https://registry.npmjs.org/@deepseek-ai%2fdsh \
  https://cdn.jsdelivr.net/gh/blue-soda/deepseek-harness-android-app@master/config/mirrors.env \
  https://api.github.com/repos/blue-soda/deepseek-harness-android-app \
  https://ghfast.top/https://raw.githubusercontent.com/blue-soda/deepseek-harness-android-app/master/config/mirrors.env \
  https://gh-proxy.com/https://raw.githubusercontent.com/blue-soda/deepseek-harness-android-app/master/config/mirrors.env \
  https://raw.githubusercontent.com/blue-soda/deepseek-harness-android-app/master/config/mirrors.env \
  https://pypi.tuna.tsinghua.edu.cn/simple/ \
  https://pypi.org/simple/ \
  https://packages.termux.dev/apt/termux-main/dists/stable/Release \
  https://mirrors.tuna.tsinghua.edu.cn/termux/apt/termux-main/dists/stable/Release \
  https://github.com/blue-soda/deepseek-harness-android-app/releases/latest ; do
  t0=$(date +%s%N 2>/dev/null || date +%s)
  code=$("$CURL" -sS -o /dev/null -w '%{http_code}' --max-time 8 -I "$u" 2>/dev/null || echo "ERR")
  t1=$(date +%s%N 2>/dev/null || date +%s)
  ms=$(( (t1 - t0) / 1000000 ))
  host=$(printf '%s' "$u" | sed -E 's#https?://([^/]+)/.*#\1#')
  printf '%-46s %-8s %-8s\n' "$host" "$code" "$ms"
done

echo
echo "== 2) 用 mirror-get 实取一个仓库文件（走 config/mirrors.env 的顺序）=="
if [ -x "$P/runtime/bin/mirror-get" ]; then
  "$P/runtime/bin/mirror-get" config/mirrors.env /data/local/tmp/mirrors.env.probe && \
    echo "   取到 $(wc -c < /data/local/tmp/mirrors.env.probe) 字节 ✓" || echo "   全部源失败 ✗"
else
  echo "   没有 mirror-get（payload 里 runtime/bin/mirror-get）"
fi

echo
echo "== 3) 当前生效的镜像配置（payload 随包副本）=="
if [ -f "$P/runtime/bin/mirrors.env" ]; then
  grep -v '^#' "$P/runtime/bin/mirrors.env" | grep -v '^$' | sed 's/^/   /'
else
  echo "   （没有 $P/runtime/bin/mirrors.env）"
fi
