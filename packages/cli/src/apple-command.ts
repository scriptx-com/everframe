// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { parseArgs } from "node:util";
import type { AppleBinaryInput } from "./apple-build.js";
import {
  discoverAppBundle,
  resolveArchiveSource,
  resolveXcodeSource,
  sandboxed,
  type AppleSymbolSource,
} from "./apple-discover.js";
import { uploadAppleBuild } from "./apple-upload.js";
import { adviceFor } from "./build-verify.js";
import { DEFAULT_API_URL, MISSING_TOKEN, NO_TOKEN_WARNING, symbolsStrict, uploadFailureWarnings } from "./defaults.js";

export interface DsymCommandDependencies {
  upload?: typeof uploadAppleBuild;
  log?: (line: string) => void;
  warn?: (line: string) => void;
}

/**
 * `--xcode`, `--archive` and `--app` are build integrations: unless strict,
 * a missing token or any upload failure prints `warning:` lines (Xcode shows
 * them as build warnings) and exits 0. The explicit `--binary` list is a
 * manual command and stays strict. Usage errors always fail.
 */
export async function dsymUploadBuildCommand(
  args: string[],
  env: NodeJS.ProcessEnv,
  deps: DsymCommandDependencies = {}
): Promise<number> {
  const log = deps.log ?? console.log,
    warn = deps.warn ?? console.warn;
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    strict: true,
    options: {
      "app-id": { type: "string" },
      binary: { type: "string", multiple: true },
      "dsym-dir": { type: "string", multiple: true },
      xcode: { type: "boolean", default: false },
      archive: { type: "string" },
      app: { type: "string" },
      strict: { type: "boolean", default: false },
    },
  });
  const explicit = values.binary ?? [];
  const modes = [values.xcode, values.archive !== undefined, values.app !== undefined, explicit.length > 0];
  if (modes.filter(Boolean).length !== 1)
    throw new Error("apple_input_mode: pass exactly one of --xcode, --archive <path>, --app <path> or --binary <path>");
  const dsymDirs = values["dsym-dir"] ?? [];
  if ((values.xcode || values.archive !== undefined) && dsymDirs.length)
    throw new Error("apple_input_mode: --xcode and --archive find their dSYM folders themselves; remove --dsym-dir");
  if ((values.app !== undefined || explicit.length) && !dsymDirs.length)
    throw new Error("missing_required_option: --dsym-dir");
  const strict = symbolsStrict(env, values.strict);
  const failHard = strict || explicit.length > 0;
  const token = env.EVERFRAME_API_TOKEN;

  async function run(): Promise<number> {
    let source: AppleSymbolSource | undefined;
    if (values.xcode) {
      const resolved = await resolveXcodeSource(env);
      if (resolved.kind === "skip") {
        log(`everframe: skipping symbol upload: ${resolved.reason}`);
        return 0;
      }
      source = resolved.source;
    }
    if (!token) {
      if (failHard) throw new Error(MISSING_TOKEN);
      warn(NO_TOKEN_WARNING);
      return 0;
    }
    const appId = values["app-id"] ?? env.EVERFRAME_APP_ID;
    if (!appId) throw new Error("missing_app_id: pass --app-id or set EVERFRAME_APP_ID");
    if (!source) {
      if (values.archive !== undefined) source = await resolveArchiveSource(values.archive);
      else if (values.app !== undefined) source = { binaries: await discoverAppBundle(values.app), dsymDirs };
      else source = { binaries: explicit.map((path) => ({ path, required: true })), dsymDirs };
    }
    const binaries: AppleBinaryInput[] = strict
      ? source.binaries.map((binary) => ({ ...binary, required: true }))
      : source.binaries;
    let result;
    try {
      result = await (deps.upload ?? uploadAppleBuild)({
        appId,
        token,
        apiUrl: env.EVERFRAME_API_URL ?? DEFAULT_API_URL,
        binaries,
        dsymDirs: source.dsymDirs,
      });
    } catch (error) {
      throw values.xcode ? sandboxed(error) : error;
    }
    log(`Symbols for ${result.images.length} images are ready (${result.artifacts.length} dSYM files).`);
    for (const entry of result.uncovered.slice(0, 16))
      warn(
        entry.reason
          ? `warning: no dSYM for ${entry.path}: not a supported 64-bit Mach-O (${entry.reason}); its frames stay raw. Pass --strict to fail instead.`
          : `warning: no dSYM for ${entry.path} (${entry.images.map((i) => `${i.architecture} ${i.uuid}`).join(", ")}); its frames stay raw. Prebuilt frameworks need their vendor's dSYMs; pass --strict to fail instead.`
      );
    if (result.uncovered.length > 16) warn(`warning: and ${result.uncovered.length - 16} more binaries without dSYMs`);
    return 0;
  }

  try {
    return await run();
  } catch (error) {
    if (failHard) throw error;
    const message = error instanceof Error ? error.message : "upload_failed";
    for (const line of uploadFailureWarnings(adviceFor(message), token)) warn(line);
    return 0;
  }
}
