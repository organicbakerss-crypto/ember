# Rifujin V3 — source-based conversational construction

The writer requested **actual question-and-answer behavior**, rather than a paragraph saying that a guest is "measured", "thoughtful" or "interested in flawed people." Version 2 did not meet that requirement: its 28 paraphrased observations taught facts and interests, not the way the real interviewee builds answers. That implementation remains archived but is **not active for this guest**.

## What the live model now receives

`src/shared/ai/guests/rifujin-exchanges.ts` contains 18 identified exchanges from published Japanese interviews. Each entry includes:

- The **real interviewer question**, expressed as a faithful English paraphrase (not falsely presented as verbatim Japanese or English).
- The **sequence of the published response**: what the first sentence does, what examples or reasons follow, and where he stops. These are source-grounded, ordered notes, not an invented response.
- Where feasible, a **short exact original Japanese fragment** from his answer, explicitly labeled as such. Copyright prevents bulk transcription and does not permit us to paste all his speeches or novel chapters.
- The original article URL and a named topic/context anchor, plus whether the medium was a published/edited written interview.

`speech.ts` selects four distinct examples by subject and interaction type, reserving at least one ordinary/social example so that the guest does not become a one-topic authorial archetype. `types.ts` sends those question/answer demonstrations to **both normal Chat and Roundtable**. They occur at the end of the relevant system instruction, following the generic anti-AI guidance, to give the sourced constructions greater prominence.

The previous `rifujin-evidence.ts` and `evidence.ts` remain in the repository as **historical V2 artifacts only**. They no longer build the live Rifujin speech prompt. V1 and V2 profile implementations are backed up separately. The selected character ID and saved conversations remain unchanged.

## Primary evidence and observed patterns

1. [June 2025 long Japanese interview on Orc Eroica — ラノベニュースオンライン](https://ln-news.com/articles/122643)
   - Intro question: begins by describing how his career started, turns to an everyday preference, then the ordinary routine and a change at home.
   - Question about his new house: accepts a joke very briefly, offers a mundane physical correction, and extends the same joke.
   - Career-retrospective question: begins with an impression of elapsed time, then simple daily actions, then specifies one meaningful change.
   - Fellow-writer-friend question: responds to the personal detail before supplying contextual explanation; narrows to a single exception.
   - Success question: initially admits the question is difficult, explains his former misunderstanding with a concrete timeline, credits specific collaborators.
   - Productivity question: lists the actual work that makes task switching hard, then notes his own difficulty.
   - Strongest-orc question: answers in a single direct sentence before deriving the worldbuilding logic at length.
   - New work's production-method question: gives a short qualified answer, then concrete time constraints and an extended creative-energy analogy.

2. [Earlier Japanese author interview/Q&A — 小説家になろう](https://ncode.syosetu.com/n3654cm/17/)
   - Expectations about success: starts with one bare negative sentence, then describes what he expected and how the approach later changed.
   - Reading frequency: gives a number, compares it with his earlier habit, adds a manga qualification, stops.
   - Whether reading determines writing quality: rejects the claimed proportional relationship, supplies other sources of experience, then adds a medium-specific qualification.
   - Book recommendations: gives a simple recommendation first, adds a graduated search strategy if requested.
   - Advice to younger self: avoids prescriptions and explains a concrete reason linked to his own behavior.
   - Writing tools: gives tangible hardware details, concedes software limitations, lists specific practical reliability reasons.
   - Fiction planning: follows a long causal chain of goals and checkpoints rather than a templated list of three.

The selected examples also include his discussions of fighting games and how creative ideas are evaluated; he is not restricted to character psychology.

## Limits

A published interview is not raw conversation. Editing, Japanese morphology, translation and context may change what appears to be personal cadence. The system **must not** assert it knows Rifujin's exact English sentence lengths, vocabulary, pauses or spontaneous delivery. The English notes are original analyses and are not disguised fake translations. There are a few genuine short Japanese excerpts, not fabricated English quotes. Source links allow auditing the longer answers.

A future improvement is source-authorized longer transcript excerpts from recordings, if available. For now, preserving exact *ordering of moves between source questions and answers* is more defensible than inventing English quotations.

## Behavioral comparison still needed

Automated tests confirm the source data is wired in and the selector preserves a range of documented response structures. They do not prove conversational fidelity. Use a **fresh** Ember chat with the same model and settings for A/B, including the original gaming question, a one-sentence practical question, an unexpected social observation, and a disagreement. Compare to V2 for repeated category-introductions, forced neat endings, same response length, and response movement. Test without invoking the novel or the Roundtable as well.

The anti-AI shared layer is unchanged; this revision addresses the separate failure of *positive evidence for conversational construction*. 
