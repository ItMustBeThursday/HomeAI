# MCL - Memory Compact Language (v1)

Line-based memory notation. Small enough for a 7B local model to read and write; code in `src/mcl.mjs`.

```
@adam                              scope header ("@" alone = no scope)
!never touch the vault;^3          rule, priority 3 (always included)
=pc:7900XT 20GB, 64GB RAM;#hw '261016   fact  key:value ; #tag 'YYMMDD date
~prefer local models               preference
>finish continuity acceptance;&plan     todo, &ref
+wan fp8 accepted                  done / verified
?hunyuan stalled, unverified       open / unverified
-pc                                retire the record with this scope+key
$a=orchestrator                    alias; "$a" in a body expands to the word
```

- Modifiers come after the first unescaped `;`: `#tag`, `^0-3` priority, `'YYMMDD`, `&ref`.
- Escapes: `\ \n \; \: \$`. Identity = scope + key (or the text, if keyless). Same identity = upsert.
- The sigils are a superset of the RESUME.md legend (`! x o ~`): `+` replaces `x`, `?` replaces `o`.
- The parser never throws; bad lines come back in `errors`. Unknown text is not stored silently.

## Use
- Prompts: route with `"memory": true, "memoryFormat": "mcl"`. The prompt gets a 1-line legend plus the ranked,
  budgeted records (core/pri 3 first). Aliases are off for prompts (models read plain words best).
- Storage / transfer: `GET /api/memory/mcl` (read) returns `{text, stats}` alias-packed; `POST /api/memory/mcl {text}` (admin)
  upserts notes by scope+key and trashes `-` lines (trash is restorable). A local model can emit MCL directly.
- Notes gained optional `kind`, `scope`, `pri`; `pri:3` also adds the `core` tag so old retrieval still works.

## Honest limits
- A notation does not make a model smarter. What it buys: fewer prompt tokens per fact, an unambiguous structure that small
  models follow reliably, deterministic merge/retire, and a bounded budget. Gains depend on writing records telegraphically.
- Measured on the 7 existing prose notes: 3752 JSON chars -> 3104 packed (0.83). Real savings need distilled records:
  the synthetic test (repeated phrases) gets < 0.4. Alias packing saves characters, not always tokens (unverified).
- A local model writing MCL from a distill prompt remains unverified. Retrieval does not require a distillation model call.

## Shared experience retrieval (0.32)

All non-private text routes retrieve shared memory by default, including MCP tasks, scheduled prompts and jobs.
Set `memory:false` on a route to opt out of retrieval; an array still restricts tags. Private sessions neither read nor
write this store. Diffusion prompts do not receive memory text.
MCP clients can call `memory_context {query,maxChars}` for the same bounded MCL packet without a model call, or use
authenticated `GET /api/memory/context?q=...&maxChars=1800`. `memory_add` also accepts kind, scope and priority.

Finished chat turns and standalone task reports are indexed as bounded, role-labelled excerpts. On startup, active and
archived conversations and the retained task history are backfilled idempotently; trash and private sessions are excluded.
Original conversations remain intact. Excerpts carry `&turn:conversation-id:message-index:chunk-index` or
`&task:task-id:request-or-report:chunk-index`, allowing source inspection through the existing conversation/history APIs.
Model reports use `?` (unverified), including success claims; retrieval never establishes that an operation really happened.
Common credential patterns are redacted in generated excerpts; this is not a complete secret detector. Do not submit secrets.

The latest user request drives retrieval rather than the entire transcript. This lets a small model retrieve an old middle
turn even after normal history compression drops it. Core notes and relevant excerpts share a fixed character budget;
full owner rules also remain in the shared system instructions. Up to three excerpts per conversation/task prevent a
large source monopolizing retrieval. Original prose, negation and numbers are kept in excerpts rather than synonym/alias
encoding. MCL aliases remain for export; character compression is not a measured token or quality improvement.

