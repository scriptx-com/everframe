// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Sample-app root for the @traceitx/react-native dogfood —
// "Elytra", a small insect field guide (the RN sibling of
// examples/react-web). Multi-tab so the reporter has something real to
// capture: tabs to switch, a long list to scroll, SVG plates to screenshot,
// and seeded PII to redact.
//
// What this file demonstrates:
//   1. <TraceItXProvider> wraps the subtree, supplying configure-on-mount.
//   2. The host renders its own triggers — the floating <ReportFab/> in the
//      corner of every tab (testID "open-reporter-button", the Maestro
//      anchor) plus the TV remote listener inside it. NO trigger machinery
//      in the SDK (feedback_triggers_are_host_concern.md).
//   3. A pure-JS <TabBar/> switcher — deliberately not @react-navigation;
//      react-native-safe-area-context@5.5.x's native module is incompatible
//      with the Yoga shape in react-native-tvos@0.85.3-0 (StyleValuePool
//      assertion), so the sample keeps zero extra native surface.
//
// Scope note (2026-05-11): @sentry/react-native and @bugsnag/react-native were
// previously bundled here to prove URLSession/OkHttp interceptor coexistence.
// That concern is real but doesn't belong in this UI-bug-report dogfood —
// the cross-tool coexistence matrix moves to Phase 7 Hardening. The sample
// app stays focused on the integration boundary it owns: provider + reporter
// modal + submit.

import React, { useCallback, useState } from 'react';
import { Platform, ScrollView, StatusBar, StyleSheet, Text, View } from 'react-native';
import { TraceItXProvider } from '@traceitx/react-native';
import { consoleIntegration } from '@traceitx/react-native/integrations/console';

import { ReportFab } from './components/ReportFab';
import { PLAYBACK_SUPPORTED, TabBar, type TabKey } from './components/TabBar';
import { color, font } from './theme';
import { Home } from './screens/Home';
import { Specimens } from './screens/Specimens';
import { FieldLog } from './screens/FieldLog';
import { Form } from './screens/Form';
import { Companion } from './screens/Companion';

// Manual top inset, same approach on both phone platforms.
//   - Android: StatusBar.currentHeight — translucent status bar overlays
//     content, so we offset.
//   - iOS / iPadOS: hardcoded value that covers status bar + Dynamic Island
//     on every shipping iPhone (Dynamic Island devices need ~59pt;
//     notch devices ~47pt; non-notch ~20pt; iPad ~24pt). 60pt is the safe
//     ceiling for the sample app — `react-native-safe-area-context@5.5.x`
//     is excluded because its native module is incompatible with the Yoga
//     shape in react-native-tvos@0.85.3-0 (StyleValuePool assertion).
//   - tvOS / Android TV: Platform.isTV branch → 0, no status bar exists.
const STATUS_BAR_HEIGHT = Platform.isTV
  ? 0
  : Platform.select({
      android: StatusBar.currentHeight ?? 24,
      ios: 60,
      default: 0,
    });

// Source of truth: repo-root `.env`. `scripts/sync-env.mjs` projects
// NEXT_PUBLIC_TRACEITX_KEY into EXPO_PUBLIC_TRACEITX_KEY at bundle time.
// The ingest URL is baked into the native iOS/Android SDKs at compile time
// (Release: https://traceitx.com; Debug: TRACEITX_DEV_INGEST_URL env var).
//
// Only `consoleIntegration()` is wired here — the sample's <TabBar/> is
// pure-JS, deliberately NOT @react-navigation (see header comment), so
// `reactNavigationIntegration` doesn't apply; navigation breadcrumbs already
// come from each screen's `useTXScreen(...)` marker instead.
const TRACEITX_CONFIG = {
  apiKey: process.env.EXPO_PUBLIC_TRACEITX_KEY ?? '',
  appName: 'examplereactnative',
  appVersion: '1.0.0',
  ...(process.env.EXPO_PUBLIC_TRACEITX_JS_BUILD_ID ? {
    jsBundle: {
      buildId: process.env.EXPO_PUBLIC_TRACEITX_JS_BUILD_ID,
      bundleName: Platform.OS === 'android' ? 'index.android.bundle' : 'main.jsbundle',
    },
  } : {}),
  integrations: [consoleIntegration()],
  // Inline reporter theme (reporter branding spec 2026-08-25) — brands the
  // NATIVE report dialogs. Renders only on a paid plan (server says
  // `watermark: false`); a free plan ignores it and keeps the watermark.
  // theme: {
  //   accent: '#336699',
  //   background: '#101314',
  // },
};

