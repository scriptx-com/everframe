// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import {
  R8_ASSET_URL,
  R8_MAX_BYTES,
  artifactKind,
  hermesAssetUrl,
  isValidBuildId,
  normalizeAssetUrl,
  parseManifest,
} from '../src/index.js';

const artifact = {
  generatedSha256: 'a'.repeat(64),
  mapSha256: 'b'.repeat(64),
  mapBytes: 10,
};

describe('normalizeAssetUrl', () => {
  it('retains the asset path and removes only query and fragment', () => {
    expect(normalizeAssetUrl('https://cdn.example/A%20B/App.js?v=2#x'))
      .toBe('https://cdn.example/A%20B/App.js');
  });

  it.each([
    'ftp://cdn.example/app.js',
    'hermes://android/index.android.bundle',
    'https://user@cdn.example/app.js',
    'https://user:secret@cdn.example/app.js',
  ])('rejects an unsafe asset URL: %s', (url) => {
    expect(() => normalizeAssetUrl(url)).toThrow();
  });

  it('rejects both an oversized original URL and an oversized normalized URL', () => {
    expect(() => normalizeAssetUrl(`https://cdn.example/app.js?${'x'.repeat(2048)}`)).toThrow();
    expect(() => normalizeAssetUrl(`https://cdn.example/${'é'.repeat(700)}.js`)).toThrow();
  });
});

describe('parseManifest', () => {
  it('preserves the version-1 canonical serialized representation', () => {
    const parsed = parseManifest({
      version: 1,
      buildId: 'web-abc',
      artifacts: [
        { ...artifact, url: 'https://cdn.example/z.js?v=2' },
        { ...artifact, url: 'http://cdn.example/a.js#release' },
      ],
    });
    expect(JSON.stringify(parsed)).toBe(
      '{"version":1,"buildId":"web-abc","artifacts":[{"url":"http://cdn.example/a.js","generatedSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","mapSha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","mapBytes":10},{"url":"https://cdn.example/z.js","generatedSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","mapSha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","mapBytes":10}]}',
    );
  });

  it('normalizes and sorts artifacts into a canonical manifest', () => {
    expect(parseManifest({
      version: 1,
      buildId: 'web-abc',
      artifacts: [
        { ...artifact, url: 'https://cdn.example/z.js?v=2' },
        { ...artifact, url: 'http://cdn.example/a.js#release' },
      ],
    })).toEqual({
      version: 1,
      buildId: 'web-abc',
      artifacts: [
        { url: 'http://cdn.example/a.js', ...artifact },
        { url: 'https://cdn.example/z.js', ...artifact },
      ],
    });
  });

  it('rejects duplicate identities after normalization', () => {
    expect(() => parseManifest({ version: 1, buildId: 'web-abc', artifacts: [
      { ...artifact, url: 'https://cdn.example/app.js?v=1' },
      { ...artifact, url: 'https://cdn.example/app.js?v=2' },
    ] })).toThrow();
  });

  it.each(['', '   ', 'x'.repeat(201)])('rejects an invalid build ID', (buildId) => {
    expect(() => parseManifest({ version: 1, buildId, artifacts: [] })).toThrow();
  });

  it.each([
    ['generatedSha256', 'A'.repeat(64)],
    ['generatedSha256', 'g'.repeat(64)],
    ['generatedSha256', 'a'.repeat(63)],
    ['mapSha256', 'B'.repeat(64)],
  ] as const)(
    'rejects an invalid %s digest',
    (field, digest) => {
      expect(() => parseManifest({
        version: 1,
        buildId: 'web-abc',
        artifacts: [{ ...artifact, [field]: digest, url: 'https://cdn.example/app.js' }],
      })).toThrow();
    },
  );

  it.each([0, -1, 1.5, 32 * 1024 * 1024 + 1])('rejects an invalid map byte count: %s', (mapBytes) => {
    expect(() => parseManifest({
      version: 1,
      buildId: 'web-abc',
      artifacts: [{ ...artifact, mapBytes, url: 'https://cdn.example/app.js' }],
    })).toThrow();
  });

  it('rejects more than 256 MiB of maps in one build', () => {
    expect(() => parseManifest({
      version: 1,
      buildId: 'web-abc',
      artifacts: Array.from({ length: 9 }, (_, index) => ({
        ...artifact,
        mapBytes: 32 * 1024 * 1024,
        url: `https://cdn.example/${index}.js`,
      })),
    })).toThrow();
  });

  it('rejects more than 500 artifacts and a manifest larger than 1 MiB', () => {
    expect(() => parseManifest({
      version: 1,
      buildId: 'web-abc',
      artifacts: Array.from({ length: 501 }, (_, index) => ({
        ...artifact,
        url: `https://cdn.example/${index}.js`,
      })),
    })).toThrow();
    expect(() => parseManifest({
      version: 1,
      buildId: 'web-abc',
      artifacts: Array.from({ length: 500 }, (_, index) => ({
        ...artifact,
        mapBytes: 1,
        url: `https://cdn.example/${index}-${'x'.repeat(1900)}.js`,
      })),
    })).toThrow();
  });
});

