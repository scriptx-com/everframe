// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Metro config for the @everframe/react-native dogfood sample (Plan 06-06).
//
// pnpm workspace integration:
//
//   - watchFolders hoists the workspace `packages/` tree so Metro re-bundles
//     when @everframe/react-native (or any sibling) changes.
//   - unstable_enableSymlinks: true tells Metro to follow pnpm's symlinks
//     (workspace packages live at `packages/foo` and are linked into
//     consuming packages via `node_modules/@everframe/foo`).
//   - disableHierarchicalLookup: true prevents Metro from walking up into
//     the pnpm virtual store (`.pnpm/`) which would otherwise duplicate
//     `react` / `react-native` and cause "version mismatch" / "Multiple copies
//     of React detected" runtime errors.
//   - extraNodeModules explicitly maps the workspace `@everframe/*` packages
//     (and the singletons `react` / `react-native`) so Metro can find them
//     regardless of which package's `dist/index.js` is doing the import.
//     This is the canonical fix for the "@everframe/react could not be
//     found" failure when bundling @everframe/react-native (which imports
//     sibling workspace packages).

const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(__dirname, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [path.resolve(workspaceRoot, 'packages')];

config.resolver.unstable_enableSymlinks = true;
config.resolver.disableHierarchicalLookup = true;
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

config.resolver.extraNodeModules = {
  // Workspace siblings — Metro resolves these regardless of which package
  // tree is doing the import. Otherwise nested workspace deps (e.g.
  // sdk-react-native importing sdk-react) fail when Metro can't walk into
  // packages/sdk-react-native/node_modules under disableHierarchicalLookup.
  '@everframe/react-native': path.resolve(workspaceRoot, 'packages/sdk-react-native'),
  '@everframe/react': path.resolve(workspaceRoot, 'packages/sdk-react'),
  '@everframe/sdk-core': path.resolve(workspaceRoot, 'packages/sdk-core'),
  '@everframe/protocol': path.resolve(workspaceRoot, 'packages/protocol'),

  // Singletons — react and react-native MUST resolve to the same physical
  // package across all imports, otherwise dev-time hooks/Fabric break.
  // Pinned to the workspace-root-hoisted copy (pnpm hoists them there since
  // the app declares them as direct deps) to avoid the second copy at
  // packages/sdk-react-native/node_modules/react-native (a pnpm-resolved
  // peer used only for the SDK's own typecheck/build).
  react: path.resolve(workspaceRoot, 'node_modules/react'),
  'react-native': path.resolve(workspaceRoot, 'node_modules/react-native'),
};

module.exports = config;
