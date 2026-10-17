# Sources for CHAT-GUIDE.mcl

Read 2026-10-16. "Read" means the page was fetched and summarized. "Search only" means I saw it in search results, not the full text. Treat search-only and secondary items as unverified.

| Ref | Source | Status |
|---|---|---|
| s1 | Discord rate limits, https://docs.discord.com/developers/topics/rate-limits | Read |
| s2 | Discord gateway, privileged intents, https://docs.discord.com/developers/events/gateway | Read |
| s3 | Discord message resource, https://docs.discord.com/developers/resources/message | Read |
| s4 | Discord channel resource (typing, threads, slowmode), https://docs.discord.com/developers/resources/channel | Read |
| s5 | Discord Community Guidelines, https://discord.com/guidelines | Read |
| s6 | Anthropic constitution, https://www.anthropic.com/constitution | Read first 100k of ~200k characters |
| s7 | Anthropic, Persona Selection Model, https://www.anthropic.com/research/persona-selection-model | Read |
| s8 | Multi-Party Chat (MultiLIGHT), https://arxiv.org/abs/2304.13835 | Abstract only |
| s9 | 2026 preprint on LLM turn-taking in group chat (benchmark of 120K+ conversations), https://arxiv.org/abs/2603.11409 | Search snippet only, id not confirmed |
| s10 | HUMA, humanlike multi-user agent, https://arxiv.org/html/2511.17315v1 | Read |
| s11 | GroupGPT, https://arxiv.org/pdf/2603.01059 | Title and authors only; body unreadable |
| s12 | Measuring and Controlling Persona Drift, https://arxiv.org/abs/2402.10962 | Search snippet |
| s13 | Persona fidelity over 100+ rounds, https://arxiv.org/abs/2512.12775 | Abstract |
| s14 | Stable personas study, https://arxiv.org/abs/2601.22812 | Search snippet |
| s15 | Setlur and Tory, Gricean maxims for chatbots, https://arxiv.org/abs/2203.08420 | Search snippet |
| s16 | Benevolence and transparency added to Grice, https://arxiv.org/abs/2403.15115 | Search snippet |
| s17 | Northeastern sycophancy study, https://news.northeastern.edu/2026/02/23/llm-sycophancy-ai-chatbots/ and related Science and arXiv items | Search snippets, secondary |
| s18 | OWASP LLM01 prompt injection via secondary write-ups, e.g. https://www.promptfoo.dev/blog/lethal-trifecta-testing/ | Search snippets, secondary |
| s19 | Simon Willison, lethal trifecta, via https://aiweekly.co and others | Secondary; original blog not opened |
| s20 | California SB 243 via https://www.skadden.com/insights/publications/2025/10/new-california-companion-chatbot-law | Search snippet, secondary |
| s21 | EU AI Act Article 50 and California BOT Act via vendor blogs (e.g. closebot.com, cxnetwork.com) | Search snippets, secondary, not statute text |
| s22 | OpenClaw bot loop protection, https://docs.openclaw.ai/channels/bot-loop-protection.md | Read; product doc, not a Discord standard |
| s23 | Sacks, Schegloff, Jefferson 1974, turn-taking | Search snippets |
| s24 | Response delays in LLM virtual agents, https://arxiv.org/pdf/2507.22352 | Search snippet |
| s25 | Discord markdown, third-party guides (official support page returned 403) | Secondary |
| s26 | Third-party Discord bot privacy policies and terms (examples only) | Secondary examples, not authority |
| s27 | Local, D:/HomeAI/projects/orchestrator/MEMORY-LANGUAGE.md | Read |

## Gaps (not covered)
- Discord Developer Policy and Terms: page returned 403. Data retention and AI-training clauses are unconfirmed.
- No survey of what Discord users find annoying about bots was found.
- No research on emoji or reaction use and perceived human-likeness was found.
- Legal items (EU AI Act, California BOT Act, SB 243) come from secondary sources. Not legal advice.
- Pacing numbers in the timing scope are my guesses (marked unverified).
- Many rules are tagged #design: my synthesis, not tested in this channel.

## Added in v2 (2026-10-16, bot-prompt research)
| Ref | Source | Status |
|---|---|---|
| s28 | OpenClaw group chat docs, https://docs.openclaw.ai/channels/groups | Read |
| s29 | SillyTavern group chats, https://docs.sillytavern.app/usage/core-concepts/groupchats/ | Search summary only |
| s30 | Anthropic claude.ai system prompt notes (Sonnet 5.5, 2026-10-07), https://platform.claude.com/docs/en/release-notes/system-prompts/claude-sonnet-5-5 | Read in full |
| s31 | ChatGPT "listener" personality prompt, https://github.com/asgeirtj/system_prompts_leaks (OpenAI/gpt-5-listener-personality.md) | Read; third-party extraction, unofficial |
| s32 | Sesame "Maya" prompt, same repo (Misc/sesame-ai-maya.md), originally from a Reddit post | First ~4.5 KB read; community-extracted, unofficial |
| s33 | Character.AI prompt template, same repo (Misc/character-ai.md) | Read; unofficial |
| s34 | ChatGPT WhatsApp prompt, same repo (OpenAI/Old/gpt-4o-whatsapp.md) | Read; unofficial |
| s35 | Generative Agents (Park et al. 2023, arXiv 2304.03442) via secondary summaries | Secondary only; thresholds unverified |

Not found or not usable: Discord-Buddy's source (the page I fetched was a login screen), Eliza's group-reply code (URL 404), Pi companion prompt (the repo's "Pi" file is a coding agent, a different product), Neuro-sama's pipeline (no technical write-up found). Leaked prompts are unofficial and may be incomplete or out of date. I used them for ideas only, not copied text. Downloaded copies are in D:/HomeAI/state/research/bots (data only, not executed).
