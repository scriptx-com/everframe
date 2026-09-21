// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// CONFIG-02 parity — fail-closed remote per-app session-replay config provider.
// Port of packages/sdk-ios/Sources/TraceItX/Config/ReplayConfigProvider.swift
// (itself a port of sdk-core/src/types/replay/config-provider.ts).
//
// Contract (mirrors the Swift/TS verbatim):
//   - `GET <IngestEndpoint.url>/api/config` authed by the Bearer SDK key (exactly
//     like /api/ingest), Accept: application/json.
//   - Response is strictly decoded: { replayEnabled, replayDurationSec,
//     samplingRate }. samplingRate is bounded to [0,1].
//   - Default object is OFF; overwritten ONLY by a fully decoded valid 200.
//   - FAIL CLOSED on every error path: network rejection / non-200 / malformed
//     body / missing/wrong-typed field / out-of-range samplingRate / timeout. On
//     any failure the cache keeps its current value and `refresh()` resolves
//     silently (never throws). An error never flips ON → OFF mid-session — only a
//     validated response mutates. An out-of-range samplingRate is REJECTED (fail
//     closed), NEVER clamped — a hostile rate must never reach the gate.
//   - TTL 5 min; refresh is a no-op within the window; refetches after expiry.
//   - `samplingRate` is surfaced verbatim for the lifecycle sampling gate (CONFIG-04).
package com.traceitx.config

import androidx.annotation.VisibleForTesting
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerializationException
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.nullable
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.doubleOrNull
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request

// Mirrors the server's BreadcrumbsBlockSchema (the server configuration contract);
// parity fixture: packages/protocol/__tests__/fixtures/breadcrumbs-config-parity.v1.json.
//
// Decoded via a custom KSerializer (BreadcrumbsConfigWireSerializer below) rather than
// the plain generated one: a future server-added field INSIDE this block must NOT
// fail-close the whole config under the provider's strict top-level
// `Json { ignoreUnknownKeys = false }` (:97) — the Plan-4 Task-1 bug class one level
// deeper. `@JsonIgnoreUnknownKeys` would be the cleaner fix but requires kotlinx.serialization
// ≥ 1.9.0; this repo pins 1.7.3 (matches quicktype codegen), so we hand-roll the
// equivalent: a private surrogate with the SAME required fields, decoded through a
// lenient `Json { ignoreUnknownKeys = true }` scoped to ONLY this type. A genuinely
// MISSING required field still throws (fail-close preserved) — only extra/unknown
// keys are tolerated. Top-level strictness is untouched.
@Serializable(with = BreadcrumbsConfigWireSerializer::class)
data class BreadcrumbsConfigWire(
    val enabled: Boolean,
    val kinds: List<String>,
    val maxCount: Int,
    val byteBudget: Int,
    val consoleEntryCap: Int,
)

private object BreadcrumbsConfigWireSerializer : KSerializer<BreadcrumbsConfigWire> {
    // A private surrogate with the SAME required fields (no defaults) as
    // BreadcrumbsConfigWire, decoded LENIENTLY so unknown keys inside the block are
    // ignored — while a missing required field still throws. This does NOT touch the
    // provider's top-level `Json { ignoreUnknownKeys = false }`; leniency is scoped
    // to exactly this surrogate's own decode call.
    @Serializable
    private data class Surrogate(
        val enabled: Boolean,
        val kinds: List<String>,
        val maxCount: Int,
        val byteBudget: Int,
        val consoleEntryCap: Int,
    )

    private val lenient = Json { ignoreUnknownKeys = true }

    override val descriptor = Surrogate.serializer().descriptor

    override fun deserialize(decoder: Decoder): BreadcrumbsConfigWire {
        val element = (decoder as JsonDecoder).decodeJsonElement()
        val s = lenient.decodeFromJsonElement(Surrogate.serializer(), element)
        return BreadcrumbsConfigWire(s.enabled, s.kinds, s.maxCount, s.byteBudget, s.consoleEntryCap)
    }

    override fun serialize(encoder: Encoder, value: BreadcrumbsConfigWire) {
        encoder.encodeSerializableValue(
            Surrogate.serializer(),
            Surrogate(value.enabled, value.kinds, value.maxCount, value.byteBudget, value.consoleEntryCap),
        )
    }
}

// Mirrors sdk-core's `RepliesConfig` (packages/sdk-core/src/types/replay/config-provider.ts)
// and the server's `RepliesBlockSchema` (the server configuration contract).
//
// Present ONLY so an app with `replies_enabled` does not fail-close this whole
// provider. The top-level `Json { ignoreUnknownKeys = false }` (:97) is a
// deliberate, tested contract ("unknown TOP-LEVEL field still fails closed"),
// so the fix for a NEW server block is to model the block — not to weaken that
// flag, which would trade a known decode failure for an untested,
// permanently-lenient top level and would delete an existing test's meaning.
//
// Decoded through the same scoped-leniency surrogate pattern as
// BreadcrumbsConfigWire above, for the same reason one level deeper: a future
// server-added field INSIDE this block must not fail-close the whole config.
// Nothing in sdk-android consumes this value yet — Android has no replies UI.
@Serializable(with = RepliesConfigWireSerializer::class)
data class RepliesConfigWire(
    val enabled: Boolean,
)

