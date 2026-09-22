// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const packageRoot = path.dirname(__filename);

/**
 * Path to the compiled SWC plugin WASM artifact.
 * Pass this to `@swc/core` config: `jsc.experimental.plugins: [[wasmPath, options]]`.
 */
export const wasmPath: string = path.resolve(packageRoot, '..', 'swc_plugin_displayname.wasm');

export default wasmPath;