/**
 * Render the Session Vitals playback screen — required LAZILY, on purpose.
 *
 * `./screens/Playback` statically imports `react-native-video`, whose module
 * scope calls `NitroModules.createHybridObject('VideoPlayerFactory')`. On
 * tvOS that throws at import time: the library's podspec declares `:ios`
 * only, so CocoaPods installs no pod and no hybrid object is ever
 * registered. A top-level `import` here would put that module in the eager
 * graph on EVERY platform and red-screen the Apple TV sample before anything
 * rendered — a `Platform.isTV` check around the JSX would not have helped,
 * because the import runs first.
 *
 * `require` returns the module cache after the first call, so the component
 * identity is stable across renders. TABS omits the tab entirely where
 * `PLAYBACK_SUPPORTED` is false, so on tvOS this is unreachable.
 */
function renderPlayback(): React.JSX.Element {
  if (!PLAYBACK_SUPPORTED) return <View />;
  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
  const { Playback } = require('./screens/Playback') as typeof import('./screens/Playback');
  return <Playback />;
}

export function App(): React.JSX.Element {
  const [tab, setTab] = useState<TabKey>('desk');

  // Deterministic console output so the consoleIntegration() dogfood has
  // something to capture from the UI: `.log` on every tab switch, `.warn`
  // when entering Profile (the seeded-PII tab). Both should land in a
  // submitted report as `console` breadcrumbs with real severity.
  const selectTab = useCallback((next: TabKey) => {
    if (next === 'profile') {
      console.warn('[elytra] entering Profile — seeded PII on screen');
    } else {
      console.log(`[elytra] tab → ${next}`);
    }
    setTab(next);
  }, []);

  return (
    <TraceItXProvider config={TRACEITX_CONFIG}>
      <StatusBar barStyle="dark-content" />
      <View style={[styles.root, { paddingTop: STATUS_BAR_HEIGHT }]}>
        <View style={styles.masthead}>
          <Text style={styles.wordmark}>ELYTRA</Text>
          <Text style={styles.demoTag}>TraceItX demo</Text>
        </View>

        {/* FieldLog owns its scrolling (SectionList); the other tabs share a
            plain ScrollView. Keyed remount per tab keeps scroll positions
            independent. */}
        {tab === 'log' ? (
          <FieldLog />
        ) : (
          <ScrollView
            key={tab}
            style={styles.scroll}
            contentContainerStyle={styles.scrollContent}>
            {tab === 'desk' && <Home />}
            {tab === 'specimens' && <Specimens />}
            {tab === 'profile' && <Form />}
            {tab === 'companion' && <Companion />}
            {tab === 'playback' && renderPlayback()}
          </ScrollView>
        )}

        <TabBar active={tab} onSelect={selectTab} />
        <ReportFab />
      </View>
    </TraceItXProvider>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: color.paper,
  },
  masthead: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.line,
    backgroundColor: color.paperRaised,
  },
  wordmark: {
    fontFamily: font.display,
    fontSize: 18,
    letterSpacing: 3,
    color: color.ink,
  },
  demoTag: {
    fontFamily: font.mono,
    fontSize: 10,
    color: color.inkFaint,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 16,
    paddingBottom: 120,
  },
});
