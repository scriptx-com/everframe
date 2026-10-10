// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { checkedAppId, sandboxCheck } from "./script.js";

export const SYMBOLS_PHASE_NAME = "Upload Everframe Symbols";
/** Declared inputs order the phase after dSYM generation and Info.plist processing. */
export const SYMBOLS_PHASE_INPUTS = [
  '"$(DWARF_DSYM_FOLDER_PATH)/$(DWARF_DSYM_FILE_NAME)/Contents/Resources/DWARF/$(EXECUTABLE_NAME)"',
  '"$(TARGET_BUILD_DIR)/$(INFOPLIST_PATH)"',
];
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export interface XcodeSymbolsProject {
  pbxNativeTargetSection(): unknown;
  pbxXCConfigurationList(): unknown;
  pbxXCBuildConfigurationSection(): unknown;
  addBuildPhase(
    files: string[],
    type: string,
    name: string,
    target: string,
    options: { shellPath: string; shellScript: string; inputPaths?: string[] },
  ): unknown;
  hash: { project: { objects: Record<string, Record<string, unknown> | undefined> } };
}
type NativeTarget = {
  name?: string;
  productType?: string;
  buildConfigurationList?: string;
  buildPhases?: Array<{ value: string; comment?: string }>;
};
type ShellPhase = { shellScript?: string; inputPaths?: string[]; alwaysOutOfDate?: number };
const unquote = (value: string | undefined) => value?.replace(/^"(.*)"$/, "$1");

/**
 * The Run Script body. It never fails the build by default: Debug builds and
 * builds without EVERFRAME_API_TOKEN skip before starting Node, and a missing
 * Node or a failed CLI run becomes a `warning:` line. EVERFRAME_SYMBOLS_STRICT=1
 * makes both fail. One command per line: `\` continuations do not survive
 * pbxproj embedding.
 */
export function symbolsPhaseScript(options: { appId?: string; cliVersion: string }): string {
  if (!VERSION.test(options.cliVersion)) throw new Error(`invalid_cli_version: ${options.cliVersion}`);
  const appId = options.appId === undefined ? "" : ` --app-id "${checkedAppId(options.appId)}"`;
  const upload = `dsym upload-build --xcode${appId}`;
  return [
    "set -uo pipefail",
    'if [ "${CONFIGURATION:-}" = "Debug" ] && [ "${EVERFRAME_UPLOAD_DEBUG:-}" != "1" ]; then',
    '  echo "everframe: skipping symbol upload: Debug configuration (set EVERFRAME_UPLOAD_DEBUG=1 to upload Debug symbols)"',
    "  exit 0",
    "fi",
    'EVERFRAME_STRICT=0; case "${EVERFRAME_SYMBOLS_STRICT:-}" in 1|true) EVERFRAME_STRICT=1;; esac',
    'if [ -z "${EVERFRAME_API_TOKEN:-}" ] && [ "$EVERFRAME_STRICT" = 0 ]; then',
    '  echo "warning: everframe: no EVERFRAME_API_TOKEN, skipping symbol upload. Crashes from this build will show raw addresses. Set EVERFRAME_API_TOKEN to a token with the artifacts:write scope, or set EVERFRAME_SYMBOLS_STRICT=1 to fail the build instead."',
    "  exit 0",
    "fi",
    ...sandboxCheck(),
    // The project's env files are not ours to hold to `set -u`.
    "set +u",
    'if [ -f "$SRCROOT/.xcode.env" ]; then . "$SRCROOT/.xcode.env"; fi',
    'if [ -f "$SRCROOT/.xcode.env.local" ]; then . "$SRCROOT/.xcode.env.local"; fi',
    "set -u",
    'export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"',
    'EVERFRAME_NODE="${NODE_BINARY:-node}"',
    `if [ -z "\${EVERFRAME_CLI_JS:-}" ]; then EVERFRAME_CLI_JS="$(cd "$SRCROOT" && "$EVERFRAME_NODE" -p "require.resolve('@everframe/cli')" 2>/dev/null || true)"; fi`,
    "EVERFRAME_STATUS=0",
    `if [ -n "$EVERFRAME_CLI_JS" ]; then "$EVERFRAME_NODE" "$EVERFRAME_CLI_JS" ${upload} || EVERFRAME_STATUS=$?; else npx --yes "@everframe/cli@${options.cliVersion}" ${upload} || EVERFRAME_STATUS=$?; fi`,
    'if [ "$EVERFRAME_STATUS" != 0 ] && [ "$EVERFRAME_STRICT" = 0 ]; then',
    '  echo "warning: everframe: the symbol upload stopped with exit status $EVERFRAME_STATUS. Crashes from this build will show raw addresses until its symbols are uploaded. Set EVERFRAME_SYMBOLS_STRICT=1 to fail the build instead."',
    "  exit 0",
    "fi",
    'exit "$EVERFRAME_STATUS"',
  ].join("\n");
}