private object RepliesConfigWireSerializer : KSerializer<RepliesConfigWire> {
    @Serializable
    private data class Surrogate(val enabled: Boolean)

    private val lenient = Json { ignoreUnknownKeys = true }

    override val descriptor = Surrogate.serializer().descriptor

    override fun deserialize(decoder: Decoder): RepliesConfigWire {
        val element = (decoder as JsonDecoder).decodeJsonElement()
        val s = lenient.decodeFromJsonElement(Surrogate.serializer(), element)
        return RepliesConfigWire(s.enabled)
    }

    override fun serialize(encoder: Encoder, value: RepliesConfigWire) {
        encoder.encodeSerializableValue(Surrogate.serializer(), Surrogate(value.enabled))
    }
}

// Mirrors sdk-core's `NetworkBodiesConfig` (packages/sdk-core/src/types/replay/config-provider.ts)
// and the server's `NetworkBodiesBlockSchema` (the server configuration contract).
//
// Decoded through the same scoped-leniency surrogate pattern as
// BreadcrumbsConfigWire above, for the same reason one level deeper: a future
// server-added field INSIDE this block must not fail-close the whole config.
//
// Round-2 review Finding F10 (mirrors iOS commit 826e5f76,
// packages/sdk-ios/Sources/TraceItX/Config/ReplayConfigProvider.swift): the
// wire ceilings below mirror the server's `NetworkBodiesBlockSchema` and are
// enforced HERE, in [NetworkBodiesConfigWireSerializer.deserialize], rather
// than left to whoever later consumes these values. Without this,
// `bodyByteCap: Int.MAX_VALUE` would sail through decode and later overflow
// `cap + secretScanOverlap` in `NetworkBodyCapture` (Int overflow wraps to
// negative), and a non-positive cap would corrupt the truncation-window math.
//
// Fail-closed granularity — Android chooses WHOLE-CONFIG-OFF, not iOS's
// degrade-this-block-to-null: an invalid value throws a [SerializationException]
// out of `deserialize`, which propagates unimpeded through the plain
// (non-try/catch-wrapped) `networkBodies` field decode inside the top-level
// `ReplayConfigWire`'s COMPILER-GENERATED `init`, all the way up through
// `ReplayConfigProvider.refresh`'s outer `catch (Throwable)` — the exact same
// propagation path already exercised by "missing REQUIRED field inside the
// breadcrumbs/replies block still fail-closes" in ReplayConfigProviderTest.kt.
// Reproducing iOS's per-block `try? decodeIfPresent` degrade-to-null here
// would require replacing `ReplayConfigWire`'s compiler-synthesized
// `@Serializable` with a hand-rolled top-level KSerializer solely to scope a
// try/catch around one field — extra surface area for a P1 fix, and it would
// make `networkBodies` behave differently from `breadcrumbs`/`replies`'
// existing (and tested) fail-closed-whole-config precedent for exactly this
// class of nested-decode error. Whole-config-OFF is strictly MORE
// fail-closed than iOS's degrade-to-null (no bodies AND no replay AND no
// breadcrumbs, instead of just no bodies), so it satisfies F10's intent
// without new plumbing or an inconsistent contract across the three blocks.
@Serializable(with = NetworkBodiesConfigWireSerializer::class)
data class NetworkBodiesConfigWire(
    val captureBodies: Boolean,
    val bodyByteCap: Int? = null,
    val bodyContentTypes: List<String>? = null,
    val bodyTotalBudget: Int? = null,
)

private object NetworkBodiesConfigWireSerializer : KSerializer<NetworkBodiesConfigWire> {
    @Serializable
    private data class Surrogate(
        val captureBodies: Boolean,
        val bodyByteCap: Int? = null,
        val bodyContentTypes: List<String>? = null,
        val bodyTotalBudget: Int? = null,
    )

    private val lenient = Json { ignoreUnknownKeys = true }

    /** 1...65536 — mirrors `bodyByteCap: z.number().int().positive().max(65536)`. */
    private val bodyByteCapRange = 1..65_536

    /** 1...1_048_576 (1 MiB) — mirrors `bodyTotalBudget: z.number().int().positive().max(1048576)`. */
    private val bodyTotalBudgetRange = 1..1_048_576

    /** 1...16 entries — mirrors `bodyContentTypes: z.array(...).min(1).max(16)`. */
    private val bodyContentTypesCountRange = 1..16

    /** 1...64 chars per entry — mirrors `z.string().min(1).max(64)`. */
    private val bodyContentTypeLengthRange = 1..64

