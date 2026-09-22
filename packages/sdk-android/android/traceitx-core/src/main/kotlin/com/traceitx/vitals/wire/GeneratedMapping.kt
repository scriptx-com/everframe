// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The generated envelope type renders `payload.vitals` as one merged
// all-optional `Vital` class (quicktype flattens the discriminated union).
// This is the only place the hand-written wire types meet it.
package com.traceitx.vitals.wire

import com.traceitx.protocol.generated.Type
import com.traceitx.protocol.generated.Vital
import com.traceitx.protocol.generated.VitalKind

fun List<VitalsEntry>.toGeneratedVitals(): List<Vital> = mapNotNull { e ->
    when (e) {
        is VitalsSample -> Vital(kind = VitalKind.Sample, t = e.t.toDouble(), mem = e.mem.toDouble(), cpu = e.cpu, extras = e.extras)
        is VitalsPlayerEvent -> {
            val type = Type.entries.firstOrNull { it.value == e.type } ?: return@mapNotNull null
            Vital(kind = VitalKind.Player, t = e.t.toDouble(), type = type, playerID = e.playerId, data = e.data, truncated = e.truncated)
        }
        is VitalsCustomEntry -> Vital(kind = VitalKind.Custom, t = e.t.toDouble(), name = e.name, data = e.data, truncated = e.truncated, playerID = e.playerId)
    }
}
