// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.rn
import com.facebook.react.bridge.BridgeReactContext
import com.facebook.react.bridge.JavaOnlyMap
import dev.everframe.Everframe
import dev.everframe.protocol.generated.StateValue
import org.junit.After
import org.junit.Test
import org.junit.Assert.*
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
@RunWith(RobolectricTestRunner::class)
@org.robolectric.annotation.Config(sdk = [34], manifest = org.robolectric.annotation.Config.NONE)
class StateBridgeTest {
    @After fun stop() { Everframe.kill() }
    @Test fun `primitive bridge calls synchronously update the next captured session`() {
        val bridge = EverframeModule(BridgeReactContext(RuntimeEnvironment.getApplication()))
        val options = JavaOnlyMap(); options.putString("sdkKey", "test")
        bridge.configureSync(options)
        assertTrue(bridge.setStateSync("enabled", "false"))
        assertEquals(StateValue.BoolValue(false), Everframe.captureSessionSnapshot().state?.current?.custom?.get("enabled"))
        assertTrue(bridge.setStateSync("count", "0"))
        assertEquals(StateValue.DoubleValue(0.0), Everframe.captureSessionSnapshot().state?.current?.custom?.get("count"))
        for (bad in listOf("null", "{}", "[]", "NaN")) assertFalse(bridge.setStateSync("bad", bad))
        assertTrue(bridge.clearStateSync("enabled"))
        assertFalse(Everframe.captureSessionSnapshot().state!!.current.custom.containsKey("enabled"))
    }
}
