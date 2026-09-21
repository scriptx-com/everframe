<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# DisplayName Cases — Single Source of Truth

This table enumerates every input pattern both `@traceitx/babel-plugin-displayname` and `@traceitx/swc-plugin-displayname` MUST handle. Snapshot tests in BOTH plugins reference these cases; CI lints for case-count parity.

| Case ID | Input pattern | Expected displayName insertion | Notes |
|---------|---------------|-------------------------------|-------|
| forwardref | `const Foo = forwardRef((p, r) => null)` | `Foo.displayName = "Foo"` | basic forwardRef |
| memo | `const Bar = memo(() => null)` | `Bar.displayName = "Bar"` | basic memo |
| forwardref-memo | `const Baz = memo(forwardRef((p, r) => null))` | `Baz.displayName = "Baz"` | nested factory |
| function-decl | `function Comp() { return null; }` | `Comp.displayName = "Comp"` | uppercase-leading function decl |
| function-decl-lowercase | `function helper() {}` | (no insertion) | lowercase-leading function — heuristic skips |
| already-set | `const Pre = forwardRef(...); Pre.displayName = "Custom";` | (no duplicate insertion) | user-explicit set wins |
| plain-arrow | `const Plain = () => null` | (no insertion) | NOT a factory call; skipped |

NOTE: `arrow-component` pattern is intentionally NOT auto-handled in v1 — only factory-wrapped arrows get displayName. Direct arrow components rely on terser's function-name preservation. Document in plugin README.
