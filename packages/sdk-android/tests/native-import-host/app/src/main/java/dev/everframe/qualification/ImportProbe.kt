// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
@file:Suppress("INVISIBLE_REFERENCE", "INVISIBLE_MEMBER")
package dev.everframe.qualification

import android.app.Activity
import android.os.Handler
import android.os.Looper
import android.system.Os
import android.util.Log
import dev.everframe.crash.AndroidNativeRecordImport
import dev.everframe.crash.AndroidNativeRecordReader
import dev.everframe.outbox.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import java.io.File
import java.time.Instant
import java.util.UUID

/** Explicit internal-component qualification. Never enables SDK native collection. */
object ImportProbe {
    private val launch=UUID.randomUUID().toString()
    private var startEpoch=0
    private val allowed=object:OutboxAuthorization { override fun isAllowed()=dev.everframe.Everframe.captureGate && dev.everframe.Everframe.currentStartEpochVolatile()==startEpoch }
    @JvmStatic fun configure(activity:Activity,mode:String?) {
        val original=mode=="arm" || mode=="arm-revoke"
        dev.everframe.Everframe.start(activity,dev.everframe.config.EverframeConfig(
            appId=if(original) "original-qualification-app" else "replacement-qualification-app",
            sdkKey=if(original) "frozen-qualification-key" else "replacement-qualification-key",
            release=if(original) "original-native-build" else "replacement-native-build",
            capture=dev.everframe.config.CaptureConfig(screenshot=false,focus=false,logs=false,network=false,crash=false,networkBodies=false),
            companionBadgeEnabled=false,installIdentifierEnabled=false,shakeToReportEnabled=false,
            vitals=dev.everframe.config.VitalsConfig(enabled=false)),activity)
        startEpoch=dev.everframe.Everframe.currentStartEpochVolatile()
    }
    private fun makeStore(activity:Activity,name:String):OutboxStore = OutboxStore(File(activity.noBackupFilesDir,"native-import/$name"),AndroidOutboxKeyProvider("dev.everframe.import.qualification.$name"),AndroidOutboxFileOps(),8,2*1024*1024)
    private fun importer(a:Activity)=AndroidNativeRecordImport(makeStore(a,"capsules"),makeStore(a,"prepared"))
    @JvmStatic fun run(activity:Activity,mode:String?) {
        try {
            val engine=importer(activity);val nativeRoot=File(activity.noBackupFilesDir,"native-import/records").apply { mkdirs();Os.chmod(path,448) }
            when(mode) {
                "arm", "arm-revoke" -> {
                    val now=System.currentTimeMillis();val id=UUID.randomUUID().toString()
                    val encoded=dev.everframe.envelope.EnvelopeBuilder(vitalsStamp={null}).buildEncoded(
                        reportId=UUID.fromString(id),sdkVersion="qualification",formFactor="phone",
                        appName="frozen-app",appVersion="1",appBuild=dev.everframe.Everframe.currentConfig!!.release,deviceModel="qualification-emulator",
                        deviceOsVersion=android.os.Build.VERSION.RELEASE,deviceScreenWidth=480.0,deviceScreenHeight=800.0)
                    val template=OutboxEntry(id,now,encoded.bytes,encoded.idempotencyKey,emptyList(),dev.everframe.Everframe.currentConfig!!.sdkKey,"https://original.invalid/ingest")
                    val ready=engine.arm(template,launch,allowed) { epoch,key ->
                        val directory=File(nativeRoot,epoch).apply { mkdir();Os.chmod(path,448) }
                        val status=MainActivity.nativeArmFrozen(directory.path,activity.applicationInfo.nativeLibraryDir,key,epoch)
                        Log.i("EVNativeImport","EV_IMPORT armed="+status.contains("handler installed")+" reportId="+id)
                        status.contains("handler installed")
                    }
                    check(ready)
                    if(mode=="arm-revoke") engine.revoke { MainActivity.nativeRevoke().contains("authority disabled") }
                    Handler(Looper.getMainLooper()).postDelayed({Log.i("EVNativeImport","EV_IMPORT fatal process="+android.os.Process.myPid());MainActivity.nativeFault(false)},1000)
                }
                "recover", "retry", "prepare-only", "erase", "erase-owner-only" -> {
                    val outbox=JSONLOutbox(activity)
                    if(mode=="erase") engine.revoke()
                    if(mode=="erase-owner-only") makeStore(activity,"capsules").revokeSync()
                    val imported=if(mode=="erase-owner-only") 0 else engine.recover(launch,System.currentTimeMillis(),allowed,{ epoch -> AndroidNativeRecordReader.readFile(File(File(nativeRoot,epoch),epoch)) }) { entry ->
                        if(mode=="prepare-only") false else { outbox.store.enqueueSync(entry,allowed);true }
                    }
                    val entries=runBlocking { outbox.hydrate() }
                    val result=buildJsonObject {
                        put("processId",android.os.Process.myPid());put("mode",mode);put("imported",imported);put("outboxCount",entries.size)
                        put("capsules",File(activity.noBackupFilesDir,"native-import/capsules/active").listFiles().orEmpty().count { it.extension=="txq" });put("prepared",File(activity.noBackupFilesDir,"native-import/prepared/active").listFiles().orEmpty().count { it.extension=="txq" })
                        put("currentSdkKey",dev.everframe.Everframe.currentConfig!!.sdkKey);put("currentRelease",dev.everframe.Everframe.currentConfig!!.release);put("currentConfiguredRoute",dev.everframe.config.IngestEndpoint.url)
                        put("entries",buildJsonArray { entries.forEach { e -> add(buildJsonObject { put("reportId",e.reportId);put("idempotencyKey",e.idempotencyKey);put("sdkKey",e.sdkKey);put("endpoint",e.endpoint);put("envelope",Json.parseToJsonElement(e.envelopeBytes.toString(Charsets.UTF_8))) }) } })
                    }
                    // Synthetic qualification data only; read back by the owned emulator harness.
                    File(activity.filesDir,"import-result.json").writeText(result.toString())
                    Log.i("EVNativeImport","EV_IMPORT complete mode=$mode imported=$imported count=${entries.size}")
                }
                else -> Log.i("EVNativeImport","EV_IMPORT inactive")
            }
        } catch(error:Throwable) { Log.e("EVNativeImport","EV_IMPORT failure "+error.javaClass.simpleName,error) }
    }
}
