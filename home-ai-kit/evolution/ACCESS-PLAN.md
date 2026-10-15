# D/E access plan

> Historical assignment output. The owner already selected Full Access; no repeat approval is pending. See CURRENT-RUNBOOK.md for current state.

## Authorization already given

The user explicitly authorizes full D: and E: file access and wants persistent access with fewer repeated prompts. This records intent; it does not claim any permission was applied. It does not authorize C: file access, network, external communication, purchases, publishing, account changes, secret disclosure, installation or blanket destructive operations. Verified restorable backups remain required before project-file deletion.

This bounded task still permits file operations only through homeai_project for homeai-evolution and only the six assigned outputs. Broader user intent does not expand the current tool or native harness capability. No access script or live configuration is changed here.

## Distinct enforcement layers

| Layer | Meaning | What must be verified |
| --- | --- | --- |
| User authorization | D/E scope and preference for durable fewer-prompt access | Preserve the recorded scope; do not request the same conceptual authorization again |
| OpenClaw tools/allowlists | Which filesystem/runtime tools, projects and actions the agent can call | Installed tool schemas and documented path restrictions; a tool being allowed is not drive access |
| Native Codex harness sandbox | Actual per-turn writable/readable roots and network/process boundaries | Effective session sandbox and launch configuration; OpenClaw allowlists cannot override it |
| Execution approvals | Whether specific process invocations require confirmation | Installed approval grammar, command/prefix matching and persistence scope; file authorization alone is not unrestricted exec |
| Windows identity/ACLs | What the executing Windows account can access | Effective account, allow/deny ACLs, protected files, encryption and drive availability; do not take ownership or grant Everyone access |
| Backup/deletion policy | Recovery before destructive changes | Real backup bytes, hashes, restore method and user-defined D/E backup layout |

D/E-only tools are not an OS boundary if the native process can reach C or network through another route. Conversely, an OS ACL grant does not add tool capability or remove harness prompts. Windows system/runtime executables may live on C; any exception must be explicit and narrow, not inferred from D/E authorization.

## Evidence-first configuration procedure

1. Read the documentation/schema for the actually installed OpenClaw and native harness versions, their effective startup settings, supported filesystem-root controls and approval persistence. Compare installed docs to behavior. Existing access-helper scripts or historical status notes are reference data, not proof of correct installed configuration.
2. Inspect relevant effective settings and account identity without emitting secrets. Establish whether documented controls can persist D/E roots, scoped native tool access and narrowly categorized exec approvals. Separate desired state from observed state.
3. Prepare an exact proposed configuration diff only after supported keys, semantics and activation/restart behavior are verified. Preserve a verified backup and rollback for any existing configuration. Do not guess config keys, install/modify undocumented policies or disable global approval/sandbox controls.
4. Apply only in a later context that exposes the required capability, honoring existing authorization; seek a further decision only for genuine scope expansion or an enforcement block. Do not bypass a blocked layer via another tool.
5. Validate with harmless create/read/update operations in a designated D/E scratch area, and deletion only after verified backup. Check persistence in a fresh session, expected refusal outside D/E and no network access expansion. Record exact effective settings and real results, redacting secrets.

## Current outcome and missing evidence

No installed access-configuration documentation has been verified in this step, so exact settings/keys/commands cannot yet be responsibly supplied. Current homeai_project access is project-scoped, not proof of full-drive access. General shell, drive inspection, ACL queries and configuration application are unavailable here. The next access step is installed-doc/effective-config evidence gathering in a context that actually exposes those capabilities; no global policy disable, silent C expansion or claim of persistent access completion.
