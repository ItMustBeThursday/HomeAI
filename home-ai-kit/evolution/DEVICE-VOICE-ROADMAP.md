# Device, switch and voice roadmap

Planning only. No device connections, physical actuation, microphones, audio retention or installation occurred. Target: one primary Raspberry Pi plus three Pi Zeros; exact models, OS, audio hardware, switch interfaces and Home Assistant endpoint are unknown. The child cannot speak and has CVI. No child name is supplied or invented. Clinical/accessibility suitability requires caregiver-led physical testing, not a software claim.

## Nonvisual interaction contract

Essential interaction must work without vision, speech, color or precise timing. Use spoken/audio sequential choices with distinct selection confirmation and a repeat/cancel/help option in every approved menu. Avoid overwhelming lists; a caregiver chooses a small, stable catalog and familiar labels. Optional visuals never become the only way to understand state.

One-switch mode: authenticated hub ticks advance the current item; a deliberate button-1 rising edge selects. Release does not select. Two-switch mode: button 1 advances, button 2 selects; no automatic tick advance. Audio timing must let the complete label finish before the next choice; caregiver-adjustable scan interval, debounce, freshness window, volume, labels and repeat behavior must be tested together. Pausing is always available through caregiver controls. Never make speech recognition a prerequisite.

switch-core is deterministic and independent of any LLM. The model may propose menus only from an approved catalog; caregiver-reviewed catalog IDs map to fixed, allowlisted intents. Neither live switch presses nor raw MQTT payloads become LLM instructions. No free-form generated action runs directly against Home Assistant.

## Proposed architecture (not deployed)

| Component | Responsibility | Boundary |
| --- | --- | --- |
| Primary Pi | Hub, authenticated session establishment, monotonic local ticks, controller and audio sequencing, caregiver UI | Exact OS/load/audio reliability must be measured |
| Three Pi Zeros | Up to three distributed switch endpoints in the proposed layout | Confirm each model's I/O, power, network and button adapter; primary Pi may provide the fourth device ID if needed |
| Switch controller | One/two-switch edges, debounce, bounded state, sequence/freshness/session checks | Pure effects only; no socket or hardware access |
| Audio adapter | Speak highlight/confirm/cancel/connection status; stop superseded labels | Playback completion synchronizes scan; no accidental catch-up ticks |
| Home Assistant adapter | Map approved item IDs to narrowly allowlisted actions and acknowledgments | No arbitrary service/entity names or code from model/switch input |
| Caregiver interface | Choose catalog/mode/timing, pause/resume, test audio, inspect connection status and manual fallback | Authenticated controls; not child timing tasks |

Hub arrival times should use one clock domain; do not compare raw Pi clocks as if synchronized. Adapters need explicit conversion/session/freshness policy. Authenticate each configured device and local tick/override origin. Generate genuinely fresh session IDs, enforce sequence growth, invalidate stale queued events and re-establish sessions after restart. The controller remembers only the current/immediately retired session, not every historical ID.

The pure core initially permits a configured device's first event to establish a session. The hardware adapter must gate input until explicit authenticated connect and a caregiver-approved session handshake. Disconnect pauses scanning and clears held edges. Reconnect must not select, replay events or automatically unpause. Held buttons, release edges, duplicate/future/old/malformed messages and rebooted sequence counters must not create extra selections.

## Home Assistant and MQTT design

First inventory existing Home Assistant integrations. Prefer a supported existing local integration for the relevant device/action; do not install a replacement broker/integration merely because MQTT is available. If MQTT is appropriate, review the existing broker, authentication, topic ACLs and documented integration before implementation.

Use separate event, intent, acknowledgment and state/availability topics. Imperative switch/select/action commands must never be retained, queued for offline execution or replayed after reconnect. Broker QoS alone does not provide exactly-once intent: adapters need fresh authenticated session, bounded monotonic sequence, unique command ID, expiry and bounded deduplication. Disable offline command queues/session replay on the command path. Inspect/clear pre-existing retained imperative messages only through a later authorized and reviewed operation; never execute one on subscription.

Retained availability or declarative state may be used only when labeled as state, with freshness and no action on receipt. Home Assistant desired-state integrations must not be blindly treated as momentary commands. On uncertain acknowledgment, report uncertainty and reconcile actual state; never auto-retry a potentially consequential action. Initial mapping should use harmless test targets. Hazardous devices remain excluded until a separately reviewed caregiver/access/safety decision.

No entity IDs, endpoints, credentials, discovery topics or exact configuration keys are invented. Require installed integration/broker documentation before exact configuration. Transport credentials stay outside catalogs/logs and this kit.

## Voice path and local fallback

Voice-core offers cancellable request-scoped capture/transcribe/think/speak orchestration, stale-result rejection and text fallback; it does not provide a microphone/STT/TTS implementation. Caregiver/adult voice is optional. The child uses deterministic switches and audio choices without speaking. Separate interactive menu audio from model speech so a response cannot mask a critical selection/disconnect message.

Inventory actual local audio devices and locally available STT/TTS first; measure recognition, speech latency, intelligibility, cancellation and offline resource use on the primary Pi/host. Do not assume a Pi Zero can run inference. Avoid retaining raw audio by default; any diagnostics need an explicit retention/location policy. A local pre-recorded approved prompt set may support reliable fallback without model availability. Text remains available to caregivers. Offer a physical/manual control path if hub, audio or network fails; prevent device action when the selected item is unclear.

## Prerequisite gates

1. Caregiver inventory: Pi models/OS/power/audio, physical switch connector/electrical compatibility, positioning, fatigue, hearing preferences, comfortable timing, existing Home Assistant/broker and approved harmless catalog. No guessed pinouts or suitability.
2. Offline software review: adversarial switch sequences, held-button behavior, stale sessions, timing, voice cancellation, deterministic intent mapping and audio sequencing; real evidence recorded separately from staged code.
3. Bench testing without actuation: one endpoint then all four possible device IDs, contact bounce, long holds, rapid presses, simultaneous devices, disconnection/reboot, duplicate/retained traffic, clock skew and power loss. Verify no spontaneous or replayed selection.
4. Caregiver-led physical trials: audible order/labels and confirmations, adjustable scanning, repeat/help/cancel, pause/resume, positioning, fatigue, lost audio and emergency/manual fallback. Revise from observed responses; do not infer the child's intent from a model or treat inactivity as consent.
5. Home Assistant test adapter: use harmless targets, validate acknowledgments/state reconciliation and timeout behavior, prove no stale/offline replay, then review a narrow household catalog before any real actuation.

Video is explicitly deferred. Camera streams, visual recognition and remote surveillance are not dependencies of this roadmap or current kit.