/** Adds or refreshes the last Run Script phase of each selected application target. */
export function patchXcodeProjectForSymbols(
  project: XcodeSymbolsProject,
  options: { appId?: string; cliVersion: string; targets?: string[] },
): string[] {
  const script = symbolsPhaseScript(options);
  const section = project.pbxNativeTargetSection() as Record<string, NativeTarget | string>;
  const apps = Object.entries(section).filter(
    (entry): entry is [string, NativeTarget] =>
      typeof entry[1] === "object" && unquote(entry[1].productType) === "com.apple.product-type.application",
  );
  const names = apps.map(([, t]) => unquote(t.name)).join(", ") || "none";
  const selected = options.targets?.length
    ? options.targets.map((name) => {
        const found = apps.find(([, t]) => unquote(t.name) === name);
        if (!found) throw new Error(`xcode_target_not_found: ${name} is not an application target (found: ${names})`);
        return found;
      })
    : apps;
  if (!selected.length) throw new Error("xcode_application_target_missing: the project has no application target");
  const shellPhases = (project.hash.project.objects.PBXShellScriptBuildPhase ??= {}) as Record<string, unknown>;
  for (const [uuid, target] of selected) {
    const phases = (target.buildPhases ??= []);
    const existing = phases.find((p) => p.comment === SYMBOLS_PHASE_NAME);
    if (existing) {
      const phase = shellPhases[existing.value] as ShellPhase | undefined;
      if (!phase) throw new Error(`xcode_phase_corrupt: ${SYMBOLS_PHASE_NAME} in ${unquote(target.name)}`);
      // Same quoting addBuildPhase applies, so an unchanged script serializes identically.
      phase.shellScript = `"${script.replace(/"/g, '\\"')}"`;
      phase.inputPaths = [...SYMBOLS_PHASE_INPUTS];
      phase.alwaysOutOfDate = 1;
      phases.splice(phases.indexOf(existing), 1);
      phases.push(existing);
    } else {
      const added = project.addBuildPhase([], "PBXShellScriptBuildPhase", SYMBOLS_PHASE_NAME, uuid, {
        shellPath: "/bin/bash",
        shellScript: script,
        inputPaths: [...SYMBOLS_PHASE_INPUTS],
      }) as { buildPhase?: ShellPhase } | undefined;
      if (added?.buildPhase) added.buildPhase.alwaysOutOfDate = 1;
    }
    const lists = project.pbxXCConfigurationList() as Record<string, { buildConfigurations?: Array<{ value: string }> }>;
    const configs = project.pbxXCBuildConfigurationSection() as Record<string, { buildSettings?: Record<string, string> } | string>;
    for (const ref of (target.buildConfigurationList && lists[target.buildConfigurationList]?.buildConfigurations) || []) {
      const config = configs[ref.value];
      if (!config || typeof config === "string") continue;
      (config.buildSettings ??= {}).ENABLE_USER_SCRIPT_SANDBOXING = "NO";
    }
  }
  return selected.map(([, target]) => unquote(target.name) ?? "");
}
