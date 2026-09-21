// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// PresentingObserver — Kotlin helper that observes
// `TraceItX.report.isPresenting` on the Activity's lifecycleScope and toggles
// a Button's enabled state. Hides the kotlinx.coroutines suspend-collect
// boilerplate from MainActivity.java.
//
// Per plan-checker W2: uses `androidx.lifecycle.lifecycleScope` (NOT
// GlobalScope) so the collect coroutine cancels with the Activity.
package com.example.viewssample

import android.widget.Button
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.traceitx.TraceItX
import kotlinx.coroutines.launch

internal object PresentingObserver {
    /**
     * Disables [button] while `TraceItX.report.isPresenting.value == true`.
     * Re-enables when the reporter dismisses. Cancels with the Activity.
     */
    @JvmStatic
    fun observe(activity: AppCompatActivity, button: Button) {
        activity.lifecycleScope.launch {
            activity.repeatOnLifecycle(Lifecycle.State.STARTED) {
                TraceItX.report.isPresenting.collect { presenting ->
                    button.isEnabled = !presenting
                }
            }
        }
    }
}