    override val descriptor = Surrogate.serializer().descriptor

    override fun deserialize(decoder: Decoder): NetworkBodiesConfigWire {
        val element = (decoder as JsonDecoder).decodeJsonElement()
        val s = lenient.decodeFromJsonElement(Surrogate.serializer(), element)

        s.bodyByteCap?.let {
            if (it !in bodyByteCapRange) {
                throw SerializationException(
                    "bodyByteCap $it outside $bodyByteCapRange — fail closed (F10)",
                )
            }
        }
        s.bodyTotalBudget?.let {
            if (it !in bodyTotalBudgetRange) {
                throw SerializationException(
                    "bodyTotalBudget $it outside $bodyTotalBudgetRange — fail closed (F10)",
                )
            }
        }
        s.bodyContentTypes?.let { types ->
            if (types.size !in bodyContentTypesCountRange) {
                throw SerializationException(
                    "bodyContentTypes has ${types.size} entries, outside " +
                        "$bodyContentTypesCountRange — fail closed (F10)",
                )
            }
            if (types.any { it.length !in bodyContentTypeLengthRange }) {
                throw SerializationException(
                    "bodyContentTypes entry length outside $bodyContentTypeLengthRange — fail closed (F10)",
                )
            }
        }

        return NetworkBodiesConfigWire(s.captureBodies, s.bodyByteCap, s.bodyContentTypes, s.bodyTotalBudget)
    }

    override fun serialize(encoder: Encoder, value: NetworkBodiesConfigWire) {
        encoder.encodeSerializableValue(
            Surrogate.serializer(),
            Surrogate(value.captureBodies, value.bodyByteCap, value.bodyContentTypes, value.bodyTotalBudget),
        )
    }
}

// Mirrors the server's identity block (recognition spec 2026-08-06,
// the server configuration contract's `IdentityBlockSchema`). Sent ONLY
// when the caller declared `identity` in `X-TX-SDK-Features` — see
// [ReplayConfigProvider.SDK_FEATURES_HEADER_VALUE]. Unlike `replies`, there
// is no separate app-level enable flag: `enabled` means exactly "this
// project has a signing secret configured".
//
// Decoded through the same scoped-leniency surrogate pattern as
// BreadcrumbsConfigWire/RepliesConfigWire/NetworkBodiesConfigWire above, for
// the same reason: a future server-added field INSIDE this block must not
// fail-close the whole config. (iOS decodes its `IdentityConfigWire`
// non-leniently — reviewed and deliberately accepted there — but the
// Kotlin decoder's existing, tested contract is "top-level strict, every
// nested block lenient"; matching that neighbouring precedent matters more
// here than cross-platform symmetry of decode strategy.)
@Serializable(with = IdentityConfigWireSerializer::class)
data class IdentityConfigWire(
    val enabled: Boolean,
)

private object IdentityConfigWireSerializer : KSerializer<IdentityConfigWire> {
    @Serializable
    private data class Surrogate(val enabled: Boolean)

    private val lenient = Json { ignoreUnknownKeys = true }

    override val descriptor = Surrogate.serializer().descriptor

    override fun deserialize(decoder: Decoder): IdentityConfigWire {
        val element = (decoder as JsonDecoder).decodeJsonElement()
        val s = lenient.decodeFromJsonElement(Surrogate.serializer(), element)
        return IdentityConfigWire(s.enabled)
    }

    override fun serialize(encoder: Encoder, value: IdentityConfigWire) {
        encoder.encodeSerializableValue(Surrogate.serializer(), Surrogate(value.enabled))
    }
}

/**
 * Server-driven companion name-badge override (plan 2026-08-25). Present
 * only when this SDK declared `companionbadge` in X-TX-SDK-Features.
 * `position` stays a STRING here (the wire shape); resolution to
 * [com.traceitx.companion.CompanionBadgePosition] happens at the badge via
 * parseCompanionBadgePositionOrNull, so an unrecognised future position
 * falls back to the inline option rather than a hard-coded corner.
 */
@Serializable(with = CompanionBadgeConfigWireSerializer::class)
data class CompanionBadgeConfigWire(
    val enabled: Boolean,
    val position: String? = null,
)

/** Lenient nested decode — same posture as IdentityConfigWireSerializer:
 *  unknown NESTED fields are dropped, never fail the whole config parse. */
object CompanionBadgeConfigWireSerializer : KSerializer<CompanionBadgeConfigWire> {
    @Serializable
    private data class Surrogate(val enabled: Boolean, val position: String? = null)

    private val lenient = Json { ignoreUnknownKeys = true }

    override val descriptor = Surrogate.serializer().descriptor

    override fun deserialize(decoder: Decoder): CompanionBadgeConfigWire {
        val element = (decoder as JsonDecoder).decodeJsonElement()
        val s = lenient.decodeFromJsonElement(Surrogate.serializer(), element)
        return CompanionBadgeConfigWire(s.enabled, s.position)
    }