describe('Hermes manifest identity', () => {
  const valid = {
    version: 2,
    runtime: 'hermes',
    platform: 'android',
    buildId: 'run-7-android',
    artifacts: [{
      url: 'hermes://android/index.android.bundle',
      generatedSha256: 'a'.repeat(64),
      mapSha256: 'b'.repeat(64),
      mapBytes: 12,
    }],
  } as const;

  it('constructs and parses one canonical artifact identity', () => {
    expect(hermesAssetUrl('android', 'index.android.bundle'))
      .toBe('hermes://android/index.android.bundle');
    expect(parseManifest(valid)).toEqual(valid);
  });

  it.each([[[]], [[valid.artifacts[0], valid.artifacts[0]]]])(
    'requires exactly one artifact: %j',
    (artifacts) => expect(() => parseManifest({ ...valid, artifacts })).toThrow(),
  );

  it.each([
    'hermes://ios/index.android.bundle',
    'hermes://android/index%2Eandroid.bundle',
    'hermes://android:80/index.android.bundle',
    'hermes://android/index.android.bundle?x=1',
    'hermes://android/index.android.bundle#x',
    'hermes://android/a/index.android.bundle',
    'hermes://user@android/index.android.bundle',
  ])('rejects a noncanonical or mismatched Hermes URI: %s', (url) => {
    expect(() => parseManifest({
      ...valid,
      artifacts: [{ ...valid.artifacts[0], url }],
    })).toThrow();
  });

  it.each([
    { runtime: 'jsc' },
    { platform: 'web' },
    { extra: true },
    { artifacts: [{ ...valid.artifacts[0], extra: true }] },
    { buildId: 'a\u0000b' },
    { buildId: 'a\ud800b' },
    { artifacts: [{ ...valid.artifacts[0], mapBytes: 0 }] },
    { artifacts: [{ ...valid.artifacts[0], mapBytes: 32 * 1024 * 1024 + 1 }] },
  ])('rejects an invalid version-2 field set: %j', (change) => {
    expect(() => parseManifest({ ...valid, ...change })).toThrow();
  });

  it.each(['', '.bundle', 'a/b', 'a%2Eb', 'a'.repeat(129)])(
    'rejects a nonpersistable bundle name: %j',
    (bundleName) => expect(() => hermesAssetUrl('android', bundleName)).toThrow(),
  );
});

