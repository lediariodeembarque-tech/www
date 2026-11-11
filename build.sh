#!/bin/bash
set -e
BUILD_DIR="/app/applet/tmp/apk_build"
cd "$BUILD_DIR"

rm -rf bin/* gen/*; mkdir -p res/drawable res/values gen bin assets

# Icons
cp /app/applet/icon-192.png res/drawable/ic_launcher.png

# Assets
cp /app/applet/index.html assets/
cp /app/applet/manifest.json assets/
cp /app/applet/icon-192.png assets/
cp /app/applet/icon-512.png assets/
cp /app/applet/favicon.png assets/
cp /app/applet/apple-touch-icon.png assets/

# Never generate or replace a signing key automatically.
# The existing keystore must be supplied securely by the release environment.
if [ ! -f release.keystore ]; then
  echo "ERRO: release.keystore não encontrado. Build interrompido para evitar gerar uma chave diferente."
  exit 1
fi

: "${ANDROID_KEYSTORE_PASSWORD:?Defina ANDROID_KEYSTORE_PASSWORD no ambiente seguro de build}"
: "${ANDROID_KEY_PASSWORD:=$ANDROID_KEYSTORE_PASSWORD}"

echo "--- 1. Generating R.java with aapt ---"
aapt package -f -m -J gen -S res -M AndroidManifest.xml -I /tmp/android.jar

echo "--- 2. Compiling Java classes with javac ---"
javac -encoding UTF-8 -source 8 -target 8 -cp /tmp/android.jar -d bin gen/com/diariodeembarque/app/R.java src/com/diariodeembarque/app/MainActivity.java

echo "--- 3. Converting classes to DEX with dalvik-exchange ---"
/usr/bin/dalvik-exchange --dex --output=bin/classes.dex bin

echo "--- 4. Creating initial APK with aapt ---"
aapt package -f -M AndroidManifest.xml -S res -A assets -I /tmp/android.jar -F bin/unaligned.apk

echo "--- 5. Adding classes.dex to APK ---"
(cd bin && aapt add unaligned.apk classes.dex)

echo "--- 6. Running zipalign ---"
zipalign -f -p 4 bin/unaligned.apk /app/applet/diario-embarque.apk

echo "--- 7. Signing APK with apksigner ---"
apksigner sign --ks release.keystore --ks-pass env:ANDROID_KEYSTORE_PASSWORD --key-pass env:ANDROID_KEY_PASSWORD /app/applet/diario-embarque.apk

echo "--- 8. Verifying APK ---"
apksigner verify -v /app/applet/diario-embarque.apk

echo "--- SUCCESS! APK CREATED AT /app/applet/diario-embarque.apk ---"
ls -lh /app/applet/diario-embarque.apk