    override fun serialize(encoder: Encoder, value: CompanionBadgeConfigWire) {
        encoder.encodeSerializableValue(Surrogate.serializer(), Surrogate(value.enabled, value.position))
    }
}

/**
 * Reporter branding: watermark + theme (Android spec 2026-08-26). Present
 * only when this SDK declared `branding` in X-TX-SDK-Features.
 *
 * Decoded ELEMENT-WISE rather than through a surrogate data class: the
 * surrogate pattern above still throws on a wrong-typed field, failing the
 * whole config parse. For branding that is the wrong failure mode — a bad
 * color (or a hostile hand-written row that somehow reached the wire) must
 * degrade THAT FIELD alone, because `watermark: false` is the paid-plan
 * entitlement signal and losing it to a sibling's typo would re-watermark a
 * paying customer. Every theme value is hex-validated here (^#[0-9a-fA-F]{6}$)
 * — these strings become colors in the reporter UI, so the format gate is a
 * correctness boundary, mirrored from the server's emit validation and the
 * web SDK's decode.
 */
@Serializable(with = BrandingConfigWireSerializer::class)
data class BrandingConfigWire(
    val watermark: Boolean? = null,
    val theme: BrandingThemeWire? = null,
)

data class BrandingThemeWire(
    val background: String? = null,
    val surface: String? = null,
    val border: String? = null,
    val text: String? = null,
    val textMuted: String? = null,
    val accent: String? = null,
    val accentForeground: String? = null,
    val destructive: String? = null,
)

object BrandingConfigWireSerializer : KSerializer<BrandingConfigWire> {
    private val HEX = Regex("^#[0-9a-fA-F]{6}$")

    // Descriptor only names the shape; decode never uses it structurally.
    @Serializable
    private data class Surrogate(val watermark: Boolean? = null)
    override val descriptor = Surrogate.serializer().descriptor

    override fun deserialize(decoder: Decoder): BrandingConfigWire {
        val element = (decoder as JsonDecoder).decodeJsonElement()
        val obj = element as? JsonObject ?: return BrandingConfigWire()
        val watermark = (obj["watermark"] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull
        val themeObj = obj["theme"] as? JsonObject
        fun hex(key: String): String? =
            (themeObj?.get(key) as? JsonPrimitive)
                ?.takeIf { it.isString }
                ?.content
                ?.takeIf { HEX.matches(it) }
        val theme = themeObj?.let {
            BrandingThemeWire(
                background = hex("background"),
                surface = hex("surface"),
                border = hex("border"),
                text = hex("text"),
                textMuted = hex("textMuted"),
                accent = hex("accent"),
                accentForeground = hex("accentForeground"),
                destructive = hex("destructive"),
            )
        }
        return BrandingConfigWire(watermark = watermark, theme = theme)
    }

    override fun serialize(encoder: Encoder, value: BrandingConfigWire) {
        // Encode via a plain map — only tests round-trip this.
        encoder.encodeSerializableValue(Surrogate.serializer(), Surrogate(value.watermark))
    }
}

/**
 * Report Resource Window (spec 2026-09-05). Mirrors the server's
 * `resources: { enabled, windowSec }` block (the ingest API's config-route.ts).
 * Present only when this SDK declares `resources` in `X-TX-SDK-Features` —
 * same capability-negotiation doctrine as `identity`/`companionBadge`/
 * `branding` above. Without declaring the token the server never emits this
 * block at all, and the feature is silently, permanently off (the
 * negotiation gap gap-class-1 of the Task 12/13 review closes).
 *
 * Decoded through a degrade-the-block-not-the-config pattern (not the
 * simpler throw-through-to-fail-closed pattern
 * [IdentityConfigWire]/[CompanionBadgeConfigWire] use): a malformed
 * `resources` block must never take breadcrumbs/replay/everything else in
 * the same response down with it, so [ResourcesConfigWireSerializer]
 * explicitly catches a structurally-malformed nested decode and marks
 * [isInvalid] rather than letting the throw escape to the top-level decode.
 *
 * `windowSec` carries its OWN field-level leniency (mirrors sdk-core's
 * `ResourcesServerConfig`/iOS's `ResourcesConfigWire`, both `.positive()
 * .optional().catch(undefined)`): a malformed or non-positive window length
 * alone degrades to `null` — the caller (`ReplaySession.refreshConfigNow`)
 * then falls back to `ResourceRingBuffer.defaultWindowSec` — WITHOUT losing
 * `enabled`, so a server-side typo on the window length doesn't also blank
 * the on/off signal.
 */
@Serializable(with = ResourcesConfigWireSerializer::class)
data class ResourcesConfigWire(
    val enabled: Boolean,
    val windowSec: Int? = null,
) {
    /** True when the decoder marked this block malformed; such a block is
     *  mapped to null (absent, feature off) rather than surfaced. */
    internal val isInvalid: Boolean
        get() = this === ResourcesConfigWireSerializer.INVALID
}

private object ResourcesConfigWireSerializer : KSerializer<ResourcesConfigWire> {
    @Serializable
    private data class Surrogate(val enabled: Boolean, val windowSec: Int? = null)

