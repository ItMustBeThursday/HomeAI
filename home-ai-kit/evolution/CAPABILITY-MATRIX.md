# HomeAI capability matrix

> Historical inventory; current verified capabilities and limitations are in STATUS.md, CURRENT-RUNBOOK.md and RELEASE-EVIDENCE.json.

Coordinator correction of the completed local extraction on 2026-10-14. The first extraction omitted explicit mission facts and incorrectly described deterministic switch interaction as LLM-driven. Do not use that draft as evidence. See MISSION.md, SPEC.md and HOST-EVIDENCE.md.

| Capability | Observed now | Development target / remaining proof |
|---|---|---|
| Repository | Local checkout readable; GitHub main matches committed HEAD; user changes present | Preserve modifications; additive kit not merged/deployed |
| Code generation | Codex/Claude/local delegated jobs produce bounded project files | Source correctness requires independent tests/review |
| Checks | Existing AppContainer dependency-free node:test runner | New kit tests pending; not compiler/browser certification |
| Build/compile | Node runtime and Git available | Manifest-driven explicit Node/npm/dotnet/cargo/cmake runner; compilers not yet inventoried or tested |
| Serving | No new service demonstrated | Localhost-only artifact server staged; health checks and host tests required |
| Models | Ollama reports main, fast, vision, embedding installed; source/alias duplicates are not extra models | Measured admission, licenses/digests, quality/resources, bounded context |
| Routing | Actual completed prior Codex/Claude/local jobs; current adaptive role assignments | Actual job history vs requested model; no invented ratings or quotas |
| Memory | Keyword memory search works; semantic backend not enabled in audit | Durable sourced mission and decisions; evaluate embedding backend rather than assume staged weights enable it |
| Voice | No live microphone/transcription/TTS verified | Cancellable session core, stale response rejection, text fallback; child need not speak |
| Assistive input | One primary Pi + three Pi Zeros specified by user, 1/2 switches, CVI/non-speaking child | Deterministic controller, configurable scan/debounce, audio feedback and caregiver override; physical suitability untested |
| Home Assistant | Integration requested, endpoint/software unknown | Allowlisted deterministic adapter with acknowledgments, no stale command replay; no actuation this pass |
| Video | Explicitly deferred | Later separate interface, not a current dependency |
| Heretic | Pinned source staged; gpuReady false/unverified; CPU torch default source | Separate native-compatible experiment; no modification or main replacement yet |
| Access | fs/runtime tools allowed; config valid; no-prompt host change in progress | D/E authorization is not a D/E-only OS boundary; current native turn sandbox remains independent |

Statuses are observations and development targets, not claims of production readiness. No child name or GPU identity inferred.
