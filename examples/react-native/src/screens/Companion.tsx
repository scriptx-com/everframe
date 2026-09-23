// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Plan 06.2-11 — sample-app Companion screen (Elytra restyle; logic and
// testIDs unchanged).
//
// Demonstrates the host-rendering contract for the phone-companion reporter
// on both phone (iOS / Android) and TV (Apple TV / Android TV) form factors.
// Mirrors the iOS-native `CompanionQRView.swift` (SampleAppTV) and the
// Android-native `CompanionQRActivity.kt` (android-views sample).
//
// State-driven rendering:
//   • `unpaired` + pairUrl set    → QR (react-native-qrcode-svg).
//   • `unpaired` + pairUrl null   → "Connecting to relay…".
//   • `paired`                    → "Phone connected — file from your phone".
//   • `report_in_progress`        → "Report in progress on phone".
//   • `phone_disconnected`        → "Phone reconnecting…".
//
// Lifecycle — the session belongs to the USER, not to this screen:
//   • On mount: `companion.start()` unconditionally (opening the WS against
//     the build-time-baked ingest URL — sdk-ios/sdk-android IngestEndpoint).
//     Since the Elytra restyle this screen lives behind a tab, so the relay
//     connects when the tab is first opened, not at app launch — this screen
//     advertises on its first visit exactly like it always did. The toggle
//     button below is the explicit stop/restart control; `useCompanion()
//     .running` drives what's rendered, not whether `start()` runs on mount.
//     `attachPinUi` is left unset here, so it defaults to `'builtin'` — a
//     dashboard attach shows a 4-digit code via the native iOS/Android PIN
//     presenter, no screen in this sample needs to render it.
//   • On unmount: nothing. Tearing the session down here used to mean the
//     device dropped out of the dashboard's Companion list the instant you
//     switched tabs — which is precisely what you do to go and attach to it —
//     and it did so silently. Ending the session is now an explicit button.
//   • `start()` is idempotent (facade docstring), so re-entering the tab with
//     a live session re-calls it harmlessly rather than opening a second
//     socket.
//
// TV sizing: `Platform.isTV` picks a 400-pt QR for the 10-foot view (matching
// the iOS sample). Phone view uses a 240-pt QR. No `react-native-safe-area
// -context` — the App.tsx header explains why it's excluded under react-
// native-tvos@0.85.3-0.

import React, { useCallback, useEffect } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { companion, useCompanion, useEverframeScreen } from '@everframe/react-native';
import { color, radius, type } from '../theme';

