#!/system/bin/sh
# shell-probe —— 打印"**引擎进程**看到的环境"（W7）
#
# ⚠ 关键教训（实测踩过两次）：
#   1) 不要读"运行脚本的这个 shell"的 env —— DSH_BASH_PATH / SHELL / TMPDIR / 镜像变量都是
#      **App 拉起引擎时注入的**，只有引擎进程自己的 environ 才有意义；
#   2) 不要用"命令行里包含 runtime/bin/node"来找进程 —— 本脚本自己的命令行就带这个字符串，
#      会匹配到脚本自己（于是又读到错误上下文）。这里用 `readlink /proc/<pid>/exe` 精确匹配。
#
# 用法（需要 root 才能读别的应用的 /proc）：
#   adb push tools/diag/shell-probe.sh /data/local/tmp/
#   adb shell su 0 sh /data/local/tmp/shell-probe.sh
PKG="${1:-com.deepseek.harness.community}"
P="/data/data/$PKG/files/payload"

echo "== shell-probe =="
echo "1) 找引擎进程（readlink /proc/<pid>/exe == .../runtime/bin/node）"
NODE_PID=""
for d in /proc/[0-9]*; do
  e="$(readlink "$d/exe" 2>/dev/null)" || continue
  case "$e" in
    */runtime/bin/node) NODE_PID="${d#/proc/}"; break ;;
  esac
done
if [ -z "$NODE_PID" ] && command -v su >/dev/null 2>&1; then
  NODE_PID="$(su 0 sh -c 'for d in /proc/[0-9]*; do e=$(readlink $d/exe 2>/dev/null); case "$e" in */runtime/bin/node) echo ${d#/proc/}; break;; esac; done' 2>/dev/null)"
fi
if [ -z "$NODE_PID" ]; then
  echo "   没找到引擎进程：引擎没在跑，或当前不是 root（读 /proc/<pid>/exe 需要 root）"
  echo "   提示：先启动引擎；再用 su 0 跑本脚本"
  exit 0
fi
echo "   引擎 pid = $NODE_PID"

echo
echo "2) 引擎的关键环境变量"
ENVF="$(cat /proc/$NODE_PID/environ 2>/dev/null | tr '\0' '\n')"
[ -n "$ENVF" ] || ENVF="$(su 0 sh -c "cat /proc/$NODE_PID/environ 2>/dev/null | tr '\\0' '\\n'" 2>/dev/null)"
if [ -z "$ENVF" ]; then echo "   读不到 environ（需要 root）"; fi
for k in SHELL DSH_BASH_PATH TMPDIR HOME DSH_HOME TERMINFO \
         NPM_CONFIG_REGISTRY npm_config_registry PIP_INDEX_URL PIP_TRUSTED_HOST \
         SSL_CERT_FILE GIT_CONFIG_GLOBAL PATH ROOT_AVAILABLE SHIZUKU_AVAILABLE; do
  v="$(printf '%s\n' "$ENVF" | grep -m1 "^$k=" | cut -d= -f2-)"
  printf '   %-22s %s\n' "$k" "${v:-<未设置>}"
done

echo
echo "3) 注入的路径真的存在吗（注入值必须落地，否则等于没注入）"
for k in SHELL DSH_BASH_PATH TMPDIR TERMINFO SSL_CERT_FILE GIT_CONFIG_GLOBAL; do
  v="$(printf '%s\n' "$ENVF" | grep -m1 "^$k=" | cut -d= -f2-)"
  [ -n "$v" ] || continue
  if [ -e "$v" ]; then
    printf '   %-16s 存在   %s\n' "$k" "$v"
  else
    printf '   %-16s **不存在**  %s\n' "$k" "$v"
  fi
done

echo
echo "4) 人工对照（在 App 的终端里跑，可复现 P5 的 shell 陷阱）"
echo "   node -e 'const cp=require(\"child_process\");try{console.log(cp.execSync(\"echo ok\").toString())}catch(e){console.log(\"execSync 失败:\",e.message.split(\"\\n\")[0])}'"
echo "   node -e 'const cp=require(\"child_process\");console.log(cp.execSync(\"echo ok\",{shell:process.env.DSH_BASH_PATH}).toString())'"
