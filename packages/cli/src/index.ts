// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { detectBuildVcs } from '@everframe/build-tools';
import { parseArgs } from 'node:util';
import { DevicePlatformSchema } from '@everframe/protocol';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { collectStagedBuild } from './build-collect.js';
import { adviceFor, verifyStagedBuild } from './build-verify.js';
import { collectHermesBuild } from './hermes.js';
import { collectBuild } from './manifest.js';
import { dsymUploadBuildCommand } from './apple-command.js';
import { DEFAULT_API_URL, redact, uploadBudget } from './defaults.js';
import { homedir } from 'node:os';
import { captureCommand, linkCommand } from './quick-capture/commands.js';
import { defaultOpenBrowser, loginCommand, logoutCommand } from './quick-capture/login.js';
import { defaultRunner, runnerWithTimeout } from './quick-capture/devices.js';
import { ensureHelper, hotkeyCommand } from './quick-capture/hotkey.js';
import {
  DeviceBuildUploadError,
  DeviceBuildWaitTimeoutError,
  getDeviceBuildUpload,
  uploadDeviceBuild,
} from './device-build-upload.js';
import { elfUploadBuildCommand } from './elf-command.js';
import { uploadAndroidElfBuild } from './elf-upload.js';
import { collectElfBuild } from './elf.js';
import { collectDsymBuild } from './dsym.js';
import { collectR8Build } from './r8.js';
import { resolveExpoAppId, uploadExpoExport } from './expo-export.js';
import { setupReactNative } from './setup-react-native.js';
import { setupXcode } from './setup-xcode.js';
import { xcodeBuildPhaseCommand } from './xcode-build-phase.js';
import { symbolsPhaseScript } from './native-setup/index.js';
import { CLI_VERSION } from './version.js';
import { uploadStagedHermes } from './staged-upload.js';
import { uploadBuild, uploadCollectedBuild } from './upload.js';
import { collectVegaBuilds, VEGA_DEFAULT_DIR } from './vega.js';

export type { LocalBuild } from './manifest.js';
export { collectBuild } from './manifest.js';
export type { CollectHermesBuildOptions } from './hermes.js';
export { collectHermesBuild } from './hermes.js';
export { uploadAndroidElfBuild } from './elf-upload.js';
export { collectAndroidElfBuild, inspectElfFile } from './elf-build.js';
export type { ElfBuildImage, CollectedAndroidElfBuild } from './elf-build.js';
export type { CollectElfBuildOptions } from './elf.js';
export { collectElfBuild } from './elf.js';
export type { CollectDsymBuildOptions } from './dsym.js';
export { collectDsymBuild } from './dsym.js';
export type { CollectR8BuildOptions } from './r8.js';
export { collectR8Build } from './r8.js';
export type { CollectedBuildUploadOptions, UploadDependencies, UploadOptions } from './upload.js';
export { uploadBuild, uploadCollectedBuild } from './upload.js';
export { resolveExpoAppId, uploadExpoExport } from './expo-export.js';
export { uploadStagedHermes } from './staged-upload.js';
export type { CollectedVegaBuilds, VegaBuild } from './vega.js';
export { collectVegaBuilds } from './vega.js';

