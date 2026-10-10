// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Build-artifact upload contract, shared by the public build tooling
// (@everframe/metro, @everframe/cli) and the server that accepts the upload.
import { z } from 'zod';
import { JvmMappingId as JvmMappingIdSchema } from './crash.js';

export interface SourceMapManifestV1 {
  version: 1;
  buildId: string;
  artifacts: Array<{
    url: string;
    generatedSha256: string;
    mapSha256: string;
    mapBytes: number;
  }>;
}

/**
 * Where a Hermes bundle runs. `vega` (Amazon Vega OS) bundles keep JavaScript
 * line/column debug info, so its frames map with the plain Metro source map.
 */
export type HermesBundlePlatform = 'android' | 'ios' | 'vega';

export interface SourceMapManifestV2 {
  version: 2;
  runtime: 'hermes';
  platform: HermesBundlePlatform;
  buildId: string;
  artifacts: [{
    url: string;
    generatedSha256: string;
    mapSha256: string;
    mapBytes: number;
  }];
}

export const R8_ASSET_URL = 'r8://android/mapping.txt';
/**
 * R8 mappings grow with the app and its dependencies, not with the shipped
 * bundle: a Compose sample's is 67.5 MiB, and large apps reach several hundred
 * MiB. The server streams them and loads only the classes a crash names, so they
 * share the dSYM per-file ceiling instead of the 32 MiB JavaScript map limit.
 */
export const R8_MAX_BYTES = 512 * 1024 * 1024;

export interface R8MappingManifestV3 {
  version: 3;
  runtime: 'r8';
  platform: 'android';
  buildId: string;
  artifacts: [{
    url: typeof R8_ASSET_URL;
    mapSha256: string;
    mapBytes: number;
    generatedSha256?: never;
  }];
}

export const DSYM_ASSET_URL = "dsym://apple/dwarf";
export const DSYM_MAX_BYTES = 512 * 1024 * 1024;

/** Raw DWARF file; image identity is derived from verified bytes by the server. */
export interface DsymManifestV4 {
  version: 4;
  runtime: "apple";
  platform: "apple";
  buildId: string;
  artifacts: [
    {
      url: typeof DSYM_ASSET_URL;
      mapSha256: string;
      mapBytes: number;
      generatedSha256?: never;
    }
  ];
}

export const ELF_ASSET_URL = "elf://android/library";
export const ELF_MAX_BYTES = 64 * 1024 * 1024;

/** Raw unstripped ELF file; image identity is derived from verified bytes by the server. */
export interface ElfManifestV5 {
  version: 5;
  runtime: "android-native";
  platform: "android";
  buildId: string;
  artifacts: [
    {
      url: typeof ELF_ASSET_URL;
      mapSha256: string;
      mapBytes: number;
      generatedSha256?: never;
    }
  ];
}

export type SourceMapManifest =
  | SourceMapManifestV1
  | SourceMapManifestV2
  | R8MappingManifestV3
  | DsymManifestV4
  | ElfManifestV5;
export type ArtifactKind = 'source_map' | 'r8' | 'dsym' | 'elf';

export function artifactKind(manifest: SourceMapManifest): ArtifactKind {
  return manifest.version === 5 ? 'elf' : manifest.version === 4 ? 'dsym' : manifest.version === 3 ? 'r8' : 'source_map';
}

export interface BuildUploadStatus {
  buildUuid: string;
  status: 'uploading' | 'ready';
  artifacts: Array<{ artifactUuid: string; url: string; available: boolean }>;
  /**
   * Request body encodings the server decodes on artifact uploads. Older
   * servers omit it, so clients send identity bytes unless `gzip` is listed.
   */
  uploadEncodings?: Array<'gzip'>;
}

const BUILD_ID_MAX_CHARS = 200;
const ASSET_URL_MAX_CHARS = 2048;
const ARTIFACTS_MAX = 500;
const MANIFEST_MAX_BYTES = 1024 * 1024;
const MAP_MAX_BYTES = 32 * 1024 * 1024;
const BUILD_MAPS_MAX_BYTES = 256 * 1024 * 1024;

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

// Preserve exact identity: trim only checks emptiness; length uses UTF-16 units.
const BuildIdSchema = z
  .string()
  .min(1)
  .max(BUILD_ID_MAX_CHARS)
  .refine((value) => value.trim().length > 0)
  // PostgreSQL text rejects NUL; UTF-8 encoding would replace lone surrogates.
  // Unicode mode matches lone code units but leaves valid surrogate pairs intact.
  .refine((value) => !/[\u0000\ud800-\udfff]/u.test(value));

/** Shared upload, enrichment and detail-fallback eligibility; never normalizes IDs. */
export function isValidBuildId(input: unknown): input is string {
  return BuildIdSchema.safeParse(input).success;
}