export function Companion(): React.JSX.Element {
  useEverframeScreen('Companion');
  const { state, pairUrl, resolvedName, code, running } = useCompanion();

  useEffect(() => {
    // The session belongs to the USER, not this screen: starting
    // unconditionally here — and never stopping on unmount — is deliberate.
    // This screen advertises on first visit; leaving the tab is exactly what
    // you do to go and attach from the dashboard, and `start()` is
    // idempotent, so re-entering with a live session re-calls it harmlessly.
    companion.start();
  }, []);

  const toggleSession = useCallback(() => {
    if (running) companion.stop();
    else companion.start();
  }, [running]);

  const qrSize = Platform.isTV ? 400 : 240;

  return (
    <View style={styles.root}>
      <Text style={type.eyebrow}>Fixture · phone-companion relay pairing</Text>
      <Text style={[type.display, styles.title]}>Companion</Text>
      <Text style={[type.muted, styles.lede]}>
        Scan the code to pair a phone and file this screen&apos;s report from it — the relay
        streams context from this device to the phone reporter.
      </Text>

      <View style={styles.card}>
        {/* Driven by `running`, NOT by `state`: `stop()` retains the last
            observable state and pairUrl, so a state-keyed card would keep
            showing a QR for a pair that no longer exists — worse than
            showing nothing, because it still looks scannable. */}
        {!running && (
          <View style={styles.center}>
            <Text
              style={[type.body, styles.caption]}
              testID="companion-status"
              accessibilityLabel="companion-status">
              Companion is off
            </Text>
            <Text style={[type.muted, styles.caption]}>
              This device is not advertising to the dashboard.
            </Text>
          </View>
        )}

        {running && state === 'unpaired' && pairUrl !== null && (
          <View style={styles.center}>
            <View style={styles.qrFrame}>
              <QRCode value={pairUrl} size={qrSize} />
            </View>
            {/* Server-resolved display name (spec 2026-08-24) lets a
                dashboard user match this screen to the right row in the
                Companion list; fall back to the short code when no name
                has resolved yet. */}
            {(resolvedName ?? code) !== null && (
              <Text
                style={styles.captionEmphasis}
                testID="companion-name"
                accessibilityLabel="companion-name">
                {resolvedName ?? `Code: ${code}`}
              </Text>
            )}
            <Text style={[type.body, styles.caption]} accessibilityLabel="companion-caption">
              Scan to file a bug report
            </Text>
            <Text style={[type.monoNote, styles.url]} numberOfLines={1} ellipsizeMode="middle">
              {pairUrl}
            </Text>
          </View>
        )}

        {running && state === 'unpaired' && pairUrl === null && (
          <View style={styles.center}>
            <Text
              style={[type.muted, styles.caption]}
              testID="companion-status"
              accessibilityLabel="companion-status">
              Connecting to relay…
            </Text>
          </View>
        )}

        {running && state === 'paired' && (
          <View style={styles.center}>
            <Text
              style={styles.captionEmphasis}
              testID="companion-status"
              accessibilityLabel="companion-status">
              Phone connected — file from your phone
            </Text>
          </View>
        )}

        {running && state === 'report_in_progress' && (
          <View style={styles.center}>
            <Text
              style={styles.captionEmphasis}
              testID="companion-status"
              accessibilityLabel="companion-status">
              Report in progress on phone
            </Text>
          </View>
        )}

        {running && state === 'phone_disconnected' && (
          <View style={styles.center}>
            <Text
              style={styles.captionWarning}
              testID="companion-status"
              accessibilityLabel="companion-status">
              Phone reconnecting…
            </Text>
          </View>
        )}

        {/* `state` is stale once stopped (it is retained, not cleared), so
            say "off" rather than echo the last value the socket saw. */}
        <Text style={[type.monoNote, styles.stateLine]}>
          State: {running ? state : 'off'}
        </Text>
      </View>

      <Pressable
        testID="companion-session-toggle"
        accessibilityLabel={running ? 'End companion session' : 'Start companion session'}
        accessibilityRole="button"
        onPress={toggleSession}
        style={({ pressed, focused }) => [
          styles.sessionButton,
          // `focused` is not decoration: without it this control gives no
          // feedback under a TV remote, which is half this screen's audience.
          (pressed || focused) && styles.sessionButtonPressed,
        ]}>
        <Text style={styles.sessionButtonText}>
          {running ? 'End session' : 'Start companion'}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    paddingVertical: 8,
  },
  title: {
    marginTop: 8,
  },
  lede: {
    marginTop: 8,
    marginBottom: 14,
  },
  card: {
    backgroundColor: color.paperRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
    borderRadius: radius.card,
    padding: 16,
  },
  center: {
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
  },
  qrFrame: {
    backgroundColor: '#FFFFFF',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
    borderRadius: radius.control,
    padding: 12,
  },
  caption: {
    textAlign: 'center',
  },
  captionEmphasis: {
    fontSize: 16,
    color: color.mossDeep,
    fontWeight: '600',
    textAlign: 'center',
  },
  captionWarning: {
    fontSize: 16,
    color: color.tag,
    fontWeight: '600',
    textAlign: 'center',
  },
  url: {
    maxWidth: 320,
  },
  stateLine: {
    marginTop: 10,
  },
  // Mirrors Home.tsx's `hookButton` — same moss fill, same pressed/focused
  // treatment, so the two host-owned controls in this app read as one family.
  sessionButton: {
    backgroundColor: color.moss,
    marginTop: 14,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: radius.control,
    alignItems: 'center',
  },
  sessionButtonPressed: {
    backgroundColor: color.mossDeep,
  },
  sessionButtonText: {
    color: '#FBFCF8',
    fontSize: 15,
    fontWeight: '600',
  },
});
