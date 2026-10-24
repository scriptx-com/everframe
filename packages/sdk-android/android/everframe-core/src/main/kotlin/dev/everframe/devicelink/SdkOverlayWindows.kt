// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// SDK windows shown over the host's Activity, such as the reporter dialog. The
// linking banner is a panel of the window it is attached to, so Android keeps
// it below any later app window; while one of these windows shows, the banner
// moves onto it so the matching number stays visible, and moves back when it
// closes. The window itself is never dismissed by this.

package dev.everframe.devicelink

import android.view.Window
import androidx.annotation.RestrictTo

/** SDK plumbing for `everframe-reporter-ui`; apps never call it. */
@RestrictTo(RestrictTo.Scope.LIBRARY_GROUP)
object SdkOverlayWindows {
    /** [window] is showing over the Activity until the returned handle is closed. Call on the main thread. */
    fun shown(window: Window): AutoCloseable {
        LinkBanner.overlayShown(window)
        var closed = false
        return AutoCloseable {
            if (!closed) {
                closed = true
                LinkBanner.overlayClosed(window)
            }
        }
    }

    /** The registered windows, topmost last. For SDK tests. */
    val current: List<Window> get() = LinkBanner.overlays()
}
