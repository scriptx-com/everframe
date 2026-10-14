// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import * as React from 'react';
import { findNodeHandle } from 'react-native';
import {
  normalizeInteractionTargetAnnotation,
  type InteractionTargetAnnotation,
} from '@everframe/protocol';
import NativeEverframe from './NativeEverframe.js';
import { useOptionalEverframeRuntime } from './EverframeProvider.js';
import {
  createInteractionTargetRegistration,
  nextInteractionTargetId,
} from './interaction-target-registration.js';

export type { InteractionTargetAnnotation } from '@everframe/protocol';
const inactive = () => 0;
const bridge = {
  findNodeHandle,
  get setInteractionTarget() {
    return NativeEverframe.setInteractionTarget;
  },
  get clearInteractionTarget() {
    return NativeEverframe.clearInteractionTarget;
  },
};

/** Optional semantic metadata on an existing native host ref. Reporting works without it. */
export function useEverframeTarget<T>(
  annotation?: InteractionTargetAnnotation,
): React.RefCallback<T> {
  const runtime = useOptionalEverframeRuntime();
  const [id] = React.useState(nextInteractionTargetId);
  const registration = React.useMemo(
    () => createInteractionTargetRegistration(bridge, id),
    [id, runtime],
  );
  const subscribe = React.useCallback(
    (notify: () => void) =>
      runtime?.interactionTargets.subscribe(() => {
        if (!runtime.interactionTargets.getSnapshot()) registration.dispose();
        notify();
      }) ?? (() => {}),
    [runtime, registration],
  );
  const epoch = React.useSyncExternalStore(
    subscribe,
    runtime?.interactionTargets.getSnapshot ?? inactive,
    inactive,
  );
  let key: string | undefined;
  try {
    key = JSON.stringify(normalizeInteractionTargetAnnotation(annotation));
  } catch {
    /* Invalid optional annotation. */
  }
  // A new ref identity detaches old metadata in React's mutation phase, before host reuse.
  // Abandoned renders never invoke this callback and cannot publish their annotation.
  return React.useCallback(
    (host: T | null) => {
      if (host == null || !epoch) {
        registration.dispose();
        return;
      }
      registration.update(key ? (JSON.parse(key) as InteractionTargetAnnotation) : undefined);
      registration.attach(host);
    },
    [registration, epoch, key],
  );
}
