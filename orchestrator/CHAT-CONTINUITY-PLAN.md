# Chat continuity and crash recovery

Owner: Adam. Updated: 2026-10-16. Priority: before further media/model work.

Required behavior: conversations remain on disk across browser refresh, service restart,
connector failure, and model changes. An interrupted operation keeps its request and
observed activity, offers Resume, and requires the next model to inspect partial work.
Never automatically replay tools, purchases, messages, or media generation.

1. Persist before inference. Save the user request and running state before invoking
   the connector; save bounded activity during execution and the final reply/error.
   On startup, mark unfinished runs interrupted once. Keep original messages.
   Status: implemented on disk; regression and deployment checks in progress.
2. Reconnect the UI. Preserve the selected chat on a temporary startup error. Retry
   observation after failed polls; do not submit a second request on refresh.
   Status: retry and selection fixes implemented; browser restart verification pending.
3. Carry context across models. Retain original user intent when the recent transcript
   is truncated, pinned notes, saved interrupted request, and observed activity.
   Status: implemented; regression tests cover another model receiving saved context.
4. Close remaining reliability gaps. Add durable request IDs before automatic transport
   retry; resolve creation when the response is lost before the conversation-ID event;
   persist partial streamed text with bounded writes; restore cancellation controls on
   reattachment; show running/interrupted state and activity persistently in the UI.
   Status: pending. Current recovery preserves requests/activity, not every streamed token.
5. Harden storage and operations. Validate corrupt/truncated-file recovery with a retained
   previous snapshot or journal; assess disk-full behavior and flush guarantees; inspect
   exit logs and startup supervision. Keep backups, avoid automatic action replay.
   Status: pending. Current conversation writes use temporary-file rename; this alone
   does not establish power-loss durability or recover an already-corrupt file.
6. Acceptance checks. Run the suite; test refresh during a detached request, temporary
   network loss then recovery, actual service restart during a stubbed running request,
   repeated restarts without duplicate markers, connector failure with Resume, and a
   model switch. Check original message count and media references, not just health.
   Use deterministic local stub connectors for destructive fault injection; no paid calls.

Do not call the entire continuity feature complete until all acceptance checks pass.
Deploy only with D:/HomeAI/scripts/Restart-Orchestrator.ps1. Preserve existing active
work before restarting. Never remove OpenClaw or publish as part of this work.
