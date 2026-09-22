// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { captureException, useTraceItX } from '@traceitx/react-native';
import { color, radius, type } from '../theme';

// Separate, stable throw sites make the reports easy to identify and map.
function throwHandledTopLevel(): never {
  throw new Error('rn-error-test:handled-top-level');
}

function throwHandledHook(): never {
  throw new Error('rn-error-test:handled-hook');
}

function throwUnhandled(): never {
  throw new Error('rn-error-test:unhandled');
}

export function ErrorTests(): React.JSX.Element {
  const { captureException: captureViaHook } = useTraceItX();
  const [lastAttempt, setLastAttempt] = useState('No error triggered yet.');
  const hasKey = Boolean(process.env.EXPO_PUBLIC_TRACEITX_KEY?.trim());

  function handledTopLevel() {
    try {
      throwHandledTopLevel();
    } catch (error) {
      captureException(error);
      setLastAttempt('Called captureException: rn-error-test:handled-top-level');
    }
  }

  function handledHook() {
    try {
      throwHandledHook();
    } catch (error) {
      captureViaHook(error);
      setLastAttempt('Called hook captureException: rn-error-test:handled-hook');
    }
  }

  function unhandled() {
    setLastAttempt('Scheduled uncaught error: rn-error-test:unhandled');
    // Let React finish the press handler, then exercise ErrorUtils naturally.
    // Do not manually capture this error: that would bypass automatic capture.
    setTimeout(throwUnhandled, 0);
  }

  return (
    <View style={styles.card} testID="error-tests">
      <Text style={type.sectionTitle}>Error tests</Text>
      <Text style={type.muted}>
        Handled errors keep the app open. Find rn-error-test in this app’s Errors in admin.
      </Text>
      <Text style={type.monoNote}>
        {hasKey ? 'SDK key configured; capture and delivery must be checked in admin.' : 'SDK key missing. Configure the RN example key and restart Metro.'}
      </Text>
      <Text testID="error-test-build" style={type.monoNote}>
        {process.env.EXPO_PUBLIC_TRACEITX_JS_BUILD_ID ?? 'Metro development build — no release map identity'}
      </Text>
      {[
        { id: 'trigger-handled-error', label: 'Handled error', onPress: handledTopLevel },
        { id: 'trigger-handled-hook-error', label: 'Handled error via hook', onPress: handledHook },
        { id: 'trigger-unhandled-error', label: 'Unhandled JS error', onPress: unhandled },
      ].map(({ id, label, onPress }) => (
        <Pressable
          key={id}
          testID={id}
          accessibilityRole="button"
          accessibilityState={{ disabled: !hasKey }}
          disabled={!hasKey}
          onPress={onPress}
          style={({ pressed, focused }) => [
            styles.button,
            id === 'trigger-unhandled-error' && styles.unhandled,
            (pressed || focused || !hasKey) && styles.dimmed,
          ]}>
          <Text style={styles.buttonText}>{label}</Text>
        </Pressable>
      ))}
      <Text style={type.muted}>
        The unhandled test may show the development error overlay or close the app.
        Relaunch afterward to check delivery. This triggers a JavaScript error, not a native crash.
      </Text>
      <Text style={type.muted}>
        Repeated handled errors at the same location may be deduplicated. Restart the app
        between runs. A button press does not confirm storage or delivery.
      </Text>
      <Text testID="error-test-status" accessibilityLiveRegion="polite" style={type.monoNote}>
        {lastAttempt}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: 16,
    padding: 16,
    gap: 10,
    backgroundColor: color.paperRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
    borderRadius: radius.card,
  },
  button: {
    backgroundColor: color.moss,
    padding: 12,
    borderRadius: radius.control,
    alignItems: 'center',
  },
  unhandled: { backgroundColor: color.danger },
  dimmed: { opacity: 0.65 },
  buttonText: { color: '#FBFCF8', fontSize: 15, fontWeight: '600' },
});
