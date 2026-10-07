// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.capture.video

import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.net.URLClassLoader
import java.util.jar.JarEntry
import java.util.jar.JarOutputStream

/** App code creating the host Views native video recognises by name; [VideoPrivacyKeepRulesTest] minifies it. */
object VideoPrivacyHostApp {
    @JvmStatic fun flutter(context: android.content.Context): android.view.View = io.flutter.embedding.android.FlutterView(context)
    @JvmStatic fun reactNative(context: android.content.Context): android.view.View = com.facebook.react.VideoPrivacyFixtureView(context)
    @JvmStatic fun flutterType(): Class<*> = io.flutter.embedding.android.FlutterView::class.java
    @JvmStatic fun reactNativeType(): Class<*> = com.facebook.react.VideoPrivacyFixtureView::class.java
}

/**
 * Native video refuses Flutter and React Native hosts it recognises by class name. Flutter turns
 * on R8 for release builds by default, and neither the Android Gradle plugin's default rules nor
 * Flutter's keep View class names: this minifies stand-in hosts with the R8 the build's Android
 * Gradle plugin runs for apps and classifies the classes it outputs.
 */
class VideoPrivacyKeepRulesTest {
    private val flutterView = "io.flutter.embedding.android.FlutterView"
    private val reactNativeView = "com.facebook.react.VideoPrivacyFixtureView"

    @Test fun hostsRecognisedByNameKeepTheirNamesThroughAnAppR8Pass() {
        val renamed = minifiedHostTypes(consumerRules = false)
        assertNotEquals("fixture: R8 renames a host nothing keeps", flutterView, renamed.first.name)
        assertNotEquals("fixture: R8 renames a host nothing keeps", reactNativeView, renamed.second.name)
        assertFalse("a renamed Flutter host passes as an ordinary FrameLayout", VideoPrivacyTypeCache().classify(renamed.first)!!.flutterHost)

        val kept = minifiedHostTypes(consumerRules = true)
        assertEquals(flutterView, kept.first.name)
        assertTrue("Flutter host in a minified app", VideoPrivacyTypeCache().classify(kept.first)!!.flutterHost)
        assertEquals(reactNativeView, kept.second.name)
        assertTrue("React Native view in a minified app", VideoPrivacyTypeCache().classify(kept.second)!!.reactNative)
    }

    /** The Flutter and React Native host classes in R8's output, with or without this module's consumer rules. */
    private fun minifiedHostTypes(consumerRules: Boolean): Pair<Class<*>, Class<*>> {
        val r8 = requireNotNull(System.getProperty("everframeR8Classpath")) { "Run through Gradle, which supplies its R8" }
        val androidJar = requireNotNull(System.getProperty("everframeAndroidJar")) { "Run through Gradle, which supplies the compile SDK" }
        val work = java.nio.file.Files.createTempDirectory("everframe-keep-rules").toFile()
        try {
            val program = File(work, "program.jar")
            JarOutputStream(program.outputStream()).use { jar ->
                for (type in listOf(VideoPrivacyHostApp::class.java, io.flutter.embedding.android.FlutterView::class.java,
                    com.facebook.react.VideoPrivacyFixtureView::class.java)) {
                    val path = type.name.replace('.', '/') + ".class"
                    jar.putNextEntry(JarEntry(path))
                    jar.write(requireNotNull(type.classLoader.getResourceAsStream(path)) { path }.use { it.readBytes() })
                    jar.closeEntry()
                }
            }
            // The app's own entry point and annotations its compilers add, plus what Flutter's
            // release build type adds (flutter_tools gradle/flutter_proguard_rules.pro).
            val appRules = File(work, "app.pro").apply {
                writeText("""
                    -keep class ${VideoPrivacyHostApp::class.java.name} { public static *; }
                    -dontwarn org.jetbrains.annotations.**
                    -dontwarn androidx.compose.runtime.internal.StabilityInferred
                    -dontwarn io.flutter.plugin.**
                    -dontwarn android.**
                    -if class * implements io.flutter.embedding.engine.plugins.FlutterPlugin
                    -keep,allowshrinking,allowobfuscation class <1>
                """.trimIndent())
            }
            val output = File(work, "out.jar")
            val stdlib = File(Unit::class.java.protectionDomain.codeSource.location.toURI())
            val command = mutableListOf(File(System.getProperty("java.home"), "bin/java").path, "-cp", r8, "com.android.tools.r8.R8",
                "--release", "--classfile", "--output", output.path, "--lib", androidJar, "--lib", stdlib.path, "--pg-conf", appRules.path)
            if (consumerRules) command += listOf("--pg-conf", File("consumer-rules.pro").absolutePath)
            command += program.path
            val process = ProcessBuilder(command).redirectErrorStream(true).start()
            val log = process.inputStream.bufferedReader().use { it.readText() }
            assertEquals("R8 failed:\n$log", 0, process.waitFor())
            // Child first: the stand-ins on the test classpath share the kept names.
            val loader = object : URLClassLoader(arrayOf(output.toURI().toURL()), javaClass.classLoader) {
                override fun loadClass(name: String, resolve: Boolean): Class<*> = findLoadedClass(name)
                    ?: if (findResource(name.replace('.', '/') + ".class") != null) findClass(name) else super.loadClass(name, resolve)
            }
            val app = loader.loadClass(VideoPrivacyHostApp::class.java.name)
            return app.getMethod("flutterType").invoke(null) as Class<*> to app.getMethod("reactNativeType").invoke(null) as Class<*>
        } finally { work.deleteRecursively() }
    }
}
