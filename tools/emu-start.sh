#!/usr/bin/env bash
# 启动 x86_64 模拟器并把它准备到「能跑引擎」的状态（本版）。
#
# 为什么要有这个脚本（都是实测踩出来的）：
#   1. 模拟器必须带 **-writable-system** 启动，否则 AVD 的可写 system 覆盖层不挂载，
#      补进 /system/lib64/arm64/ 的 guest 库会"消失" → 引擎起不来（node 报
#      `CANNOT LINK … library "libz.so.1" not found`）。Android Studio 默认不带这个开关。
#   2. 图形后端要用 `-gpu swiftshader_indirect`：不带时在部分机器上宿主端会直接
#      `EXCEPTION_ACCESS_VIOLATION` 崩溃。
#   3. 启动命令**不要用管道截断**（如 `emulator … | head -30`）：管道一被关闭，
#      模拟器进程会跟着退出（看起来像"模拟器自己退了"）。
#   4. 起来之后还要补 guest 库：guest（arm64）加载器不认 LD_LIBRARY_PATH，
#      只搜 /system/lib64/arm64/ —— 由 tools/emu-arm64libs.py 负责。
#
# 用法：
#   bash tools/emu-start.sh                 # 用第一个 AVD
#   bash tools/emu-start.sh Pixel_10_Pro    # 指定 AVD
#   bash tools/emu-start.sh Pixel_10_Pro --no-libs    # 只启动，不补库
#   bash tools/emu-start.sh Pixel_10_Pro --size 720x1600 --dpi 320
#                                        # 启动后把逻辑分辨率调小（模拟器窗口一屏放得下）
#   bash tools/emu-start.sh Pixel_10_Pro --scale 0.4   # 窗口缩放（默认 0.4；--scale none 关掉）
#
# 关于窗口大小（实测）：
#   · `wm size` 只改**设备逻辑分辨率**，不会缩小宿主窗口；
#   · 窗口大小由 AVD 的 hw.lcd.*（+ skill/skin）决定；
#   · `-scale` 在**本机模拟器版本上实测被忽略**（0.45 / 0.4 / 0.34 三个值窗口都是同一尺寸），
#     所以 `--scale` 只作兼容保留；真正决定窗口大小的是 AVD config.ini 的 hw.lcd.*；
#   · 本机最终采用 hw.lcd = 360x640 @160dpi（约 373x675 的窗口，1229x768 的屏放得下）；
#   · 注意 `wm size` / `wm density` 是**运行时覆盖**，会一直留着 —— 换分辨率后要用
#     `wm size reset` + `wm density reset` 清掉，否则 physical 与 override 不一致会让人困惑。
#
# 为什么需要 --size：AVD 默认分辨率（如 Pixel_10_Pro 的 1280x2856）在笔记本屏幕上
# 窗口高到放不下；`wm size` 改的是**设备逻辑分辨率**，窗口会随之缩小，且不影响
# 打包/运行（App 内部按 dp 布局）。想让改动永久生效，改 AVD 的
# ~/.android/avd/<AVD>.avd/config.ini 里的 hw.lcd.width/height/density。
#
# 真机（arm64 原生）不需要本脚本。
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$LOCALAPPDATA/Android/Sdk}}"
EMU="$SDK/emulator/emulator"
ADB="$SDK/platform-tools/adb"
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) EMU="$EMU.exe"; ADB="$ADB.exe" ;; esac
[ -x "$EMU" ] || { echo "!! 找不到模拟器：$EMU（设 ANDROID_HOME 或装 Android SDK）"; exit 1; }
[ -x "$ADB" ] || { echo "!! 找不到 adb：$ADB"; exit 1; }

AVD="${1:-}"
shift || true
NO_LIBS=0
WM_SIZE=""
WM_DPI=""
SCALE="0.4"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-libs) NO_LIBS=1 ;;
    --size) shift; WM_SIZE="${1:-}" ;;
    --dpi)  shift; WM_DPI="${1:-}" ;;
    --scale) shift; SCALE="${1:-}" ;;
    *) echo "  （忽略未知参数：$1）" ;;
  esac
  shift || true
done
if [ -z "$AVD" ]; then
  AVD="$("$EMU" -list-avds 2>/dev/null | head -1)"
  [ -n "$AVD" ] || { echo "!! 没有可用 AVD（先建一个 userdebug 的 google_apis 镜像）"; exit 1; }
