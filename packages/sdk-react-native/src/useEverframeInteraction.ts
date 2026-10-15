// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import * as React from 'react';
import { findNodeHandle } from 'react-native';
import NativeEverframe from './NativeEverframe.js';
import { useOptionalEverframeRuntime } from './EverframeProvider.js';
import { nextInteractionTargetId } from './interaction-target-registration.js';
import {
  createInteractionRegistration,
  normalizeInteractionOptions,
  type InteractionHookOptions,
} from './interactions/registration.js';
export type {
  InteractionHookOptions,
  HelperType,
  ControlChangeInput,
  ScrollInput,
} from './interactions/registration.js';
const inactive = () => 0;
const bridge = {
  findNodeHandle,
  get getInteractionLease() {
    return NativeEverframe.getInteractionLease;
  },
  get setInteractionObserver() {
    return NativeEverframe.setInteractionObserver;
  },
  get clearInteractionObserver() {
    return NativeEverframe.clearInteractionObserver;
  },
};
/** Annotates an existing native host; legacy evidence helpers are compatibility no-ops. */
export function useEverframeInteraction<T>(options?: InteractionHookOptions) {
  const runtime = useOptionalEverframeRuntime();
  const [id] = React.useState(nextInteractionTargetId);
  const key = JSON.stringify(normalizeInteractionOptions(options));
  // A runtime replacement alone must not replay unchanged mounted metadata.
  // A fresh committed option set/ref attachment can acquire ownership again.
  const registration = React.useMemo(
    () =>
      createInteractionRegistration(
        bridge,
        runtime?.interactionEvents,
        id,
        JSON.parse(key) as unknown,
      ),
    [id, key],
  );
  const epoch = React.useSyncExternalStore(
    runtime?.interactionTargets.subscribe ?? (() => () => {}),
    runtime?.interactionTargets.getSnapshot ?? inactive,
    inactive,
  );
  React.useLayoutEffect(() => {
    registration.start();
  }, [registration, epoch]);
  React.useLayoutEffect(() => () => registration.dispose(), [registration]);
  const ref = React.useCallback((host: T | null) => registration.attach(host), [registration]);
  return React.useMemo(
    () => ({
      ref,
      textChanged: registration.textChanged,
      controlChanged: registration.controlChanged,
      scrollSettled: registration.scrollSettled,
    }),
    [ref, registration],
  );
}
