// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// ReportFab — the HOST-owned floating "report a bug" trigger, pinned to the
// bottom-right corner above the tab bar on every screen. The SDK ships zero
// trigger machinery (feedback_triggers_are_host_concern.md); this is the
// canonical host wiring, now app-global instead of Home-screen-local:
//   - Phone: one Pressable calling useEverframe().open().
//   - TV:    TVEventHandler → Apple TV long-press Play/Pause
//            (`longPlayPause`) or Android TV KEYCODE_MENU (`menu`).
//
// Maestro contract (maestro/reporter-smoke.yaml):
//   - testID "open-reporter-button" is visible on launch and tappable.
//   - after a submitted/queued result, testID "submitted" renders for ~3s.
//
// TVEventHandler API surface as installed (react-native-tvos@0.85.3-0):
//   const sub = TVEventHandler.addListener((evt: HWEvent) => { ... });
//   sub?.remove();   // EventSubscription | undefined
// The older class-based API (`new TVEventHandler()` + enable/disable) was
// deprecated in RN-tvos and is gone in 0.85.x.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, TVEventHandler, View } from 'react-native';
import Svg, { Ellipse, Path } from 'react-native-svg';
import { useEverframe } from '@everframe/react-native';
import { color, font, radius } from '../theme';

// Key-up sentinel: RCTTVRemoteEventKeyActionUp (iOS, NSNumber @(1)) and
// KeyEvent.ACTION_UP (Android, int 1) are both 1. We fire on key-up to
// avoid double-fires for one press (down + up).
const KEY_ACTION_UP = 1;

export function ReportFab(): React.JSX.Element {
  const { open } = useEverframe();
  const [submitted, setSubmitted] = useState(false);
  // open() resolves when the reporter closes; the ref guards re-entry so a
  // double-tap (or remote-key repeat) can't stack two reporters.
  const busy = useRef(false);

  const onOpenReporter = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setSubmitted(false);
    try {
      const result = await open();
      if (result.status === 'submitted' || result.status === 'queued') {
        setSubmitted(true);
        // Auto-clear the label after ~3s — long enough for Maestro to assert.
        setTimeout(() => setSubmitted(false), 3000);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.log('[example] openReporter failed:', err);
    } finally {
      busy.current = false;
    }
  }, [open]);

  // TV-only remote-key trigger. Phone path is unchanged: early-returns when
  // `Platform.isTV` is false.
  useEffect(() => {
    if (!Platform.isTV) return;

    const subscription = TVEventHandler.addListener((evt) => {
      if (Number(evt.eventKeyAction) !== KEY_ACTION_UP) return;

      // Apple TV: native `longPlayPause` fires when the user holds Play/Pause
      // past the OS threshold — the OS debounces for us, and Apple rejects
      // apps that bind `.menu` (reserved for system back navigation).
      if (Platform.OS === 'ios' && evt.eventType === 'longPlayPause') {
        void onOpenReporter();
        return;
      }

      // Android TV: KEYCODE_MENU maps to eventType === 'menu' — the
      // conventional "open settings / debug menu" key on TV remotes.
      if (Platform.OS === 'android' && evt.eventType === 'menu') {
        void onOpenReporter();
        return;
      }
    });

    return () => {
      subscription?.remove();
    };
  }, [onOpenReporter]);

  return (
    <View style={styles.corner} pointerEvents="box-none">
      {submitted && (
        <Text testID="submitted" accessibilityLabel="submitted" style={styles.submittedLabel}>
          Submitted
        </Text>
      )}
      <Pressable
        testID="open-reporter-button"
        accessibilityLabel="Open Reporter"
        accessibilityRole="button"
        // TV: land initial focus here so the remote can press OK immediately.
        hasTVPreferredFocus={Platform.isTV}
        onPress={onOpenReporter}
        style={({ pressed }) => [styles.fab, pressed && styles.fabPressed]}>
        {/* minimal beetle glyph: body, seam, legs, antennae */}
        <Svg viewBox="0 0 24 24" width={18} height={18}>
          <Ellipse cx={12} cy={13.5} rx={5} ry={6.5} stroke={color.sdkText} strokeWidth={1.8} fill="none" />
          <Path
            d="M12 7v13 M7 11H4M7 15H4.5M17 11h3M17 15h2.5 M10 7 8 4M14 7l2-3"
            stroke={color.sdkText}
            strokeWidth={1.8}
            strokeLinecap="round"
            fill="none"
          />
        </Svg>
        <Text style={styles.fabLabel}>Report a bug</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  corner: {
    position: 'absolute',
    right: 16,
    // Clears the tab bar (56pt + inset) on phones; TV has no tab-bar overlap
    // concern at this offset either.
    bottom: 76,
    alignItems: 'flex-end',
    gap: 8,
  },
  fab: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: color.sdkBg,
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderRadius: radius.pill,
    // RN shadow (iOS) + elevation (Android)
    shadowColor: '#0E3038',
    shadowOpacity: 0.3,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  fabPressed: {
    backgroundColor: color.sdkBgPressed,
  },
  fabLabel: {
    color: color.sdkText,
    fontSize: 14,
    fontWeight: '600',
  },
  submittedLabel: {
    color: color.mossDeep,
    backgroundColor: color.mossWash,
    borderRadius: radius.control,
    overflow: 'hidden',
    paddingVertical: 4,
    paddingHorizontal: 10,
    fontSize: 13,
    fontWeight: '600',
    fontFamily: font.mono,
  },
});
