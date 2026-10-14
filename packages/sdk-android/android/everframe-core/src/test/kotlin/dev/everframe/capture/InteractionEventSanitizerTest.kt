// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.capture

import androidx.test.core.app.ApplicationProvider
import dev.everframe.shared.SharedData
import dev.everframe.protocol.generated.BreadcrumbKind
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

internal fun interactionJson(json: String) = Json.parseToJsonElement(json).jsonObject
internal fun eventJson(type: String, fields: String) = interactionJson("""{"type":"$type","source":"app","observedAt":1,$fields}""")

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE)
class InteractionEventSanitizerTest {
    @Before fun setup() { SharedData.init(ApplicationProvider.getApplicationContext()) }

    @Test fun valuesRequireExactLiveIdentityAndAreRedactedBeforeRetention() {
        val policy = InteractionEventPolicy.parse("""{"valueTestIds":["search"]}""")
        val event = eventJson("text_edit", """"length":15,"value":"123-45-6789","reason":"idle"""")
        val hidden = InteractionEventSanitizer.sanitize(event, policy, "other")!!
        assertFalse(hidden.toString().contains("value"))
        assertFalse(hidden.toString().contains("123-45"))
        val allowed = InteractionEventSanitizer.sanitize(event, policy, "search")!!
        assertFalse(allowed.toString().contains("123-45"))
        assertTrue(allowed.containsKey("value"))
    }

    @Test fun linkDefaultsDropPathCredentialsQueryAndFragment() {
        val raw = "https://user:password@example.com/private-token?q=secret#secret"
        val clean = InteractionEventSanitizer.sanitize(eventJson("deep_link", """"url":"$raw","delivery":"initial""""), InteractionEventPolicy.parse(null))!!
        assertEquals("https://example.com", clean["url"]!!.jsonPrimitive.content)
        assertNull(InteractionEventSanitizer.sanitize(eventJson("deep_link", """"url":"not a url","delivery":"initial""""), InteractionEventPolicy.parse(null)))
    }

    @Test fun routeTemplateAndQueriesAreScopedAndRedacted() {
        val policy = InteractionEventPolicy.parse("""{"urlRules":[{"origin":"https://example.com","routes":["/watch/:id"],"queryKeys":["q"]}]}""")
        val clean = InteractionEventSanitizer.sanitize(eventJson("deep_link", """"url":"https://example.com/watch/private?q=hello&token=secret","delivery":"subsequent""""), policy)!!
        assertEquals("https://example.com/watch/:id?q=hello", clean["url"]!!.jsonPrimitive.content)
        val other = InteractionEventSanitizer.sanitize(eventJson("deep_link", """"url":"https://evil.example/watch/private?q=hello","delivery":"subsequent""""), policy)!!
        assertEquals("https://evil.example", other["url"]!!.jsonPrimitive.content)
    }

    @Test fun finalBoundsPreserveUnicodeAndDropOptionalEnrichmentInOrder() {
        val expanded = "😀".repeat(300)
        val text = eventJson("text_edit", """"length":600,"value":"$expanded","reason":"idle"""")
        val bounded = InteractionEventSanitizer.bound(text)!!
        assertEquals(256, bounded["value"]!!.jsonPrimitive.content.length)
        val args = JsonObject((0..15).associate { "key$it" to JsonPrimitive("😀".repeat(64)) })
        val launch = eventJson("launch", """"start":"cold"""") + ("arguments" to args)
        assertFalse(InteractionEventSanitizer.bound(JsonObject(launch))!!.containsKey("arguments"))
        val url = "https://example.com/?q=" + "😀".repeat(300)
        val link = InteractionEventSanitizer.bound(eventJson("deep_link", """"url":"$url","delivery":"initial""""))!!
        assertTrue(link["url"]!!.jsonPrimitive.content.length <= 1024)
        assertTrue(link.toString().toByteArray().size <= 4096)
    }

    @Test fun missingCoreFactsAndWrongControlValueAreRejected() {
        val policy = InteractionEventPolicy.parse(null)
        for (event in listOf(
            eventJson("control_change", """"control":"switch","position":1"""),
            eventJson("permission", """"permission":"camera","phase":"result""""),
            eventJson("scroll", """"axis":"x""""),
            eventJson("text_edit", """"length":-1,"reason":"idle""""),
        )) assertNull(InteractionEventSanitizer.sanitize(event, policy))
    }

    @Test fun producerBoundsRunAfterBufferRedactionWithoutChangingHostCustomObjects() {
        val buffer = BreadcrumbRingBuffer(100, false)
        // Final redaction must precede producer-specific bounds.
        val value = "a".repeat(245) + " 123-45-6789"
        val data = JsonObject(mapOf("interaction" to eventJson("text_edit", """"length":257,"value":"$value","reason":"idle"""")))
        buffer.addObservedInteraction(BreadcrumbKind.Custom, "Text edited", data, buffer.captureRevision())
        val stored = buffer.snapshotForReport().single().data!!["interaction"]!!.jsonObject
        assertTrue(stored["value"]!!.jsonPrimitive.content.length <= 256)
        buffer.add(BreadcrumbKind.Custom, "Host custom", data = data)
        assertTrue(buffer.snapshotForReport().last().data!!["interaction"]!!.jsonObject["value"]!!.jsonPrimitive.content.length > 256)
    }

    @Test fun allowedArgumentAndQueryKeysStillPassThroughRedaction() {
        val policy = InteractionEventPolicy.parse("""{"launchArgumentKeys":["123-45-6789"],"urlRules":[{"origin":"https://example.com","queryKeys":["123-45-6789"]}]}""")
        val launch = InteractionEventSanitizer.sanitize(eventJson("launch", """"start":"cold","arguments":{"123-45-6789":"safe"}"""), policy)!!
        val link = InteractionEventSanitizer.sanitize(eventJson("deep_link", """"url":"https://example.com?123-45-6789=safe","delivery":"initial""""), policy)!!
        assertFalse(launch.toString().contains("123-45-6789"))
        assertFalse(link.toString().contains("123-45-6789"))
    }
}
