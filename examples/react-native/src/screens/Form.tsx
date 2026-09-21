// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Form ("Profile") — the redaction + metadata tab. Keeps the original
// fixture surface intact and extends it Elytra-style:
//   - `public-field` / `secret-field` testIDs preserved (Plan 06-05
//     <TraceItXSensitive> comparison — one TextInput wrapped, one not).
//   - Seeded PII text (test card + bearer token, same canonical strings as
//     the web example) for the native redaction engine to scrub.
//   - setExtra() wired to a real control — the RN SDK surface beyond open().
//   - setUser() wired to a sign-in/switch/sign-out control (spec 2026-08-12).
//
// WHY THIS SAMPLE USES setUser AND THE WEB ONE USES setIdentityToken.
// TraceItX has two recognition tiers and the two dogfood apps deliberately
// demonstrate one each:
//
//   examples/react-web  → VERIFIED. Its `identity` prop on TraceItXProvider fetches a
//     short-lived JWT from its own backend, which the server verifies against
//     the project's signing secret. Proven, and the only tier allowed to
//     unlock a person's conversations on another device.
//
//   this app           → SELF-DECLARED. `setUser` is a plain assertion with
//     nothing backing it. It labels and groups reports in the dashboard and
//     does nothing else. Anyone able to run this app's code — or holding its
//     publishable SDK key, which ships in the bundle — could claim any
//     identifier they like, so the dashboard badges these people "Unverified".
//
// That split is the point: a React Native app with no backend of its own can
// still put a name on its reports, without pretending it proved anything.

import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { TraceItXSensitive, useTraceItX, useTXScreen } from '@traceitx/react-native';
import { color, font, radius, type } from '../theme';

// Two collectors so the sample can demonstrate an account SWITCH, not just a
// sign-in. Switching is the case worth showing: the SDK keeps attributing to
// whoever it was last told about, so an app that changes user without saying
// so files Grace's bug reports under Ada.
const COLLECTORS = [
  { id: 'collector-8891', email: 'ada@elytra.example', displayName: 'Ada Lovelace' },
  { id: 'collector-2277', email: 'grace@elytra.example', displayName: 'Grace Hopper' },
] as const;

