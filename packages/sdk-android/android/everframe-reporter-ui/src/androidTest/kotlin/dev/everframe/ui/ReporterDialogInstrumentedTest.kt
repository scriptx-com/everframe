// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Instrumented test — requires phone or tablet emulator. Verifies the
// ReporterRoot Composable renders title + description fields, an annotated
// screenshot Image, and the Send button; that empty-title submit triggers
// validation; that a valid submit triggers the onSubmit callback with a
// baked Bitmap.
package dev.everframe.ui

import android.graphics.Bitmap
import android.graphics.Color
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.assertIsDisplayed
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import dev.everframe.capture.ScreenshotCapture
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Rule
import org.junit.Test
import java.io.ByteArrayOutputStream

class ReporterDialogInstrumentedTest {

    @get:Rule
    val composeRule = createAndroidComposeRule<ComponentActivity>()

    private fun fakeCapture(): ScreenshotCapture.CaptureResult {
        val bmp = Bitmap.createBitmap(400, 600, Bitmap.Config.ARGB_8888).apply {
            eraseColor(Color.WHITE)
        }
        val pngBytes = ByteArrayOutputStream().use { bos ->
            bmp.compress(Bitmap.CompressFormat.PNG, 100, bos); bos.toByteArray()
        }
        return ScreenshotCapture.CaptureResult(bmp, 400, 600, pngBytes)
    }

    @Test
    fun reporter_renders_title_description_image_send() {
        composeRule.setContent {
            MaterialTheme {
                ReporterRoot(
                    reportCapture = dev.everframe.Everframe.__replayFreeze(),
                    activity = composeRule.activity,
                    capture = fakeCapture(),
                    onSubmit = { _, _, _, _ -> },
                    onCancel = { },
                )
            }
        }
        composeRule.onNodeWithText("Title *").assertIsDisplayed()
        composeRule.onNodeWithText("What happened?").assertIsDisplayed()
        composeRule.onNodeWithContentDescription("Captured screenshot").assertIsDisplayed()
        composeRule.onNodeWithText("Send").assertIsDisplayed()
    }

    @Test
    fun empty_title_send_does_not_invoke_onSubmit() {
        var submitted = false
        composeRule.setContent {
            MaterialTheme {
                ReporterRoot(
                    reportCapture = dev.everframe.Everframe.__replayFreeze(),
                    activity = composeRule.activity,
                    capture = fakeCapture(),
                    onSubmit = { _, _, _, _ -> submitted = true },
                    onCancel = { },
                )
            }
        }
        composeRule.onNodeWithText("Send").performClick()
        composeRule.onNodeWithText("Title is required").assertIsDisplayed()
        assertEquals(false, submitted)
    }

    @Test
    fun valid_title_send_invokes_onSubmit_with_baked_bitmap() {
        var bakedReceived: Bitmap? = null
        var titleReceived: String? = null
        composeRule.setContent {
            MaterialTheme {
                ReporterRoot(
                    reportCapture = dev.everframe.Everframe.__replayFreeze(),
                    activity = composeRule.activity,
                    capture = fakeCapture(),
                    onSubmit = { title, _, baked, _ ->
                        titleReceived = title
                        bakedReceived = baked.single().bitmap
                    },
                    onCancel = { },
                )
            }
        }
        composeRule.onNodeWithText("Title *").performTextInput("Found a bug")
        composeRule.onNodeWithText("Send").performClick()
        composeRule.waitForIdle()
        assertEquals("Found a bug", titleReceived)
        assertNotNull(bakedReceived)
    }
}
