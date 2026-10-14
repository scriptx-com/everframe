// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import React, { useEffect, useRef, useState } from 'react';
import { AppState, Linking, PermissionsAndroid, Platform, Pressable, ScrollView, Switch, Text, TextInput, View } from 'react-native';
import {
  captureException, EverframeSensitive, observePermissionRequest, recordLaunchContext, setUser,
  useEverframeInteraction, useEverframeScreen,
} from '@everframe/react-native';

export const fixtureInteractionPolicy = {
  valueTestIds: ['search-input'],
  urlRules: [{ origin: 'everframeexample://interaction', routes: ['/:id'], queryKeys: ['campaign'] }],
  launchArgumentKeys: ['campaign'],
};
const initialHelpers = process.env.EXPO_PUBLIC_EVERFRAME_INTERACTION_HELPERS !== '0';
function Button({ id, title, onPress }: { id: string; title: string; onPress(): void }) {
  return <Pressable testID={id} accessibilityRole="button" accessibilityLabel={title} onPress={onPress}
    style={({ focused, pressed }: { focused?: boolean; pressed: boolean }) => ({ padding: 12, borderWidth: 2, borderColor: focused ? '#f3b847' : '#526170', backgroundColor: pressed ? '#425366' : '#172532', borderRadius: 6 })}>
    <Text style={{ color: '#fff', fontSize: 18 }}>{title}</Text>
  </Pressable>;
}
function Field({ id, helpers, secure = false }: { id: string; helpers: boolean; secure?: boolean }) {
  const [text, setText] = useState('');
  const interaction = useEverframeInteraction<React.ElementRef<typeof TextInput>>({ target: { testId: id, name: id }, helperTypes: id === 'search-input' ? [] : ['text_edit'] });
  return <TextInput testID={id} accessibilityLabel={id} ref={helpers ? interaction.ref : undefined}
    value={text} secureTextEntry={secure} placeholder={id} placeholderTextColor="#b5c6d6" returnKeyType="done"
    onChangeText={value => { interaction.textChanged(value); setText(value); }}
    onEndEditing={event => interaction.textChanged(event.nativeEvent.text, { reason: 'end' })}
    onSubmitEditing={event => interaction.textChanged(event.nativeEvent.text, { reason: 'submit' })}
    style={{ color: '#fff', borderColor: '#8194a6', borderWidth: 1, padding: 12, fontSize: 20, minHeight: 50 }} />;
}
/** Development fixture: app operations remain visible and synthetic results are explicitly labelled. */
export default function InteractionEventsFixture() {
  useEverframeScreen('Interaction fixture');
  const [helpers, setHelpers] = useState(initialHelpers), [version, setVersion] = useState(0);
  const [checked, setChecked] = useState(false), [option, setOption] = useState('recent'), [status, setStatus] = useState('Ready');
  const captures = useRef(0), pending = useRef<((value: string) => void) | undefined>(undefined);
  const custom = useEverframeInteraction<React.ElementRef<typeof Pressable>>({ target: { testId: 'fixture-picker', name: 'Sort order' }, helperTypes: ['control_change'] });
  const toggle = useEverframeInteraction<React.ElementRef<typeof Pressable>>({ target: { testId: 'fixture-checkbox', name: 'Saved' }, helperTypes: ['control_change'] });
  const scroll = useEverframeInteraction<React.ElementRef<typeof ScrollView>>({ target: { testId: 'fixture-scroll', name: 'Fixture titles' }, helperTypes: [] });
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') recordLaunchContext({ trigger: 'notification', arguments: { campaign: 'fixture-explicit', ignored: 'SECRET-LAUNCH' } });
    });
    return () => { subscription.remove(); pending.current?.('unavailable'); pending.current = undefined; };
  }, []);
  const synthetic = () => {
    if (pending.current) return;
    setStatus('Synthetic request pending');
    void observePermissionRequest('fixture.synthetic', () => new Promise<string>(resolve => { pending.current = resolve; }), result => result === 'granted' ? 'granted' : 'unavailable')
      .then(() => setStatus('Synthetic request completed'));
  };
  return <ScrollView style={{ backgroundColor: '#0d1721' }} contentContainerStyle={{ padding: Platform.isTV ? 50 : 28, paddingTop: Platform.isTV ? 50 : 70, gap: 14 }} keyboardShouldPersistTaps="handled">
    <Text style={{ color: '#fff', fontSize: 26 }}>Interaction evidence fixture</Text>
    <Text style={{ color: '#b5c6d6' }}>Helpers {helpers ? 'on' : 'off'} · host generation {version} · {status}</Text>
    <Button id="fixture-helpers" title="Toggle helpers" onPress={() => setHelpers(value => !value)} />
    <Button id="fixture-remount" title="Remount hosts" onPress={() => setVersion(value => value + 1)} />
    <View key={version} style={{ gap: 14 }}>
      <Field id="search-input" helpers={helpers} />
      <Field id="private-input" helpers={helpers} />
      <Field id="secure-input" helpers={helpers} secure />
      <EverframeSensitive><Field id="masked-input" helpers={helpers} /></EverframeSensitive>
      {!Platform.isTV && <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}><Text style={{ color: '#fff' }}>Native switch</Text><Switch testID="fixture-switch" accessibilityLabel="Native saved switch" value={checked} onValueChange={setChecked} /></View>}
      <Pressable testID="fixture-checkbox" accessibilityRole="checkbox" accessibilityState={{ checked }} ref={helpers ? toggle.ref : undefined}
        onPress={() => { toggle.controlChanged({ control: 'checkbox', checked: !checked }); setChecked(!checked); }} style={{ padding: 16, borderColor: '#8194a6', borderWidth: 1 }}>
        <Text style={{ color: '#fff' }}>Custom checkbox: {checked ? 'on' : 'off'} (helper only)</Text>
      </Pressable>
      <Pressable testID="fixture-picker" accessibilityRole="button" accessibilityLabel="Change sort" ref={helpers ? custom.ref : undefined}
        onPress={() => { const next = option === 'recent' ? 'alphabetical' : 'recent'; custom.controlChanged({ control: 'picker', optionId: next }); setOption(next); }} style={{ padding: 16, borderColor: '#8194a6', borderWidth: 1 }}>
        <Text style={{ color: '#fff' }}>Sort: {option} (helper only)</Text>
      </Pressable>
      <ScrollView horizontal testID="fixture-scroll" ref={helpers ? scroll.ref : undefined} style={{ height: 140 }}>
        {Array.from({ length: 30 }, (_, index) => <View key={index} style={{ width: 180, padding: 10 }}><Button id={`fixture-item-${index}`} title={`Title ${index}`} onPress={() => setStatus(`Selected title ${index}`)} /></View>)}
      </ScrollView>
    </View>
    <Button id="fixture-link" title="Open link with private path and query" onPress={() => { void Linking.openURL('everframeexample://interaction/SECRET-PATH?campaign=fixture&token=SECRET-QUERY#SECRET-FRAGMENT').catch(() => setStatus('Link unavailable')); }} />
    <Button id="fixture-permission-start" title="Begin synthetic permission request" onPress={synthetic} />
    <Button id="fixture-permission-finish" title="Resolve synthetic request as granted" onPress={() => { pending.current?.('granted'); pending.current = undefined; }} />
    {Platform.OS === 'android' && !Platform.isTV && <Button id="fixture-permission-os" title="Request Android camera (real OS operation)" onPress={() => {
      void observePermissionRequest('android.permission.CAMERA', () => PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.CAMERA))
        .then(result => setStatus(`Android camera result: ${result}`), () => setStatus('Android camera request failed'));
    }} />}
    <Button id="fixture-signout" title="Sign out while work is pending" onPress={() => { setUser(); setStatus('Signed out; remount hosts to renew helpers'); }} />
    <Button id="fixture-late-context" title="Supply late launch context" onPress={() => recordLaunchContext({ trigger: 'notification', arguments: { campaign: 'late-fixture' } })} />
    <Button id="fixture-capture" title="Capture evidence" onPress={() => {
      const ordinal = ++captures.current;
      const error = new Error(`interaction-fixture-${helpers ? 'helpers' : 'automatic'}-${ordinal}`);
      // Each deliberate fixture capture is a separate case at this shared call site.
      error.name = `InteractionFixtureCapture${ordinal}`;
      captureException(error);
    }} />
  </ScrollView>;
}
