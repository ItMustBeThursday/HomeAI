# Migrating from OpenClaw to the orchestrator

Status as of 2026-10-15: **everything below is checked from the orchestrator side, but OpenClaw has NOT been removed or
disabled.** Adam signs off on cutover; nothing here changes OpenClaw.

## What the orchestrator already replaces

| OpenClaw feature | Orchestrator equivalent | Verified |
|---|---|---|
| Model routing (Claude, Codex, local) | `config/routes.json` routes, fallback chains, budgets | live check |
| Chat UI | WebUI Chat tab, streaming + Stop | API verified; page not click-tested (browser tool blocks localhost) |
| Image input | Attach/paste/drop in WebUI; `images` on the API; `images` in MCP `ask`/`chat` | live check (Claude and local vision read a red test image) |
| Shell / run programs / tests | Terminal and Projects tabs, `/api/exec`, MCP `shell`, `run_tests` | live check |
| Coding agent | `agent` route (Claude or Codex inside a registered project) | live check |
| GitHub | Projects tab + `/api/github*` (reads, issues, comments), publish via project `sync` command | live check (read) |
| Automations | `config/schedule.json` + Schedule tab (the 2 old OpenClaw automations were disabled) | tests |
| Memory notes | Memory tab, `/api/memory`, injected per route (`"memory": true`) | live check |
| Claude uses it directly | MCP server `src/mcp.mjs` (15 tools), registered as `homeai` (user scope) | stdio session |
| Codex independent of OpenClaw | `D:\HomeAI\runtime\codex` standalone install | live check |
| Network access | scoped device tokens, host allow-list, optional Tailscale (see README "Network access") | tests; remote use not tried |

## Not migrated yet (decide before cutover)

1. **Companion apps** (desktop, Android, remote) still talk to the OpenClaw gateway
   (`homeai-companion/desktop/src/core/gateway-client.mjs`, the remote bridge, docs). Per the plan they are updated last.
   The public companion endpoint (Tailscale Funnel on :8443 -> the bridge) must keep working until they are ported.
   Disable with `tailscale funnel --https=8443 off` only after that.
2. **HomeAI plugins** inside OpenClaw (workbench, jobs, autonomy, execution) and the local-model maintenance tools
   (`homeai_maintain`, model staging/locking) have no orchestrator equivalent. Decide which, if any, to port.
3. **Logan** menus/feed: placeholder tab only (Phase 3).
4. **OpenClaw channels:** none were configured, so nothing to move.
5. **Tailscale serve** also exposes OpenClaw's gateway (tailnet-only, port 443). Re-point or remove at cutover.

## Memory notes

Imported into the orchestrator memory store (idempotent, keyed by `source: migrated:<slug>`): operating rules (from
SOUL.md), OneDrive exclusion, hardware/preferences, orchestrator goal, Logan menus, Codex notes, companion endpoint.
The import script and its content live outside the public repo at `D:\HomeAI\state\migration\import-memory.mjs`.
Claude's own file memory and OpenClaw's `MEMORY.md`/`USER.md` are left untouched.

## Cutover checklist (when Adam says go)

- [ ] `node scripts/live-check.mjs` passes against the running service.
- [ ] Back up `D:\HomeAI\state\openclaw` and the OpenClaw config (`openclaw.json`).
- [ ] Companion apps ported and verified against the orchestrator (item 1).
- [ ] Decide on item 2 (plugins).
- [ ] Stop the OpenClaw gateway; keep files for 30 days; remove its Tailscale serve entry.
- [ ] Leave `HomeAI-Orchestrator-Autostart` registered; confirm it starts after a reboot.
- [ ] Publish with `Sync-Orchestrator.ps1`.

## Rollback

Everything is additive. To go back, stop the orchestrator (`HomeAI-Orchestrator-Autostart` task + the node process on
port 18850) and use OpenClaw as before. Remove the MCP registration with `claude mcp remove homeai -s user`.
