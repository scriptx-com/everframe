// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.ui

import android.app.Activity
import android.app.Application
import android.os.Looper
import dev.everframe.Everframe
import dev.everframe.config.ReportResult
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Before
import org.junit.After
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode

class ReporterCountingApplication : Application() {
    val registrations = mutableListOf<ActivityLifecycleCallbacks>()
    override fun registerActivityLifecycleCallbacks(callback: ActivityLifecycleCallbacks) {
        registrations.add(callback)
        super.registerActivityLifecycleCallbacks(callback)
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ReporterCountingApplication::class)
@LooperMode(LooperMode.Mode.PAUSED)
class ReporterResolverInstallerTest {
    @Before fun before() = resetReporterTestState()
    @After fun after() = resetReporterTestState()

    private val app get() = (RuntimeEnvironment.getApplication() as ReporterCountingApplication)

    @Test fun repeatedInstallRegistersOnce() {
        ReporterResolverInstaller().create(app)
        ReporterResolverInstaller().create(app)
        assertEquals(1, app.registrations.count { it === ActivityRegistry })
    }

    @Test fun successorCallbacksSurviveRetry() {
        ReporterResolverInstaller().create(app)
        val successor: suspend () -> ReportResult = { ReportResult.Cancelled("successor") }
        val supplier: () -> Activity? = { null }
        Everframe.report.__resolver = successor
        Everframe.__activitySupplier = supplier
        ReporterResolverInstaller().create(app)
        assertSame(successor, Everframe.report.__resolver)
        assertSame(supplier, Everframe.__activitySupplier)
    }

    @Test fun offMainCreateDoesNotBlock() {
        val thread = Thread { ReporterResolverInstaller().create(app) }
        thread.start(); thread.join(2000)
        assertFalse("initializer must not wait for main", thread.isAlive)
        assertEquals(0, app.registrations.count { it === ActivityRegistry })
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(1, app.registrations.count { it === ActivityRegistry })
    }

    @Test fun partialInstallRetriesRemainingSteps() {
        var failCompanion = true
        val installation = ReporterInstallationState {
            if (failCompanion) throw IllegalStateException("companion setup failed")
            CompanionPinPresenter.install()
        }
        try { installation.ensureInstalled(app); fail("installation must fail") }
        catch (_: IllegalStateException) { }
        assertEquals(1, app.registrations.count { it === ActivityRegistry })
        assertNull(Everframe.report.__resolver)
        failCompanion = false
        installation.ensureInstalled(app)
        assertEquals(1, app.registrations.count { it === ActivityRegistry })
        assertNotNull(Everframe.report.__resolver)
        assertTrue(Everframe.__attachPinUiInstalled)
    }

    @Test fun cancelledCollectorIsReplacedWithoutDuplicatingAnActiveCollector() {
        CompanionPinPresenter.install()
        val field = CompanionPinPresenter::class.java.getDeclaredField("collector").apply { isAccessible = true }
        val original = field.get(null) as kotlinx.coroutines.Job
        CompanionPinPresenter.install()
        assertSame(original, field.get(null))
        original.cancel()
        CompanionPinPresenter.install()
        val replacement = field.get(null) as kotlinx.coroutines.Job
        assertNotSame(original, replacement)
        assertTrue(replacement.isActive)
    }

    @Test fun lateActivityOpensThroughSuccessor() = runBlocking {
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        ReporterResolverInstaller().create(app)
        Everframe.report.__resolver = { ReportResult.Cancelled("selected_resolver") }
        val result = ReporterResolverInstaller().openForActivity(app, activity)
        assertEquals(ReportResult.Cancelled("selected_resolver"), result)
        assertSame(activity, ActivityRegistry.activeActivity())
    }

    @Test fun invalidExplicitActivityCannotUseStaleRegistry() = runBlocking {
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        ReporterResolverInstaller().create(app)
        ActivityRegistry.onActivityResumed(activity)
        var invoked = false
        Everframe.report.__resolver = { invoked = true; ReportResult.Cancelled("wrong") }
        assertEquals(ReportResult.Cancelled("no_active_activity"), ReporterResolverInstaller().openForActivity(app, null))
        activity.finish()
        assertEquals(ReportResult.Cancelled("no_active_activity"), ReporterResolverInstaller().openForActivity(app, activity))
        assertFalse(invoked)
    }
}