const ArtifactSchema = z
  .object({
    url: z.string().min(1).max(ASSET_URL_MAX_CHARS),
    generatedSha256: Sha256Schema,
    mapSha256: Sha256Schema,
    mapBytes: z.number().int().positive().max(MAP_MAX_BYTES),
  })
  .strict();

const ManifestV1Schema = z
  .object({
    version: z.literal(1),
    buildId: BuildIdSchema,
    artifacts: z.array(ArtifactSchema).max(ARTIFACTS_MAX),
  })
  .strict();

const ManifestV2Schema = z
  .object({
    version: z.literal(2),
    runtime: z.literal('hermes'),
    platform: z.enum(['android', 'ios', 'vega']),
    buildId: BuildIdSchema,
    artifacts: z.array(ArtifactSchema).length(1),
  })
  .strict();

const R8ArtifactSchema = z
  .object({
    url: z.literal(R8_ASSET_URL),
    mapSha256: Sha256Schema,
    mapBytes: z.number().int().positive().max(R8_MAX_BYTES),
  })
  .strict();

const ManifestV3Schema = z
  .object({
    version: z.literal(3),
    runtime: z.literal('r8'),
    platform: z.literal('android'),
    buildId: JvmMappingIdSchema,
    artifacts: z.array(R8ArtifactSchema).length(1),
  })
  .strict();

const ManifestV4Schema = z
  .object({
    version: z.literal(4),
    runtime: z.literal("apple"),
    platform: z.literal("apple"),
    buildId: z.string().length(69),
    artifacts: z
      .array(
        z
          .object({
            url: z.literal(DSYM_ASSET_URL),
            mapSha256: Sha256Schema,
            mapBytes: z.number().int().positive().max(DSYM_MAX_BYTES),
          })
          .strict()
      )
      .length(1),
  })
  .strict();

const ManifestV5Schema = z
  .object({
    version: z.literal(5),
    runtime: z.literal("android-native"),
    platform: z.literal("android"),
    buildId: z.string().length(68),
    artifacts: z
      .array(
        z
          .object({
            url: z.literal(ELF_ASSET_URL),
            mapSha256: Sha256Schema,
            mapBytes: z.number().int().positive().max(ELF_MAX_BYTES),
          })
          .strict()
      )
      .length(1),
  })
  .strict();

const ManifestSchema = z.discriminatedUnion('version', [
  ManifestV1Schema,
  ManifestV2Schema,
  ManifestV3Schema,
  ManifestV4Schema,
  ManifestV5Schema,
]);

type ManifestErrorCode =
  | 'invalid_manifest'
  | 'manifest_too_large'
  | 'invalid_asset_url'
  | 'duplicate_asset_url'
  | 'build_too_large';

export class SourceMapManifestError extends Error {
  constructor(public readonly code: ManifestErrorCode) {
    super(code);
    this.name = 'SourceMapManifestError';
  }
}

export function normalizeAssetUrl(input: string): string {
  if (input.length === 0 || input.length > ASSET_URL_MAX_CHARS) {
    throw new SourceMapManifestError('invalid_asset_url');
  }

  if (input.startsWith('~/')) {
    const segments = input.slice(2).split('/');
    if (
      /[?#\\]/.test(input) ||
      segments.some((segment) => segment === '' || segment === '.' || segment === '..')
    ) {
      throw new SourceMapManifestError('invalid_asset_url');
    }
    return input;
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new SourceMapManifestError('invalid_asset_url');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw new SourceMapManifestError('invalid_asset_url');
  }

  url.search = '';
  url.hash = '';
  // URL.href intentionally keeps WHATWG's canonical origin representation
  // (for example, a lower-case host and no default port) while preserving
  // path case and encoded path segments.
  const normalized = url.href;
  if (normalized.length > ASSET_URL_MAX_CHARS) {
    throw new SourceMapManifestError('invalid_asset_url');
  }
  return normalized;
}

const BundleNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);

export function hermesAssetUrl(
  platform: HermesBundlePlatform,
  bundleName: string,
): string {
  if (
    (platform !== 'android' && platform !== 'ios' && platform !== 'vega') ||
    !BundleNameSchema.safeParse(bundleName).success
  ) {
    throw new SourceMapManifestError('invalid_asset_url');
  }
  return `hermes://${platform}/${bundleName}`;
}

function parseHermesAssetUrl(
  input: string,
  platform: HermesBundlePlatform,
): string {
  const match = /^hermes:\/\/(android|ios|vega)\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/.exec(input);
  if (!match || match[1] !== platform) {
    throw new SourceMapManifestError('invalid_asset_url');
  }
  const canonical = hermesAssetUrl(platform, match[2]!);
  if (canonical !== input) throw new SourceMapManifestError('invalid_asset_url');
  return canonical;
}