Embedding queries have a bounded 32-entry process cache. Indexing is serialized in batches of at most 32 notes per query;
later queries progressively finish it. Keyword retrieval works immediately and is the fallback on embedding failure.
Index writes check for concurrent edits/deletion. No extra cloud summarization calls are used. Automatic memory indexing
is best effort; transcript persistence remains authoritative. Existing transcripts/history may already contain sensitive
text, and this feature does not rewrite those records.

Limits: bounded retrieval is lossy and cannot expand a model's native context window. It improves access to relevant
history, not reasoning ability or perfect recall. Archived records remain searchable; trashing a source does not currently
purge its existing derived memories (remove those through Memory if desired). Cross-session sharing applies to this
orchestrator; separate model applications must use its MCP/API to access it.

Memory snapshots now flush the temporary file before atomic replacement and retain a parseable `.bak`. Corrupt-primary
reads fall back to that snapshot; removing a note does not resurrect its backup. Sudden-power-loss durability and
disk-full handling remain unverified.

Local recall acceptance, 2026-10-16: `node scripts/memory-smoke.mjs` indexed a synthetic 400-message history
(166,987 JSON characters). Retrieval returned 320 characters carrying the requested exact constant. Both installed
`homeai-fast:locked` and `qwen3-4b-instruct-2507-heretic-exp:latest` answered `0.937` correctly with a 4096-token window
(154/158 input tokens reported by Ollama). This demonstrates selective recall, not lossless compression of the history
or a general quality benchmark. Results: `D:/HomeAI/logs/memory-local-smoke-20261016.log`.

## Distill prompt (for a local model)
"Rewrite these notes as MCL. One fact per line. Use ! rules, = key:value facts, ~ prefs, > todos, + done, ? unverified.
Telegraphic, no filler. Add ;^3 only for hard rules. Output only MCL lines." then feed the output to `POST /api/memory/mcl`.

## Correction preservation and model acceptance (0.32.1)

Retrieval deduplicates identical whitespace-normalized text with matching kind, scope, tags and fact title before applying the
retrieval limit. Word-overlap deduplication is unsafe here: a changed number, case-sensitive path or added negation can
be the entire point of a correction. Episode titles contain turn counters and are ignored for duplicate matching;
their text still retains the speaker label. Distinct versions retain their source references so models can inspect conflicts;
retrieval does not automatically declare one source authoritative. Stored records and original transcripts stay intact.
After relevance-based selection and fitting, excerpts from the same conversation are displayed in original turn order.
This prevents an obsolete value appearing after its correction merely because it ranked lower. Shared instructions
explicitly distinguish corrected values from obsolete or negated ones; source order is not new authorization.

`node scripts/memory-parity.mjs` runs a local-only synthetic acceptance probe through the shared orchestrator for every
configured Ollama text connector. A 400-message history contains an obsolete constant and an explicit correction, an
exact output path and a negative permission statement. Each model receives the same bounded retrieval at 4096 context;
checks require the corrected number, exact path and boolean false. Evidence is retained under
`D:/HomeAI/evaluations/memory-parity-<timestamp>/report.json`. No real chats, owner notes, cloud connectors or downloads
are used. The probe bounds generation, unloads each model after use and tests serially to limit memory pressure.

Passing this probe establishes those specific recall behaviors. Shared retrieval gives models access to the same
source store; it does not equalize their native reasoning, context capacity, vision or tool capabilities.

For an evidence-preserving targeted retry, pass `--connector=local-heretic-exp` (or another configured local connector).
`--startup-ms=600000` allows a longer bounded cold start for CPU-offloaded models. Each run writes a new report rather
than replacing an earlier failure. Generation remains bounded and uses no cloud fallback.

Semantic coverage is separate from model recall. `node scripts/memory-index-local.mjs` completes the existing shared
index in bounded batches of32 using the installed local embedding model. Run after model generation is idle and retain
a verified memory-store backup before bulk maintenance. It logs counts and saves a coverage report without logging
note text. Existing concurrent-edit guards remain active. Foreground retrieval continues indexing newly added notes
incrementally; keyword search remains available if embedding fails. No transcript or note content is deleted.
