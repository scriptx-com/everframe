// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// "Powered by Everframe" (Android spec 2026-08-26). Rendered whenever the
// server has NOT confirmed paid entitlement (shouldShowWatermark) — fail
// closed to watermarked. Drawn shapes only (the diamond mirrors web's
// .txx-modal-title::before glyph and the sdk-react Watermark SVG): no
// remote asset, no new resource. The tap opens everframe.com in the
// browser; a device with no browser must never crash the dialog.
package dev.everframe.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.everframe.ui.theme.LocalReporterTheme

@Composable
internal fun PoweredByEverframe(modifier: Modifier = Modifier) {
    val theme = LocalReporterTheme.current
    val context = LocalContext.current
    Row(
        modifier = modifier
            .clickable {
                try {
                    context.startActivity(
                        Intent(Intent.ACTION_VIEW, Uri.parse("https://everframe.dev/?ref=powered-by"))
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                    )
                } catch (_: Throwable) {
                    // No browser / restricted profile — swallow (DEFE-02).
                }
            }
            .padding(horizontal = 12.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        androidx.compose.foundation.layout.Box(
            Modifier
                .size(7.dp)
                .rotate(45f)
                .clip(RoundedCornerShape(1.5.dp))
                .background(theme.accent),
        )
        Text(
            "Powered by Everframe",
            fontSize = 11.sp,
            // Codex round-2 residual: without an explicit lineHeight this Text
            // inherited MaterialTheme's default (24sp for the typography slot
            // Text resolves to), inflating the row well past its 11sp glyph
            // size and desyncing it from ReporterRoot's old constant-based
            // footer reserve. The reserve is now MEASURED (ReporterRoot.kt's
            // onSizeChanged on the pinned footer), so this is cosmetic
            // tightening rather than load-bearing sizing — but a tight
            // line-height still keeps the row itself compact.
            lineHeight = 14.sp,
            color = theme.ink3,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}
