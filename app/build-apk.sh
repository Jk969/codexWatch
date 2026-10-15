#!/usr/bin/env bash
#
# CodexWatch APK 一键构建脚本(无 Gradle,纯手工工具链)
#
# 用法:在 Git Bash 中执行   bash app/build-apk.sh   (任意目录均可)
# 产物:dist/codexwatch.apk
#
# 工具链约定(全部来自仓库 .tools/,无需 Android Studio):
#   .tools/jdk            Microsoft OpenJDK 17
#   .tools/bt34           Android build-tools 34 (aapt2/zipalign/lib/d8.jar/lib/apksigner.jar)
#   .tools/android-34     platform-34 android.jar
#   .tools/Java-WebSocket-1.5.7.jar
#
set -euo pipefail

# ====================== 变量集中定义 ======================

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # .../codexWatch/app
ROOT_DIR="$(dirname "$APP_DIR")"                          # .../codexWatch
TOOLS="$ROOT_DIR/.tools"
JDK="$TOOLS/jdk"
BT="$TOOLS/bt34"
PLATFORM_JAR="$TOOLS/android-34/android.jar"
WS_JAR="$TOOLS/Java-WebSocket-1.5.7.jar"
SLF4J_API="$TOOLS/slf4j-api-2.0.6.jar"
SLF4J_NOP="$TOOLS/slf4j-nop-2.0.6.jar"

KEYSTORE="$TOOLS/cw.keystore"
KS_ALIAS="cw"
KS_PASS="codexwatch2024"          # keytool storepass/keypass,自签证书

MIN_SDK="24"
TARGET_SDK="33"
VERSION_CODE="22"
VERSION_NAME="1.3.5"

OUT_APK="$ROOT_DIR/dist/codexwatch.apk"
BUILD="$APP_DIR/build"            # 中间产物目录(build/ 可随时删除)

# ====================== 0. 前置检查 ======================

for f in "$JDK/bin/javac.exe" "$JDK/bin/java.exe" "$JDK/bin/keytool.exe" "$JDK/bin/jar.exe" \
         "$BT/aapt2.exe" "$BT/zipalign.exe" "$BT/lib/d8.jar" "$BT/lib/apksigner.jar" \
         "$PLATFORM_JAR" "$WS_JAR" "$SLF4J_API" "$SLF4J_NOP" "$APP_DIR/AndroidManifest.xml"; do
  [ -f "$f" ] || { echo "[ERROR] 缺少文件: $f" >&2; exit 1; }
done
command -v node >/dev/null 2>&1 || { echo "[ERROR] 需要 node(生成图标)" >&2; exit 1; }

# 签名密钥:不存在则自签生成
if [ ! -f "$KEYSTORE" ]; then
  echo "==> 生成自签名密钥库 $KEYSTORE (alias=$KS_ALIAS)"
  "$JDK/bin/keytool.exe" -genkeypair -v \
    -keystore "$KEYSTORE" -alias "$KS_ALIAS" -keyalg RSA -keysize 2048 -validity 10950 \
    -storepass "$KS_PASS" -keypass "$KS_PASS" \
    -dname "CN=CodexWatch, OU=dev, O=jingxixi, L=City, ST=State, C=CN" >/dev/null 2>&1
fi

# ====================== 1. 准备构建目录 ======================

[[ "$BUILD" == "$ROOT_DIR/app/build" && "$ROOT_DIR" != "/" ]] || { echo "[ERROR] 构建清理目录无效" >&2; exit 1; }
rm -rf -- "$BUILD"
mkdir -p "$BUILD/classes" "$BUILD/gen" "$ROOT_DIR/dist"

# Windows 下 javac/java 等原生工具的参数使用相对路径最稳(MSYS 不做改写)
cd "$BUILD"
TOOLS_REL="../../.tools"           # BUILD = <root>/app/build -> <root>/.tools
JDK_REL="$TOOLS_REL/jdk"
BT_REL="$TOOLS_REL/bt34"
JAVAC="$JDK_REL/bin/javac.exe"
JAVA="$JDK_REL/bin/java.exe"

# ====================== 2. 生成启动图标 ======================

echo "==> [1/7] node make-icons.js 生成 mipmap 图标"
node "$APP_DIR/make-icons.js"

# ====================== 3. aapt2 compile + link ======================

echo "==> [2/7] aapt2 compile res"
"$BT_REL/aapt2.exe" compile --dir ../res -o res.zip

echo "==> [3/7] aapt2 link 生成 base.apk(资源 + manifest)"
# 注意:Windows 版 aapt2 的 -A 会把 assets 条目写成反斜杠(assets\www\index.html),
# 运行时 AssetManager 找不到;因此 assets 改在 [6/7] 用 jar uf 以正斜杠条目补入。
"$BT_REL/aapt2.exe" link \
  -o base.apk \
  --manifest ../AndroidManifest.xml \
  -I "$TOOLS_REL/android-34/android.jar" \
  --java gen \
  --min-sdk-version "$MIN_SDK" \
  --target-sdk-version "$TARGET_SDK" \
  --version-code "$VERSION_CODE" \
  --version-name "$VERSION_NAME" \
  res.zip

# ====================== 4. javac 编译 ======================

