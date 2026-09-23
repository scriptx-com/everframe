// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// AnnotationWireFormat — serializes the pure [Annotation] model (this
// module) into the web-wire-compatible JSON shapes consumed by the ingest
// service (`payload.annotations[]` / `payload.redactions[]`). Mirrors web
// `ReporterDialog.tsx:267-279` (annotation -> wire dict spread + `partName`)
// and iOS `AnnotationWireFormat.swift` (Task 10).
//
// Pure Kotlin + kotlinx.serialization only — no android.* import — so this
// stays plain-JVM testable like AnnotationModel.kt.
package dev.everframe.ui.annotation

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject

object AnnotationWireFormat {

    /** [annotations] land in `payload.annotations[]`; [redactions] (blur mirrors) in `payload.redactions[]`. */
    data class Wire(val annotations: List<JsonObject>, val redactions: List<JsonObject>)

    /**
     * Serializes [annotations] (all belonging to ONE shot/screenshot part
     * named [partName]) into the wire's `annotations[]` entries plus the
     * `redactions[]` mirror for blur shapes.
     *
     * Field shapes per kind (web `ReporterDialog.tsx:267-279`):
     *   pen/highlighter: `{id, kind, points, color, thickness, partName}`
     *   rect/ellipse:    `{id, kind, x, y, width, height, color, thickness, partName}`
     *   arrow:           `{id, kind, from: [x,y], to: [x,y], color, thickness, partName}`
     *   text:            `{id, kind, x, y, text, color, fontSize, partName}`
     *   blur:            `{id, kind, x, y, width, height, partName}` (NO
     *                     color/thickness — blur carries neither on the
     *                     wire) — ALSO mirrored into `redactions[]` as
     *                     `{x, y, width, height, type: "blur", partName}`
     *                     (no id).
     *
     * Colors serialize as `#RRGGBB` (alpha channel dropped — annotation
     * colors are always opaque on the wire, matching web). `kind` is always
     * lowercase (`AnnotationKind.name.lowercase()`). Numbers are Double.
     */
    fun serialize(annotations: List<Annotation>, partName: String): Wire {
        val annotationObjects = mutableListOf<JsonObject>()
        val redactionObjects = mutableListOf<JsonObject>()

        for (a in annotations) {
            annotationObjects.add(
                buildJsonObject {
                    put("id", JsonPrimitive(a.id))
                    put("kind", JsonPrimitive(a.kind.name.lowercase()))
                    when (a.kind) {
                        AnnotationKind.PEN, AnnotationKind.HIGHLIGHTER -> {
                            put("points", points(a.points))
                            put("color", JsonPrimitive(hexColor(a.color)))
                            put("thickness", JsonPrimitive(a.thickness.toDouble()))
                        }
                        AnnotationKind.RECT, AnnotationKind.ELLIPSE -> {
                            put("x", JsonPrimitive(a.x.toDouble()))
                            put("y", JsonPrimitive(a.y.toDouble()))
                            put("width", JsonPrimitive(a.width.toDouble()))
                            put("height", JsonPrimitive(a.height.toDouble()))
                            put("color", JsonPrimitive(hexColor(a.color)))
                            put("thickness", JsonPrimitive(a.thickness.toDouble()))
                        }
                        AnnotationKind.ARROW -> {
                            put("from", buildJsonArray {
                                add(JsonPrimitive(a.fromX.toDouble()))
                                add(JsonPrimitive(a.fromY.toDouble()))
                            })
                            put("to", buildJsonArray {
                                add(JsonPrimitive(a.toX.toDouble()))
                                add(JsonPrimitive(a.toY.toDouble()))
                            })
                            put("color", JsonPrimitive(hexColor(a.color)))
                            put("thickness", JsonPrimitive(a.thickness.toDouble()))
                        }
                        AnnotationKind.TEXT -> {
                            put("x", JsonPrimitive(a.x.toDouble()))
                            put("y", JsonPrimitive(a.y.toDouble()))
                            put("text", JsonPrimitive(a.text))
                            put("color", JsonPrimitive(hexColor(a.color)))
                            put("fontSize", JsonPrimitive(a.fontSize.toDouble()))
                        }
                        AnnotationKind.BLUR -> {
                            put("x", JsonPrimitive(a.x.toDouble()))
                            put("y", JsonPrimitive(a.y.toDouble()))
                            put("width", JsonPrimitive(a.width.toDouble()))
                            put("height", JsonPrimitive(a.height.toDouble()))
                        }
                    }
                    put("partName", JsonPrimitive(partName))
                }
            )

            if (a.kind == AnnotationKind.BLUR) {
                redactionObjects.add(
                    buildJsonObject {
                        put("x", JsonPrimitive(a.x.toDouble()))
                        put("y", JsonPrimitive(a.y.toDouble()))
                        put("width", JsonPrimitive(a.width.toDouble()))
                        put("height", JsonPrimitive(a.height.toDouble()))
                        put("type", JsonPrimitive("blur"))
                        put("partName", JsonPrimitive(partName))
                    }
                )
            }
        }

        return Wire(annotationObjects, redactionObjects)
    }

    private fun points(points: List<Float>): JsonArray = buildJsonArray {
        points.forEach { add(JsonPrimitive(it.toDouble())) }
    }

    /**
     * `color and 0xFFFFFFL` drops the alpha byte (annotation colors are the
     * palette's `0xFFrrggbb` literals — always fully opaque); `%06X`
     * zero-pads so e.g. `0x0000FF` prints `#0000FF`, not `#FF`.
     */
    private fun hexColor(color: Long): String = "#%06X".format(color and 0xFFFFFFL)
}

/**
 * Empty lists coerce to `null` at the envelope boundary — reports with no
 * annotations/redactions ship `payload.annotations: null` / `payload.
 * redactions: null` (the pre-annotations wire shape), matching
 * `EnvelopeBuilder.buildEncoded`'s empty-coerces-null convention.
 */
fun List<JsonObject>.toJsonArrayOrNull(): JsonArray? = if (isEmpty()) null else JsonArray(this)
