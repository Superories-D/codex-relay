# Extensions / MCP verification — 2026-10-18

Source milestone after v0.6.16. Existing release artifacts and the installed
client have not been replaced. No model requests or real account credentials
were used in this work.

## Changes

The previous catalog handler closed its CLI process immediately after each RPC.
An MCP OAuth login returned a URL, then lost the process listening for its browser
callback. Catalog now owns a persistent, serialized app-server connection and
forwards `mcpServer/oauthLogin/completed` through the isolated preload. It drains
on shutdown, reconnects after disconnection only on an explicit new operation,
does not replay failed writes, and refuses replacement if the old process cannot
be confirmed stopped. Changing the configured CLI also closes the old process.

Local Skills, MCP discovery/authentication/resource reads and configuration no
longer require a signed-in OpenAI account. Remote plugin/app/model operations
retain account preparation. MCP tool calls require the managed conversation path,
which supplies its thread ID, rather than an unowned catalog request.

The extension page now follows MCP pagination, passes project paths to plugin
discovery, refreshes Skills after changes, and prevents stale responses from
overwriting another tab. Cards cannot reopen stale data during refresh. MCP
details refresh after authentication and show discovery errors; auth notifications
are associated with server names. Local configured servers can be disabled,
enabled and removed. Duplicate-name additions cannot silently overwrite a server.
Plugin-owned servers do not expose these local-config controls. Added user-facing
labels support English, Japanese and Simplified/Traditional Chinese.

Native shutdown checks also exposed repeated quit requests bypassing asynchronous
cleanup. Main now distinguishes shutdown-in-progress from shutdown-complete;
further quits/window closes wait until all managed cleanup finishes.

## Evidence

- Build/typecheck passed. Full suite: 38 files / 350 tests passed. Seven new tests
  cover connection lifetime, OAuth completion, failed-write non-replay, failed
  process stop, draining, local/account operation separation and MCP pagination.
- `scripts/qa/extensions-native.cjs` passed with actual Electron and Codex CLI
  **0.162.1**, isolated empty-account profiles, local stdio MCP, and a loopback-only
  OAuth/HTTP MCP fixture. Japanese UI was used throughout.
- Native UI discovered, disabled and re-enabled a disk-backed Skill through CLI;
  created/discovered/disabled/re-enabled a stdio MCP server; rejected a duplicate
  name; persisted removals and retained configuration after renderer reload.
- An actual CLI resource read returned the fixture resource. A separate ephemeral
  CLI thread executed `mcpServer/tool/call` and returned the expected echo. No
  `turn/start` or inference request was sent. This validates tool transport, not
  model-driven tool selection or output quality.
- Actual OAuth dynamic registration, authorization redirect, browser callback and
  token exchange completed. The CLI notification reached the Japanese UI and the
  authorized server's tools appeared. Browser launch was intercepted only in the
  QA process and its loopback authorization URL was followed by the test.
- A separate CLI home using a copy of config.toml discovered the authorized HTTP
  server without copying credential files or doing another authorization. This
  proves the tested Windows credential-store/configuration combination, not all
  platforms or credential-store modes.
- A server whose executable arguments referred to a missing fixture file showed
  connection failure in its card and an error in details, and could be removed.
- Repeated app.quit calls completed cleanup and removed the catalog ownership
  record. No renderer errors. The Japanese details screenshot was inspected.
- The first native run found the stale-card race (config was saved correctly but
  old details could be reopened during refresh). The final evidence includes the
  fix; an earlier green unit suite alone did not establish that behavior.

Ignored local evidence: `qa-output/extensions-native-report.json`,
`qa-output/extensions-native-ja.png`, isolated `extensions-native-*` profiles.
Fixture tokens are synthetic; no existing installed profile was opened or changed.
The repeatable MCP fixtures live under `tests/fixtures/`.

## Remaining gates

Remote marketplace installation/uninstallation, plugin interstitials and required
app authentication remain unaccepted. The local OAuth fixture does not prove
third-party provider-specific OAuth behavior or expired-token refresh under
parallel tasks. Real model-driven MCP use, permission/elicitation flows, plugin
tools in subagents and cross-account relay still require bounded acceptance.
Existing conversations keep their own configuration snapshot; changing the global
catalog is not proof of hot reconfiguration of already running conversations.
The broader release-readiness goal remains active; this source milestone is not
a new packaged release.
