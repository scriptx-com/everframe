// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { INGEST_URL, setupReleaseHealth, type WebEverframeConfig } from '@everframe/web';

/** Pure during render: only a committed Provider effect starts durable work. */
export function createProviderReleaseHealth(config: WebEverframeConfig, sdkVersion: string) {
  const captured = {
    sdkKey: config.sdkKey,
    disabled: config.disabled === true,
    ...(config.releaseHealth ? { releaseHealth: {
      enabled: config.releaseHealth.enabled,
      ...(config.releaseHealth.userId === undefined ? {} : { userId: config.releaseHealth.userId }),
      ...(config.releaseHealth.loadedBuildId === undefined ? {} : { loadedBuildId: config.releaseHealth.loadedBuildId }),
    } } : {}),
  };
  let producer: ReturnType<typeof setupReleaseHealth> | undefined;
  let stoppedNormally = false;
  let revoked = false;
  return {
    // Later effect cleanup cannot turn an explicit kill into repairable teardown.
    get stoppedNormally() { return stoppedNormally && !revoked; },
    start() {
      if (stoppedNormally || producer) return;
      producer = setupReleaseHealth(revoked ? { ...captured, disabled: true } : captured, INGEST_URL, sdkVersion);
    },
    stop() {
      stoppedNormally = true;
      void producer?.stop();
    },
    revoke() {
      revoked = true;
      void producer?.revoke();
    },
  };
}
