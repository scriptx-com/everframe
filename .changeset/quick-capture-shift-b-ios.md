---
'@everframe/sdk-ios-marker': patch
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

Simulator quick capture skips a binding that is also ordinary typing (a key alone or with Shift only, such as the new dashboard default ⇧B) while an editable text input is first responder: `UITextField`, an editable `UITextView`, and React Native or Flutter text inputs. Double Shift and chords with ⌘, ⌃ or ⌥ fire whatever has focus, as before.

The `Captured · <device name>` toast now appears as soon as the capture is taken and handed to the upload, instead of after the upload finishes. A queued upload adds no second toast (the `Captured · uploads when online` toast is gone), and an upload that is rejected and not queued follows with `Capture didn't upload`.
