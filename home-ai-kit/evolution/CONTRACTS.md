# Evolution kit core contracts

These additive, dependency-free native ESM modules target Node >=24. The four core modules (switch-core, model-policy, execution-policy, voice-core) perform no network, filesystem, process, audio, device or import-time external effects. runtime-runner.mjs performs process/filesystem/loopback effects only when its exported functions are explicitly called; run-kit.mjs is the separate CLI. Nothing replaces the working installation. No runtime configuration, credentials, hardware or other owners' files are changed.

## Common conventions

Only the named exports below are public. Inputs are plain data, not executable instructions. Configuration/validation errors throw TypeError unless specified otherwise. Handles return arrays of declarative effects; adapters decide how to implement them. Extra input fields are ignored. Numeric counts and event timestamps are nonnegative safe integers. No core function reads the wall clock. Snapshots are detached copies of mutable state. Error reason strings below are part of the documented API.

## switch-core.mjs

Export: createSwitchController(config) -> {handle(event), snapshot()}.

Config: {deviceIds, mode, itemIds, debounceMs, scanIntervalMs, maxAgeMs}. deviceIds holds 0..4 unique, nonblank strings (max 256 UTF-16 units); an empty list supports caregiver-only control. itemIds is nonempty with the same string constraints. mode is 'one' or 'two'; debounceMs >=0; scanIntervalMs and maxAgeMs >0. Arrays are copied.

Event: {kind, at, receivedAt, deviceId?, sessionId?, seq?, button?, paused?}. kind is press, release, tick, disconnect, connect or override. All events require at/receivedAt. tick and override need no device fields. override requires a boolean paused. Device events require a configured deviceId, nonblank sessionId (max256), and seq >=0; only press/release require button 1 or 2. Hub/caregiver adapters must authenticate local tick/override and session establishment/connect notifications; this pure module cannot authenticate transport.

Initial index is 0, not selected; paused=false. Configured devices are initially eligible: their first device event establishes the session. A new session requires an explicit connect. The current session ID cannot be reused for connect (new-session-required). Each device remembers its last 8 superseded session IDs; any event (including connect) carrying one rejects with retired-session, so A -> B -> A session replay is refused. Reconnect clears held/debounce state and permits a reset sequence in the new session. The retired list is bounded, so an adapter must still issue genuinely fresh IDs; replay of IDs older than the last 8 sessions is the authenticated adapter's responsibility, not an unbounded controller log. Sequence must strictly increase within a session; session mismatch, duplicates and non-monotonic global timestamps reject. Equal timestamps are allowed with increasing sequences. Future events and events older than maxAgeMs reject before mutation. Accepted timestamps are globally nondecreasing.

One mode: only tick advances; the first accepted tick represents a due scan and advances once. Subsequent ticks need scanIntervalMs elapsed since the last advancing tick; late ticks never catch up multiple items. Button1 rising edge selects the current item; button2 rejects. Two mode: button1 advances, button2 selects; tick does not advance. Release never selects. Debounce compares successive rising edges per device/button. A held or debounce-suppressed press cannot repeatedly select without a release. Valid device events consume sequence/time even if the action is suppressed for held/debounce/paused/unsupported-button. A suppressed rising edge remains held until release. Other malformed/freshness/session/sequence failures do not consume device state.

Disconnect pauses globally and clears that device's edges. No disconnected device can act. Connect neither selects nor unpauses; explicit override resumes. Caregiver override may resume other connected devices even if one device remains disconnected. Timing and item/audio feedback are configurable; essential child interaction never requires speech or LLM interpretation.

Effects:
- highlight: {type:'highlight', index, itemId}, followed by {type:'feedback', action:'highlight', itemId}.
- select: {type:'select', index, itemId, deviceId}, followed by {type:'feedback', action:'select', itemId}.
- disconnect/override: {type:'paused', paused, reason:'disconnect'|'caregiver', deviceId?}.
- connect: {type:'feedback', action:'connected', deviceId}.
- rejected event: [{type:'reject', reason}], where reason is malformed, future, old, non-monotonic, retired-session, session, sequence, disconnected, new-session-required, paused, held, debounce or unsupported-button.
- releases, non-due ticks and two-mode ticks return [].

snapshot(): {mode,index,itemId,paused,lastAt,lastTickAt,devices}. devices is keyed by deviceId, each value {connected,sessionId,retiredSessionIds,seq,lastAt,buttons:[{held,lastPressAt},{held,lastPressAt}]}. Times/session IDs start null, retiredSessionIds [] and sequence -1. Memory contains at most four devices, two buttons and eight retired session IDs each, the configured item list, and no event log.

## model-policy.mjs

Exports: rankCandidates(candidates, request, now), buildContext(items, budget).

rankCandidates uses the candidate/request fields exactly specified in SPEC.md. now is a nonnegative safe-integer timestamp; no freshness policy is invented because candidates have no evidence timestamp/expiry field. Digest ambiguity is resolved conservatively: exactly 64 hexadecimal SHA-256 characters, optionally prefixed with lowercase 'sha256:'. This validates representation, not authenticity or actual model contents.

