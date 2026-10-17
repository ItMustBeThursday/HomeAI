# Runtime transition status

The current project is the HomeAI orchestrator. Development source is `D:/HomeAI/projects/orchestrator`; the Git checkout is `D:/HomeAIGit/HomeAI`. Do not remove, disable or reconfigure OpenClaw without explicit cutover approval. Earlier notes claimed a completed cutover; that claim is not accepted as authorization.

## Current replacements

| Capability | Current implementation |
|---|---|
| Model routing | Validated connectors and compatible fallback routes |
| Chat and history | Persistent conversations, streaming, cancellation and recovery |
| Coding work | Jobs, action routes, registered projects and terminal tools |
| Usage | Append-only ledger and informational counters |
| Memory | Shared bounded retrieval for non-private text routes |
| Automations | In-service scheduler and scheduled backup |
| Claude access | MCP server in `src/mcp.mjs` |
| Codex | Standalone runtime independent of the legacy gateway |
| Local media | ComfyUI image, video and audio connectors |

## Incomplete transition

Companion desktop, Android and remote clients still depend on the legacy gateway protocol. Their existing code and endpoints must be preserved until the replacement is tested and cutover is approved. Logan integration and operational supervision also retain open work. See SPEC.md and CHAT-CONTINUITY-PLAN.md.

Obsolete installer/router scripts can be archived after hash-verified backup and a dependency check. Backup compatibility exclusions for old state are retained because removing them could break recovery. Historical records belong in verified backups and Git history, not in current setup instructions.
