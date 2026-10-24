// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// User-visible copy for device linking. Fixed by the wire contract; change it
// there first.

package dev.everframe.devicelink

internal object DeviceLinkCopy {
    fun captured(owner: DeviceLinkOwner): String = when (owner) {
        is DeviceLinkOwner.User -> "Captured · ${owner.displayName()}"
        DeviceLinkOwner.Team -> "Captured · team device"
    }

    fun linked(owner: DeviceLinkOwner): String = when (owner) {
        is DeviceLinkOwner.User -> "Linked to ${owner.displayName()}"
        DeviceLinkOwner.Team -> "Linked as team device"
    }

    const val UNLINKED: String = "This device was unlinked"

    fun bannerTitle(number: Int): String = "Linking to Everframe · $number"

    const val BANNER_SUBLINE: String = "A teammate is linking a device. If that's not you, ignore this."
}
