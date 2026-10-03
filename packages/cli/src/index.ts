// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { parseArgs } from "node:util";
import type { StagedBuild } from "@everframe/protocol";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { collectStagedBuild } from "./build-collect.js";
import { adviceFor, verifyStagedBuild } from "./build-verify.js";
import { collectHermesBuild } from "./hermes.js";
import { collectBuild } from "./manifest.js";
import { collectR8Build } from "./r8.js";
import { readComplete, readPointer } from "./staging-io.js";
import { uploadBuild, uploadCollectedBuild } from "./upload.js";

export type { LocalBuild } from "./manifest.js";
export { collectBuild } from "./manifest.js";
export type { CollectHermesBuildOptions } from "./hermes.js";
export { collectHermesBuild } from "./hermes.js";
export type { CollectR8BuildOptions } from "./r8.js";
export { collectR8Build } from "./r8.js";
export type {
  CollectedBuildUploadOptions,
  UploadDependencies,
  UploadOptions,
} from "./upload.js";
export { uploadBuild, uploadCollectedBuild } from "./upload.js";

const HELP = `Usage:
  everframe sourcemaps upload --app-id <uuid> --build <id> --dir <path> --url-prefix <url> [--delete-after-upload]
  everframe sourcemaps upload-hermes --app-id <uuid> --build <id> --platform <android|ios> --bundle-name <name> --bundle <path> --source-map <path>
  everframe sourcemaps upload-hermes --manifest <dir> --platform <android|ios> --app-id <uuid>
  everframe r8 upload --app-id <uuid> --mapping-id <id> --mapping <path>
  everframe build collect --staging <dir> --platform <android|ios> --bundle <path> --source-map <path> [--dsym <dir>] [--elf <dir>]
  everframe build verify --staging <dir> --platform <android|ios> [--release] [--allow-missing]

Environment:
  EVERFRAME_API_TOKEN  API token with artifacts:write scope (required)
  EVERFRAME_API_URL    API base URL (default: https://api.everframe.dev/api/v1)
`;

