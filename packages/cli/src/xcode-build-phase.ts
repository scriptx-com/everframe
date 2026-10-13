// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { join } from "node:path";
import { parseArgs } from "node:util";
import { dsymUploadBuildCommand } from "./apple-command.js";
import { collectStagedBuild } from "./build-collect.js";
import { adviceFor, verifyStagedBuild } from "./build-verify.js";
import { DEFAULT_API_URL, MISSING_TOKEN, redact, symbolsStrict, uploadBudget } from "./defaults.js";
import { checkedAppId, XCODE_SANDBOX_MESSAGE } from "./native-setup/script.js";
import { uploadStagedHermes } from "./staged-upload.js";

export const XCODE_DEBUG_SKIP = "everframe: Debug build, skipping artifact upload";
export const XCODE_NO_TOKEN_WARNING =
  "warning: everframe: no EVERFRAME_API_TOKEN, skipping artifact upload. Crashes from this build will show raw frames. Set EVERFRAME_API_TOKEN to a token with the artifacts:write scope, or set EVERFRAME_SYMBOLS_STRICT=1 to fail the build instead.";
export const XCODE_UPLOAD_FAILED_WARNING =
  "warning: everframe: artifact upload failed; the build continues. Crashes from this build will show raw frames until its artifacts are uploaded. Set EVERFRAME_SYMBOLS_STRICT=1 to fail the build instead.";

export interface XcodeBuildPhaseDependencies {
  collect?: typeof collectStagedBuild;
  verify?: typeof verifyStagedBuild;
  uploadHermes?: typeof uploadStagedHermes;
  dsym?: typeof dsymUploadBuildCommand;
  log?: (line: string) => void;
  warn?: (line: string) => void;
  error?: (line: string) => void;
}

/**
 * `everframe xcode build-phase`: what `scripts/xcode-upload.sh` runs in the "Upload Everframe
 * Build Artifacts" Run Script phase of React Native and Expo apps. It reads Xcode's build
 * settings from the environment, uploads the Hermes bundle with its composed source map
 * (`SOURCEMAP_FILE`), then the dSYMs.
 *
 * It never fails the build by default: Debug builds and `SKIP_BUNDLING` skip, and a missing
 * EVERFRAME_API_TOKEN, a sandboxed phase or a failed step print `warning:` lines and exit 0.
 * A failed Hermes upload still lets the dSYM upload run. EVERFRAME_SYMBOLS_STRICT=1 turns each
 * of them into an `error:` line and exit 1. Each upload gets EVERFRAME_UPLOAD_TIMEOUT_SECONDS
 * (600 by default).
 */
export async function xcodeBuildPhaseCommand(
  args: string[],
  env: NodeJS.ProcessEnv,
  deps: XcodeBuildPhaseDependencies = {},
): Promise<number> {
  const log = deps.log ?? console.log,
    warn = deps.warn ?? console.warn,
    error = deps.error ?? console.error;
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    strict: true,
    options: { "app-id": { type: "string" }, staging: { type: "string" } },
  });
  const rawAppId = values["app-id"] ?? env.EVERFRAME_APP_ID;
  if (!rawAppId) throw new Error("missing_app_id: pass --app-id or set EVERFRAME_APP_ID");
  const appId = checkedAppId(rawAppId);

  if (env.CONFIGURATION === "Debug" || env.SKIP_BUNDLING) {
    log(XCODE_DEBUG_SKIP);
    return 0;
  }
  const strict = symbolsStrict(env);
  const token = env.EVERFRAME_API_TOKEN;
  if (!token) {
    if (strict) {
      error(`error: everframe: ${MISSING_TOKEN}`);
      return 1;
    }
    warn(XCODE_NO_TOKEN_WARNING);
    return 0;
  }
  if (env.ENABLE_USER_SCRIPT_SANDBOXING === "YES") {
    if (strict) {
      error(`error: everframe: ${XCODE_SANDBOX_MESSAGE}`);
      return 1;
    }
    warn(`warning: everframe: ${XCODE_SANDBOX_MESSAGE}`);
    return 0;
  }

  try {
    const stagingDir = values.staging ?? (env.SRCROOT ? join(env.SRCROOT, "..", ".everframe") : undefined);
    if (!stagingDir) throw new Error("xcode_environment_missing: SRCROOT is not set; run this from an Xcode Run Script phase or pass --staging");
    if (!env.CONFIGURATION_BUILD_DIR || !env.UNLOCALIZED_RESOURCES_FOLDER_PATH)
      throw new Error("xcode_environment_missing: CONFIGURATION_BUILD_DIR or UNLOCALIZED_RESOURCES_FOLDER_PATH is not set; run this from an Xcode Run Script phase");
    // The map is the target-level SOURCEMAP_FILE setting React Native's bundle phase writes.
    if (!env.SOURCEMAP_FILE) throw new Error("source_map_not_found");
    const bundlePath = join(env.CONFIGURATION_BUILD_DIR, env.UNLOCALIZED_RESOURCES_FOLDER_PATH, "main.jsbundle");
    try {
      await (deps.collect ?? collectStagedBuild)({ stagingDir, platform: "ios", bundlePath, mapPath: env.SOURCEMAP_FILE });
    } catch (cause) {
      throw new Error(adviceFor(cause instanceof Error ? cause.message : "collect_failed"));
    }
    const verified = await (deps.verify ?? verifyStagedBuild)({ stagingDir, platform: "ios", release: true, allowMissing: false, hasToken: true });
    for (const line of verified.warnings) warn(`warning: everframe: ${line}`);
    if (!verified.ok) throw new Error(verified.failures.join("\n"));
    const result = await (deps.uploadHermes ?? uploadStagedHermes)(
      { stagingDir, platform: "ios", appId, apiUrl: env.EVERFRAME_API_URL ?? DEFAULT_API_URL, token },
      uploadBudget(env, true),
    );
    log(`Source-map build ${result.buildUuid} is ready.`);
  } catch (cause) {
    const message = redact(adviceFor(cause instanceof Error ? cause.message : "upload_failed"), token);
    if (strict) {
      for (const line of message.split("\n")) error(`error: everframe: ${line}`);
      return 1;
    }
    for (const line of message.split("\n")) warn(`warning: everframe: ${line}`);
    warn(XCODE_UPLOAD_FAILED_WARNING);
  }

  // Lenient unless strict: it prints its own warnings and returns 0, or throws when strict.
  try {
    return await (deps.dsym ?? dsymUploadBuildCommand)(["--xcode", "--app-id", appId], env, { log, warn });
  } catch (cause) {
    const message = redact(adviceFor(cause instanceof Error ? cause.message : "upload_failed"), token);
    for (const line of message.split("\n")) error(`error: everframe: ${line}`);
    return 1;
  }
}
