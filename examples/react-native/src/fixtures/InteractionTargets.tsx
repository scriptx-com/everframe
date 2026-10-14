// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { useEverframe, EverframeSensitive } from '@everframe/react-native';
import { useEverframeTarget } from '@everframe/react-native';

/** Mount beneath the example's existing EverframeProvider; no credentials live in this fixture. */
export default function InteractionTargetsFixture() {
  const everframe=useEverframe();
  const [updated,setUpdated]=React.useState(false);
  const [enabled,setEnabled]=React.useState(true);
  const [version,setVersion]=React.useState(0);
  const [presses,setPresses]=React.useState(0);
  const ref=useEverframeTarget<React.ElementRef<typeof View>>(enabled ? {
    name: 'Low Orbit', testId:'poster-low-orbit', role:'button',
    container: updated ? {name:'Continue',index:1,count:3} : {name:'Originals',index:0,count:12},
  } : undefined);
  return <View style={{padding:40,gap:24}}>
    <Pressable key={version} ref={ref} testID="target-fixture-card" accessibilityRole="button" accessibilityLabel="Automatic Low Orbit" onPress={()=>setPresses(n=>n+1)}><Text>Low Orbit</Text></Pressable>
    <Pressable testID="target-fixture-update" onPress={()=>setUpdated(v=>!v)}><Text>Update metadata without layout</Text></Pressable>
    <Pressable testID="target-fixture-replace" onPress={()=>setVersion(v=>v+1)}><Text>Replace host</Text></Pressable>
    <Pressable testID="target-fixture-toggle" onPress={()=>setEnabled(v=>!v)}><Text>Annotations {enabled?'on':'off'}</Text></Pressable>
    <EverframeSensitive><Pressable testID="target-fixture-masked" accessibilityLabel="SECRET-FIXTURE" onPress={()=>setPresses(n=>n+1)}><Text>Masked control</Text></Pressable></EverframeSensitive>
    <Pressable testID="target-fixture-capture" onPress={()=>everframe.captureException(new Error(`target-fixture-${updated?'updated':'initial'}-${enabled?'on':'off'}`))}><Text>Capture evidence</Text></Pressable>
    <Text>Press count: {presses}; container: {updated?'Continue':'Originals'}</Text>
  </View>;
}
