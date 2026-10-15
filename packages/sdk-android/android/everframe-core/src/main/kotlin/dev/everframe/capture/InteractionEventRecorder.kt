// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.capture

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.text.method.PasswordTransformationMethod
import android.view.View
import android.widget.TextView
import android.widget.EditText
import android.view.inputmethod.BaseInputConnection
import dev.everframe.Everframe
import java.lang.ref.WeakReference
import java.util.UUID
import java.util.WeakHashMap
import kotlinx.serialization.json.*

/** An observation owns its revision before reading any values; it can never renew itself. */
internal class InteractionOwner(
    val lease: String,
    val revision: Long,
    val host: WeakReference<View>?,
    val target: JsonObject?,
    val liveTestId: String?,
    val hostId: Int?,
    val registrationId: String? = null,
    val generation: Long? = null,
)

internal data class InteractionObservation(
    val owner: InteractionOwner,
    val event: JsonObject,
    val phase: String = "change",
    val composing: Boolean = false,
    val deferLaunch: Boolean = false,
    // Set only by the native user-edit adapter, never by helper JSON.
    val nativeTextAttachment: InteractionTextAdapter.Attachment? = null,
    val nativeScrollAttachment: InteractionScrollAdapter.Attachment? = null,
)

/** Mutable admission state shares the buffer lock; no view access occurs under that lock. */
internal class InteractionEventRecorder(
    private val buffer: BreadcrumbRingBuffer,
    private val clock: () -> Long = SystemClock::elapsedRealtime,
    private val schedule: (Long, () -> Unit) -> Unit = { delay, action -> Handler(Looper.getMainLooper()).postDelayed({ action() }, delay); Unit },
) {
    private data class Pending(val owner: InteractionOwner, val event: JsonObject, var deadline: Long, val composing: Boolean,
        val nativeTextAttachment: InteractionTextAdapter.Attachment? = null,
        val nativeScrollAttachment: InteractionScrollAdapter.Attachment? = null,
        var dormant: Boolean = false, var completionReason: String? = null)
    private var token = UUID.randomUUID().toString()
    private var runtime: String? = null
    private val prepared = mutableListOf<PreparedInteraction>()
    fun openRuntime(): String = buffer.withInteractionLock {
        eraseLocked(); UUID.randomUUID().toString().also { runtime = it }
    }
    fun ownsRuntime(id: String): Boolean = buffer.withInteractionLock { runtime == id }
    fun closeRuntime(id: String) = buffer.withInteractionLock {
        if (runtime == id) { eraseLocked(); runtime = null }
    }
    fun prepare(lease: String, id: String, generation: Long, json: String): PreparedInteraction? {
        if (json.toByteArray(Charsets.UTF_8).size > 8192) return null
        val input = runCatching { Json.parseToJsonElement(json) as? JsonObject }.getOrNull() ?: return null
        val type = input.string("type") ?: return null
        val sourceScreen = InteractionTargetScreenState.current()
        // Never inspect UI under the breadcrumb lock or retain a JS value while waiting for UI validation.
        val candidate = buffer.withInteractionLock { registrations[id]?.owner }
        val hostPrivacy = if (candidate != null && Looper.myLooper() == Looper.getMainLooper()) live(candidate) else null
        // Every host-bound state requires observation-time native privacy proof.
        // A later UI queue drain cannot establish whether it preceded unmasking.
        if (type in setOf("text_edit", "control_change", "scroll") && hostPrivacy != true) return null
        val privacyVerified = hostPrivacy == true && candidate != null && !nativeComposing(candidate)
        return buffer.withInteractionLock {
            if (!enabled() || lease != token) return@withInteractionLock null
            if (type == "launch_context") {
                if (id.isNotEmpty() || generation != 0L || prepared.size >= 64) return@withInteractionLock null
                val previous = pending.firstOrNull { it.event.string("type") == "launch" && current(it.owner) && it.deadline > clock() } ?: return@withInteractionLock null
                val fields = previous.event.toMutableMap()
                input["trigger"]?.let { fields["trigger"] = it }; input["arguments"]?.let { fields["arguments"] = it }
                val event = InteractionEventSanitizer.sanitize(JsonObject(fields), policy) ?: return@withInteractionLock null
                pending[pending.indexOf(previous)] = previous.copy(event = event)
                return@withInteractionLock PreparedInteraction(InteractionObservation(previous.owner, event, "context")).also { prepared.add(it) }
            }
            val entry = registrations[id]
            var owner = if (id.isEmpty() && generation == 0L && type in setOf("deep_link", "permission")) {
                InteractionOwner(lease, buffer.captureRevision(), null, null, null, null)
            } else entry?.owner?.takeIf { it.generation == generation && type in entry.types && current(it) }
                ?: return@withInteractionLock null
            if (owner.host != null) {
                val fields = owner.target?.toMutableMap() ?: mutableMapOf()
                fields.remove("screen"); sourceScreen?.let { fields["screen"] = JsonPrimitive(it) }
                val target = InteractionEventSanitizer.target(InteractionEventSanitizer.redact(JsonObject(fields)) as JsonObject)
                owner = InteractionOwner(owner.lease,owner.revision,owner.host,target,owner.liveTestId,owner.hostId,owner.registrationId,owner.generation)
            }
            val phase = if (type == "text_edit") input.string("phase") ?: "change" else if (type == "scroll") "end" else "change"
            if (phase !in setOf("change", "end", "submit")) return@withInteractionLock null
            val composing = input["composing"] == JsonPrimitive(true)
            if (input.containsKey("composing") && input["composing"] !in listOf(JsonPrimitive(true), JsonPrimitive(false))) return@withInteractionLock null
            val fields = input.toMutableMap()
            if (type == "text_edit") {
                fields["reason"] = JsonPrimitive(if (phase == "change") "idle" else phase)
                if (composing) fields.remove("value")
            }
            val allowedId = if (privacyVerified && candidate === entry?.owner && (type != "text_edit" || owner.host?.get() is TextView)) owner.liveTestId else null
            val event = InteractionEventSanitizer.sanitize(JsonObject(fields), policy, allowedId) ?: return@withInteractionLock null
            if (type == "text_edit" && phase == "change") {
                val superseded = prepared.filter { it.observation?.phase == "change" && it.observation?.event?.string("type") == type && it.observation?.owner?.registrationId == owner.registrationId && it.observation?.owner?.generation == owner.generation }
                prepared.removeAll(superseded); superseded.forEach { it.observation = null }
            }
            if (type in setOf("text_edit", "scroll")) boundSummaryHostsLocked(owner)
            if (prepared.size >= 64) return@withInteractionLock null
            PreparedInteraction(InteractionObservation(owner, event, phase, composing)).also { prepared.add(it) }
        }
    }
    fun discardPrepared(item: PreparedInteraction) = buffer.withInteractionLock { prepared.remove(item); item.observation = null }
    fun cancelRegistration(id: String, generation: Long) = buffer.withInteractionLock {
        if (generations[id] == generation) {
            registrations.remove(id); pendingRegistrations.remove(id)
            pending.removeAll { it.owner.registrationId == id }
            prepared.filter { it.observation?.owner?.registrationId == id }.toList().forEach { prepared.remove(it); it.observation = null }
        }
    }
    fun recordPrepared(item: PreparedInteraction): Boolean {
        val observation = buffer.withInteractionLock {
            if (!prepared.remove(item)) null else item.observation.also { item.observation = null }
        } ?: return false
        if (observation.phase == "context") return buffer.withInteractionLock { current(observation.owner) }
        return observe(observation)
    }
    private var policy = InteractionEventPolicy.parse(null)
    private val pending = ArrayList<Pending>()
    private val semanticTimes = ArrayDeque<Long>()
    private val lifecycleTimes = ArrayDeque<Long>()
    private val hostTimes = WeakHashMap<View, Long>()
    private data class Registration(val owner: InteractionOwner, val types: Set<String>, val annotation: JsonObject?)
    private val registrations = mutableMapOf<String, Registration>()
    private val generations = mutableMapOf<String, Long>()
    private val pendingRegistrations = mutableMapOf<String, Pair<Long, JsonObject?>>()
    private var registrationOverflow = false
    private var timerDeadline: Long? = null
    private var timerGeneration = 0L
    private val revocationListeners = mutableListOf<() -> Unit>()
    internal fun onRevoked(listener: () -> Unit) = buffer.withInteractionLock { revocationListeners.add(listener) }
    // No UI reads or recorder calls in retain: adapter insertion shares revoke's lock.
    internal fun retainIfCurrent(owner: InteractionOwner, retain: () -> Unit): Boolean = buffer.withInteractionLock {
        if (!current(owner)) false else { retain(); true }
    }

    init {
        buffer.interactionRevocation = { eraseLocked() }
        buffer.interactionFreeze = { flushReadyForFreeze() }
    }

    fun configure(value: InteractionEventPolicy) = buffer.withInteractionLock {
        eraseLocked(); policy = value
    }
    fun lease(): String? = buffer.withInteractionLock { token.takeIf { enabled() } }
    fun revoke() = buffer.withInteractionLock { eraseLocked() }
    private fun enabled() = !policy.disabled && (!buffer.honorsKillGate || Everframe.captureGate) &&
        listOf("text_edit", "launch", "deep_link").any { buffer.isKindEnabled(InteractionEventSanitizer.kind(it)) }
    private fun eraseLocked() {
        token = UUID.randomUUID().toString()
        prepared.forEach { it.observation = null }; prepared.clear()
        pending.clear(); semanticTimes.clear(); lifecycleTimes.clear(); hostTimes.clear()
        registrations.clear(); generations.clear(); pendingRegistrations.clear(); registrationOverflow = false
        timerDeadline = null
        timerGeneration++
        revocationListeners.forEach { it() }
    }
    val pendingCount: Int get() = buffer.withInteractionLock { pending.size }
    internal fun pendingDebugSnapshot(): List<JsonObject> = buffer.withInteractionLock { pending.map { it.event } }

    fun owner(view: View? = null, lease: String? = lease()): InteractionOwner? {
        if (lease == null) return null
        val revision = buffer.withInteractionLock { if (!enabled() || lease != token) null else buffer.captureRevision() } ?: return null
        if (view == null) return InteractionOwner(lease, revision, null, null, null, null)
        if (!safeHost(view)) return null
        return try {
            val snapshot = InteractionTargetResolver.resolve(view)
            val target = snapshot.data["target"] as? JsonObject
            if (target?.get("masked") == JsonPrimitive(true)) return null
            val safeTarget = target?.let { InteractionEventSanitizer.target(InteractionEventSanitizer.redact(it) as JsonObject) }
            val owner = InteractionOwner(lease, revision, WeakReference(view), safeTarget, testId(view), view.id)
            buffer.withInteractionLock {
                if (!current(owner)) null else {
                    val annotation = registrations.values.firstOrNull { it.owner.host?.get() === view && current(it.owner) }?.annotation
                    if (annotation == null) owner else InteractionOwner(owner.lease,owner.revision,owner.host,
                        JsonObject((owner.target ?: JsonObject(emptyMap())) + annotation),owner.liveTestId,owner.hostId)
                }
            }
        } catch (_: Exception) { null }
    }

    fun observe(observation: InteractionObservation): Boolean {
        val owner = observation.owner
        val type = observation.event.string("type") ?: return false
        if ((type in setOf("text_edit", "control_change", "scroll")) != (owner.host != null)) return false
        if (!live(owner) || observation.nativeTextAttachment?.attached == false || observation.nativeScrollAttachment?.attached == false) return false
        val localPolicy = buffer.withInteractionLock { if (current(owner)) policy else null } ?: return false
        if (observation.phase !in setOf("change", "end", "submit")) return false
        val composing = observation.composing || (type == "text_edit" && nativeComposing(owner))
        val input = observation.event.toMutableMap()
        if (type == "text_edit") {
            input["reason"] = JsonPrimitive(if (observation.phase == "change") "idle" else observation.phase)
            if (composing) input.remove("value")
        }
        val event = InteractionEventSanitizer.sanitize(JsonObject(input), localPolicy,
            owner.liveTestId.takeIf { type != "text_edit" || owner.host?.get() is TextView }) ?: return false
        val now = clock()
        val delay = when (type) { "text_edit" -> 750L; "scroll" -> 200L; "launch" -> if (observation.deferLaunch) 250L else 0L; else -> 0L }
        val shouldPend = delay != 0L && (observation.phase == "change" || composing)
        val accepted = buffer.withInteractionLock {
            if (!current(owner) || !buffer.isKindEnabled(InteractionEventSanitizer.kind(type))) return@withInteractionLock false
            pending.removeAll { it.owner.host?.get() === owner.host?.get() && it.event.string("type") == type }
            if (shouldPend) {
                boundSummaryHostsLocked(owner)
                pending.add(Pending(owner, event, now + delay, composing, observation.nativeTextAttachment, observation.nativeScrollAttachment))
                true
            } else admitLocked(owner, event, now)
        }
        // Timers retain the recorder only, never a host, raw value or old observation.
        if (accepted && shouldPend) armTimer()
        return accepted
    }

    /** UI-queued and delayed text/scroll share one host bound; eviction never emits. */
    private fun boundSummaryHostsLocked(owner: InteractionOwner) {
        val view = owner.host?.get() ?: return
        val summaries = prepared.filter { it.observation?.event?.string("type") in setOf("text_edit", "scroll") }
        val hosts = (pending.mapNotNull { it.owner.host?.get() } + summaries.mapNotNull { it.observation?.owner?.host?.get() }).distinct()
        if (view in hosts || hosts.size < 32) return
        val oldest = hosts.first()
        pending.removeAll { it.owner.host?.get() === oldest }
        val removed = summaries.filter { it.observation?.owner?.host?.get() === oldest }
        prepared.removeAll(removed); removed.forEach { it.observation = null }
    }
    private fun armTimer() {
        val timer = buffer.withInteractionLock {
            val deadline = pending.filterNot { it.dormant }.minOfOrNull { it.deadline } ?: return@withInteractionLock null
            if (timerDeadline?.let { it <= deadline } == true) return@withInteractionLock null
            timerDeadline = deadline
            Triple(token, ++timerGeneration, (deadline - clock()).coerceAtLeast(1))
        } ?: return
        schedule(timer.third) {
            val active = buffer.withInteractionLock {
                if (token != timer.first || timerGeneration != timer.second) false else { timerDeadline = null; true }
            }
            if (active) { flushDue(); armTimer() }
        }
    }

    fun allowsValue(owner: InteractionOwner, type: String): Boolean {
        if (!live(owner) || (type == "text_edit" && owner.host?.get() !is TextView)) return false
        return buffer.withInteractionLock { current(owner) && owner.liveTestId in policy.valueTestIds }
    }

    /** Begin/clear are synchronous and view-free, so queued Fabric resolution cannot resurrect a ref. */
    fun beginRegistration(id: String, generation: Long, lease: String, optionsJson: String? = null): Boolean {
        val input = if (optionsJson == null) JsonObject(emptyMap()) else {
            if (optionsJson.toByteArray(Charsets.UTF_8).size > 8192) return false
            runCatching { Json.parseToJsonElement(optionsJson) as? JsonObject }.getOrNull() ?: return false
        }
        val raw = (input["target"] as? JsonObject)?.filterKeys { it in setOf("name","testId","role","container") }
        val annotation = raw?.let { InteractionEventSanitizer.target(InteractionEventSanitizer.redact(JsonObject(it)) as JsonObject) }
            ?.let { if (it.containsKey("name")) JsonObject(it + ("nameFrom" to JsonPrimitive("annotation"))) else it }
        return buffer.withInteractionLock {
            if (!enabled() || lease != token || !advance(id, generation)) return@withInteractionLock false
            pendingRegistrations[id] = generation to annotation; true
        }
    }
    fun completeRegistration(view: View, id: String, generation: Long, lease: String, types: Set<String>): Boolean {
        if (types.any { it !in setOf("text_edit", "control_change", "scroll") }) return false
        val owner = owner(view, lease) ?: return false
        return buffer.withInteractionLock {
            val request = pendingRegistrations[id]
            if (!current(owner) || request?.first != generation) return@withInteractionLock false
            val annotation = request.second
            val target = if (annotation == null) owner.target else JsonObject((owner.target ?: JsonObject(emptyMap())) + annotation)
            pendingRegistrations.remove(id)
            val displaced = registrations.filterValues { it.owner.host?.get() === view }.keys.toList()
            for (key in displaced) { generations[key]?.let { cancelRegistration(key,it) } }
            pending.removeAll { it.owner.host?.get() === view && it.event.string("type") in types }
            registrations[id] = Registration(InteractionOwner(owner.lease, owner.revision, owner.host, target,
                owner.liveTestId, owner.hostId, id, generation), types.toSet(), annotation)
            true
        }
    }
    fun register(view: View, id: String, generation: Long, lease: String, types: Set<String>): Boolean =
        beginRegistration(id, generation, lease) && completeRegistration(view, id, generation, lease, types)
    fun clearRegistration(id: String, generation: Long): Boolean = buffer.withInteractionLock { advance(id, generation) }
    private fun advance(id: String, generation: Long): Boolean {
        if (registrationOverflow || !InteractionEventPolicy.identifier(id, 256) || generation < 0 || generation > 9007199254740991L || generation <= (generations[id] ?: -1)) return false
        if (id !in generations && generations.size >= 4096) {
            registrationOverflow = true; registrations.clear(); pendingRegistrations.clear()
            pending.removeAll { it.owner.registrationId != null }; return false
        }
        generations[id]?.let { cancelRegistration(id,it) }
        generations[id] = generation
        registrations.remove(id); pendingRegistrations.remove(id)
        pending.removeAll { it.owner.registrationId == id }
        return true
    }
    fun registeredOwner(id: String, generation: Long, lease: String): InteractionOwner? {
        val entry = buffer.withInteractionLock { registrations[id]?.takeIf { it.owner.generation == generation && it.owner.lease == lease && current(it.owner) } } ?: return null
        if (!live(entry.owner)) return null
        // Resolve the source screen at observation, not when the host was mounted.
        val fresh = owner(entry.owner.host?.get() ?: return null, lease) ?: return null
        return InteractionOwner(fresh.lease, fresh.revision, fresh.host, fresh.target, fresh.liveTestId, fresh.hostId, id, generation)
    }
    fun suppresses(view: View, type: String): Boolean {
        val owners = buffer.withInteractionLock { registrations.values.filter { type in it.types && it.owner.host?.get() === view && current(it.owner) }.map { it.owner } }
        return owners.any { live(it) }
    }
    fun helperOwns(owner: InteractionOwner, type: String): Boolean = buffer.withInteractionLock {
        current(owner) && registrations[owner.registrationId]?.types?.contains(type) == true
    }

    fun complete(host: View, type: String, reason: String) {
        val item = buffer.withInteractionLock {
            pending.firstOrNull { it.owner.host?.get() === host && it.event.string("type") == type }
                ?.takeUnless { it.completionReason != null && !it.dormant }
        } ?: return
        val firstReason = buffer.withInteractionLock { item.completionReason ?: reason }
        flush(item, firstReason)
        buffer.withInteractionLock {
            if (pending.any { it === item } && current(item.owner) && item.composing && item.nativeTextAttachment?.attached == true && item.completionReason == null) {
                // Some IMEs submit before removing composing spans. Give this same edit
                // one deferred check on the shared timer, retaining its original owner.
                // Keeping the reason also prevents duplicate end callbacks from polling.
                item.completionReason = firstReason
                item.deadline = clock() + 1
                item.dormant = false
            }
        }
        armTimer()
    }
    fun cancel(host: View, type: String) = buffer.withInteractionLock {
        pending.removeAll { it.owner.host?.get() === host && it.event.string("type") == type }
    }
    fun finishLaunch() {
        val item = buffer.withInteractionLock { pending.firstOrNull { it.event.string("type") == "launch" } } ?: return
        flush(item, "end")
    }
    fun flushDue() {
        val now = clock()
        val ready = buffer.withInteractionLock { pending.filter { !it.dormant && it.deadline <= now }.map { it to (it.completionReason ?: "idle") } }
        for ((item, reason) in ready) flush(item, reason)
    }
    fun flushReadyForFreeze() {
        // Off-main report/crash capture cannot inspect UIKit/Android hosts or wait for JS.
        if (Looper.myLooper() != Looper.getMainLooper()) return
        val ready = buffer.withInteractionLock { pending.toList() }
        for (item in ready) flush(item, "freeze")
    }
    private fun flush(item: Pending, reason: String) {
        val live = live(item.owner) && item.nativeTextAttachment?.attached != false && item.nativeScrollAttachment?.attached != false
        val composing = live && item.event.string("type") == "text_edit" && nativeComposing(item.owner)
        val nativeComposition = item.composing && item.nativeTextAttachment != null
        buffer.withInteractionLock {
            if (item !in pending) return@withInteractionLock
            if (live && nativeComposition && composing && current(item.owner)) {
                // Retain only the original edit's metadata within the shared host bound.
                // A span-only IME commit may have no text callback. End/freeze can finish
                // this edit later, without polling or renewing its capture revision.
                item.dormant = true
                return@withInteractionLock
            }
            pending.remove(item)
            if (!live || composing || (item.composing && !nativeComposition) || !current(item.owner)) return@withInteractionLock
            val event = if (item.event.string("type") == "text_edit") JsonObject(item.event + ("reason" to JsonPrimitive(reason))) else item.event
            admitLocked(item.owner, event, clock())
        }
    }

    private fun admitLocked(owner: InteractionOwner, event: JsonObject, now: Long): Boolean {
        if (!current(owner)) return false
        val type = event.string("type") ?: return false
        val kind = InteractionEventSanitizer.kind(type)
        if (!buffer.isKindEnabled(kind)) return false
        val semantic = type in setOf("text_edit", "control_change", "scroll")
        val times = if (semantic) semanticTimes else lifecycleTimes
        while (times.isNotEmpty() && now - times.first() >= 10000) times.removeFirst()
        if (times.size >= if (semantic) 20 else 10) return false
        val host = owner.host?.get()
        val hostLimited = type == "text_edit" || type == "scroll"
        if (hostLimited && host != null && hostTimes[host]?.let { now - it < 1000 } == true) return false
        val data = linkedMapOf<String, JsonElement>("interaction" to event)
        owner.target?.let { data["target"] = it }
        if (!buffer.addObservedInteraction(kind, InteractionEventSanitizer.message(type), JsonObject(data), owner.revision)) return false
        times.addLast(now)
        if (hostLimited && host != null) hostTimes[host] = now
        return true
    }

    private fun current(owner: InteractionOwner): Boolean = enabled() && owner.lease == token && owner.revision == buffer.captureRevision() &&
        (owner.registrationId == null || registrations[owner.registrationId]?.owner?.let { it.generation == owner.generation && it.host?.get() === owner.host?.get() } == true)
    private fun live(owner: InteractionOwner): Boolean {
        if (owner.host == null) return true
        val view = owner.host.get() ?: return false
        return safeHost(view) && runCatching { view.id == owner.hostId && testId(view) == owner.liveTestId }.getOrDefault(false)
    }
    private fun nativeComposing(owner: InteractionOwner): Boolean {
        val text = (owner.host?.get() as? EditText)?.text ?: return false
        return BaseInputConnection.getComposingSpanStart(text) >= 0 || text.getSpans(0,text.length,Any::class.java).any { text.getSpanFlags(it) and android.text.Spanned.SPAN_COMPOSING != 0 }
    }
    private fun safeHost(view: View): Boolean = Looper.myLooper() == Looper.getMainLooper() && runCatching {
        view.isAttachedToWindow && !InteractionTargetResolver.sensitiveAncestry(view) &&
            !(view is TextView && view.transformationMethod is PasswordTransformationMethod)
    }.getOrDefault(false)
    private fun testId(view: View): String? {
        // Annotation normalization may truncate/drop invalid characters. It must never grant
        // permission to read a value; only the exact ID on the live native host can do that.
        val raw = InteractionTargetViewAdapters.describe(view)?.testId
            ?: if (view.id != View.NO_ID) runCatching { view.resources.getResourceEntryName(view.id) }.getOrNull() else null
        return raw?.takeIf { InteractionEventPolicy.identifier(it, 256) }
    }
}

