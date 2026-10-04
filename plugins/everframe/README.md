<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Everframe plugin for Cursor

Connects Cursor to [Everframe](https://everframe.dev), in-app bug reporting for
web, iOS, Android and TV apps, so the agent can read a bug report's evidence
and fix it without you pasting context into the chat.

## What's included

- **MCP server** (`mcp.json`): the hosted Everframe MCP server at
  `https://everframe.dev/mcp`. Eight read-only tools: `list_projects`,
  `search`, `get_report`, `get_screenshot`, `get_error_group`, `get_ticket`,
  `get_ticket_attachment` and `resolve_link`.
- **Skill** `everframe-bug-triage`: how to go from a report, crash or ticket
  to a fix using those tools.

## Setup

Install the plugin, then connect the `everframe` MCP server. Cursor opens your
browser to sign in to Everframe and approve read-only access. The agent sees
exactly the projects your account can reach.

Self-hosted Everframe: replace the URL in `mcp.json` with your dashboard origin
followed by `/mcp`.

Docs: <https://everframe.dev/docs/mcp/>