const HELP = `Usage:
  everframe --version
  everframe device-builds upload --app-id <uuid> --platform <ios|tvos|android|android-tv|roku> --file <path> --version <version> --build-number <number> [--commit <full-sha>] [--wait] [--timeout <seconds>] [--json]
  everframe device-builds status --app-id <uuid> --upload-id <uuid> [--json]
  everframe sourcemaps upload --app-id <uuid> --build <id> --dir <path> [--url-prefix <url>] [--delete-after-upload]
  everframe sourcemaps upload-hermes --app-id <uuid> --build <id> --platform <android|ios|vega> --bundle-name <name> --bundle <path> --source-map <path>
  everframe sourcemaps upload-hermes --manifest <dir> --platform <android|ios> --app-id <uuid>
  everframe sourcemaps upload-vega [--app-id <uuid>] [--dir build/lib/rn-bundles/Release]
  everframe upload-expo-export [--dist dist] [--staging .everframe] [--app-id <uuid>]
  everframe setup react-native --app-id <uuid> [--project <dir>]
  everframe setup xcode --project <App.xcodeproj> [--target <name>]... [--app-id <uuid>] [--print-script]
  everframe xcode build-phase --app-id <uuid> [--staging <dir>]   (React Native and Expo Run Script phase)
  everframe dsym upload-build (--xcode | --archive <x.xcarchive> | --app <App.app> --dsym-dir <dir>... | --binary <file>... --dsym-dir <dir>...) [--app-id <uuid>] [--strict]
  everframe dsym upload --app-id <uuid> --dwarf <raw-file>
  everframe elf upload-build (--binaries-dir <dir> [--abi <abi>]... | --binary <file>...) --symbols-dir <dir> [--project-native-dir <dir>]... [--app-id <uuid>] [--summary] [--strict]
  everframe elf upload --app-id <uuid> --library <unstripped-elf>
  everframe r8 upload --app-id <uuid> --mapping-id <id> --mapping <path>
  everframe build collect --staging <dir> --platform <android|ios> --bundle <path> --source-map <path> [--dsym <dir>] [--elf <dir>]
  everframe build verify --staging <dir> --platform <android|ios> [--release] [--allow-missing]
  everframe login [--url <api-url>] [--no-browser]   (sign in for quick capture)
  everframe logout   (revoke and remove your quick capture login)
  everframe link   (copy your login to running Android emulators)
  everframe capture [--device <udid|name|serial>]   (trigger a quick capture on a simulator or emulator)
  everframe hotkey [--key <combo>]   (macOS: capture the Android emulator in front with a global hotkey, default Cmd+Shift+B)

Device builds: uploads are asynchronous by default; --wait observes readiness within a total 600-second budget (override with --timeout).

Build provenance: --commit <full-sha> overrides captured or detected source identity.

Environment:
  EVERFRAME_API_TOKEN  API token with artifacts:write scope (required)
  EVERFRAME_API_URL    API base URL (default: ${DEFAULT_API_URL})
  EVERFRAME_APP_ID     Default application UUID for upload commands
  EVERFRAME_SYMBOLS_STRICT  Set to 1 to fail builds when symbols cannot be uploaded (default: warn)
  EVERFRAME_UPLOAD_TIMEOUT_SECONDS  Overall upload time limit (default 600 for build integrations)
`;