export async function main(
  argv: string[],
  env: NodeJS.ProcessEnv,
): Promise<number> {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    console.log(HELP);
    return 0;
  }
  const isSourceMapCommand =
    argv[0] === "sourcemaps" &&
    (argv[1] === "upload" || argv[1] === "upload-hermes");
  const isR8Command = argv[0] === "r8" && argv[1] === "upload";
  const isBuildCommand =
    argv[0] === "build" && (argv[1] === "collect" || argv[1] === "verify");
  if (!isSourceMapCommand && !isR8Command && !isBuildCommand) {
    console.error("invalid_command");
    return 1;
  }
  try {
    if (isBuildCommand) {
      const parsed = parseArgs({
        args: argv.slice(2),
        allowPositionals: false,
        strict: true,
        options: {
          staging: { type: "string" },
          platform: { type: "string" },
          bundle: { type: "string" },
          "source-map": { type: "string" },
          dsym: { type: "string" },
          elf: { type: "string" },
          release: { type: "boolean", default: false },
          "allow-missing": { type: "boolean", default: false },
          help: { type: "boolean", short: "h" },
        },
      });
      if (parsed.values.help) {
        console.log(HELP);
        return 0;
      }
      const staging = parsed.values.staging;
      const platform = parsed.values.platform;
      if (!staging || (platform !== "android" && platform !== "ios"))
        throw new Error("missing_required_option");

      if (argv[1] === "collect") {
        const bundlePath = parsed.values.bundle;
        const mapPath = parsed.values["source-map"];
        if (!bundlePath || !mapPath)
          throw new Error("missing_required_option");
        const dsymDir = parsed.values.dsym;
        const elfDir = parsed.values.elf;
        try {
          await collectStagedBuild({
            stagingDir: staging,
            platform,
            bundlePath,
            mapPath,
            ...(dsymDir !== undefined && { dsymDir }),
            ...(elfDir !== undefined && { elfDir }),
          });
        } catch (error) {
          // collect runs under the build phase's `set -e`, so it aborts the
          // script before `build verify` can offer its advice. Render the
          // same advice here instead of a bare code (or a raw Node errno).
          throw new Error(
            adviceFor(error instanceof Error ? error.message : "collect_failed"),
          );
        }
        return 0;
      }

      const result = await verifyStagedBuild({
        stagingDir: staging,
        platform,
        release: parsed.values.release,
        allowMissing: parsed.values["allow-missing"],
        hasToken: Boolean(env.EVERFRAME_API_TOKEN),
      });
      for (const warning of result.warnings) console.warn(warning);
      for (const failure of result.failures) console.error(failure);
      return result.ok ? 0 : 1;
    }

    if (isR8Command) {
      const parsed = parseArgs({
        args: argv.slice(2),
        allowPositionals: false,
        strict: true,
        options: {
          "app-id": { type: "string" },
          "mapping-id": { type: "string" },
          mapping: { type: "string" },
          help: { type: "boolean", short: "h" },
        },
      });
      if (parsed.values.help) {
        console.log(HELP);
        return 0;
      }
      const appId = parsed.values["app-id"];
      const mappingId = parsed.values["mapping-id"];
      const mappingPath = parsed.values.mapping;
      const token = env.EVERFRAME_API_TOKEN;
      if (!appId || !mappingId || !mappingPath || !token)
        throw new Error("missing_required_option");
      const local = await collectR8Build({ mappingId, mappingPath });
      const result = await uploadCollectedBuild(local, {
        appId,
        root: dirname(resolve(mappingPath)),
        apiUrl: env.EVERFRAME_API_URL ?? "https://api.everframe.dev/api/v1",
        token,
        deleteAfterUpload: false,
      });
      console.log(`R8 mapping ${result.buildUuid} is ready.`);
      return 0;
    }

    if (argv[1] === "upload-hermes") {
      const parsed = parseArgs({
        args: argv.slice(2),
        allowPositionals: false,
        strict: true,
        options: {
          "app-id": { type: "string" },
          build: { type: "string" },
          platform: { type: "string" },
          "bundle-name": { type: "string" },
          bundle: { type: "string" },
          "source-map": { type: "string" },
          manifest: { type: "string" },
          "delete-after-upload": { type: "boolean", default: false },
          help: { type: "boolean", short: "h" },
        },
      });
      if (parsed.values.help) {
        console.log(HELP);
        return 0;
      }
      if (parsed.values["delete-after-upload"])
        throw new Error("delete_after_upload_unsupported");
      const appId = parsed.values["app-id"];
      const platform = parsed.values.platform;
      const manifestDir = parsed.values.manifest;
      const token = env.EVERFRAME_API_TOKEN;

      let buildId = parsed.values.build;
      let bundleName = parsed.values["bundle-name"];
      let bundlePath = parsed.values.bundle;
      let sourceMapPath = parsed.values["source-map"];
      let staged: StagedBuild | undefined;

      if (manifestDir !== undefined) {
        if (
          buildId !== undefined ||
          bundlePath !== undefined ||
          bundleName !== undefined ||
          sourceMapPath !== undefined
        )
          throw new Error("manifest_conflicts_with_explicit_options");
        if (platform !== "android" && platform !== "ios")
          throw new Error("missing_required_option");
        const pointerBuildId = await readPointer(manifestDir, platform);
        staged = await readComplete(manifestDir, pointerBuildId);
        buildId = staged.buildId;
        bundleName = staged.bundleName;
        bundlePath = staged.bundlePath;
        sourceMapPath = staged.mapPath;
      }

      if (
        !appId ||
        !buildId ||
        (platform !== "android" && platform !== "ios") ||
        !bundleName ||
        !bundlePath ||
        !sourceMapPath ||
        !token
      )
        throw new Error("missing_required_option");
      const local = await collectHermesBuild({
        buildId,
        platform,
        bundleName,
        bundlePath,
        sourceMapPath,
      });
      // `build collect` hashed the bundle and the map the moment hermesc
      // finished; `collectHermesBuild` above re-hashed whatever is on disk
      // now. If those disagree, something rewrote an artifact between the
      // two steps and the map no longer describes the bytecode being
      // uploaded — the exact "map came from a different run than the
      // binary" failure this staging pipeline exists to prevent. Refuse
      // rather than publish a silently-mismatched pair.
      if (staged) {
        const artifact = local.manifest.artifacts[0];
        if (!artifact) throw new Error("invalid_local_build");
        if (artifact.generatedSha256 !== staged.generatedSha256)
          throw new Error(adviceFor("staged_bundle_changed"));
        if (
          artifact.mapSha256 !== staged.mapSha256 ||
          artifact.mapBytes !== staged.mapBytes
        )
          throw new Error(adviceFor("staged_source_map_changed"));
      }
      const result = await uploadCollectedBuild(local, {
        appId,
        root: dirname(resolve(sourceMapPath)),
        apiUrl: env.EVERFRAME_API_URL ?? "https://api.everframe.dev/api/v1",
        token,
        deleteAfterUpload: false,
      });
      console.log(`Source-map build ${result.buildUuid} is ready.`);
      return 0;
    }

    const parsed = parseArgs({
      args: argv.slice(2),
      allowPositionals: false,
      strict: true,
      options: {
        "app-id": { type: "string" },
        build: { type: "string" },
        dir: { type: "string" },
        "url-prefix": { type: "string" },
        "delete-after-upload": { type: "boolean", default: false },
        help: { type: "boolean", short: "h" },
      },
    });
    if (parsed.values.help) {
      console.log(HELP);
      return 0;
    }
    const appId = parsed.values["app-id"];
    const buildId = parsed.values.build;
    const root = parsed.values.dir;
    const urlPrefix = parsed.values["url-prefix"];
    const token = env.EVERFRAME_API_TOKEN;
    if (!appId || !buildId || !root || !urlPrefix || !token)
      throw new Error("missing_required_option");
    const local = await collectBuild({ buildId, root, urlPrefix });
    for (const path of local.uncovered)
      console.log(`Uncovered JavaScript: ${path}`);
    const result = await uploadBuild(
      {
        appId,
        buildId,
        root,
        urlPrefix,
        apiUrl: env.EVERFRAME_API_URL ?? "https://api.everframe.dev/api/v1",
        token,
        deleteAfterUpload: parsed.values["delete-after-upload"],
      },
      {},
      local,
    );
    console.log(`Source-map build ${result.buildUuid} is ready.`);
    return 0;
  } catch (error) {
    console.error(
      error instanceof Error ? error.message.slice(0, 256) : "upload_failed",
    );
    return 1;
  }
}

// When invoked through the package's `bin` entry, `process.argv[1]` is the
// symlink path (e.g. `node_modules/.bin/everframe`) while `import.meta.url` is
// the realpath of the file actually executing (e.g.
// `node_modules/@everframe/cli/dist/index.js`). Comparing the raw argv path
// against `import.meta.url` therefore never matches for the documented
// invocation, and `main` silently never runs. Resolve symlinks on the argv
// side before comparing so both sides refer to the same real file.
function invokedFileUrl(): string {
  const argvPath = process.argv[1];
  if (!argvPath) return "";
  let resolvedPath = argvPath;
  try {
    resolvedPath = realpathSync(argvPath);
  } catch {
    // The path may no longer exist (e.g. deleted between process start and
    // now); fall back to the unresolved value rather than crashing.
  }
  return pathToFileURL(resolvedPath).href;
}

if (import.meta.url === invokedFileUrl())
  process.exitCode = await main(process.argv.slice(2), process.env);
