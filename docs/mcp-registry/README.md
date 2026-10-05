<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# MCP Registry listing

`server.json` is the source of Everframe's entry in the official
[MCP Registry](https://registry.modelcontextprotocol.io), published as
`dev.everframe/everframe`.

Everframe's MCP server is hosted, so the listing has no package: it is a single
Streamable HTTP remote at `https://everframe.dev/mcp`, and clients authorize
with OAuth in the browser. See the [MCP docs](https://everframe.dev/docs/mcp/)
for how to connect Claude Code, Cursor, VS Code or Zed.

The registry only accepts versions published by the owner of `everframe.dev`.
Changes to this file take effect when a maintainer publishes a new `version`;
merging a change here does not update the registry on its own.
