// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Link state, the attempt loop, banner and toasts, on a test dispatcher with a
// fake client and a JCE-keyed store. Tokens are compared, never printed.

package dev.everframe.devicelink

import dev.everframe.config.DeviceLinkStatusWire
import dev.everframe.config.DeviceLinkingConfigWire
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

@OptIn(ExperimentalCoroutinesApi::class)
class DeviceLinkTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private val scope = "scope-a"
    private val tokA = "evf_dev_" + "AaAa".repeat(8)
    private val tokB = "evf_dev_" + "BbBb".repeat(8)
    private val uuid = "6c1e2f6a-1b7e-4b43-9a55-0e0c2b8f3e10"

    private lateinit var file: File
    private lateinit var keys: JceTestDeviceLinkKeyProvider
    private lateinit var store: DeviceLinkStore
    private val client = FakeClient()
    private val toasts = mutableListOf<String>()
    private val banners = mutableListOf<Int?>()
    private var refreshes = 0
    private var bannerNumber: Int? = null
    private var linkChanges = 0

    private val device = HelloDevice(model = "Pixel 9", osVersion = "15", appVersion = "1.0.0", sdk = "android/x", formFactor = "phone")

    @Before
    fun setUp() {
        file = File(tmp.newFolder("dev.everframe"), "device-link-v1.bin")
        keys = JceTestDeviceLinkKeyProvider()
        store = DeviceLinkStore(file, keys)
    }

    @After
    fun tearDown() {
        DeviceLink.teardown()
        DeviceLink.__resetForTesting()
    }

    private fun TestScope.install(linkingEnabled: Boolean = true, isCurrent: () -> Boolean = { true }) {
        val dispatcher = StandardTestDispatcher(testScheduler)
        DeviceLink.scopeProvider = { CoroutineScope(dispatcher) }
        DeviceLink.now = { testScheduler.currentTime }
        DeviceLink.toaster = { toasts += it }
        DeviceLink.refreshConfig = { refreshes++ }
        DeviceLink.showBanner = { bannerNumber = it; banners += it }
        DeviceLink.hideBanner = { bannerNumber = null; banners += null }
        DeviceLink.onLinkChanged = { linkChanges++ }
        DeviceLink.install(store, client, scope, { device }, isCurrent)
        if (linkingEnabled) DeviceLink.applyConfig(DeviceLinkingConfigWire(true, null), isCurrent)
    }

    @Test
    fun copy() {
        assertEquals("Captured · Aurimas", DeviceLinkCopy.captured(DeviceLinkOwner.User("Aurimas")))
        assertEquals("Captured · team device", DeviceLinkCopy.captured(DeviceLinkOwner.Team))
        assertEquals("Linked to Aurimas", DeviceLinkCopy.linked(DeviceLinkOwner.User("Aurimas")))
        assertEquals("Linked as team device", DeviceLinkCopy.linked(DeviceLinkOwner.Team))
        assertEquals("Linking to Everframe · 47", DeviceLinkCopy.bannerTitle(47))
        assertEquals("A teammate is linking a device. If that's not you, ignore this.", DeviceLinkCopy.BANNER_SUBLINE)
        assertEquals("This device was unlinked", DeviceLinkCopy.UNLINKED)
    }

    @Test
    fun installLoadsTheStoredLinkForThisScopeOnly() = runTest {
        assertTrue(store.save(StoredDeviceLink(tokA, DeviceLinkOwner.User("Ann"), scope)))
        install()
        assertTrue(DeviceLink.isLoaded)
        assertTrue(DeviceLink.current?.token == tokA)
        assertTrue(DeviceLink.tokenForRequest() == tokA)
        DeviceLink.teardown()
        assertFalse(DeviceLink.isLoaded)

        DeviceLink.install(store, client, "other-scope", { device }, { true })
        assertNull(DeviceLink.current)
        assertNull(DeviceLink.tokenForRequest())
        assertTrue("kept for its own scope", file.exists())
        DeviceLink.teardown()

        DeviceLink.install(store, client, null, { device }, { true })
        assertNull(DeviceLink.current)
    }

    @Test
    fun helloPendingShowsBannerAndChecksEvery3s() = runTest {
        install()
        client.helloResult = HelloResult.Pending(uuid, 47)
        DeviceLink.sendHello()
        runCurrent()
        assertEquals(1, client.hellos.size)
        assertTrue(client.hellos.single().length >= 32)
        assertEquals(47, bannerNumber)
        assertTrue(DeviceLink.attemptInFlight)
        advanceTimeBy(2_999); runCurrent()
        assertEquals(0, client.checks.size)
        advanceTimeBy(1); runCurrent()
        assertEquals(1, client.checks.size)
        advanceTimeBy(6_000); runCurrent()
        assertEquals(3, client.checks.size)
        // The check carries the hello's nonce.
        assertTrue(client.checks.all { it.first == uuid && it.second == client.hellos.single() })
    }

    @Test
    fun helloNoneOrStopShowsNothing() = runTest {
        install()
        listOf(HelloResult.None, HelloResult.Stop).forEach { r ->
            client.helloResult = r
            DeviceLink.sendHello()
            runCurrent()
            advanceTimeBy(10_000); runCurrent()
        }
        assertEquals(2, client.hellos.size)
        assertTrue(banners.isEmpty())
        assertEquals(0, client.checks.size)
        assertFalse(DeviceLink.attemptInFlight)
    }

    @Test
    fun linkedStoresTokenToastsAndRefreshesConfig() = runTest {
        install()
        client.helloResult = HelloResult.Pending(uuid, 47)
        client.checkResults += CheckResult.Linked(tokA, DeviceLinkOwner.User("Aurimas"))
        DeviceLink.sendHello()
        advanceTimeBy(3_000); runCurrent()
        assertTrue(store.load(scope)?.token == tokA)
        assertTrue(DeviceLink.current?.token == tokA)
        assertEquals(listOf("Linked to Aurimas"), toasts)
        assertNull(bannerNumber)
        assertEquals(1, refreshes)
        assertEquals("gesture arming follows the link", 1, linkChanges)
        assertFalse(DeviceLink.attemptInFlight)
    }

    @Test
    fun saveFailureStaysUnlinkedWithoutToast() = runTest {
        install()
        keys.failWith = java.security.KeyStoreException("gone")
        client.helloResult = HelloResult.Pending(uuid, 47)
        client.checkResults += CheckResult.Linked(tokA, DeviceLinkOwner.Team)
        DeviceLink.sendHello()
        advanceTimeBy(3_000); runCurrent()
        assertNull(DeviceLink.current)
        assertTrue(toasts.isEmpty())
        assertNull(bannerNumber)
    }

    @Test
    fun expiredOrStopHidesBannerWithoutToast() = runTest {
        install()
        listOf(CheckResult.Expired, CheckResult.Stop).forEachIndexed { i, r ->
            client.helloResult = HelloResult.Pending(uuid, 10 + i)
            client.checkResults += r
            DeviceLink.now = { testScheduler.currentTime + i * 10_000L } // past the hello debounce
            DeviceLink.sendHello()
            runCurrent()
            assertEquals(10 + i, bannerNumber)
            advanceTimeBy(3_000); runCurrent()
            assertNull(bannerNumber)
            assertFalse(DeviceLink.attemptInFlight)
        }
        assertEquals(2, client.checks.size)
        assertTrue(toasts.isEmpty())
        assertNull(DeviceLink.current)
    }

    @Test
    fun retryKeepsCheckingUntil150sThenHides() = runTest {
        install()
        client.helloResult = HelloResult.Pending(uuid, 47)
        client.defaultCheck = { if (client.checks.size % 2 == 0) CheckResult.Retry else CheckResult.Pending }
        DeviceLink.sendHello()
        runCurrent()
        advanceTimeBy(149_999); runCurrent()
        assertEquals(47, bannerNumber)
        advanceTimeBy(60_000); runCurrent()
        assertNull(bannerNumber)
        assertFalse(DeviceLink.attemptInFlight)
        assertEquals(50, client.checks.size)
        assertTrue(client.checkTimes.last() <= 150_000L)
        assertTrue(toasts.isEmpty())
    }

    @Test
    fun secondHelloWhileAttemptInFlightIsDropped() = runTest {
        install()
        client.helloResult = HelloResult.Pending(uuid, 47)
        DeviceLink.sendHello()
        DeviceLink.sendHello()
        runCurrent()
        DeviceLink.now = { testScheduler.currentTime + 60_000 } // past the debounce: still dropped
        DeviceLink.sendHello()
        runCurrent()
        assertEquals(1, client.hellos.size)
        assertEquals(listOf<Int?>(47), banners)
        // A takeover attempt while a hello attempt runs is dropped too: one loop.
        DeviceLink.beginAttempt("other", 12, LinkNonce.generate())
        advanceTimeBy(3_000); runCurrent()
        assertEquals(listOf<Int?>(47), banners)
        assertTrue(client.checks.all { it.first == uuid })
    }

    @Test
    fun helloDebouncedFor5s() = runTest {
        install()
        client.helloResult = HelloResult.None
        DeviceLink.sendHello()
        runCurrent()
        advanceTimeBy(4_999); runCurrent()
        DeviceLink.sendHello(); runCurrent()
        assertEquals(1, client.hellos.size)
        advanceTimeBy(1); runCurrent()
        DeviceLink.sendHello(); runCurrent()
        assertEquals(2, client.hellos.size)
    }

    @Test
    fun helloNotSentWhenLinkingDisabledOrNotLoaded() = runTest {
        DeviceLink.sendHello()
        install(linkingEnabled = false)
        DeviceLink.sendHello(); runCurrent()
        DeviceLink.applyConfig(DeviceLinkingConfigWire(false, null)) { true }
        DeviceLink.sendHello(); runCurrent()
        assertEquals(0, client.hellos.size)
        DeviceLink.applyConfig(DeviceLinkingConfigWire(true, null)) { true }
        DeviceLink.sendHello(); runCurrent()
        assertEquals(1, client.hellos.size)
    }

    @Test
    fun linkedDeviceSendsNoHello() = runTest {
        assertTrue(store.save(StoredDeviceLink(tokA, DeviceLinkOwner.Team, scope)))
        install()
        DeviceLink.sendHello(); runCurrent()
        assertEquals(0, client.hellos.size)
    }

    @Test
    fun takeoverAttemptReplacesTheStoredToken() = runTest {
        assertTrue(store.save(StoredDeviceLink(tokA, DeviceLinkOwner.User("Aurimas"), scope)))
        install()
        val nonce = LinkNonce.generate()
        client.checkResults += CheckResult.Linked(tokB, DeviceLinkOwner.User("Jonas"))
        DeviceLink.beginAttempt(uuid, 47, nonce)
        runCurrent()
        assertEquals(47, bannerNumber)
        advanceTimeBy(3_000); runCurrent()
        assertTrue(client.checks.single().second == nonce)
        assertTrue(DeviceLink.current?.token == tokB)
        assertTrue(store.load(scope)?.token == tokB)
        assertEquals(listOf("Linked to Jonas"), toasts)
        assertNull(bannerNumber)
    }

    @Test
    fun configUnlinkedForgetsAndToastsOnce() = runTest {
        assertTrue(store.save(StoredDeviceLink(tokA, DeviceLinkOwner.User("Aurimas"), scope)))
        install()
        DeviceLink.tokenForRequest() // the config request carried this token
        val unlinked = DeviceLinkingConfigWire(true, DeviceLinkStatusWire(false, null))
        DeviceLink.applyConfig(unlinked) { true }
        DeviceLink.applyConfig(unlinked) { true }
        assertNull(DeviceLink.current)
        assertNull(store.load(scope))
        assertFalse(file.exists())
        assertEquals(listOf("This device was unlinked"), toasts)
        assertEquals(1, refreshes)
        assertEquals(1, linkChanges)
    }

    @Test
    fun configStatusForAnotherTokenIsIgnored() = runTest {
        assertTrue(store.save(StoredDeviceLink(tokA, DeviceLinkOwner.User("Aurimas"), scope)))
        install()
        // No config request has carried tokA yet (it was linked after the last fetch went out).
        DeviceLink.applyConfig(DeviceLinkingConfigWire(true, DeviceLinkStatusWire(false, null))) { true }
        assertTrue(DeviceLink.current?.token == tokA)
        assertTrue(toasts.isEmpty())
    }

    @Test
    fun configOwnerRenameUpdatesTheStoredOwner() = runTest {
        assertTrue(store.save(StoredDeviceLink(tokA, DeviceLinkOwner.User("Ann"), scope)))
        install()
        DeviceLink.tokenForRequest()
        DeviceLink.applyConfig(DeviceLinkingConfigWire(true, DeviceLinkStatusWire(true, DeviceLinkOwner.User("Ann Lee")))) { true }
        assertEquals(DeviceLinkOwner.User("Ann Lee"), DeviceLink.current?.owner)
        assertEquals(DeviceLinkOwner.User("Ann Lee"), store.load(scope)?.owner)
        assertTrue(DeviceLink.current?.token == tokA)
        assertTrue(toasts.isEmpty())
    }

    @Test
    fun configWithoutLinkKeepsTheToken() = runTest {
        assertTrue(store.save(StoredDeviceLink(tokA, DeviceLinkOwner.Team, scope)))
        install()
        DeviceLink.tokenForRequest()
        DeviceLink.applyConfig(DeviceLinkingConfigWire(true, null)) { true }
        assertTrue(DeviceLink.current?.token == tokA)
        assertTrue(DeviceLink.linkingEnabled)
        DeviceLink.applyConfig(null) { true }
        assertTrue(DeviceLink.current?.token == tokA)
        assertFalse(DeviceLink.linkingEnabled)
        assertTrue(toasts.isEmpty())
    }

    @Test
    fun teardownCancelsTheLoopAndHidesTheBanner() = runTest {
        install()
        client.helloResult = HelloResult.Pending(uuid, 47)
        DeviceLink.sendHello()
        advanceTimeBy(3_000); runCurrent()
        assertEquals(1, client.checks.size)
        DeviceLink.teardown()
        advanceTimeBy(10_000); runCurrent()
        assertEquals(1, client.checks.size)
        assertNull(bannerNumber)
        assertFalse(DeviceLink.attemptInFlight)
    }

    @Test
    fun staleApplyIsIgnored() = runTest {
        assertTrue(store.save(StoredDeviceLink(tokA, DeviceLinkOwner.Team, scope)))
        install(linkingEnabled = false)
        DeviceLink.tokenForRequest()
        DeviceLink.applyConfig(DeviceLinkingConfigWire(true, DeviceLinkStatusWire(false, null))) { false }
        assertFalse(DeviceLink.linkingEnabled)
        assertNotNull(DeviceLink.current)
        assertTrue(toasts.isEmpty())
    }

    @Test
    fun forgetClearsAndToasts() = runTest {
        assertTrue(store.save(StoredDeviceLink(tokA, DeviceLinkOwner.Team, scope)))
        install()
        assertFalse("another token is current", DeviceLink.forget(onlyIfToken = tokB))
        assertNotNull(DeviceLink.current)
        assertTrue(DeviceLink.forget())
        assertNull(DeviceLink.current)
        assertFalse(file.exists())
        assertEquals(listOf("This device was unlinked"), toasts)
        assertEquals(1, refreshes)
    }

    @Test
    fun storedLinkToStringNeverLeaksThroughState() = runTest {
        assertTrue(store.save(StoredDeviceLink(tokA, DeviceLinkOwner.Team, scope)))
        install()
        assertFalse(DeviceLink.current.toString().contains(tokA))
    }

    internal class FakeClient : DeviceLinkApi {
        var helloResult: HelloResult = HelloResult.None
        val hellos = mutableListOf<String>()
        val checks = mutableListOf<Pair<String, String>>()
        val checkTimes = mutableListOf<Long>()
        val checkResults = ArrayDeque<CheckResult>()
        var defaultCheck: () -> CheckResult = { CheckResult.Pending }

        override suspend fun hello(nonce: String, device: HelloDevice): HelloResult {
            hellos += nonce
            return helloResult
        }

        override suspend fun check(attemptId: String, nonce: String): CheckResult {
            checks += attemptId to nonce
            checkTimes += DeviceLink.now()
            return checkResults.removeFirstOrNull() ?: defaultCheck()
        }
    }
}
