// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// DiscardConfirmDialog — Phase 13 D10 (bento-duo-blue) Compose port.
// Replaces the previous Material 3 AlertDialog with a brand-styled card:
//
//   ┌───────────────────────────────────────┐
//   │  Discard this report?                 │
//   │  Your annotations, redactions, …      │
//   ├──────────────────┬────────────────────┤
//   │  Keep editing    │  Discard           │  ← hot accent
//   └──────────────────┴────────────────────┘
//
// Layout mirrors `branding-explorations/bento-duo-blue/console-next/
// reporter/web-reporter.phone.html` `.dialog` block:
//   • Bg2 card on default Dialog scrim
//   • 18dp radius + Hair hairline border
//   • Title 16sp SemiBold (Ink), body 13.5sp / 20sp leading (Ink3)
//   • Two equal-weight buttons separated by a 1dp Hair divider, Discard in Hot
//
// Backdrop blur is out of scope (Compose Dialog does not expose
// RenderEffect on the underlying window; the default scrim is accepted).
//
// Body copy is the locked D10 string and MUST match every other platform.
package com.traceitx.ui.details

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.traceitx.ui.theme.LocalReporterTheme

/**
 * Brand-styled discard-confirmation dialog (Phase 13 D10).
 *
 * @param onKeepEditing invoked when the user taps **Keep editing** or
 *   dismisses the dialog via the system Back gesture / outside tap.
 * @param onDiscard invoked when the user taps **Discard**. Callers are
 *   responsible for actually closing the reporter (this composable only
 *   reports intent).
 */
@Composable
internal fun DiscardConfirmDialog(
    onKeepEditing: () -> Unit,
    onDiscard: () -> Unit,
) {
    val theme = LocalReporterTheme.current
    Dialog(
        onDismissRequest = onKeepEditing,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 18.dp),
            contentAlignment = Alignment.Center,
        ) {
            Column(
                modifier = Modifier
                    .widthIn(max = 320.dp)
                    .clip(RoundedCornerShape(18.dp))
                    .background(theme.bg2)
                    .border(1.dp, theme.hair, RoundedCornerShape(18.dp)),
            ) {
                Text(
                    "Discard this report?",
                    color = theme.ink,
                    fontSize = 16.sp,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.padding(
                        start = 18.dp,
                        end = 18.dp,
                        top = 18.dp,
                        bottom = 6.dp,
                    ),
                )
                Text(
                    "Your annotations, redactions, title, and description will be lost. " +
                        "The captured screenshot stays on the host device.",
                    color = theme.ink3,
                    fontSize = 13.5.sp,
                    lineHeight = 20.sp,
                    modifier = Modifier.padding(start = 18.dp, end = 18.dp, bottom = 18.dp),
                )
                HorizontalDivider(color = theme.hair)
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(IntrinsicSize.Min),
                ) {
                    Box(
                        modifier = Modifier
                            .weight(1f)
                            .clickable(onClick = onKeepEditing)
                            .padding(vertical = 14.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            "Keep editing",
                            color = theme.ink2,
                            fontSize = 14.5.sp,
                        )
                    }
                    Box(
                        Modifier
                            .fillMaxHeight()
                            .width(1.dp)
                            .background(theme.hair),
                    )
                    Box(
                        modifier = Modifier
                            .weight(1f)
                            .clickable(onClick = onDiscard)
                            .padding(vertical = 14.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            "Discard",
                            color = theme.hot,
                            fontSize = 14.5.sp,
                            fontWeight = FontWeight.SemiBold,
                        )
                    }
                }
            }
        }
    }
}
