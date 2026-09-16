#!/usr/bin/env bash
# Source this before any Tauri Android command (Git Bash):
#   . tools/android-env.sh && npx tauri android build --apk --target aarch64
# Android Studio's bundled JBR is a stripped runtime (no lib/jvm.cfg) and
# cannot run Gradle; a portable MS OpenJDK 21 lives in LOCALAPPDATA instead:
#   curl -sL -o "$LOCALAPPDATA/jdk21.zip" https://aka.ms/download-jdk/microsoft-jdk-21-windows-x64.zip
#   /c/Windows/System32/tar.exe -xf "$LOCALAPPDATA/jdk21.zip" -C "$LOCALAPPDATA"
JDK_DIR=$(ls -d "$LOCALAPPDATA"/jdk-21.* 2>/dev/null | head -1)
export JAVA_HOME="$JDK_DIR"
export ANDROID_HOME="$LOCALAPPDATA\\Android\\Sdk"
export NDK_HOME="$LOCALAPPDATA\\Android\\Sdk\\ndk\\28.2.13676358"
export PATH="$HOME/.cargo/bin:$PATH"
