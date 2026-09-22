// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// TabBar — pure-JS bottom tab switcher. Deliberately NOT @react-navigation:
// react-native-safe-area-context's native module is incompatible with the
// Yoga shape in react-native-tvos@0.85.3-0 (see App.tsx header), and a
// state-based switcher keeps the sample runnable on all four form factors
// with zero extra native surface. Every tab is a Pressable, so TV remote
// focus traversal works out of the box.

import React from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { color, radius } from '../theme';

export type TabKey = 'desk' | 'specimens' | 'log' | 'profile' | 'companion' | 'playback';

/**
 * Is the Playback (Session Vitals) tab available on this platform?
 *
 * react-native-video v7's podspec declares `:ios` only — no `:tvos` — so on
 * an Apple TV build CocoaPods installs no pod, the Nitro hybrid objects are
 * never registered, and the library's module-scope
 * `NitroModules.createHybridObject('VideoPlayerFactory')` throws the instant
 * the module is imported. Android TV is unaffected: the Android half is one
 * Gradle module that builds for leanback like any other.
 *
 * App.tsx also requires the screen lazily off the back of this flag, so on
 * tvOS `react-native-video` is never evaluated at all.
 */
export const PLAYBACK_SUPPORTED = !(Platform.isTV && Platform.OS === 'ios');

export const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'desk', label: 'Desk' },
  { key: 'specimens', label: 'Specimens' },
  { key: 'log', label: 'Log' },
  { key: 'profile', label: 'Profile' },
  { key: 'companion', label: 'Companion' },
  ...(PLAYBACK_SUPPORTED ? [{ key: 'playback' as const, label: 'Playback' }] : []),
];

export function TabBar({
  active,
  onSelect,
}: {
  active: TabKey;
  onSelect: (tab: TabKey) => void;
}): React.JSX.Element {
  return (
    <View style={styles.bar}>
      {TABS.map(({ key, label }) => {
        const isActive = key === active;
        return (
          <Pressable
            key={key}
            testID={`tab-${key}`}
            accessibilityRole="tab"
            accessibilityState={{ selected: isActive }}
            accessibilityLabel={label}
            onPress={() => onSelect(key)}
            style={({ pressed, focused }) => [
              styles.tab,
              isActive && styles.tabActive,
              (pressed || focused) && styles.tabFocused,
            ]}>
            <Text style={[styles.label, isActive && styles.labelActive]}>{label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.lineStrong,
    backgroundColor: color.paperRaised,
    paddingVertical: 8,
    paddingHorizontal: 8,
    // Clear the home indicator on modern iPhones (no safe-area-context — see
    // module header); Android/TV keep the slim padding.
    paddingBottom: Platform.select({ ios: Platform.isTV ? 8 : 24, default: 8 }),
  },
  tab: {
    paddingVertical: 7,
    paddingHorizontal: 8,
    borderRadius: radius.pill,
    flexShrink: 1,
  },
  tabActive: {
    backgroundColor: color.mossWash,
  },
  tabFocused: {
    backgroundColor: color.paperSunken,
  },
  label: {
    // System sans, not the mono face — mono labels overflow a 393dp phone.
    // Six sans labels at 12 (was five at 13, before the Playback tab) still
    // fit across the narrowest shipping iPhone with room for the active pill.
    fontSize: Platform.isTV ? 18 : 12,
    color: color.inkSoft,
  },
  labelActive: {
    color: color.mossDeep,
    fontWeight: '600',
  },
});