describe('R8 manifest identity', () => {
  const valid = {
    version: 3,
    runtime: 'r8',
    platform: 'android',
    buildId: 'ci-123',
    artifacts: [{
      url: R8_ASSET_URL,
      mapSha256: 'a'.repeat(64),
      mapBytes: 12,
    }],
  } as const;

  it('preserves one exact mapping artifact and reports its namespace', () => {
    const parsed = parseManifest(valid);
    expect(parsed).toEqual(valid);
    expect(artifactKind(parsed)).toBe('r8');
    expect(artifactKind(parseManifest({ version: 1, buildId: 'ci-123', artifacts: [] })))
      .toBe('source_map');
  });

  it.each([
    '',
    '.mapping',
    'mapping/id',
    `a${'b'.repeat(128)}`,
    'ci-123\n',
    'ci-123\r',
    'ci-123\r\n',
  ])('rejects an invalid exact mapping ID: %j', (buildId) => {
    expect(() => parseManifest({ ...valid, buildId })).toThrow();
  });

  it('accepts the full 128-character mapping ID bound', () => {
    const buildId = `a${'b'.repeat(127)}`;
    expect(parseManifest({ ...valid, buildId }).buildId).toBe(buildId);
  });

  it.each([
    { runtime: 'hermes' },
    { platform: 'ios' },
    { extra: true },
    { artifacts: [] },
    { artifacts: [valid.artifacts[0], valid.artifacts[0]] },
    { artifacts: [{ ...valid.artifacts[0], url: 'https://example.test/mapping.txt' }] },
    { artifacts: [{ ...valid.artifacts[0], generatedSha256: 'b'.repeat(64) }] },
    { artifacts: [{ ...valid.artifacts[0], extra: true }] },
    { artifacts: [{ ...valid.artifacts[0], mapBytes: 0 }] },
    { artifacts: [{ ...valid.artifacts[0], mapBytes: R8_MAX_BYTES + 1 }] },
  ])('rejects an invalid version-3 field set: %j', (change) => {
    expect(() => parseManifest({ ...valid, ...change })).toThrow();
  });

  it('accepts R8 mappings up to 512 MiB, far above the 32 MiB JavaScript map limit', () => {
    expect(R8_MAX_BYTES).toBe(512 * 1024 * 1024);
    for (const mapBytes of [32 * 1024 * 1024 + 1, 70_769_438, R8_MAX_BYTES]) {
      const manifest = parseManifest({ ...valid, artifacts: [{ ...valid.artifacts[0], mapBytes }] });
      expect(manifest.artifacts[0]!.mapBytes).toBe(mapBytes);
    }
  });

  it('keeps generated hashes mandatory for legacy JavaScript manifests', () => {
    const v1 = {
      version: 1,
      buildId: 'web-build',
      artifacts: [{ ...artifact, url: 'https://example.test/app.js' }],
    };
    const v2 = {
      version: 2,
      runtime: 'hermes',
      platform: 'android',
      buildId: 'native-build',
      artifacts: [{ ...artifact, url: 'hermes://android/index.android.bundle' }],
    };
    for (const input of [v1, v2]) {
      const withoutGeneratedHash = structuredClone(input);
      delete (withoutGeneratedHash.artifacts[0] as Partial<typeof artifact>).generatedSha256;
      expect(() => parseManifest(withoutGeneratedHash)).toThrow();
    }
  });
});

describe('shared build identity eligibility', () => {
  it.each([
    [undefined, false],
    [42, false],
    ['', false],
    [' \t ', false],
    ['😀'.repeat(101), false],
    ['😀'.repeat(100), true],
    [' release ', true],
  ])('uses the exact manifest rule for %j', async (buildId, valid) => {
    const { isValidBuildId } = await import('../src/index.js');
    expect(isValidBuildId(buildId)).toBe(valid);
    if (valid) expect(parseManifest({ version: 1, buildId, artifacts: [] }).buildId).toBe(buildId);
    else expect(() => parseManifest({ version: 1, buildId, artifacts: [] })).toThrow();
  });
});

it.each(['a\u0000b', 'a\ud800b', 'a\udc00b'])(
  'rejects non-preservable build identity %j',
  (buildId) => {
    expect(isValidBuildId(buildId)).toBe(false);
    expect(() => parseManifest({ version: 1, buildId, artifacts: [] })).toThrow();
  },
);
it.each([' a😀b ', 'a\ufffdb', '😀'.repeat(100)])(
  'preserves exact valid build identity %j',
  (buildId) => {
    expect(isValidBuildId(buildId)).toBe(true);
    expect(parseManifest({ version: 1, buildId, artifacts: [] }).buildId).toBe(buildId);
  },
);

describe('path-only asset URLs', () => {
  it.each(['~/assets/app.js', '~/a/b%20c.js', '~/x.js'])('accepts %s unchanged', (url) => {
    expect(normalizeAssetUrl(url)).toBe(url);
  });

  it.each(['~/', '~', '~assets/x.js', '~/a/../x.js', '~/./x.js', '~/a//x.js', '~/x.js?v=1', '~/x.js#h', '~/a\\x.js', `~/${'a'.repeat(2048)}`])(
    'rejects %j',
    (url) => {
      expect(() => normalizeAssetUrl(url)).toThrow('invalid_asset_url');
    },
  );

  it('parses a v1 manifest that mixes path-only and absolute urls', () => {
    const parsed = parseManifest({
      version: 1,
      buildId: 'b1',
      artifacts: [
        { url: '~/assets/b.js', ...artifact },
        { url: 'https://cdn.example/assets/a.js', ...artifact },
      ],
    });
    expect(parsed.artifacts.map((a) => a.url)).toEqual(['https://cdn.example/assets/a.js', '~/assets/b.js']);
  });

  it('rejects the same path-only url twice', () => {
    expect(() =>
      parseManifest({ version: 1, buildId: 'b1', artifacts: [{ url: '~/x.js', ...artifact }, { url: '~/x.js', ...artifact }] }),
    ).toThrow('duplicate_asset_url');
  });
});
