// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package com.traceitx.config

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerializationException
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.buildClassSerialDescriptor
import kotlinx.serialization.descriptors.element
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.encoding.encodeStructure
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull

@Serializable(with = NativeVideoSettingsSerializer::class)
data class NativeVideoSettings(val framesPerSecond: Int)

object NativeVideoSettingsSerializer : KSerializer<NativeVideoSettings> {
    override val descriptor = buildClassSerialDescriptor("NativeVideoSettings") {
        element("framesPerSecond", kotlinx.serialization.descriptors.PrimitiveSerialDescriptor(
            "framesPerSecond",
            kotlinx.serialization.descriptors.PrimitiveKind.INT,
        ))
    }

    override fun deserialize(decoder: Decoder): NativeVideoSettings {
        val objectValue = (decoder as? JsonDecoder)?.decodeJsonElement() as? JsonObject
            ?: throw SerializationException("nativeVideo must be an object")
        if (objectValue.keys != setOf("framesPerSecond")) {
            throw SerializationException("nativeVideo must contain only framesPerSecond")
        }
        val primitive = objectValue["framesPerSecond"] as? JsonPrimitive
            ?: throw SerializationException("framesPerSecond must be an integer")
        val framesPerSecond = primitive.takeIf { !it.isString }?.intOrNull
            ?: throw SerializationException("framesPerSecond must be an integer")
        return NativeVideoSettings(framesPerSecond)
    }

    override fun serialize(encoder: Encoder, value: NativeVideoSettings) {
        encoder.encodeStructure(descriptor) {
            encodeIntElement(descriptor, 0, value.framesPerSecond)
        }
    }
}

fun effectiveNativeVideo(
    config: ReplayConfig,
    refreshSucceeded: Boolean,
    locallyDisabled: Boolean = false,
    sdkInt: Int = android.os.Build.VERSION.SDK_INT,
): NativeVideoSettings? {
    if (sdkInt < 29 || !refreshSucceeded || locallyDisabled || !config.replayEnabled) return null
    return config.nativeVideo?.takeIf { it.framesPerSecond == 5 || it.framesPerSecond == 10 }
}
