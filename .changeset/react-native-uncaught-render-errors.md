---
"@everframe/react-native": patch
"@everframe/sdk-android": patch
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

React Native: an error that no error boundary catches (thrown while rendering, in an effect or in a lifecycle method) is now reported as a fatal JavaScript crash with its Hermes stack, and React's component stack follows the message after `This error is located at:`. Since React Native 0.78, React reports these through the root's `onUncaughtError` and React Native's `ExceptionsManager`, never the `ErrorUtils` handler, so they arrived only as React Native's native fatal (`RCTFatalException` on iOS and tvOS, `JavascriptException` on Android) with no JavaScript frames. Crash reporting now also hooks `ExceptionsManager.handleException`, and keeps the hook until the end of the task in which React unmounted `EverframeProvider`, because React reports the error after that unmount. The native fatal that follows is not reported again; on Android that match now also recognises React Native's wrapper when the title carries a component stack, when the message was cut at 4,096 characters, when the JavaScript stack contains native or internal frames, and when the message already starts with the error name. Errors a boundary catches are unchanged: report them with `captureReactError`.
