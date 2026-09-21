// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
// PascalCase class that does NOT extend a React base class — must NOT be tagged.
class Logger {
  log(msg: string) {
    console.log(msg);
  }
}
class CacheLine extends Map<string, number> {}
export { Logger, CacheLine };
