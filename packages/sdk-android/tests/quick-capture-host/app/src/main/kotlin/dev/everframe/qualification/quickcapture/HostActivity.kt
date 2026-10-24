// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.qualification.quickcapture

import android.app.Activity
import android.os.Bundle
import android.view.Gravity
import android.widget.TextView

/** A plain screen to capture. Shake the device (or the emulator's virtual sensors) to trigger. */
class HostActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(
            TextView(this).apply {
                text = "Everframe quick capture host\nShake to capture or link"
                gravity = Gravity.CENTER
                textSize = 20f
            },
        )
    }
}
