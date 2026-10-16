// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import {
  DeviceBuildUploadInputSchema,
  DeviceBuildUploadReceiptSchema,
  DeviceBuildUploadReservationSchema,
  DeviceBuildUploadStateSchema,
  DeviceBuildUploadStatusSchema,
  DevicePlatformSchema,
} from '../src/index.js';

const appId = 'da011e77-8faa-4eb3-8f3d-e781160355c4';
const uploadId = '833419db-a593-49e1-9cc3-d58f0717010b';
const buildId = 'f217cc34-5c59-4b9d-8f16-6138d97dfc10';
const uploadPath = `/api/v1/apps/${appId}/device-builds/${uploadId}`;
const timestamp = '2026-10-16T10:00:00.000Z';

function input(overrides: Record<string, unknown> = {}) {
  return {
    platform: 'ios',
    version: '1.2.3',
    buildNumber: '42',
    commit: 'a'.repeat(40),
    filename: 'simulator.zip',
    sizeBytes: 1024,
    sha256: 'b'.repeat(64),
    ...overrides,
  };
}

function status(overrides: Record<string, unknown> = {}) {
  return { uploadId, state: 'queued', createdAt: timestamp, updatedAt: timestamp, ...overrides };
}

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    uploadId,
    state: 'receiving',
    contentPath: `${uploadPath}/content`,
    statusPath: uploadPath,
    expiresAt: timestamp,
    ...overrides,
  };
}

describe('device build upload input', () => {
  it('accepts string build numbers and optional commit', () => {
    expect(
      DeviceBuildUploadInputSchema.parse(input({ buildNumber: '001', commit: undefined }))
        .buildNumber,
    ).toBe('001');
    expect(DeviceBuildUploadInputSchema.safeParse(input({ buildNumber: 1 })).success).toBe(false);
  });

  it('rejects provider fields and store-only filename', () => {
    expect(
      DeviceBuildUploadInputSchema.safeParse({ ...input(), providerAppId: 'foreign' }).success,
    ).toBe(false);
    expect(() => DeviceBuildUploadInputSchema.parse(input({ filename: 'store.ipa' }))).toThrow(
      /simulator.*\.app.*\.zip/i,
    );
    expect(() =>
      DeviceBuildUploadInputSchema.parse(input({ platform: 'android', filename: 'store.aab' })),
    ).toThrow(/APK/i);
  });

  it('bounds size and normalizes commit', () => {
    expect(DeviceBuildUploadInputSchema.safeParse(input({ sizeBytes: 524288001 })).success).toBe(
      false,
    );
    expect(
      DeviceBuildUploadInputSchema.parse(input({ sizeBytes: 524288000, commit: 'A'.repeat(40) }))
        .commit,
    ).toBe('a'.repeat(40));
    expect(DeviceBuildUploadInputSchema.parse(input({ commit: 'B'.repeat(64) })).commit).toBe(
      'b'.repeat(64),
    );
  });

  it.each([
    ['ios', 'Simulator.ZIP'],
    ['tvos', 'tv-simulator.zip'],
    ['android', 'app.APK'],
    ['android-tv', 'tv.apk'],
    ['roku', 'channel.ZIP'],
  ])('accepts %s runnable filenames without renaming them', (platform, filename) => {
    expect(DevicePlatformSchema.parse(platform)).toBe(platform);
    expect(DeviceBuildUploadInputSchema.parse(input({ platform, filename })).filename).toBe(
      filename,
    );
  });

  it.each([
    { platform: 'web' },
    { version: '' },
    { version: '   ' },
    { version: 'v'.repeat(129) },
    { buildNumber: '' },
    { buildNumber: '   ' },
    { buildNumber: '1'.repeat(129) },
    { commit: 'a'.repeat(39) },
    { commit: 'g'.repeat(40) },
    { commit: 'a'.repeat(40) + '\n' },
    { filename: '../simulator.zip' },
    { filename: 'nested/simulator.zip' },
    { filename: 'nested\\simulator.zip' },
    { filename: 'bad\u0000.zip' },
    { filename: 'simulator.zip\n' },
    { filename: 'a'.repeat(252) + '.zip' },
    { filename: 'simulator.app' },
    { platform: 'android', filename: 'app.zip' },
    { platform: 'roku', filename: 'app.apk' },
    { sizeBytes: 0 },
    { sizeBytes: 1.5 },
    { sha256: 'B'.repeat(64) },
    { sha256: 'b'.repeat(63) },
    { sha256: 'b'.repeat(64) + '\n' },
  ])('rejects invalid upload metadata %j', (overrides) => {
    expect(DeviceBuildUploadInputSchema.safeParse(input(overrides)).success).toBe(false);
  });

  it('accepts metadata at its string and size boundaries', () => {
    expect(
      DeviceBuildUploadInputSchema.safeParse(
        input({
          version: 'v'.repeat(128),
          buildNumber: '1'.repeat(128),
          filename: 'a'.repeat(251) + '.zip',
          sizeBytes: 1,
        }),
      ).success,
    ).toBe(true);
  });
});

