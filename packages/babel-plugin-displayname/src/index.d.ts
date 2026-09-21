// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import type { PluginObj } from '@babel/core';

interface BabelPluginDisplayNameOptions {
  factories?: string[];
  debug?: boolean;
}

declare const babelPluginDisplayName: (babel: any, options?: BabelPluginDisplayNameOptions) => PluginObj;

// `export =`, not `export default`: src/index.cjs assigns `module.exports =
// <function>` directly, so `require()` yields the function itself. Declaring
// a default export made TypeScript under node16 believe an extra `.default`
// access was needed — types that disagree with the runtime in exactly the way
// that fails at call time. `export =` is the shape that matches
// `module.exports =`, and it is what @babel/core's CJS loader actually gets.
export = babelPluginDisplayName;
declare namespace babelPluginDisplayName {
  export type { BabelPluginDisplayNameOptions };
}
