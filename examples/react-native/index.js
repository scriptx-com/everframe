// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Expo entry point for the @everframe/react-native dogfood sample.
// Everframe.configure(...) flows through <EverframeProvider config={...}> in
// src/App.tsx — the provider owns the entire lifecycle including
// configure-on-mount.

import { registerRootComponent } from 'expo';
import { App } from './src/App';

registerRootComponent(App);
