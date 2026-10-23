---
'@everframe/sdk-ios-marker': patch
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

Simulator quick capture skips a binding that is also ordinary typing (a key alone or with Shift only, such as the new dashboard default ⇧B) while an editable text input is first responder: `UITextField`, an editable `UITextView`, and React Native or Flutter text inputs. Double Shift and chords with ⌘, ⌃ or ⌥ fire whatever has focus, as before.