Malformed request, non-array candidates, missing/blank IDs and duplicate IDs throw TypeError. An unknown/malformed required candidate metric, roles, digest, admission status or local flag excludes that candidate rather than guessing defaults. Only admitted, role-supported candidates pass. Tokens/VRAM bytes are safe integer counts, contextTokens >0, quality finite in [0,1], latency finite >=0. Input+output must fit context; output must fit maxOutputTokens. For local candidates only, requiredVRAM+reserve must fit measured freeVRAM. Hosted candidates need no fictional VRAM metrics. All thresholds are inclusive. Hosted availability/billing is not inferred or authorized.

Result: [{id,reason,quality,latencyMs,local,digest}], only eligible candidates. reason explains common gates and either local VRAM satisfaction or hosted VRAM not applicable. Sort: descending quality, ascending latency, then case-sensitive code-unit ascending id (locale-independent). No scalar benchmark score or invented measurements.

buildContext items: {id,text,tokens,required,priority}; nonblank id, string text, tokens >=0, boolean required, finite numeric priority. budget is a positive safe integer. Identical duplicate IDs collapse; any difference in the five fields throws TypeError. All required items remain whole in original first-occurrence order or RangeError is thrown if they exceed budget. Optional items are considered in descending priority, ties by ascending id, and included whole when fitting; oversized optional items do not block smaller later items. Result {included,excluded,usedTokens}; included/excluded contain detached five-field item objects, not IDs. Included required items precede selected optional items. Excluded optional items retain consideration order. Zero-token items are allowed. Counts are caller estimates; no tokenizer or separator overhead is silently invented.

## execution-policy.mjs

Exports: validateManifest(manifest), createRunPlan(manifest,context), nextState(state,event).

validateManifest returns a detached, allowlisted manifest (not a boolean), or throws TypeError. Version is 1. Manifest and step IDs match [A-Za-z0-9][A-Za-z0-9_.-]{0,127}. Steps: 1..128, unique IDs, kind test/build/compile, tool node/npm/dotnet/cargo/cmake, timeoutMs 1..300000. Args: 1..64 nonblank strings, max4096 characters each and max32768 total. Control characters/NUL, DEL and shell operators semicolon, ampersand, pipe, angle brackets, backtick and dollar are rejected even though shell=false.

Roots/executables accept local drive-absolute Windows paths or single-slash absolute POSIX paths, max4096 characters. UNC/device namespaces, drive-relative paths, dot/traversal components, reserved Windows device components (CON/PRN/AUX/NUL/COM1..9/LPT1..9), wildcard/quote/control/operator characters and trailing-dot/space components reject conservatively. Root comparison normalizes slash direction and trailing slash; Windows roots compare case-insensitively, POSIX case-sensitively. There is no filesystem existence, symlink, executable-type or containment certification in this pure module.

Serve is optional {directory,port}; directory must be a nonempty safe relative path without dot/traversal/empty segments, absolute prefix, colon, wildcard, device component or unsafe character. '.' is intentionally rejected. Port: 1..65535. A serve manifest must declare at least one build/compile step; it cannot serve test-only artifacts.

Args and their '='-delimited operands reject absolute, traversal and device paths. This lexical rule is deliberately conservative, not a promise to constrain arbitrary build-code access. Node test accepts ONLY ['--test', ...safeRelativeTestTargets], at least one target, every target ends in '.test.mjs' and does not begin '-'. No eval/import/require/preload or other flags are allowed in node test steps.

createRunPlan requires context {projectRoot,toolPaths,allowBuild,allowServe}; booleans must be explicit. Every used tool has an own-property local absolute executable path. All non-test steps AND every npm/dotnet/cargo/cmake test require allowBuild=true. Serving requires allowServe=true. These flags represent caller authorization, not a prompt or approval issued by this pure module.

Plan:
- {version:1,id,projectRoot,commands,serve,manifest,context}.
- commands: [{id,kind,tool,args,timeoutMs,executable,shell:false,cwd:projectRoot}].
- serve: null or {directory,port,host:'127.0.0.1',requiresSuccessfulBuild:true,requiresHealthCheck:true}.
- manifest: normalized validation output; context: detached {projectRoot,toolPaths,allowBuild,allowServe}, with only used tool paths.
- command args are copied independently of embedded manifest args.

Build tools and project tests execute arbitrary project code; allowBuild is NOT install/network permission. cwd and shell:false are not containment.

nextState takes {status,successfulBuild?,artifactsReady?,serveReady?,...callerMetadata} and {type,...}. Missing booleans default false; malformed booleans or readiness without passed+successfulBuild throw. It returns a new object, preserving metadata without mutating input. Initial state: {status:'queued'}.

| Event | Allowed from | Result |
| --- | --- | --- |
| {type:'start'} | queued | running, evidence/readiness cleared |
| {type:'buildSucceeded',kind:'build'|'compile'} | running | successfulBuild=true; readiness false |
| {type:'pass'} | running | passed; readiness false |
| {type:'fail'} | running | failed; readiness false |
| {type:'timeout'} | running | timed-out; readiness false |
| {type:'cancel'} | queued/running | cancelled; readiness false |
| {type:'healthChecked',ok:boolean} | passed with successfulBuild | artifactsReady=serveReady=ok |