    private val lenient = Json { ignoreUnknownKeys = true }

    /** Sentinel instance meaning "this block was malformed" — identity-
     *  compared by [ResourcesConfigWire.isInvalid]. A dedicated instance is
     *  used instead of a sentinel field value since `enabled: Boolean` has
     *  no spare value to repurpose. */
    internal val INVALID = ResourcesConfigWire(enabled = false, windowSec = null)

    override val descriptor = Surrogate.serializer().descriptor

    override fun deserialize(decoder: Decoder): ResourcesConfigWire {
        val element = (decoder as JsonDecoder).decodeJsonElement()
        // The surrogate decode itself can throw — a missing or wrong-typed
        // `enabled`. That throw would otherwise escape to the top-level
        // decode and take the WHOLE config down with it — see this type's
        // doc comment.
        val s = try {
            lenient.decodeFromJsonElement(Surrogate.serializer(), element)
        } catch (_: Throwable) {
            return INVALID
        }
        // Field-level leniency for windowSec: a non-positive value alone
        // degrades to null, WITHOUT losing `enabled` (mirrors iOS's
        // ResourcesConfigWire.init(from:)).
        val windowSec = s.windowSec?.takeIf { it > 0 }
        return ResourcesConfigWire(enabled = s.enabled, windowSec = windowSec)
    }

    override fun serialize(encoder: Encoder, value: ResourcesConfigWire) {
        encoder.encodeSerializableValue(Surrogate.serializer(), Surrogate(value.enabled, value.windowSec))
    }
}

/** Native shake-to-report dashboard gate. Malformed nested values degrade to absent/off. */
@Serializable(with = ShakeToReportConfigWireSerializer::class)
data class ShakeToReportConfigWire(val enabled: Boolean)

private object ShakeToReportConfigWireSerializer : KSerializer<ShakeToReportConfigWire> {
    @Serializable
    private data class Surrogate(val enabled: Boolean)

    private val lenient = Json { ignoreUnknownKeys = true }
    internal val INVALID = ShakeToReportConfigWire(enabled = false)
    override val descriptor = Surrogate.serializer().descriptor

    override fun deserialize(decoder: Decoder): ShakeToReportConfigWire = try {
        val element = (decoder as JsonDecoder).decodeJsonElement()
        val value = lenient.decodeFromJsonElement(Surrogate.serializer(), element)
        ShakeToReportConfigWire(value.enabled)
    } catch (_: Throwable) {
        INVALID
    }

