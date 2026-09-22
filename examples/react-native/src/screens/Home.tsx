// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Home ("Desk") — the landing tab. The reporter trigger machinery that used
// to live here (host Pressable + TV remote listener) moved to the app-global
// <ReportFab/> (src/components/ReportFab.tsx), which carries the Maestro
// testIDs `open-reporter-button` and `submitted`. This screen keeps a
// secondary programmatic-open button to demonstrate useTraceItX().open()
// from arbitrary host code.

import React, { useCallback } from 'react';
import { Image, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useTraceItX, useTXScreen } from '@traceitx/react-native';
import { SpecimenPlate } from '../components/SpecimenPlate';
import { ErrorTests } from '../components/ErrorTests';
import { getSpecimen } from '../data/specimens';
import { color, radius, type } from '../theme';

const HERO_SPECIMEN = getSpecimen('txx-008')!; // stag beetle

export function Home(): React.JSX.Element {
  useTXScreen('Desk');
  const { open } = useTraceItX();

  const openViaHook = useCallback(() => {
    void open().catch((err) => {
      // eslint-disable-next-line no-console
      console.log('[example] open() failed:', err);
    });
  }, [open]);

  return (
    <View style={styles.root}>
      <Text style={type.eyebrow}>TraceItX RN Example</Text>
      <Text style={[type.display, styles.title]}>A field catalog built to be broken</Text>
      <Text style={[type.muted, styles.lede]}>
        Elytra is a small insect field guide that exists so the TraceItX reporter has something
        real to capture: tabs to switch, lists to scroll, plates to screenshot, and seeded PII to
        redact. Wander around, then file a bug about a bug — the report button floats in the
        corner of every tab.
      </Text>

      <ErrorTests />

      <View style={styles.heroPlate}>
        <SpecimenPlate specimen={HERO_SPECIMEN} size={Platform.isTV ? 340 : 220} />
      </View>

      {/*
        The one RASTER image in the app, and it is here on purpose. Every other
        picture in Elytra is a generative SVG plate, which the replay walk sees
        as vector nodes — so before this there was nothing exercising Android's
        image capture at all. `<Image>` on Android is a Fresco-backed
        ReactImageView, which is the path replay has to survive.

        Expect it to replay as a PLACEHOLDER under the default `bundled` mode
        even though it ships inside the app: nothing about a Fresco-composed
        bitmap proves it came from the bundle. Set the app's image mode to
        `all` in the dashboard and it captures for real.
      */}
      <View style={styles.card}>
        <Text style={type.sectionTitle}>Field photo</Text>
        <Text style={[type.muted, styles.cardBody]}>
          A bundled raster (`require`), not a plate — the only thing here that goes through
          Android&apos;s Fresco image pipeline.
        </Text>
        <Image
          testID="field-photo"
          accessibilityLabel="Field photo of the collection tray"
          source={require('../../assets/field-photo.png')}
          style={styles.fieldPhoto}
          resizeMode="cover"
        />
      </View>

      <View style={styles.card}>
        <Text style={type.sectionTitle}>Triggers</Text>
        <Text style={[type.muted, styles.cardBody]}>
          {Platform.isTV
            ? Platform.OS === 'ios'
              ? 'Long-press Play/Pause on the Siri Remote to open the reporter — or press OK on the corner button.'
              : 'Press Menu on the remote to open the reporter — or press OK on the corner button.'
            : 'The SDK ships no visible trigger chrome; the floating corner button and the button below are both host-owned calls to useTraceItX().open().'}
        </Text>
        <Pressable
          testID="open-via-hook"
          accessibilityLabel="Open reporter via hook"
          accessibilityRole="button"
          onPress={openViaHook}
          style={({ pressed, focused }) => [
            styles.hookButton,
            (pressed || focused) && styles.hookButtonPressed,
          ]}>
          <Text style={styles.hookButtonText}>Open reporter via useTraceItX().open()</Text>
        </Pressable>
      </View>

      <Text style={[type.monoNote, styles.footnote]}>
        Specimens · plates to capture{'\n'}Log · a long list to scroll{'\n'}Profile · seeded PII to
        redact{'\n'}Companion · pair a phone to file from it
      </Text>
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
    marginTop: 10,
  },
  heroPlate: {
    alignItems: 'center',
    marginVertical: 20,
  },
  fieldPhoto: {
    width: '100%',
    height: 140,
    borderRadius: radius.control,
  },
  card: {
    backgroundColor: color.paperRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
    borderRadius: radius.card,
    padding: 16,
    gap: 10,
  },
  cardBody: {
    marginBottom: 2,
  },
  hookButton: {
    backgroundColor: color.moss,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: radius.control,
    alignItems: 'center',
  },
  hookButtonPressed: {
    backgroundColor: color.mossDeep,
  },
  hookButtonText: {
    color: '#FBFCF8',
    fontSize: 15,
    fontWeight: '600',
  },
  footnote: {
    marginTop: 18,
    lineHeight: 18,
  },
});
