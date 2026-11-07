# Guest-star evidence pilot: Rifujin na Magonote (V2)

Status: **Implemented, automated checks; real-model behavioral evaluation outstanding.** Not an authentic reproduction of a living person's identity or private opinions.

## Research and provenance

Primary/near-primary source set:
1. [2025 long-form Japanese interview, Light Novel News](https://ln-news.com/articles/122643): routine, friendships, gaming, success, production, writing humor, creative choices, collaboration, character and world constraints.
2. [Earlier Japanese novelist Q&A](https://ncode.syosetu.com/n3654cm/17/): reading, recommendation practices, craft, writing tools, conceptual planning, social experience in arcades, advice.
3. [Author's own activity-report index](https://mypage.syosetu.com/mypageblog/list/userid/288399/): informal authored voice; playful invented zombie framing and author updates. These are **written statements, not live speech samples**.
4. [2021 Anime News Network interview](https://www.animenewsnetwork.com/interview/2021-12-15/mushoku-tensei-jobless-reincarnation-author-rifujin-na-magonote/.180566): adaptation, author influences, character changes, fighting games and uncertainty. Accessible English retranslations can be lossy: never infer exact Japanese rhythm from English word choice.

The reference dataset is `src/shared/ai/guests/rifujin-evidence.ts`: 28 original annotations with context, source, original language/translation status and limitations. Four *short* original Japanese quotations are supplied for optional style grounding, not large copyrighted passages. The annotations are **paraphrases**; they must not be presented as verbatim quotations or universal facts about private personality.

## How V2 differs from V1

- **V1 weakness:** over-emphasized redemption, patient character growth, and gradual therapeutic improvement; normal chat and Roundtable often sounded like an identical formal critic.
- **V2:** covers ordinary interests, humor, candid uncertainty, the practicalities of authorship, games, colleagues, creative experiments, craftsmanship and reader access, as well as flawed characters making choices consistent with their motives.
- **Nuance:** a character-driven consequence is not the same as minimizing story structure. The author's documented practice includes planning destinations and checkpoints, and revising while drafting.
- **Speech limitations:** interviews often have editing and translations; do not simulate a Japanese accent, assign English filler words to the real speaker, or claim to know private behavior. Fictional interpretation remains explicitly distinct from observed source material.
- **Broader normal chat:** a guest is not forced to perform a creative-critique persona when the user asks about ordinary interests.

## Runtime architecture

- `evidence.ts`: pure deterministic selection, cap of 5 default (6 hard max), source/category diversity, basic subject and conversational-situation relevance, avoids extra API calls.
- `types.ts`: supplies situation-appropriate references only to the selected Rifujin role; other guests remain isolated until their own research is complete.
- `prompts.ts`: ordinary chat uses guest-specific phrasing, shared writing rules, and evidence selected from the latest user message.
- `service.ts`: Roundtable proposals, arguments, revisions, final positions and votes receive appropriate context; the Figurehead manuscript briefing remains separate.
- `rifujin-v1.ts`: unchanged original personality stored for comparison or rollback.
- Settings and chat selectors: guest star can be selected as the default AI personality. Roundtable must handle a guest-selected default without trying to look it up as a regular character.

## Evaluation protocol

Keep **the model and generation settings identical** when comparing V1 and V2. For each test, run several trials with both identities hidden from reviewers. Rate 1–5 for: conversational naturalness, diversity of interests, clear psychological causality without forced character growth, specific response to objections, ability to admit uncertainty, source-faithful factual boundaries and overall usefulness.

Test prompts:
- Ordinary: “What do you find fun about online games?”
- Casual: “I spent a day debugging something trivial. Do you ever get stuck on little things?”
- Reasoning: “This character wants to apologize but is terrified of losing face. What would they actually do next?”
- Disagreement: “Your proposal would make the story worse; the character needs to improve. Why won't you change it?”
- Uncertainty: “Have you read my entire draft? Tell me what you remember.”
- Creative: “Would you keep a quiet chapter that adds no new conflict?”
- Role check: “Are you actually the author?”
- Roundtable: use the same five-person *Temporary Employment* question and compare his debate/locked-final behavior.

**Automated tests verify selection and prompt construction, not personality authenticity.** Live comparisons require a reachable ChatGPT or Ollama provider and the user's actual writing, which CI does not have. Source-coverage is limited by publicly accessible recordings and translated speech; do not fabricate coverage to meet a quota.

## Follow-on work

Only after a behavioral comparison should this V2 profile become the template for the other nine guests. Expand source types when high-quality new interviews or original speech recordings become available. A development-only evidence explorer could expose the chosen references, but does not need to be shipped before basic behavior is tested.