export function parseManifest(input: unknown): SourceMapManifest {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(input);
  } catch {
    throw new SourceMapManifestError('invalid_manifest');
  }
  if (serialized === undefined) {
    throw new SourceMapManifestError('invalid_manifest');
  }
  if (new TextEncoder().encode(serialized).byteLength > MANIFEST_MAX_BYTES) {
    throw new SourceMapManifestError('manifest_too_large');
  }

  const result = ManifestSchema.safeParse(input);
  if (!result.success) {
    throw new SourceMapManifestError('invalid_manifest');
  }

  if (result.data.version === 5) {
    const artifact = result.data.artifacts[0]!;
    if (result.data.buildId !== "elf:" + artifact.mapSha256)
      throw new SourceMapManifestError("invalid_manifest");
    return {
      version: 5,
      runtime: "android-native",
      platform: "android",
      buildId: result.data.buildId,
      artifacts: [
        {
          url: ELF_ASSET_URL,
          mapSha256: artifact.mapSha256,
          mapBytes: artifact.mapBytes,
        },
      ],
    };
  }

  if (result.data.version === 4) {
    const artifact = result.data.artifacts[0]!;
    if (result.data.buildId !== "dsym:" + artifact.mapSha256)
      throw new SourceMapManifestError("invalid_manifest");
    return {
      version: 4,
      runtime: "apple",
      platform: "apple",
      buildId: result.data.buildId,
      artifacts: [
        {
          url: DSYM_ASSET_URL,
          mapSha256: artifact.mapSha256,
          mapBytes: artifact.mapBytes,
        },
      ],
    };
  }

  if (result.data.version === 3) {
    const artifact = result.data.artifacts[0]!;
    return {
      version: 3,
      runtime: 'r8',
      platform: 'android',
      buildId: result.data.buildId,
      artifacts: [{
        url: R8_ASSET_URL,
        mapSha256: artifact.mapSha256,
        mapBytes: artifact.mapBytes,
      }],
    };
  }

  if (result.data.version === 2) {
    const artifact = result.data.artifacts[0]!;
    return {
      version: 2,
      runtime: 'hermes',
      platform: result.data.platform,
      buildId: result.data.buildId,
      artifacts: [{
        url: parseHermesAssetUrl(artifact.url, result.data.platform),
        generatedSha256: artifact.generatedSha256,
        mapSha256: artifact.mapSha256,
        mapBytes: artifact.mapBytes,
      }],
    };
  }

  let totalBytes = 0;
  const seen = new Set<string>();
  const artifacts = result.data.artifacts.map((artifact) => {
    const url = normalizeAssetUrl(artifact.url);
    if (seen.has(url)) {
      throw new SourceMapManifestError('duplicate_asset_url');
    }
    seen.add(url);
    totalBytes += artifact.mapBytes;
    return {
      url,
      generatedSha256: artifact.generatedSha256,
      mapSha256: artifact.mapSha256,
      mapBytes: artifact.mapBytes,
    };
  });
  if (totalBytes > BUILD_MAPS_MAX_BYTES) {
    throw new SourceMapManifestError('build_too_large');
  }
  artifacts.sort((left, right) => (left.url < right.url ? -1 : left.url > right.url ? 1 : 0));

  return { version: 1, buildId: result.data.buildId, artifacts };
}

// Staged build records written to disk between bundling and upload.

/** Written by @everframe/metro before hermesc runs; completed by the CLI after. */
export const StagedBuildPartial = z.object({
  schema: z.literal(1),
  buildId: z.string().min(1).max(200)
    .regex(/\S/u)
    .regex(/^(?:[^\u0000\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/u),
  platform: z.enum(['android', 'ios']),
  bundleName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  dev: z.boolean(),
});
export type StagedBuildPartial = z.infer<typeof StagedBuildPartial>;

/** Recorded for epics 4 and 5; there is no server contract to upload these yet. */
export const StagedNativeIdentity = z.object({
  dsym: z.array(z.object({ uuid: z.string(), arch: z.string(), path: z.string() })).default([]),
  elf: z.array(z.object({ buildId: z.string(), abi: z.string(), path: z.string() })).default([]),
});
export type StagedNativeIdentity = z.infer<typeof StagedNativeIdentity>;

export const StagedBuild = StagedBuildPartial.extend({
  bundlePath: z.string().min(1),
  mapPath: z.string().min(1),
  generatedSha256: Sha256Schema,
  mapSha256: Sha256Schema,
  mapBytes: z.number().int().positive(),
  native: StagedNativeIdentity.optional(),
});
export type StagedBuild = z.infer<typeof StagedBuild>;

export function parseStagedBuildPartial(input: unknown): StagedBuildPartial {
  return StagedBuildPartial.parse(input);
}

export function parseStagedBuild(input: unknown): StagedBuild {
  return StagedBuild.parse(input);
}
