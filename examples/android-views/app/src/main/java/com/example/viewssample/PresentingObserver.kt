// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// PresentingObserver — Kotlin helper that observes
// `Everframe.report.isPresenting` on the Activity's lifecycleScope and toggles
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
import dev.everframe.Everframe
import kotlinx.coroutines.launch

internal object PresentingObserver {
    /**
     * Disables [button] while `Everframe.report.isPresenting.value == true`.
     * Re-enables when the reporter dismisses. Cancels with the Activity.
     */
    @JvmStatic
    fun observe(activity: AppCompatActivity, button: Button) {
        activity.lifecycleScope.launch {
            activity.repeatOnLifecycle(Lifecycle.State.STARTED) {
                Everframe.report.isPresenting.collect { presenting ->
                    button.isEnabled = !presenting
                }
            }
        }
    }
}
