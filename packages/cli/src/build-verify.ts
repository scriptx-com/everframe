// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { readComplete, readPointer } from './staging-io.js';

export interface VerifyOptions {
  stagingDir: string;
  platform: 'android' | 'ios';
  release: boolean;
  allowMissing: boolean;
  hasToken: boolean;
}

export interface VerifyResult {
  ok: boolean;
  failures: string[];
  warnings: string[];
}

const ADVICE: Record<string, string> = {
  missing_bundle_identity:
    'missing_bundle_identity: the composed map has no generated Everframe identity. Apply withEverframe() and rebuild; manual identities require explicit upload-hermes options.',
  ambiguous_bundle_identity:
    'ambiguous_bundle_identity: multiple generated Everframe identity modules are present. Apply withEverframe() once and rebuild in an isolated workspace.',
  invalid_bundle_identity:
    'invalid_bundle_identity: the generated identity in the source map is malformed or mismatched. Rebuild the bytecode and composed map together.',
  staged_identity_mismatch:
    'staged_identity_mismatch: the artifact identity and staged partial disagree. Use the matching platform and preserve its .everframe directory.',
  staged_partial_missing:
    'staged_partial_missing: the composed map names a build that has no staged manifest in --staging. Point --staging at the .everframe directory of the Metro projectRoot that bundled it, and keep that directory until upload.',
  compiled_build_identity_missing:
    'compiled_build_identity_missing: bytecode does not contain the build ID selected by the composed map. Rebuild and collect the matching bundle/map pair.',
  no_staged_build:
    'no_staged_build: metro never staged this platform. Is withEverframe() applied in metro.config.js, and is it enabled for this build?',
  manifest_not_collected:
    'manifest_not_collected: run `everframe build collect` after hermesc and before upload.',
  invalid_staged_manifest:
    'invalid_staged_manifest: the staging directory is corrupt. Delete .everframe and rebuild.',
  missing_api_token:
    'missing_api_token: set EVERFRAME_API_TOKEN to a token with the artifacts:write scope.',
  'request_failed:project_quota_exceeded':
    'request_failed:project_quota_exceeded: the project\'s artifact storage quota is full even after removing older builds. Builds uploaded in the last 24 hours, and builds used for symbolication in the last 7 days, are kept. Retry later or ask for a larger quota.',
  // The codes below are raised by `build collect`, not by verify itself.
  // Under the generated build phase's `set -e`, collect aborts the script
  // before verify ever runs, so these would otherwise surface only as a bare
  // code. `adviceFor` is exported so `build collect` can render the same
  // sentence on its own failure path.
  bundle_not_found:
    'bundle_not_found: no file at --bundle. iOS final bytecode is $CONFIGURATION_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH/main.jsbundle, not the intermediate Metro JS beside it. Android: app/build/generated/assets/react/<variant>/index.android.bundle.',
  source_map_not_found:
    'source_map_not_found: no file at --source-map. iOS needs SOURCEMAP_FILE as a target-level build setting, not an export inside one phase, e.g. $(DERIVED_FILE_DIR)/everframe/main.jsbundle.map; Android needs hermesFlags = ["-O", "-output-source-map"].',
  invalid_hermes_bytecode:
    'invalid_hermes_bytecode: --bundle is not Hermes bytecode, most likely plain Metro JavaScript. Point it at the post-hermesc output and run collect after hermesc, not after the packager.',
  source_map_empty:
    'source_map_empty: the --source-map file is zero bytes. It was truncated or still being written; rebuild and run collect only after the bundle phase has completed.',
  source_map_too_large:
    'source_map_too_large: the composed map exceeds the 32 MiB per-map limit the API enforces. Reduce or split the bundle.',
  // Raised by `sourcemaps upload-hermes --manifest` when the bytes on disk
  // no longer hash to what `build collect` recorded.
  staged_bundle_changed:
    'staged_bundle_changed: the bundle changed between `build collect` and upload, so the staged map no longer describes it. Do not rebuild between collect and upload; re-run collect on the bytes you are shipping.',
  staged_source_map_changed:
    'staged_source_map_changed: the source map changed between `build collect` and upload, so it may not describe the bundle being uploaded. Do not rebuild between collect and upload; re-run collect.',
};

/** Renders a coded staging/collect failure as an actionable sentence. */
export function adviceFor(code: string): string {
  return ADVICE[code] ?? code;
}

export async function verifyStagedBuild(options: VerifyOptions): Promise<VerifyResult> {
  const failures: string[] = [];
  const warnings: string[] = [];

  // A dev build with no token is not configured for upload at all; say nothing.
  if (!options.hasToken && !options.release) return { ok: true, failures: [], warnings: [] };

  const record = (code: string): void => {
    const message = adviceFor(code);
    if (options.release && !options.allowMissing) failures.push(message);
    else warnings.push(message);
  };

  try {
    const buildId = await readPointer(options.stagingDir, options.platform);
    await readComplete(options.stagingDir, buildId);
    if (!options.hasToken) record('missing_api_token');
  } catch (error) {
    record(error instanceof Error ? error.message : 'invalid_staged_manifest');
  }

  return { ok: failures.length === 0, failures, warnings };
}
