---
'@everframe/react-native': minor
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

Errors from a failed native-module call now carry the native stack. React Native builds these errors in native code, so their JavaScript stack has no frames, and a rejected call (such as a Java exception in a notifications library) used to arrive with no stack at all. When the JavaScript stack is empty, the Java frames React Native attaches on Android (`nativeStackAndroid`) are sent as JVM stack lines, and the iOS call stack (`nativeStackIOS`) is sent without its per-launch addresses, so one failure keeps one fingerprint.
