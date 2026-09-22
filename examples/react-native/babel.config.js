// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Babel config for the dogfood sample (Plan 06-06).
//
// PITFALL P11 (06-RESEARCH §8.5): @traceitx/babel-plugin-displayname MUST run
// before the preset's JSX transform strips component names in release builds.
// Babel runs plugins[] BEFORE presets by spec, so listing the plugin under
// `plugins` is sufficient — the plugin sees AST with original component
// identifiers and annotates `displayName` so the bippy reactTree walker
// (06-04) and the iOS/Android UITree walkers can correlate JS components
// with native views.

module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: ['@traceitx/babel-plugin-displayname'],
  };
};
