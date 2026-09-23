// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Playback — the Session Vitals live-smoke screen (spec 2026-09-06 §5).
//
// The point of this screen is the ONE line that wires vitals:
//
//     useVideoPlayerVitals(player, { name: 'main', libraryVersion: '…' });
//
// The one extra wrinkle is `initializeOnCreation: false` + an explicit
// `player.initialize()` after that line. It is not vitals bookkeeping — it is
// the documented way to make INITIAL STARTUP measurable on Android, where v7
// fires `onLoadStart` synchronously inside the native constructor, before any
// effect (and so before the adapter) has subscribed. See the hook call below.
//
// Everything else is an ordinary react-native-video v7 player. No vitals
// call sites are sprinkled through the playback code — the adapter subscribes
// to the player's own events (onLoadStart / onLoad / onPlaybackStateChange /
// onBuffer / onProgress / onBandwidthUpdate / onPlaybackRateChange / onSeek /
// onEnd / onError / onStatusChange) and translates them into the vitals
// timeline. That is the integration contract this screen exists to prove.
//
// `trackVitals('ad_break', …)` on the Mark button is the one deliberate
// exception: a custom, app-domain event the player cannot know about.
//
// react-native-video is a dependency of THIS EXAMPLE only — never of
// @everframe/react-native, whose adapter is structurally typed and imports
// nothing from the library.

import React, { useEffect } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useVideoPlayer, VideoView } from 'react-native-video';
import { trackVitals, useEverframeScreen } from '@everframe/react-native';
import { useVideoPlayerVitals } from '@everframe/react-native/integrations/react-native-video';
import { color, font, radius, type } from '../theme';

// Apple's public HLS reference stream — multi-bitrate, so ABR actually
// switches renditions under the simulator's bandwidth and `bitrate_change`
// fires for real rather than being asserted from a single fixed rendition.
const SOURCE =
  'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8';

// Kept in sync with examples/react-native/package.json. Reported verbatim as
// the player's `libraryVersion` so a vitals session records which player build
// produced the timeline.
const RNV_VERSION = '7.0.0-beta.11';

// The initialise latch belongs to the PLAYER, not to this component. A `useRef`
// here tracked the component instance, so a REPLACEMENT player object — which
// `useVideoPlayer` hands out under StrictMode's double-mount, or on a source
// change — arrived with the latch already closed and was never initialised, i.e.
// never loaded anything. Keyed on the instance instead: each new player gets
// exactly one `initialize()`, and the same player never gets a second one (which
// would restart playback under the user). `WeakSet`, so a discarded player is
// collectable rather than pinned for the app's lifetime.
const initialised = new WeakSet<object>();

export function Playback(): React.JSX.Element {
  useEverframeScreen('Playback');

  // `initializeOnCreation: false` is what makes STARTUP measurable here (codex round-5, G3).
  // On Android react-native-video v7 emits `onLoadStart` synchronously from inside the native
  // player constructor — before any effect has run, so before the vitals adapter has
  // subscribed — and the adapter arms its startup clock on `onLoadStart`. Deferring the load
  // puts it back under our control: subscribe first, then load.
  const player = useVideoPlayer({ uri: SOURCE, initializeOnCreation: false });

  // ── The whole integration. One line. ──────────────────────────────────
  useVideoPlayerVitals(player, { name: 'main', libraryVersion: RNV_VERSION });

  // …and the load, kicked off AFTER the line above. Effects run in declaration order, so this
  // one is guaranteed to follow the adapter's subscribe. The module-level `initialised`
  // WeakSet makes it once-per-player: this effect can legitimately re-run for the same player
  // object, and a second `initialize()` would restart playback under the user.
  useEffect(() => {
    if (initialised.has(player)) return;
    initialised.add(player);
    void player.initialize().catch(() => { /* surfaced through onError/onStatusChange */ });
  }, [player]);

  return (
    <View style={styles.root}>
      <Text style={type.eyebrow}>Session Vitals</Text>
      <Text style={[type.display, styles.title]}>Playback</Text>
      <Text style={[type.muted, styles.lede]}>
        An ordinary react-native-video v7 player. A single{' '}
        <Text style={styles.code}>useVideoPlayerVitals(player)</Text> call turns its events into a
        vitals timeline — startup, rebuffers, bitrate switches, seeks and rate changes — with no
        other instrumentation anywhere on this screen.
      </Text>

      <View style={styles.stage}>
        <VideoView player={player} style={styles.video} resizeMode="contain" />
      </View>

      <View style={styles.row}>
        <Control testID="playback-play" label="Play" onPress={() => player.play()} />
        <Control testID="playback-pause" label="Pause" onPress={() => player.pause()} />
        <Control testID="playback-seek" label="+30s" onPress={() => player.seekBy(30)} />
        <Control
          testID="playback-mark"
          label="Mark"
          onPress={() => trackVitals('ad_break', { pod: 1 })}
        />
      </View>

      <Text style={[type.monoNote, styles.footnote]}>
        Play · opens the play span{'\n'}
        Pause · closes it{'\n'}
        +30s · emits seek (and the rebuffer that follows){'\n'}
        Mark · trackVitals(&apos;ad_break&apos;) — a custom, app-domain line
      </Text>
    </View>
  );
}

function Control({
  testID,
  label,
  onPress,
}: {
  testID: string;
  label: string;
  onPress: () => void;
}): React.JSX.Element {
  return (
    <Pressable
      testID={testID}
      accessibilityLabel={label}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed, focused }) => [
        styles.btn,
        (pressed || focused) && styles.btnPressed,
      ]}>
      <Text style={styles.btnText}>{label}</Text>
    </Pressable>
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
    marginTop: 10,
  },
  code: {
    fontFamily: font.mono,
    fontSize: 13,
  },
  stage: {
    marginTop: 18,
    borderRadius: radius.card,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.lineStrong,
    backgroundColor: '#000',
  },
  video: {
    width: '100%',
    aspectRatio: 16 / 9,
  },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 16,
  },
  btn: {
    backgroundColor: color.moss,
    paddingVertical: Platform.isTV ? 14 : 12,
    paddingHorizontal: 18,
    borderRadius: radius.control,
    alignItems: 'center',
  },
  btnPressed: {
    backgroundColor: color.mossDeep,
  },
  btnText: {
    color: '#FBFCF8',
    fontSize: Platform.isTV ? 18 : 15,
    fontWeight: '600',
  },
  footnote: {
    marginTop: 18,
    lineHeight: 18,
  },
});