fi
echo "▶ AVD：$AVD"

mkdir -p "$REPO/.cache"
LOG="$REPO/.cache/emu-start.log"
echo "▶ 启动模拟器（-writable-system -gpu swiftshader_indirect），日志：$LOG"
# 关键：重定向到文件而不是管道，且放后台（管道截断会连带杀掉模拟器）
if [ "$SCALE" = "none" ] || [ -z "$SCALE" ]; then SCALE_ARG=""; else SCALE_ARG="-scale $SCALE"; fi
# shellcheck disable=SC2086
nohup "$EMU" -avd "$AVD" -writable-system -no-boot-anim -gpu swiftshader_indirect -no-snapshot-load $SCALE_ARG \
  >"$LOG" 2>&1 &
EMU_PID=$!
echo "   emulator pid=$EMU_PID"

echo -n "▶ 等待启动完成"
ok=0
for _ in $(seq 1 60); do
  sleep 5
  b="$("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')"
  if [ "$b" = "1" ]; then ok=1; break; fi
  echo -n "."
  # 模拟器进程没了就早退，别傻等
  kill -0 "$EMU_PID" 2>/dev/null || { echo; echo "!! 模拟器进程已退出，看日志：$LOG"; tail -n 12 "$LOG"; exit 1; }
done
echo
[ "$ok" = "1" ] || { echo "!! 启动超时（120s×…），看日志：$LOG"; exit 1; }
echo "   ✓ 已启动"

echo "▶ 准备可写 /system"
"$ADB" root >/dev/null 2>&1 || true
sleep 3
"$ADB" remount 2>&1 | sed 's/^/   /' || true
if "$ADB" shell "touch /system/lib64/arm64/.dsh-wtest && rm -f /system/lib64/arm64/.dsh-wtest" 2>/dev/null; then
  echo "   ✓ /system 可写"
else
  echo "   !! /system 不可写：该 AVD 需要用 -writable-system 启动，且镜像须为 userdebug"
  echo "      （Android Studio：Device Manager → 编辑该 AVD → Additional emulator command line options 填 -writable-system）"
  exit 1
fi

if [ "$NO_LIBS" = "1" ]; then
  echo "▶ 跳过 guest 库（--no-libs）"
else
  echo "▶ 补 guest 库（node 的 arm64 依赖 → /system/lib64/arm64/）"
  PY=""
  for c in python3 python py; do
    if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys' >/dev/null 2>&1; then PY="$c"; break; fi
  done
  if [ -z "$PY" ]; then
    echo "   !! 本机没有可用 python，手动跑：python tools/emu-arm64libs.py"
  else
    "$PY" "$REPO/tools/emu-arm64libs.py" --adb "$ADB" 2>&1 | sed 's/^/   /' || \
      echo "   !! 补库失败（见上）；可重复执行本脚本，或手动 python tools/emu-arm64libs.py"
  fi
fi

# 可选：把逻辑分辨率/密度调小（模拟器窗口一屏放得下；不影响打包与 App 的 dp 布局）
if [ -n "$WM_SIZE" ] || [ -n "$WM_DPI" ]; then
  echo "▶ 调整模拟器显示尺寸"
  [ -n "$WM_SIZE" ] && { "$ADB" shell wm size "$WM_SIZE" 2>&1 | sed 's/^/   /'; }
  [ -n "$WM_DPI" ] && { "$ADB" shell wm density "$WM_DPI" 2>&1 | sed 's/^/   /'; }
  sleep 1
  echo "   现在：$("$ADB" shell wm size 2>/dev/null | tr -d '\r') / $("$ADB" shell wm density 2>/dev/null | tr -d '\r')"
  echo "   （永久生效请改 AVD 的 config.ini：hw.lcd.width/height/density）"
fi

echo
echo "✓ 就绪。接下来："
echo "    adb install -r android-app/DeepSeekHarness-community-1.19.3-x86_64.apk   # 模拟器包"
echo "    adb shell am start -n com.deepseek.harness.community/.MainActivity        # 走完向导后点「启动引擎」"
echo "    引擎就绪判据：adb logcat -d | grep 'engine token url captured'"
