// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.capture.video

import android.view.View

/** Cross-module native privacy classification. UNKNOWN always excludes the frame. */
public fun interface VideoPrivacyAdapter {
    public fun classify(view: View): Classification
    public enum class Classification { ORDINARY_VIEW, EXCLUDE, UNKNOWN }
}