Unknown or invalid transitions throw TypeError. Terminal statuses never restart. Independent healthChecked events may update readiness after passed; no health check can rescue failed/cancelled/timed-out. Test pass alone never establishes build or artifact readiness. Events/evidence must be emitted by a trusted runner after actual observations; the reducer cannot verify supplied claims.

## voice-core.mjs

Export: createVoiceSession({maxTextLength=4000,maxRequests=4096}={}) -> {handle(event),snapshot()}. Text limit is a positive safe integer and measures UTF-16 units. maxRequests is an integer from 1 through 65536. A new start at capacity rejects session-capacity without changing state; IDs are never evicted. Rotate the controller only after detaching old callbacks/transports. All events use type (not kind) and carry a nonblank requestId of max256 units. Explicit start creates the active request, invalidates any prior active request and returns a stop effect for that request before capture. IDs cannot be reused during the controller object's lifetime, including after completion/cancel, preventing old results from becoming current again. Only issued IDs are retained, never audio/text.

| Event | Required current state | Next state / effects |
| --- | --- | --- |
| start with a new ID | any | listening; [{type:'stop',requestId:old}] if active, then {type:'capture',requestId:new} |
| stopCapture | listening | transcribing; {type:'transcribe',requestId} |
| transcript with text | transcribing | thinking; {type:'request',requestId,text} |
| response with text | thinking | speaking; {type:'speak',requestId,text} |
| playbackDone | speaking | idle, active ID cleared; [] |
| cancel | any matching active request | idle, active ID cleared; {type:'stop',requestId} |
| disconnect / error | any matching active request | error, active ID cleared; {type:'stop',requestId} |

Effects are arrays. Blank/non-string/oversized text rejects without advancing; accepted text is preserved verbatim. All non-start events must match the active ID. Rejections: [{type:'reject',reason:'malformed'|'reused-request-id'|'stale-request'|'invalid-state'|'invalid-text'}], with no state change. error recovers through a fresh start. Later stale responses cannot emit speak.

snapshot(): {state,requestId,textFallbackAvailable:true}. Text fallback can use start -> stopCapture -> transcript with typed text; these effects do not require actual microphone capture, and an adapter may skip audio operations. This module has no speech requirement and is independent of switch input. UI/audio adapters and clinical/accessibility suitability are not certified.

## runtime-runner.mjs (summary; full detail in its header comments)

Exports: runPlan(plan,{context,spawnImpl?,clock?,signal?,maxLogBytes?}), serveArtifacts({plan,context,runResult,signal?}).

- Revalidation: runPlan requires an independently trusted options.context and rebuilds the plan via createRunPlan(plan.manifest, context); any deep difference rejects before spawning ("Forged or stale run plan"). A plain plan is never an approval token.
- Children: resolved executable, args copy, shell:false, cwd=projectRoot, windowsHide, stdio ignore/pipe/pipe. Real spawns preflight canonical non-symlink directories, regular single-link tool files (Windows: native .exe only, never .cmd/.bat) and node test target files; preflight is not atomic with spawn.
- Environment: minimal. No PATH, NODE_OPTIONS, npm config, credentials or inherited user env; on Windows only SystemRoot/WINDIR are passed.
- Logs: stdout+stderr bytes bounded across the whole run (default 65536, max 1 MiB), with a truncated flag.
- Timeout/cancel: AbortSignal or per-step timeout sends SIGTERM, SIGKILL after 250 ms, and settles after 2000 ms with cleanupConfirmed=false if close is never observed. Later steps never spawn. POSIX real spawns use a process group; Windows and injected adapters kill the direct child only. Escaped descendants are NOT contained.
- Readiness: successfulBuild may be true, but artifactsReady/serveReady are always false in runPlan results. Only a genuine real-spawn run (private WeakMap provenance, unchanged result object) with build + explicit serve directory can authorize serving; injected/cloned/forged results cannot.
- Serving: 127.0.0.1 only, Host/Origin checked, GET/HEAD only, bounded immutable in-memory snapshot (512 entries, depth 16, 8 MiB/file, 32 MiB total), symlink/hardlink/traversal/encoded-separator refusal, no directory listing, MIME allowlist, startup loopback health check of index.html against snapshot digest.
- Honest limitation: this is NOT an OS sandbox. No network isolation, filesystem isolation or descendant containment is claimed; build/test steps run arbitrary project code with the user's privileges.

## Evidence and review boundary

Required check for this assignment: homeai_check kind=test entry=all.test.mjs (imports switch.test.mjs, policy.test.mjs, voice.test.mjs, runner.test.mjs). That runner is an isolated copied snapshot with no network capability; results are reported in the job summary, not asserted here. Real subprocess spawning and serveArtifacts HTTP handling are not exercised by the isolated checker (runner.test.mjs marks the HTTP case TODO) and require a separate host check. Passing tests do not certify complete application behavior; human review remains the next verification layer.
