// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Expo entry point for the @everframe/react-native dogfood sample.
// Everframe.configure(...) flows through <EverframeProvider config={...}> in
// src/App.tsx — the provider owns the entire lifecycle including
// configure-on-mount.

import { registerRootComponent } from 'expo';
import { App } from './src/App';
import React from 'react';
import { EverframeProvider } from '@everframe/react-native';
import InteractionTargetsFixture from './src/fixtures/InteractionTargets';

// Explicit local-validation entry; no credentials or destination are baked into the fixture.
const Root = __DEV__ && process.env.EXPO_PUBLIC_EVERFRAME_TARGET_FIXTURE === '1'
  ? () => React.createElement(EverframeProvider, {config:{sdkKey:process.env.EXPO_PUBLIC_EVERFRAME_KEY ?? ''}}, React.createElement(InteractionTargetsFixture))
  : App;
registerRootComponent(Root);
