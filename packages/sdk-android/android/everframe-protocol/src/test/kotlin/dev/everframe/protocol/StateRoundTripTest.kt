// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.protocol
import dev.everframe.protocol.generated.*
import kotlinx.serialization.json.Json
import kotlinx.serialization.encodeToString
import kotlinx.serialization.decodeFromString
import org.junit.Assert.*
import org.junit.Test
class StateRoundTripTest {
    @Test fun primitivesStayPrimitives() {
        val input = """{"automatic":{},"custom":{"plan":"premium","enabled":false,"count":0}}"""
        val parsed = Json.decodeFromString<StateSnapshot>(input)
        assertEquals("premium", (parsed.custom["plan"] as StateValue.StringValue).value)
        assertFalse((parsed.custom["enabled"] as StateValue.BoolValue).value)
        assertEquals(0.0, (parsed.custom["count"] as StateValue.DoubleValue).value, 0.0)
        assertEquals(parsed, Json.decodeFromString<StateSnapshot>(Json.encodeToString(parsed)))
    }
}