internal val sharedInteractionRecorder by lazy { InteractionEventRecorder(sharedBreadcrumbBuffer) }

/** Opaque observation ownership for native support modules. */
class InteractionCapture internal constructor(internal val owner: InteractionOwner)
/** A bounded, already-redacted queue cell. Revocation erases it synchronously. */
class PreparedInteraction internal constructor(internal var observation: InteractionObservation?)

/** Small cross-module surface; leases and native privacy checks remain authoritative. */
object InteractionEvents {
    fun openRuntime(): String = sharedInteractionRecorder.openRuntime()
    fun ownsRuntime(id: String): Boolean = sharedInteractionRecorder.ownsRuntime(id)
    fun closeRuntime(id: String) = sharedInteractionRecorder.closeRuntime(id)
    fun prepare(lease: String, id: String, generation: Long, json: String): PreparedInteraction? = sharedInteractionRecorder.prepare(lease, id, generation, json)
    fun recordPrepared(item: PreparedInteraction): Boolean = sharedInteractionRecorder.recordPrepared(item)
    fun discardPrepared(item: PreparedInteraction) = sharedInteractionRecorder.discardPrepared(item)
    fun cancelRegistration(id: String, generation: Long) = sharedInteractionRecorder.cancelRegistration(id,generation)
    fun lease(): String? = sharedInteractionRecorder.lease()
    fun capture(view: View? = null, lease: String? = lease()): InteractionCapture? = sharedInteractionRecorder.owner(view, lease)?.let { InteractionCapture(it) }
    fun allowsValue(capture: InteractionCapture, type: String): Boolean = sharedInteractionRecorder.allowsValue(capture.owner, type)
    fun suppresses(view: View, type: String): Boolean = sharedInteractionRecorder.suppresses(view, type)
    fun beginRegistration(id: String, generation: Long, lease: String, optionsJson: String? = null): Boolean = sharedInteractionRecorder.beginRegistration(id, generation, lease, optionsJson)
    fun completeRegistration(view: View, id: String, generation: Long, lease: String, types: Set<String>): Boolean = sharedInteractionRecorder.completeRegistration(view, id, generation, lease, types)
    fun clearRegistration(id: String, generation: Long): Boolean = sharedInteractionRecorder.clearRegistration(id, generation)
    fun registeredCapture(id: String, generation: Long, lease: String): InteractionCapture? = sharedInteractionRecorder.registeredOwner(id, generation, lease)?.let { InteractionCapture(it) }
    fun helperOwns(capture: InteractionCapture, type: String): Boolean = sharedInteractionRecorder.helperOwns(capture.owner, type)
    fun record(capture: InteractionCapture, json: String, phase: String = "change", composing: Boolean = false): Boolean = try {
        if (json.toByteArray(Charsets.UTF_8).size > 8192) false else {
            val event = Json.parseToJsonElement(json) as? JsonObject
            event != null && sharedInteractionRecorder.observe(InteractionObservation(capture.owner, event, phase, composing))
        }
    } catch (_: Exception) { false }
    fun complete(view: View, type: String, reason: String) = sharedInteractionRecorder.complete(view, type, reason)
}
