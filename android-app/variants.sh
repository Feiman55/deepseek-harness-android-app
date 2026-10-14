#!/system/bin/sh
# ============================================================================
# 变体表（单一真源）—— 由 android-app/build.sh 与 tools/build-apk.sh source。
#
# 本版：**只保留社区版（community）**。此前还支持 official / lite / compat 三个变体：
#   · official（com.deepseek.harness，用私有 release.jks 签）—— 与官方包同包名，
#     本地调试密钥签不出可覆盖安装的包，实际只用于自测；
#   · lite（.beta）与 compat（.compat，内嵌 GeckoView）—— 兼容版/救援版整条线已按维护者
#     决定删除（连同 android-app/compat/、android-app-fix/、legacy-patch/）。
# 社区版是唯一对外发布的产物（release 名形如 v1.19.x-community），也是唯一默认变体。
#
# 每个字段的用途：构建期生成 AndroidManifest 与 BuildVariant.java，不靠包名子串硬编码。
# ⚠ 端口与目录全局唯一（历史踩坑：8999 互斥导致"虚拟屏二选一"）。
#    规则：引擎端口 = 3080 + 2*idx；通知端口 = 引擎端口 + 1；
#          虚拟屏桥 = 8999 + 10*idx；虚拟屏核心 = 8998 + 10*idx（社区版 idx=3）。
#
# 用法：
#   bash android-app/build.sh            # 直接构建（DSH_VARIANT 恒为 community）
#   bash tools/build-apk.sh              # 推荐：一键构建（默认社区版）
# ============================================================================

DSH_VARIANT="community"

# 社区版：由公开的 community.jks 签名，与官方版可共存。
# 密钥是【故意公开】的，只用于社区自助构建；绝不用于签名正式发布物。
V_APP_ID="com.deepseek.harness.community"
V_PORT=3086
V_EXT_DIR="DeepSeekHarnessCommunity"
V_LABEL="DeepSeek Harness"
V_SUFFIX="-community"
V_KEY_FILE="community.jks"
V_VS_BRIDGE_PORT=9029
V_VS_CORE_PORT=9028

V_NOTIFY_PORT=$((V_PORT + 1))
# Java 包路径（com.deepseek.harness.community → com/deepseek/harness/community）
V_PKG_PATH=$(printf '%s' "$V_APP_ID" | tr '.' '/')
# 变体主类前缀（供 app_process 拉起 vscreen 特权核心时拼类名）
V_VS_CORE_MAIN="$V_APP_ID.vscreen.Main"

export DSH_VARIANT V_APP_ID V_PORT V_NOTIFY_PORT V_EXT_DIR V_LABEL V_SUFFIX V_KEY_FILE \
       V_VS_BRIDGE_PORT V_VS_CORE_PORT V_PKG_PATH V_VS_CORE_MAIN