describe('device build upload status', () => {
  it('ready requires buildId', () => {
    expect(
      DeviceBuildUploadStatusSchema.safeParse(status({ state: 'ready', buildId: undefined }))
        .success,
    ).toBe(false);
    expect(DeviceBuildUploadStatusSchema.parse(status({ state: 'ready', buildId })).buildId).toBe(
      buildId,
    );
  });

  it.each(['receiving', 'queued', 'uploading', 'retrying', 'failed', 'expired'])(
    'keeps %s distinct from ready',
    (state) => {
      expect(DeviceBuildUploadStateSchema.parse(state)).toBe(state);
      expect(DeviceBuildUploadStatusSchema.safeParse(status({ state })).success).toBe(true);
      expect(DeviceBuildUploadStatusSchema.safeParse(status({ state, buildId })).success).toBe(
        false,
      );
    },
  );

  it.each([
    'invalid_format',
    'invalid_content',
    'upload_too_large',
    'upload_expired',
    'provider_unavailable',
    'retry_exhausted',
  ])('accepts safe error code %s', (code) => {
    expect(
      DeviceBuildUploadStatusSchema.safeParse(
        status({
          state: 'retrying',
          retryAt: timestamp,
          error: { code, message: 'Please retry the upload.' },
        }),
      ).success,
    ).toBe(true);
  });

  it.each([
    { uploadId: 'provider-upload' },
    { state: 'complete' },
    { createdAt: 'yesterday' },
    { updatedAt: 'invalid' },
    { retryAt: 'later' },
    { state: 'ready', buildId: 'provider-build' },
    { providerBuildId: 'foreign' },
    { error: { code: 'raw_http_error', message: 'Unavailable.' } },
    { error: { code: 'invalid_format', message: '' } },
    { error: { code: 'invalid_format', message: 'Invalid.', response: 'raw' } },
  ])('rejects invalid status %j', (overrides) => {
    expect(DeviceBuildUploadStatusSchema.safeParse(status(overrides)).success).toBe(false);
  });
});

describe('device build upload reservation', () => {
  it('accepts a receipt or an existing status', () => {
    expect(DeviceBuildUploadReceiptSchema.safeParse(receipt()).success).toBe(true);
    expect(DeviceBuildUploadReservationSchema.safeParse(receipt()).success).toBe(true);
    expect(DeviceBuildUploadReservationSchema.safeParse(status()).success).toBe(true);
    expect(
      DeviceBuildUploadReservationSchema.safeParse(status({ state: 'ready', buildId })).success,
    ).toBe(true);
    expect(
      DeviceBuildUploadReservationSchema.safeParse({ ...receipt(), ...status() }).success,
    ).toBe(false);
  });

  it.each([
    { state: 'queued' },
    { uploadId: 'foreign' },
    { expiresAt: 'tomorrow' },
    { providerAppId: 'foreign' },
    { contentPath: `https://example.com${uploadPath}/content` },
    { contentPath: `//example.com${uploadPath}/content` },
    { contentPath: `${uploadPath}/../content` },
    { contentPath: `${uploadPath}/content?token=foreign` },
    { contentPath: `${uploadPath}/content#fragment` },
    { contentPath: `${uploadPath}/content\n` },
    { statusPath: `${uploadPath}\n` },
    { contentPath: `${uploadPath}/content\\foreign` },
    { contentPath: `${uploadPath}/%63ontent` },
    { contentPath: uploadPath },
    { statusPath: `${uploadPath}/content` },
    { statusPath: `/api/v1/apps/${appId}/device-builds/${buildId}` },
    { contentPath: `/api/v1/apps/${buildId}/device-builds/${uploadId}/content` },
    { statusPath: '/api/v1/apps/not-a-uuid/device-builds/not-a-uuid' },
  ])('rejects unsafe or mismatched receipt metadata %j', (overrides) => {
    expect(DeviceBuildUploadReceiptSchema.safeParse(receipt(overrides)).success).toBe(false);
  });
});