export function Form(): React.JSX.Element {
  useTXScreen('Profile');
  const { setExtra, setUser } = useTraceItX();
  const [extra, setExtraDraft] = useState('{"plan":"field-team","build":"demo"}');
  const [applied, setApplied] = useState(false);
  const [recognizedAs, setRecognizedAs] = useState<string | null>(null);

  const applyExtra = () => {
    setExtra(extra);
    setApplied(true);
  };

  // Called from a button, so it necessarily runs after <TraceItXProvider> has
  // mounted and started the SDK. That ordering is required, not incidental:
  // a `setUser` issued before start is DROPPED on every platform, silently,
  // leaving every report anonymous for the session. Wire it to your own
  // sign-in completing — never to module scope or app construction.
  const signInAs = (collector: (typeof COLLECTORS)[number]) => {
    setUser({
      id: collector.id,
      email: collector.email,
      displayName: collector.displayName,
    });
    setRecognizedAs(collector.displayName);
  };

  // Sign-out. On React Native the clear is `setUser()` with NO argument —
  // the TurboModule bridge forbids a nullable object parameter, so omission is
  // how "no user" is expressed. (`setUser(null)` is the equivalent on web,
  // iOS and Android.)
  const signOut = () => {
    setUser();
    setRecognizedAs(null);
  };

  return (
    <View style={styles.root}>
      <Text style={type.eyebrow}>Fixtures · seeded PII</Text>
      <Text style={[type.display, styles.title]}>Collector profile</Text>
      <Text style={[type.muted, styles.lede]}>
        A pretend membership card. The reporter captures this screen; the redaction engine must
        scrub these values before the envelope leaves the device.
      </Text>

      <View style={styles.card}>
        <View style={styles.factRow}>
          <Text style={styles.factLabel}>CARD ON FILE</Text>
          <Text style={styles.piiValue} testID="cc-number">
            Test card: 4111-1111-1111-1111
          </Text>
        </View>
        <View style={styles.factRow}>
          <Text style={styles.factLabel}>SESSION TOKEN</Text>
          <Text style={styles.piiValue} testID="bearer-token">
            Auth: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.fake-signature
          </Text>
        </View>
      </View>

      <View style={styles.card}>
        <Text style={type.sectionTitle}>Redaction demo</Text>
        <Text style={[type.muted, styles.cardBody]}>
          The first field is captured normally; the second is wrapped in TraceItXSensitive and
          must be masked in the captured screenshot. Compare both in the produced envelope.
        </Text>

        <Text style={styles.inputLabel}>Public field (not redacted)</Text>
        <TextInput
          testID="public-field"
          accessibilityLabel="public-field"
          style={styles.input}
          placeholder="visible in captures"
          placeholderTextColor={color.inkFaint}
        />

        <Text style={styles.inputLabel}>Secret field (wrapped in TraceItXSensitive)</Text>
        <TraceItXSensitive>
          <TextInput
            testID="secret-field"
            accessibilityLabel="secret-field"
            style={styles.input}
            placeholder="redacted in captures"
            placeholderTextColor={color.inkFaint}
            secureTextEntry
          />
        </TraceItXSensitive>
      </View>

      <View style={styles.card}>
        <Text style={type.sectionTitle}>Recognition — setUser()</Text>
        <Text style={[type.muted, styles.cardBody]}>
          Puts a name on the next report. Self-declared: this app asserts it and nothing proves
          it, so the dashboard shows these people as “Unverified”. Grouping and labelling only —
          it never unlocks a conversation on another device.
        </Text>

        <View style={styles.personRow}>
          {COLLECTORS.map((collector) => {
            const active = recognizedAs === collector.displayName;
            return (
              <Pressable
                key={collector.id}
                testID={`sign-in-${collector.id}`}
                accessibilityRole="button"
                accessibilityLabel={`Sign in as ${collector.displayName}`}
                onPress={() => signInAs(collector)}
                style={({ pressed, focused }) => [
                  styles.personButton,
                  active && styles.personButtonActive,
                  (pressed || focused) && styles.applyButtonPressed,
                ]}>
                <Text style={[styles.personName, active && styles.personNameActive]}>
                  {collector.displayName}
                </Text>
                <Text style={styles.personEmail}>{collector.email}</Text>
              </Pressable>
            );
          })}
        </View>

        <Pressable
          testID="sign-out"
          accessibilityRole="button"
          accessibilityLabel="Sign out"
          onPress={signOut}
          disabled={recognizedAs === null}
          style={({ pressed, focused }) => [
            styles.applyButton,
            recognizedAs === null && styles.applyButtonDisabled,
            (pressed || focused) && recognizedAs !== null && styles.applyButtonPressed,
          ]}>
          <Text style={styles.applyButtonText}>Sign out — setUser()</Text>
        </Pressable>

        <Text testID="recognition-status" style={styles.recognitionStatus}>
          {recognizedAs === null
            ? 'Anonymous — the next report carries no person.'
            : `Recognized as ${recognizedAs} — the next report is grouped under them.`}
        </Text>
      </View>

      <View style={styles.card}>
        <Text style={type.sectionTitle}>Report metadata — setExtra()</Text>
        <Text style={[type.muted, styles.cardBody]}>
          One opaque string, attached to the next report. JSON is a convention, not a requirement;
          2000-char ceiling applied native-side.
        </Text>
        <TextInput
          testID="extra-input"
          accessibilityLabel="Extra payload"
          style={[styles.input, styles.inputMono]}
          value={extra}
          onChangeText={(v) => {
            setExtraDraft(v);
            setApplied(false);
          }}
          multiline
        />
        <Pressable
          testID="apply-extra"
          accessibilityRole="button"
          accessibilityLabel="Apply setExtra"
          onPress={applyExtra}
          style={({ pressed, focused }) => [
            styles.applyButton,
            (pressed || focused) && styles.applyButtonPressed,
          ]}>
          <Text style={styles.applyButtonText}>
            {applied ? 'Applied — rides with the next report' : 'Apply setExtra'}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    paddingVertical: 8,
    gap: 14,
  },
  title: {
    marginTop: 8,
  },
  lede: {
    marginTop: 8,
  },
  card: {
    backgroundColor: color.paperRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
    borderRadius: radius.card,
    padding: 16,
    gap: 8,
  },
  cardBody: {
    marginBottom: 4,
  },
  factRow: {
    flexDirection: 'row',
    gap: 12,
    paddingVertical: 6,
    alignItems: 'flex-start',
  },
  factLabel: {
    fontFamily: font.mono,
    fontSize: 10,
    letterSpacing: 1,
    color: color.inkFaint,
    width: 100,
    paddingTop: 3,
  },
  piiValue: {
    flex: 1,
    fontFamily: font.mono,
    fontSize: 12,
    lineHeight: 17,
    color: color.ink,
  },
  inputLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: color.ink,
    marginTop: 6,
  },
  input: {
    borderWidth: 1,
    borderColor: color.lineStrong,
    borderRadius: radius.control,
    paddingHorizontal: 12,
    paddingVertical: 9,
    backgroundColor: color.paper,
    color: color.ink,
    fontSize: 14,
  },
  inputMono: {
    fontFamily: font.mono,
    fontSize: 12,
    minHeight: 60,
    textAlignVertical: 'top',
  },
  applyButton: {
    backgroundColor: color.moss,
    borderRadius: radius.control,
    paddingVertical: 11,
    alignItems: 'center',
    marginTop: 4,
  },
  applyButtonPressed: {
    backgroundColor: color.mossDeep,
  },
  applyButtonText: {
    color: '#FBFCF8',
    fontSize: 14,
    fontWeight: '600',
  },
  applyButtonDisabled: {
    backgroundColor: color.line,
  },
  personRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 4,
  },
  personButton: {
    flex: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
    borderRadius: radius.control,
    paddingVertical: 9,
    paddingHorizontal: 10,
    gap: 2,
  },
  personButtonActive: {
    borderColor: color.moss,
    backgroundColor: color.paper,
  },
  personName: {
    fontSize: 13,
    fontWeight: '600',
    color: color.ink,
  },
  personNameActive: {
    color: color.mossDeep,
  },
  personEmail: {
    fontFamily: font.mono,
    fontSize: 10,
    color: color.inkFaint,
  },
  recognitionStatus: {
    fontFamily: font.mono,
    fontSize: 10,
    color: color.inkFaint,
    marginTop: 8,
  },
});
