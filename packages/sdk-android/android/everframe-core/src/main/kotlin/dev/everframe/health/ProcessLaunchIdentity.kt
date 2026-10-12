// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.health

import java.util.UUID

/** One anonymous launch token per VM process; an SDK restart does not replace it. */
internal object ProcessLaunchIdentity { val id: UUID = UUID.randomUUID() }