    override fun serialize(encoder: Encoder, value: ShakeToReportConfigWire) {
        encoder.encodeSerializableValue(Surrogate.serializer(), Surrogate(value.enabled))
    }
}

/** Decodes a JSON boolean; anything else (string "true", number, null) → null. Per-field leniency for a top-level scalar. */
object LenientBooleanSerializer : KSerializer<Boolean?> {
    override val descriptor = PrimitiveSerialDescriptor("LenientBoolean", PrimitiveKind.BOOLEAN).nullable
    override fun deserialize(decoder: Decoder): Boolean? {
        val el = (decoder as? JsonDecoder)?.decodeJsonElement() ?: return null
        return (el as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull
    }
    override fun serialize(encoder: Encoder, value: Boolean?) {
        if (value == null) encoder.encodeNull() else encoder.encodeBoolean(value)
    }
}

/** Decodes a JSON number; anything else → null. */
object LenientDoubleSerializer : KSerializer<Double?> {
    override val descriptor = PrimitiveSerialDescriptor("LenientDouble", PrimitiveKind.DOUBLE).nullable
    override fun deserialize(decoder: Decoder): Double? {
        val el = (decoder as? JsonDecoder)?.decodeJsonElement() ?: return null
        return (el as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull?.takeIf { !it.isNaN() }
    }
    override fun serialize(encoder: Encoder, value: Double?) {
        if (value == null) encoder.encodeNull() else encoder.encodeDouble(value)
    }
}

/** Decoded `GET /api/config` value. Mirrors `ReplayConfig` in the Swift/TS source. */
data class ReplayConfig(
    val replayEnabled: Boolean,
    val replayDurationSec: Int,
    val samplingRate: Double,
    val breadcrumbs: BreadcrumbsConfigWire? = null,
    val replies: RepliesConfigWire? = null,
    val networkBodies: NetworkBodiesConfigWire? = null,
    val identity: IdentityConfigWire? = null,
    val companionBadge: CompanionBadgeConfigWire? = null,
    val branding: BrandingConfigWire? = null,
    val resources: ResourcesConfigWire? = null,
    val shakeToReport: ShakeToReportConfigWire? = null,
    /** Session Vitals (spec 2026-09-05) — negotiated via the `vitals` feature token; null when the server did not send them. */
    val vitalsEnabled: Boolean? = null,
    val vitalsSampleRate: Double? = null,
    val nativeVideo: NativeVideoSettings? = null,
) {
    companion object {
        /**
         * The canonical OFF default (REPLAY_CONFIG_OFF). Returned until the first
         * fully validated 200 resolves — and never weakened by any error path.
         */
        val OFF = ReplayConfig(replayEnabled = false, replayDurationSec = 30, samplingRate = 1.0)
    }
}

/**
 * True only when the server says identity is enabled for this project. A
 * project with no signing secret never reaches the customer's endpoint and
 * never presents a header.
 */
fun isIdentityEnabled(config: ReplayConfig): Boolean = config.identity?.enabled == true

/**
 * Strict wire shape. A bad type / missing field fails decoding → fail closed.
 * `Json { ignoreUnknownKeys = false }` rejects unexpected keys too.
 */
@Serializable
private data class ReplayConfigWire(
    val replayEnabled: Boolean,
    val replayDurationSec: Int,
    val samplingRate: Double,
    val breadcrumbs: BreadcrumbsConfigWire? = null,
    val replies: RepliesConfigWire? = null,
    val networkBodies: NetworkBodiesConfigWire? = null,
    val identity: IdentityConfigWire? = null,
    val companionBadge: CompanionBadgeConfigWire? = null,
    val branding: BrandingConfigWire? = null,
    val resources: ResourcesConfigWire? = null,
    val shakeToReport: ShakeToReportConfigWire? = null,
    @Serializable(with = LenientBooleanSerializer::class) val vitalsEnabled: Boolean? = null,
    @Serializable(with = LenientDoubleSerializer::class) val vitalsSampleRate: Double? = null,
    val nativeVideo: NativeVideoSettings? = null,
)

/**
 * Injectable transport so specs drive every error path deterministically (no real
 * network). The default impl calls an [OkHttpClient].
 */
fun interface ConfigFetcher {
    fun fetch(request: Request): okhttp3.Response
}

/**
 * Fail-closed session-replay config provider. The cache lives inside an
 * [AtomicReference] (see the `state` field below) so concurrent reads see the
 * last-good value and concurrent [refresh] calls can never corrupt each
 * other's writes; `lastFetchedAt` is `@Volatile` for the same cross-thread
 * visibility. Only [refresh] mutates either.
 */
class ReplayConfigProvider(
    private val configUrl: String,
    private val apiKey: String,
    private val fetcher: ConfigFetcher,
    private val ttlMs: Long = 300_000L,
    private val now: () -> Long = { android.os.SystemClock.elapsedRealtime() },
    /**
     * Resolved on EVERY fetch, not once at construction (Plan 2b-i). Plan
     * 2b-ii puts a per-UTC-day gate behind this, which only works if the value
     * is re-asked for each time — the web SDK baked its identifier into the
     * stored URL in Plan 2a and needs a retrofit for exactly this reason.
     * Returning null means "send the config URL unchanged"; it is never an
     * error, and a throw here is swallowed for the same reason.
     */
    private val installIdProvider: () -> String? = { null },
) {
    /**
     * Sequence issuance and cache commit, moved as ONE value so neither can
     * ever be observed or mutated independently of the other.
     *
     * History of this defect class (all in this file, same subsystem):
     *   - F32 (round-7): concurrent [refresh] calls could commit in
     *     COMPLETION order instead of START order — fixed with a monotonic
     *     `requestSeq: AtomicInteger`, compared after decode.
     *   - F38 (round-8): that compare and the cache assignment were still
     *     two separate, unlocked statements — a newer call's entire
     *     issue-and-commit cycle could land between them. Fixed by putting
     *     the compare + assignment under a lock together.
     *   - F43 (round-9, THIS fix): sequence ISSUANCE stayed outside that
     *     lock (deliberately, to avoid serializing concurrent refreshes) —
     *     so a newer call's issuance could still land in the gap between an
     *     OLDER call's lock-protected compare succeeding and that same
     *     call's assignment actually executing. The older call would
     *     blindly commit and report success anyway, re-arming capture from
     *     stale config while the newer read was underway or had already
     *     failed.
     *
     * Each of the first two fixes closed exactly the window that was
     * demonstrated and left an adjacent one, because each added ANOTHER
     * independently-synchronized step (a compare, then a lock around a
     * DIFFERENT pair of statements) instead of making the whole
     * issue → fetch → compare → commit lifecycle a single indivisible
     * operation. This fix does that: issuance and commit are both just CAS
     * attempts against the SAME [AtomicReference], so there is no third (or
     * fourth) moving part left to accidentally leave unsynchronized.
     *
     * INVARIANT — checkable by reading [refresh] alone: only the
     * LATEST-issued request may commit, and no interleaving of issuance and
     * commit can violate that. Concretely: a response commits iff
     * `state.compareAndSet(observed, ...)` SUCCEEDS, where `observed` was
     * read fresh in the SAME loop iteration as the CAS attempt, and the CAS
     * only succeeds if `observed.seq == mySeq` (this request's own issued
     * sequence). There is no gap between "compare" and "swap" for anything
     * else to land in — `compareAndSet` performs both as one hardware
     * operation, unlike two separate statements under a lock. Sequence
     * issuance (`state.updateAndGet { it.copy(seq = it.seq + 1) }`) is ALSO
     * just a CAS-loop mutation of this same reference, so an issuance and a
     * commit attempt are inherently serialized w.r.t. EACH OTHER by the
     * JVM's compareAndSet primitive itself — never by a lock either side
     * has to remember to take, and never by two independently-synchronized
     * operations that a future change could pull back apart.
     *
     * The fetch itself (`fetcher.fetch(req)`, suspending and slow) runs
     * with NO lock or CAS held — only issuance (before the fetch) and
     * commit (after decode) touch [state], and each is a single atomic
     * step.
     */
    private data class RefreshState(val seq: Int, val current: ReplayConfig)

    private val state = AtomicReference(RefreshState(seq = 0, current = ReplayConfig.OFF))

    /** Starts OFF. The ONLY mutation path is a fully decoded valid 200 (see [refresh]). */
    val current: ReplayConfig
        get() = state.get().current

    @Volatile
    private var lastFetchedAt: Long? = null

    private val json = Json { ignoreUnknownKeys = false }

    /**
     * [configUrl] plus `?installId=<value>` when the supplier has one. Any
     * failure — null, empty, a throw, or an unparseable base URL — yields the
     * unmodified [configUrl]. This is the kill-switch read; it must never fail
     * because of the meter. Built through OkHttp's `HttpUrl` rather than
     * string concatenation so a future non-base64url value cannot silently
     * produce a malformed URL.
     */
    private fun requestUrl(): String {
        val id = runCatching { installIdProvider() }.getOrNull()
        if (id.isNullOrEmpty()) return configUrl
        return runCatching {
            configUrl.toHttpUrl().newBuilder().addQueryParameter("installId", id).build().toString()
        }.getOrDefault(configUrl)
    }

    /**
     * Fetches `GET /api/config`, strictly decodes, and overwrites the cache ONLY on
     * full validation. Any error path keeps the cache and resolves silently (fail
     * closed). A no-op within the TTL window, UNLESS [force] is set.
     *
     * Final-review Findings 4/5 (2026-08-01-network-body-capture-native):
     *   - `force = true` bypasses the TTL check (still records `lastFetchedAt`)
     *     so a caller that itself runs on a TTL-matched cadence (the
     *     [com.traceitx.capture.replay.ReplaySession] periodic loop) doesn't
     *     race its own gate — see that file's `startPeriodicRefreshLoop()` for
     *     why an unforced call there was silently halving the effective poll
     *     rate.
     *   - Return value reports whether THIS invocation can be trusted as
     *     reflecting a live, current config: `true` on a fully decoded valid
     *     200, OR a non-forced TTL-skip (the cache is still fresh by
     *     definition); `false` when an actual fetch was attempted and failed
     *     (network error, non-200, decode failure, out-of-range
     *     samplingRate) — even though the cache itself silently keeps its
     *     last-good value per the fail-closed contract above. Callers that
     *     need to distinguish "confirmed current" from "stale cache, fetch
     *     just failed" (e.g. the network-body gate, which must not stay
     *     latched ON forever off an unreachable config) use this return
     *     value rather than [current].
     */
    suspend fun refresh(force: Boolean = false): Boolean = withContext(Dispatchers.IO) {
        // No-op within the TTL window once we have fetched at least once —
        // unless the caller forces a bypass. A TTL-skip is not a failure: the
        // cache is still fresh, so this reports success.
        val last = lastFetchedAt
        if (!force && last != null && now() - last < ttlMs) {
            return@withContext true
        }
        // F43: issuance is a CAS-loop mutation of the SAME [state] reference
        // the eventual commit below targets — stamp this attempt with the
        // next sequence number BEFORE the network call, so "which request
        // started last" is determined by call order, and so a NEWER call's
        // issuance can never be invisible to this call's later commit
        // attempt (see [state]'s doc comment for the full invariant).
        val mySeq = state.updateAndGet { it.copy(seq = it.seq + 1) }.seq
        val succeeded = try {
            val req = Request.Builder()
                .url(requestUrl())
                .get()
                .header("Authorization", "Bearer $apiKey")
                .header("Accept", "application/json")
                .header("X-TX-SDK-Features", SDK_FEATURES_HEADER_VALUE)
                .build()

            fetcher.fetch(req).use { resp ->
                // Non-200 ⇒ fail closed (keep current cache).
                if (resp.code != 200) return@use false
                val bodyStr = resp.body?.string() ?: return@use false
                // Malformed JSON / missing field / wrong type ⇒ throws ⇒ caught
                // below ⇒ fail closed.
                val wire = json.decodeFromString(ReplayConfigWire.serializer(), bodyStr)
                // After decode, an out-of-range samplingRate is REJECTED (fail
                // closed, NO clamp) — a hostile rate must never reach the gate.
                if (wire.samplingRate !in 0.0..1.0) return@use false
                if (wire.nativeVideo?.framesPerSecond?.let { it != 5 && it != 10 } == true) {
                    return@use false
                }
                val decoded = ReplayConfig(
                    replayEnabled = wire.replayEnabled,
                    replayDurationSec = wire.replayDurationSec,
                    samplingRate = wire.samplingRate,
                    breadcrumbs = wire.breadcrumbs,
                    replies = wire.replies,
                    networkBodies = wire.networkBodies,
                    identity = wire.identity,
                    companionBadge = wire.companionBadge,
                    branding = wire.branding,
                    // A block the decoder marked malformed reads as ABSENT
                    // (feature off) —
                    // never throws and never takes the rest of this config
                    // down with it.
                    resources = wire.resources?.takeIf { !it.isInvalid },
                    shakeToReport = wire.shakeToReport?.takeUnless {
                        it === ShakeToReportConfigWireSerializer.INVALID
                    },
                    vitalsEnabled = wire.vitalsEnabled,
                    vitalsSampleRate = wire.vitalsSampleRate,
                    nativeVideo = wire.nativeVideo,
                )
                __beforeCommitHookForTesting()
                // F43: commit succeeds ONLY if [state] still shows `mySeq`
                // as the head sequence at the instant of the CAS — `observed`
                // is read fresh in the SAME loop iteration as the CAS
                // attempt, never cached from before this point, so a NEWER
                // request's issuance (or commit) that happened at any point
                // up to and including right now is guaranteed to already be
                // reflected in `observed`. A superseded response is
                // discarded here, same fail-closed-on-THIS-read posture as
                // any other failure path above.
                var committed = false
                while (true) {
                    val observed = state.get()
                    if (observed.seq != mySeq) break // superseded — bail, fail closed on this read
                    if (state.compareAndSet(observed, RefreshState(seq = observed.seq, current = decoded))) {
                        committed = true
                        break
                    }
                    // `state` changed between our read and our CAS attempt
                    // (another issuance, or another commit) — loop and
                    // re-read fresh; `observed` is never reused stale.
                }
                committed
            }
        } catch (_: Throwable) {
            // network rejection / timeout / decode failure ⇒ fail closed silently.
            // cache stays at its current value (last-good or OFF). Never re-throw.
            false
        } finally {
            // Mark the attempt so TTL windowing advances even on failure.
            lastFetchedAt = now()
        }
        succeeded
    }

    /**
     * Test-only (round-9 review Finding F43). The round-8 seams
     * ([__holdLockForTesting] / [__hasQueuedThreadsForTesting]) held and
     * polled `stateLock` from outside — meaningless now that [refresh] has
     * no lock to hold (that absence is the point of this fix), so they're
     * removed rather than kept as dead code.
     *
     * This replacement is invoked once per [refresh] call, immediately
     * after a response is fully decoded and validated but BEFORE the
     * compare+commit CAS loop begins — letting a test park a request at
     * exactly the point the finding describes ("passes validation, then a
     * DIFFERENT, newer request issues AND commits before this one
     * resumes"), without needing to hold any lock, since there is none.
     * No-op by default.
     */
    @VisibleForTesting
    internal var __beforeCommitHookForTesting: () -> Unit = {}

    companion object {
        /**
         * Capability tokens sent as `X-TX-SDK-Features`. The server returns a
         * config block ONLY for capabilities the caller declares
         * (the server configuration contract) — so adding a block here is a
         * prerequisite for receiving it, not a formality. Mirrors iOS's
         * `ReplayConfigProvider.sdkFeaturesHeaderValue`.
         */
        val SDK_FEATURES_HEADER_VALUE: String
            get() = "networkbodies, identity, companionbadge, branding, vitals, resources, shaketoreport" +
                if (android.os.Build.VERSION.SDK_INT >= 29) ", nativevideo" else ""

        /**
         * Build the provider from the base ingest endpoint by appending
         * `/api/config` (mirrors MultipartUploader's base-URL path-append),
         * tolerating an already-suffixed URL.
         */
        fun make(
            baseUrl: String = IngestEndpoint.url,
            apiKey: String,
            fetcher: ConfigFetcher,
            installIdProvider: () -> String? = { null },
        ): ReplayConfigProvider {
            val trimmed = baseUrl.trimEnd('/')
            val configUrl = if (trimmed.endsWith("/api/config")) trimmed else "$trimmed/api/config"
            return ReplayConfigProvider(
                configUrl = configUrl,
                apiKey = apiKey,
                fetcher = fetcher,
                installIdProvider = installIdProvider,
            )
        }
    }
}
