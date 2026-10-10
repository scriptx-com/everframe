// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { parseArgs } from "node:util";
import { adviceFor } from "./build-verify.js";
import { DEFAULT_API_URL, MISSING_TOKEN, NO_TOKEN_WARNING, symbolsStrict, uploadFailureWarnings } from "./defaults.js";
import { discoverElfBinaries, type ElfBinaryInput } from "./elf-build.js";
import { uploadAndroidElfBuild } from "./elf-upload.js";

export interface ElfCommandDependencies {
  upload?: typeof uploadAndroidElfBuild;
  log?: (line: string) => void;
  warn?: (line: string) => void;
}

/**
 * `--binaries-dir` is the build integration (the Gradle plugin uses it): it
 * discovers every shipped library, treats them as optional, and unless strict
 * turns a missing token or an upload failure into `warning:` lines with exit 0.
 * The explicit `--binary` list is a manual command and stays strict.
 */
export async function elfUploadBuildCommand(
  args: string[],
  env: NodeJS.ProcessEnv,
  deps: ElfCommandDependencies = {}
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
      "binaries-dir": { type: "string" },
      "symbols-dir": { type: "string" },
      strict: { type: "boolean", default: false },
    },
  });
  const explicit = values.binary ?? [],
    directory = values["binaries-dir"];
  if ((explicit.length > 0) === (directory !== undefined))
    throw new Error("elf_input_mode: pass either --binaries-dir <dir> or --binary <path>...");
  const symbolsDir = values["symbols-dir"];
  if (!symbolsDir) throw new Error("missing_required_option: --symbols-dir");
  const strict = symbolsStrict(env, values.strict);
  const failHard = strict || explicit.length > 0;
  const token = env.EVERFRAME_API_TOKEN;

  async function run(): Promise<number> {
    let binaries: ElfBinaryInput[];
    if (explicit.length) binaries = explicit.map((path) => ({ path, required: true }));
    else {
      binaries = (await discoverElfBinaries(directory!)).map((path) => ({ path, required: strict }));
      if (!binaries.length) {
        log(`No native libraries under ${directory}; nothing to upload.`);
        return 0;
      }
    }
    if (!token) {
      if (failHard) throw new Error(MISSING_TOKEN);
      warn(NO_TOKEN_WARNING);
      return 0;
    }
    const appId = values["app-id"] ?? env.EVERFRAME_APP_ID;
    if (!appId) throw new Error("missing_app_id: pass --app-id or set EVERFRAME_APP_ID");
    const result = await (deps.upload ?? uploadAndroidElfBuild)({
      appId,
      token,
      apiUrl: env.EVERFRAME_API_URL ?? DEFAULT_API_URL,
      binaries,
      symbolsDir: symbolsDir!,
    });
    log(`Symbols for ${result.images.length} images are ready (${result.artifacts.length} ELF files).`);
    for (const entry of result.uncovered.slice(0, 16))
      warn(`warning: no symbols for ${entry.path}: ${entry.reason}; its frames stay raw.`);
    if (result.uncovered.length > 16) warn(`warning: and ${result.uncovered.length - 16} more libraries without symbols`);
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