echo "==> [4/7] javac 编译 (JDK17, -source 8)"
SRCS=$(find ../src -name '*.java')
RJAVA=$(find gen -name 'R.java')
set +e
JAVAC_OUT=$("$JAVAC" -source 8 -target 8 -encoding UTF-8 \
  -classpath "$TOOLS_REL/android-34/android.jar;$TOOLS_REL/Java-WebSocket-1.5.7.jar;$TOOLS_REL/slf4j-api-2.0.6.jar;$TOOLS_REL/slf4j-nop-2.0.6.jar" \
  -d classes $SRCS $RJAVA 2>&1)
JAVAC_RC=$?
set -e
# 过滤预期警告(仅显示层),退出码如实透传
echo "$JAVAC_OUT" | grep -v -E "警告|warning:|bootstrap class path|过时的 API|已过时|Xlint:deprecation|^注:" || true
if [ $JAVAC_RC -ne 0 ]; then
  echo "[ERROR] javac 编译失败 (exit=$JAVAC_RC)" >&2
  exit 1
fi

# 构造客户端就会加载 SLF4J，编译通过无法发现运行时缺失依赖。
mkdir -p smoke
WS_CP="$TOOLS_REL/Java-WebSocket-1.5.7.jar;$TOOLS_REL/slf4j-api-2.0.6.jar;$TOOLS_REL/slf4j-nop-2.0.6.jar"
"$JAVAC" -classpath "$WS_CP" -d smoke ../test/WebSocketSmoke.java
"$JAVA" -classpath "smoke;$WS_CP" WebSocketSmoke

# ====================== 5. d8 生成 classes.dex ======================

echo "==> [5/7] d8 dex(含 Java-WebSocket jar)"
CLS=$(find classes -name '*.class')
"$JAVA" -cp "$BT_REL/lib/d8.jar" com.android.tools.r8.D8 \
  --release --lib "$TOOLS_REL/android-34/android.jar" --min-api "$MIN_SDK" \
  --output . $CLS "$TOOLS_REL/Java-WebSocket-1.5.7.jar" \
  "$TOOLS_REL/slf4j-api-2.0.6.jar" "$TOOLS_REL/slf4j-nop-2.0.6.jar"
node ../test/check-dex.js classes.dex
# sanity:关键类必须都在 dex 里(dex 内类型描述符为 ASCII,可直接 grep)
for t in MainActivity GatewayService BootReceiver; do
  grep -aq "Ltop/jingxixi/codexwatch/$t;" classes.dex || { echo "[ERROR] classes.dex 缺少 $t" >&2; exit 1; }
done
grep -aq "Lorg/java_websocket/client/WebSocketClient;" classes.dex || { echo "[ERROR] classes.dex 缺少 Java-WebSocket" >&2; exit 1; }

# ====================== 6. 打包 dex -> zipalign -> 签名 ======================

echo "==> [6/7] jar 塞入 classes.dex + assets + zipalign + apksigner 签名"
JAR_EXE="$JDK/bin/jar.exe"
"$JAR_EXE" uf base.apk classes.dex
# d8 只转换 class，SLF4J 的 ServiceLoader 注册资源需要单独放进 APK。
"$JAR_EXE" xf "$SLF4J_NOP" META-INF/services/org.slf4j.spi.SLF4JServiceProvider
"$JAR_EXE" uf base.apk META-INF/services/org.slf4j.spi.SLF4JServiceProvider
# assets 以正斜杠条目补入(jar 在包内递归 assets/ 目录,entry 名统一为 '/')
mkdir -p pkg
cp -r ../src/assets pkg/assets
( cd pkg && "$JAR_EXE" uf ../base.apk assets )
# 校验条目分隔符必须是 '/',否则 WebView file:///android_asset/www/... 无法加载
if unzip -l base.apk | grep -a 'assets\\'; then
  echo "[ERROR] assets 条目使用了反斜杠" >&2; exit 1
fi
unzip -l base.apk | grep -a 'assets/' || { echo "[ERROR] 未找到 assets 条目" >&2; exit 1; }
"$BT_REL/zipalign.exe" -f -p 4 base.apk aligned.apk
"$JAVA" -cp "$BT_REL/lib/apksigner.jar" com.android.apksigner.ApkSignerTool sign \
  --ks "$TOOLS_REL/cw.keystore" \
  --ks-key-alias "$KS_ALIAS" \
  --ks-pass "pass:$KS_PASS" --key-pass "pass:$KS_PASS" \
  --out "$ROOT_DIR/dist/codexwatch.apk" aligned.apk

# ====================== 7. 校验 ======================

echo "==> [7/7] 校验"
BADGING=$("$BT_REL/aapt2.exe" dump badging "$ROOT_DIR/dist/codexwatch.apk")
echo "$BADGING" | head -6
CERTS=$("$JAVA" -cp "$BT_REL/lib/apksigner.jar" com.android.apksigner.ApkSignerTool verify --print-certs "$ROOT_DIR/dist/codexwatch.apk")
echo "$CERTS" | head -4
echo "$BADGING" | grep -q "package: name='top.jingxixi.codexwatch'" || { echo "[ERROR] badging 校验失败" >&2; exit 1; }
echo "$BADGING" | grep -q "launchable-activity" || { echo "[ERROR] 缺少 launchable-activity" >&2; exit 1; }

echo
echo "=============================================="
ls -l "$OUT_APK"
echo "构建完成: $OUT_APK"
echo "=============================================="