async function quickCaptureCommand(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const { values } = parseArgs({
    args: argv.slice(1),
    strict: true,
    allowPositionals: false,
    options: {
      help: { type: 'boolean', short: 'h' },
      ...(argv[0] === 'capture' ? { device: { type: 'string' as const } } : {}),
      ...(argv[0] === 'hotkey' ? { key: { type: 'string' as const } } : {}),
      ...(argv[0] === 'login'
        ? { url: { type: 'string' as const }, 'no-browser': { type: 'boolean' as const } }
        : {}),
    },
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  const deps = {
    run: defaultRunner,
    env,
    home: homedir(),
    out: (s: string) => console.log(s),
    err: (s: string) => console.error(s),
  };
  if (argv[0] === 'link') return linkCommand(deps);
  if (argv[0] === 'hotkey') {
    const key = (values as { key?: string }).key;
    return hotkeyCommand(
      {
        ...deps,
        // The first build of the Swift helper can outlast the default 15 s runner timeout.
        ensure: () =>
          ensureHelper({
            run: defaultRunner,
            home: deps.home,
            compile: runnerWithTimeout(300_000),
          }),
      },
      key === undefined ? {} : { key },
    );
  }
  if (argv[0] === 'logout') return logoutCommand({ ...deps, fetch });
  if (argv[0] === 'login') {
    const login = values as { url?: string; 'no-browser'?: boolean };
    return loginCommand(
      { ...deps, fetch, openBrowser: defaultOpenBrowser() },
      {
        ...(login.url === undefined ? {} : { url: login.url }),
        ...(login['no-browser'] ? { noBrowser: true } : {}),
      },
    );
  }
  const device = (values as { device?: string }).device;
  return captureCommand(deps, device === undefined ? {} : { device });
}

async function deviceBuildsCommand(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const json = argv.slice(2).includes('--json');
  let appId: string | undefined;
  try {
    const upload = argv[1] === 'upload';
    const { values } = parseArgs({
      args: argv.slice(2),
      strict: true,
      allowPositionals: false,
      options: {
        'app-id': { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        platform: { type: 'string' },
        file: { type: 'string' },
        version: { type: 'string' },
        'build-number': { type: 'string' },
        commit: { type: 'string' },
        wait: { type: 'boolean' },
        timeout: { type: 'string' },
        'upload-id': { type: 'string' },
      },
    });
    if (values.help) {
      console.log(HELP);
      return 0;
    }
    const unsupported = upload
      ? values['upload-id'] !== undefined
      : [
          values.platform,
          values.file,
          values.version,
          values['build-number'],
          values.commit,
          values.wait,
          values.timeout,
        ].some((value) => value !== undefined);
    if (unsupported)
      throw new DeviceBuildUploadError(
        'invalid_input',
        'Options do not match this device-builds command; run everframe --help.',
      );
    appId = values['app-id'] ?? env.EVERFRAME_APP_ID;
    if (!appId)
      throw new DeviceBuildUploadError(
        'invalid_input',
        'Set --app-id or EVERFRAME_APP_ID to the application UUID.',
      );
    const options = {
      appId,
      token: env.EVERFRAME_API_TOKEN ?? '',
      apiUrl: env.EVERFRAME_API_URL ?? DEFAULT_API_URL,
    };
    let status;
    if (upload) {
      const platform = DevicePlatformSchema.safeParse(values.platform);
      if (!platform.success || !values.file || !values.version || !values['build-number'])
        throw new DeviceBuildUploadError(
          'invalid_input',
          'Provide --platform, --file, --version and --build-number.',
        );
      status = await uploadDeviceBuild({
        ...options,
        platform: platform.data,
        file: values.file,
        version: values.version,
        buildNumber: values['build-number'],
        ...(values.commit !== undefined && { commit: values.commit }),
        ...(values.timeout !== undefined && { timeout: Number(values.timeout) }),
        wait: values.wait ?? false,
      });
    } else {
      if (!values['upload-id'])
        throw new DeviceBuildUploadError(
          'invalid_input',
          'Provide --upload-id to observe an upload.',
        );
      status = await getDeviceBuildUpload({ ...options, uploadId: values['upload-id'] });
    }
    const failed = status.state === 'failed' || status.state === 'expired';
    const error =
      status.error ??
      (failed
        ? {
            code: status.state === 'expired' ? 'upload_expired' : 'upload_failed',
            message:
              status.state === 'expired'
                ? 'The upload has expired; start a new upload.'
                : 'Runnable build processing failed.',
          }
        : undefined);
    const output = json
      ? JSON.stringify({ ...status, ...(error && { error }) })
      : `Device build upload ${status.uploadId}: ${status.state}.${status.state === 'ready' ? ` Build ${status.buildId}.` : ''}${error ? ` ${error.code}: ${error.message}` : ''}`;
    console.log(redact(output, env.EVERFRAME_API_TOKEN));
    return failed ? 1 : 0;
  } catch (error) {
    // Parser and unexpected exceptions may contain user input or filesystem details.
    const safe =
      error instanceof DeviceBuildUploadError
        ? error
        : new DeviceBuildUploadError(
            'invalid_input',
            'Invalid device-builds options; run everframe --help.',
          );
    const statusCommand =
      safe.uploadId && appId
        ? `everframe device-builds status --app-id ${appId.toLowerCase()} --upload-id ${safe.uploadId}`
        : undefined;
    const diagnostic =
      safe.message === safe.code || safe.message.startsWith(`${safe.code}:`)
        ? safe.message
        : `${safe.code}: ${safe.message}`;
    const output = json
      ? JSON.stringify({
          ...(safe.uploadId && { uploadId: safe.uploadId }),
          ...(safe.lastStatus && { state: safe.lastStatus.state }),
          error: { code: safe.code, message: safe.message },
          ...(statusCommand && { statusCommand }),
        })
      : `${diagnostic}${safe.uploadId ? ` Upload ID: ${safe.uploadId}.` : ''}${safe.lastStatus ? ` Last known state: ${safe.lastStatus.state}.` : ''}${statusCommand ? ` Continue with: ${statusCommand}` : ''}`;
    const safeOutput = redact(output, env.EVERFRAME_API_TOKEN);
    if (json) console.log(safeOutput);
    else console.error(safeOutput);
    return safe instanceof DeviceBuildWaitTimeoutError ? 2 : 1;
  }
}

export async function main(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    console.log(HELP);
    return 0;
  }
  if (argv.length === 1 && (argv[0] === '--version' || argv[0] === '-v')) {
    console.log(CLI_VERSION);
    return 0;
  }
  const isDeviceBuildCommand =
    argv[0] === 'device-builds' && (argv[1] === 'upload' || argv[1] === 'status');
  const isSourceMapCommand =
    argv[0] === 'sourcemaps' &&
    (argv[1] === 'upload' || argv[1] === 'upload-hermes' || argv[1] === 'upload-vega');
  const isDsymBuildCommand = argv[0] === 'dsym' && argv[1] === 'upload-build';
  const isElfBuildCommand = argv[0] === 'elf' && argv[1] === 'upload-build';
  const isElfCommand = argv[0] === 'elf' && argv[1] === 'upload';
  const isDsymCommand = argv[0] === 'dsym' && argv[1] === 'upload';
  const isR8Command = argv[0] === 'r8' && argv[1] === 'upload';
  const isBuildCommand = argv[0] === 'build' && (argv[1] === 'collect' || argv[1] === 'verify');
  const isExpoExportCommand = argv[0] === 'upload-expo-export';
  const isSetupCommand = argv[0] === 'setup' && argv[1] === 'react-native';
  const isSetupXcodeCommand = argv[0] === 'setup' && argv[1] === 'xcode';
  const isXcodeBuildPhaseCommand = argv[0] === 'xcode' && argv[1] === 'build-phase';
  if (
    argv[0] === 'link' ||
    argv[0] === 'capture' ||
    argv[0] === 'login' ||
    argv[0] === 'logout' ||
    argv[0] === 'hotkey'
  ) {
    try {
      return await quickCaptureCommand(argv, env);
    } catch {
      console.error('invalid_command');
      return 1;
    }
  }
  if (
    !isDeviceBuildCommand &&
    !isSetupCommand &&
    !isXcodeBuildPhaseCommand &&
    !isSetupXcodeCommand &&
    !isSourceMapCommand &&
    !isR8Command &&
    !isDsymCommand &&
    !isElfCommand &&
    !isElfBuildCommand &&
    !isDsymBuildCommand &&
    !isBuildCommand &&
    !isExpoExportCommand
  ) {
    console.error('invalid_command');
    return 1;
  }
  try {
    if (isDeviceBuildCommand) return await deviceBuildsCommand(argv, env);

    if (isXcodeBuildPhaseCommand) {
      if (argv.slice(2).some((arg) => arg === '--help' || arg === '-h')) {
        console.log(HELP);
        return 0;
      }
      return await xcodeBuildPhaseCommand(argv.slice(2), env);
    }

    if (isSetupXcodeCommand) {
      const { values } = parseArgs({
        args: argv.slice(2),
        allowPositionals: false,
        strict: true,
        options: {
          project: { type: 'string' },
          target: { type: 'string', multiple: true },
          'app-id': { type: 'string' },
          'print-script': { type: 'boolean', default: false },
          help: { type: 'boolean', short: 'h' },
        },
      });
      if (values.help) {
        console.log(HELP);
        return 0;
      }
      const appId = values['app-id'];
      if (values['print-script']) {
        console.log(
          `#!/usr/bin/env bash\n${symbolsPhaseScript({ ...(appId && { appId }), cliVersion: CLI_VERSION })}`,
        );
        return 0;
      }
      if (!values.project) throw new Error('missing_required_option: --project');
      const result = await setupXcode({
        project: values.project,
        ...(appId && { appId }),
        ...(values.target && { targets: values.target }),
        cliVersion: CLI_VERSION,
      });
      console.log(
        result.changed
          ? `Updated ${values.project}/project.pbxproj`
          : 'Already set up; no changes.',
      );
      console.log(`"Upload Everframe Symbols" runs last in: ${result.targets.join(', ')}`);
      console.log(
        'ENABLE_USER_SCRIPT_SANDBOXING = NO on those targets: the phase reads embedded frameworks and dSYM folders.',
      );
      if (result.xcodegen)
        console.warn(
          'warning: project.yml found. XcodeGen regenerates this project; add a postBuildScripts entry with the script from `everframe setup xcode --print-script` instead.',
        );
      return 0;
    }

    if (isSetupCommand) {
      const parsed = parseArgs({
        args: argv.slice(2),
        allowPositionals: false,
        strict: true,
        options: {
          'app-id': { type: 'string' },
          project: { type: 'string', default: '.' },
          help: { type: 'boolean', short: 'h' },
        },
      });
      if (parsed.values.help) {
        console.log(HELP);
        return 0;
      }
      const appId = parsed.values['app-id'];
      if (!appId) throw new Error('missing_required_option');
      const { files, metroHint, uploadScript } = await setupReactNative({
        projectRoot: resolve(parsed.values.project),
        appId,
      });
      for (const file of files)
        console.log(file.changed ? `Updated ${file.path}` : `No changes: ${file.path}`);
      if (uploadScript && !uploadScript.installed)
        console.warn(
          `warning: @everframe/cli is not installed in this app, so the Xcode phase's script ${uploadScript.path} does not exist and every build of the app fails until it does. Install @everframe/cli in the app (npm install --save-dev @everframe/cli) and run this command again.`,
        );
      console.log('Add to metro.config.js:');
      console.log(metroHint);
      return 0;
    }

    if (isExpoExportCommand) {
      const parsed = parseArgs({
        args: argv.slice(1),
        allowPositionals: false,
        strict: true,
        options: {
          commit: { type: 'string' },
          dist: { type: 'string', default: 'dist' },
          staging: { type: 'string', default: '.everframe' },
          'app-id': { type: 'string' },
          help: { type: 'boolean', short: 'h' },
        },
      });
      if (parsed.values.help) {
        console.log(HELP);
        return 0;
      }
      const token = env.EVERFRAME_API_TOKEN;
      if (!token) throw new Error('missing_required_option');
      const appId = await resolveExpoAppId(parsed.values['app-id'], env, process.cwd());
      const results = await uploadExpoExport({
        distDir: parsed.values.dist,
        commit: parsed.values.commit,
        stagingDir: parsed.values.staging,
        appId,
        apiUrl: env.EVERFRAME_API_URL ?? DEFAULT_API_URL,
        token,
      });
      for (const { platform, buildUuid } of results)
        console.log(`Source-map build ${buildUuid} is ready (${platform}).`);
      return 0;
    }

    if (isBuildCommand) {
      const parsed = parseArgs({
        args: argv.slice(2),
        allowPositionals: false,
        strict: true,
        options: {
          staging: { type: 'string' },
          platform: { type: 'string' },
          bundle: { type: 'string' },
          'source-map': { type: 'string' },
          dsym: { type: 'string' },
          elf: { type: 'string' },
          release: { type: 'boolean', default: false },
          'allow-missing': { type: 'boolean', default: false },
          help: { type: 'boolean', short: 'h' },
        },
      });
      if (parsed.values.help) {
        console.log(HELP);
        return 0;
      }
      const staging = parsed.values.staging;
      const platform = parsed.values.platform;
      if (!staging || (platform !== 'android' && platform !== 'ios'))
        throw new Error('missing_required_option');

      if (argv[1] === 'collect') {
        const bundlePath = parsed.values.bundle;
        const mapPath = parsed.values['source-map'];
        if (!bundlePath || !mapPath) throw new Error('missing_required_option');
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
          throw new Error(adviceFor(error instanceof Error ? error.message : 'collect_failed'));
        }
        return 0;
      }

      const result = await verifyStagedBuild({
        stagingDir: staging,
        platform,
        release: parsed.values.release,
        allowMissing: parsed.values['allow-missing'],
        hasToken: Boolean(env.EVERFRAME_API_TOKEN),
      });
      for (const warning of result.warnings) console.warn(warning);
      for (const failure of result.failures) console.error(failure);
      return result.ok ? 0 : 1;
    }

    if (isDsymBuildCommand) {
      if (argv.slice(2).some((arg) => arg === '--help' || arg === '-h')) {
        console.log(HELP);
        return 0;
      }
      return await dsymUploadBuildCommand(argv.slice(2), env);
    }

    if (isDsymCommand) {
      const parsed = parseArgs({
        args: argv.slice(2),
        allowPositionals: false,
        strict: true,
        options: {
          commit: { type: 'string' },
          'app-id': { type: 'string' },
          dwarf: { type: 'string' },
          help: { type: 'boolean', short: 'h' },
        },
      });
      if (parsed.values.help) {
        console.log(HELP);
        return 0;
      }
      const appId = parsed.values['app-id'],
        dwarfPath = parsed.values.dwarf,
        token = env.EVERFRAME_API_TOKEN;
      if (!appId || !dwarfPath || !token) throw new Error('missing_required_option');
      const local = await collectDsymBuild({
        dwarfPath,
        vcs: detectBuildVcs({
          projectRoot: process.cwd(),
          ...(parsed.values.commit !== undefined && { commit: parsed.values.commit }),
          env,
        }),
      });
      const result = await uploadCollectedBuild(local, {
        appId,
        root: dirname(resolve(dwarfPath)),
        apiUrl: env.EVERFRAME_API_URL ?? DEFAULT_API_URL,
        token,
        deleteAfterUpload: false,
      });
      console.log(`dSYM ${result.buildUuid} is ready.`);
      return 0;
    }

    if (isElfBuildCommand) {
      if (argv.slice(2).some((arg) => arg === '--help' || arg === '-h')) {
        console.log(HELP);
        return 0;
      }
      return await elfUploadBuildCommand(argv.slice(2), env);
    }

    if (isElfCommand) {
      const parsed = parseArgs({
        args: argv.slice(2),
        allowPositionals: false,
        strict: true,
        options: {
          commit: { type: 'string' },
          'app-id': { type: 'string' },
          library: { type: 'string' },
          help: { type: 'boolean', short: 'h' },
        },
      });
      if (parsed.values.help) {
        console.log(HELP);
        return 0;
      }
      const appId = parsed.values['app-id'],
        libraryPath = parsed.values.library,
        token = env.EVERFRAME_API_TOKEN;
      if (!appId || !libraryPath || !token) throw new Error('missing_required_option');
      const local = await collectElfBuild({
        libraryPath,
        vcs: detectBuildVcs({
          projectRoot: process.cwd(),
          ...(parsed.values.commit !== undefined && { commit: parsed.values.commit }),
          env,
        }),
      });
      const result = await uploadCollectedBuild(local, {
        appId,
        root: dirname(resolve(libraryPath)),
        apiUrl: env.EVERFRAME_API_URL ?? DEFAULT_API_URL,
        token,
        deleteAfterUpload: false,
      });
      console.log(`ELF ${result.buildUuid} is ready.`);
      return 0;
    }

    if (isR8Command) {
      const parsed = parseArgs({
        args: argv.slice(2),
        allowPositionals: false,
        strict: true,
        options: {
          commit: { type: 'string' },
          'app-id': { type: 'string' },
          'mapping-id': { type: 'string' },
          mapping: { type: 'string' },
          help: { type: 'boolean', short: 'h' },
        },
      });
      if (parsed.values.help) {
        console.log(HELP);
        return 0;
      }
      const appId = parsed.values['app-id'];
      const mappingId = parsed.values['mapping-id'];
      const mappingPath = parsed.values.mapping;
      const token = env.EVERFRAME_API_TOKEN;
      if (!appId || !mappingId || !mappingPath || !token)
        throw new Error('missing_required_option');
      const local = await collectR8Build({
        mappingId,
        mappingPath,
        vcs: detectBuildVcs({
          projectRoot: process.cwd(),
          ...(parsed.values.commit !== undefined && { commit: parsed.values.commit }),
          env,
        }),
      });
      const result = await uploadCollectedBuild(
        local,
        {
          appId,
          root: dirname(resolve(mappingPath)),
          apiUrl: env.EVERFRAME_API_URL ?? DEFAULT_API_URL,
          token,
          deleteAfterUpload: false,
        },
        uploadBudget(env, false),
      );
      console.log(`R8 mapping ${result.buildUuid} is ready.`);
      return 0;
    }

    if (argv[1] === 'upload-vega') {
      const parsed = parseArgs({
        args: argv.slice(2),
        allowPositionals: false,
        strict: true,
        options: {
          'app-id': { type: 'string' },
          dir: { type: 'string', default: VEGA_DEFAULT_DIR },
          help: { type: 'boolean', short: 'h' },
        },
      });
      if (parsed.values.help) {
        console.log(HELP);
        return 0;
      }
      const appId = parsed.values['app-id'] ?? env.EVERFRAME_APP_ID;
      const token = env.EVERFRAME_API_TOKEN;
      if (!appId || !token) throw new Error('missing_required_option');
      const dir = parsed.values.dir;
      const { builds, stale } = await collectVegaBuilds(dir);
      for (const bundleId of stale)
        console.log(
          `Skipped ${bundleId}.bundle.map: no JavaScript bundle in ${dir} hashes to it (a map from an earlier build).`,
        );
      if (builds.length === 0) throw new Error('vega_bundle_not_found');
      for (const { bundleId, local } of builds) {
        const result = await uploadCollectedBuild(local, {
          appId,
          root: resolve(dir),
          apiUrl: env.EVERFRAME_API_URL ?? DEFAULT_API_URL,
          token,
          deleteAfterUpload: false,
        });
        console.log(`Source-map build ${result.buildUuid} is ready (Vega bundle ${bundleId}).`);
      }
      return 0;
    }

    if (argv[1] === 'upload-hermes') {
      const parsed = parseArgs({
        args: argv.slice(2),
        allowPositionals: false,
        strict: true,
        options: {
          commit: { type: 'string' },
          'app-id': { type: 'string' },
          build: { type: 'string' },
          platform: { type: 'string' },
          'bundle-name': { type: 'string' },
          bundle: { type: 'string' },
          'source-map': { type: 'string' },
          manifest: { type: 'string' },
          'delete-after-upload': { type: 'boolean', default: false },
          help: { type: 'boolean', short: 'h' },
        },
      });
      if (parsed.values.help) {
        console.log(HELP);
        return 0;
      }
      if (parsed.values['delete-after-upload']) throw new Error('delete_after_upload_unsupported');
      const appId = parsed.values['app-id'];
      const platform = parsed.values.platform;
      const manifestDir = parsed.values.manifest;
      const token = env.EVERFRAME_API_TOKEN;

      let buildId = parsed.values.build;
      let bundleName = parsed.values['bundle-name'];
      let bundlePath = parsed.values.bundle;
      let sourceMapPath = parsed.values['source-map'];

      if (manifestDir !== undefined) {
        if (
          buildId !== undefined ||
          bundlePath !== undefined ||
          bundleName !== undefined ||
          sourceMapPath !== undefined
        )
          throw new Error('manifest_conflicts_with_explicit_options');
        if (platform !== 'android' && platform !== 'ios')
          throw new Error('missing_required_option');
        if (!appId || !token) throw new Error('missing_required_option');
        const result = await uploadStagedHermes(
          {
            stagingDir: manifestDir,
            commit: parsed.values.commit,
            platform,
            appId,
            apiUrl: env.EVERFRAME_API_URL ?? DEFAULT_API_URL,
            token,
          },
          // The RN/Expo build phase sets EVERFRAME_UPLOAD_TIMEOUT_SECONDS.
          uploadBudget(env, false),
        );
        console.log(`Source-map build ${result.buildUuid} is ready.`);
        return 0;
      }

      if (
        !appId ||
        !buildId ||
        (platform !== 'android' && platform !== 'ios' && platform !== 'vega') ||
        !bundleName ||
        !bundlePath ||
        !sourceMapPath ||
        !token
      )
        throw new Error('missing_required_option');
      const local = await collectHermesBuild({
        vcs: detectBuildVcs({
          projectRoot: process.cwd(),
          ...(parsed.values.commit !== undefined && { commit: parsed.values.commit }),
          env,
        }),
        buildId,
        platform,
        bundleName,
        bundlePath,
        sourceMapPath,
      });
      const result = await uploadCollectedBuild(local, {
        appId,
        root: dirname(resolve(sourceMapPath)),
        apiUrl: env.EVERFRAME_API_URL ?? DEFAULT_API_URL,
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
        'app-id': { type: 'string' },
        build: { type: 'string' },
        dir: { type: 'string' },
        'url-prefix': { type: 'string' },
        'delete-after-upload': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h' },
      },
    });
    if (parsed.values.help) {
      console.log(HELP);
      return 0;
    }
    const appId = parsed.values['app-id'];
    const buildId = parsed.values.build;
    const root = parsed.values.dir;
    const urlPrefix = parsed.values['url-prefix'];
    const token = env.EVERFRAME_API_TOKEN;
    if (!appId || !buildId || !root || !token) throw new Error('missing_required_option');
    const local = await collectBuild({ buildId, root, urlPrefix });
    for (const path of local.uncovered) console.log(`Uncovered JavaScript: ${path}`);
    const result = await uploadBuild(
      {
        appId,
        buildId,
        root,
        urlPrefix,
        apiUrl: env.EVERFRAME_API_URL ?? DEFAULT_API_URL,
        token,
        deleteAfterUpload: parsed.values['delete-after-upload'],
      },
      {},
      local,
    );
    console.log(`Source-map build ${result.buildUuid} is ready.`);
    return 0;
  } catch (error) {
    const message = adviceFor(error instanceof Error ? error.message : 'upload_failed');
    const token = env.EVERFRAME_API_TOKEN;
    // upload-build failures list bounded paths and image identities; an R8
    // size failure names the mapping's path.
    const bound = isDsymBuildCommand || isElfBuildCommand ? 8192 : argv[0] === 'r8' ? 1024 : 256;
    console.error((token ? message.split(token).join('[redacted]') : message).slice(0, bound));
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
  if (!argvPath) return '';
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
