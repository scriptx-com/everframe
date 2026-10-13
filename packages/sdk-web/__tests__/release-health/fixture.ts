import type { WebReleaseHealthExposure } from '@everframe/protocol';
export const exposure = (): WebReleaseHealthExposure => ({
 exposureId: crypto.randomUUID(), pageLaunchId: crypto.randomUUID(), startedAt: '2026-10-13T12:00:00.000Z',
 platform: 'web', sdkVersion: '1.2.2', app: { version: '12.3.5-12-web', build: null, debug: false },
 subject: { kind: 'anonymous' }, sessionPolicy: 'page-v1',
});
export const at = new Date('2026-10-13T12:01:00.000Z');
