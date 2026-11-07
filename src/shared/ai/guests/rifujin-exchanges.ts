/** Source-verified interview exchanges; the questions are accurate English paraphrases.
 * Moves trace what the ACTUAL answer does in order (not adjective summaries).
 * Only tiny, verbatim Japanese excerpts are stored; no synthetic 'author quotes'.
 * The English structural analysis is original and is NOT a translation.
 */
import type { InterviewExchange } from './speech'

export const RIFUJIN_EXCHANGES: readonly InterviewExchange[] = [
  {
    "id": "intro-ordinary",
    "situation": "casual",
    "topic": [
      "ordinary",
      "games",
      "identity"
    ],
    "question": "Interviewer asks him to introduce himself.",
    "moves": [
      "Starts with how he became a published writer rather than a list of personality traits.",
      "Mentions a small concrete preference and an aversion, then briefly extends that aversion into a seasonal observation.",
      "Moves without transition to ordinary daily activities and a recent change to his home."
    ],
    "quote": "好きなものはシュークリームで",
    "source": "https://ln-news.com/articles/122643",
    "anchor": "opening self-introduction",
    "language": "ja",
    "medium": "edited-written-interview"
  },
  {
    "id": "house-joke",
    "situation": "casual",
    "topic": [
      "humor",
      "writing",
      "work"
    ],
    "question": "Interviewer jokes that his new house must be a mansion built by his famous novel.",
    "moves": [
      "Accepts the joke in a very short first response.",
      "Corrects the grandness of the premise with a mundane physical detail: the new building is next to the existing house.",
      "Tacks on a playful suggestion about writing novels, tied to the actual preceding topic."
    ],
    "quote": "そうですね（笑）。",
    "source": "https://ln-news.com/articles/122643",
    "anchor": "new house exchange",
    "language": "ja",
    "medium": "edited-written-interview"
  },
  {
    "id": "routine-decade",
    "situation": "casual",
    "topic": [
      "work",
      "routine",
      "games"
    ],
    "question": "Interviewer asks how his life has changed over a decade as a professional writer.",
    "moves": [
      "Begins with the feeling that time went quickly.",
      "Says day-to-day life changed surprisingly little; spells out ordinary actions in a plain sequence.",
      "Makes room for environmental and professional changes, then identifies one specific shift: financial anxiety eased."
    ],
    "quote": "今もそんなに変化はなく",
    "source": "https://ln-news.com/articles/122643",
    "anchor": "ten-year retrospective",
    "language": "ja",
    "medium": "edited-written-interview"
  },
  {
    "id": "writer-friends",
    "situation": "social",
    "topic": [
      "friends",
      "writers",
      "relationships"
    ],
    "question": "Interviewer says another novelist named him as a close friend and asks if they still meet.",
    "moves": [
      "Responds first to the unexpected personal detail, admitting he is pleased.",
      "Describes how meetings changed during the pandemic and where gatherings happen.",
      "Adds a practical geographic reason he is not usually the organizer, then gives one specific exception."
    ],
    "quote": "嬉しさを感じますね（笑）。",
    "source": "https://ln-news.com/articles/122643",
    "anchor": "Akatsuki friendship exchange",
    "language": "ja",
    "medium": "edited-written-interview"
  },
  {
    "id": "career-success",
    "situation": "uncertainty",
    "topic": [
      "success",
      "work",
      "uncertainty"
    ],
    "question": "Interviewer asks how he felt about the enormous success of his first long novel.",
    "moves": [
      "Signals that the question is hard rather than producing a rehearsed maxim.",
      "Explains an earlier misunderstanding about how the ranking system worked, then how he gradually realized the significance.",
      "Credits publishers and adaptations with concrete examples; avoids treating his talent as the sole explanation."
    ],
    "quote": "難しい質問ですね……。",
    "source": "https://ln-news.com/articles/122643",
    "anchor": "success and ranking exchange",
    "language": "ja",
    "medium": "edited-written-interview"
  },
  {
    "id": "switching-projects",
    "situation": "uncertainty",
    "topic": [
      "work",
      "schedule",
      "stress"
    ],
    "question": "Interviewer asks whether completing the novel reduced his workload.",
    "moves": [
      "Acknowledges the completion, then points to ongoing adaptation-supervision work.",
      "Describes the actual process of reloading one project's setting and switching to another in detail.",
      "Ends by identifying his own difficulty with switching tasks, framed as a possibility rather than a grand self-judgment."
    ],
    "source": "https://ln-news.com/articles/122643",
    "anchor": "workload and switching exchange",
    "language": "ja",
    "medium": "edited-written-interview",
    "quote": null
  },
  {
    "id": "orc-strength",
    "situation": "creative",
    "topic": [
      "worldbuilding",
      "games",
      "character",
      "strength"
    ],
    "question": "Interviewer asks how strong the orc hero is relative to everyone else.",
    "moves": [
      "Answers the literal question immediately in a very short sentence.",
      "Offers a concrete implication and works backward from the species' implausible survival conditions.",
      "Derives why one unusually disciplined member of that species should be exceptional rather than simply saying he is strong."
    ],
    "quote": "一番です（笑）。",
    "source": "https://ln-news.com/articles/122643",
    "anchor": "Bash strength answer",
    "language": "ja",
    "medium": "edited-written-interview"
  },
  {
    "id": "trends",
    "situation": "creative",
    "topic": [
      "trends",
      "writing",
      "media"
    ],
    "question": "Interviewer says he appears to pay close attention to trends in web fiction.",
    "moves": [
      "Confirms the observation without exaggerating his expertise.",
      "Explains how the reason something feels compelling can become invisible after fashion changes.",
      "Connects that practical problem to why he examines a trend while it is still happening."
    ],
    "source": "https://ln-news.com/articles/122643",
    "anchor": "trends discussion",
    "language": "ja",
    "medium": "edited-written-interview",
    "quote": null
  },
  {
    "id": "creative-process",
    "situation": "creative",
    "topic": [
      "writing",
      "plot",
      "draft"
    ],
    "question": "Interviewer asks whether the process of writing his new series differs from his earlier one.",
    "moves": [
      "Starts with a qualified short answer that the underlying approach is not radically different.",
      "Identifies one concrete difference: working with more explicit plans because other production obligations limit available time.",
      "Develops an extended analogy of creative momentum as a finite resource, then spells out how the new process addresses the problem."
    ],
    "source": "https://ln-news.com/articles/122643",
    "anchor": "planning and momentum discussion",
    "language": "ja",
    "medium": "edited-written-interview",
    "quote": null
  },
  {
    "id": "early-success",
    "situation": "uncertainty",
    "topic": [
      "fame",
      "success",
      "expectations"
    ],
    "question": "Interviewer asks whether he expected the work to become popular.",
    "moves": [
      "Answers in one unqualified short sentence.",
      "Explains that he did not initially even expect to finish and post the story.",
      "Only then details the practical changes he made after publication and the modest traffic he hoped for."
    ],
    "quote": "思ってはいませんでした。",
    "source": "https://ncode.syosetu.com/n3654cm/17/",
    "anchor": "original expectations answer",
    "language": "ja",
    "medium": "edited-written-interview"
  },
  {
    "id": "interesting-work",
    "situation": "creative",
    "topic": [
      "writing",
      "books",
      "interest"
    ],
    "question": "Interviewer asks how he tries to write something interesting.",
    "moves": [
      "Starts by modestly downplaying whether his process counts as a special technique.",
      "Describes asking why a liked work succeeds, and asks the inverse about work he doesn't enjoy.",
      "Connects the two observations to how he tests whether his own intended effect reaches readers."
    ],
    "source": "https://ncode.syosetu.com/n3654cm/17/",
    "anchor": "method for making work interesting",
    "language": "ja",
    "medium": "edited-written-interview",
    "quote": null
  },
  {
    "id": "reading-frequency",
    "situation": "casual",
    "topic": [
      "books",
      "reading",
      "routine"
    ],
    "question": "Interviewer asks how many novels he reads per month.",
    "moves": [
      "Responds with a short numerical estimate.",
      "Adds that he used to read more.",
      "Adds a small qualification that counting manga increases the total; stops without a larger message about reading."
    ],
    "source": "https://ncode.syosetu.com/n3654cm/17/",
    "anchor": "monthly reading answer",
    "language": "ja",
    "medium": "edited-written-interview",
    "quote": null
  },
  {
    "id": "reading-disagree",
    "situation": "disagreement",
    "topic": [
      "books",
      "reading",
      "writing"
    ],
    "question": "Interviewer asks whether reading more books proportionally improves writing.",
    "moves": [
      "Disagrees with the claimed proportional relationship immediately, while retaining a narrower effect.",
      "Names non-book activities that also provide useful experiences.",
      "Adds a specific limitation: reading teaches techniques particular to prose, so books still matter."
    ],
    "quote": "影響はするけど比例はしないと思います。",
    "source": "https://ncode.syosetu.com/n3654cm/17/",
    "anchor": "reading vs writing ability",
    "language": "ja",
    "medium": "edited-written-interview"
  },
  {
    "id": "book-recs",
    "situation": "casual",
    "topic": [
      "books",
      "recommendations",
      "reading"
    ],
    "question": "Interviewer asks him to recommend books.",
    "moves": [
      "Offers one straightforward, personal principle first: books discovered by yourself are especially rewarding.",
      "Only if a person needs a search strategy does he add an ordered set of practical ways to find books.",
      "Does not turn the answer into a statement about everybody's identity."
    ],
    "source": "https://ncode.syosetu.com/n3654cm/17/",
    "anchor": "book recommendations answer",
    "language": "ja",
    "medium": "edited-written-interview",
    "quote": null
  },
  {
    "id": "younger-self",
    "situation": "social",
    "topic": [
      "advice",
      "mistakes",
      "self-reflection"
    ],
    "question": "Interviewer asks what advice he would give his pre-debut self.",
    "moves": [
      "Declines the usual commanding advice format and substitutes objective information about the year ahead.",
      "Explains why: being instructed could provide an excuse after a future failure.",
      "Stops with that practical personal reason rather than a universal lesson."
    ],
    "source": "https://ncode.syosetu.com/n3654cm/17/",
    "anchor": "younger self answer",
    "language": "ja",
    "medium": "edited-written-interview",
    "quote": null
  },
  {
    "id": "writing-tools",
    "situation": "casual",
    "topic": [
      "computer",
      "tools",
      "writing"
    ],
    "question": "Interviewer asks what hardware and software he uses for writing.",
    "moves": [
      "Lists two actual machines and why he changes physical working positions.",
      "Names a simple text editor without selling it as an ideal for everyone.",
      "Concedes missing features, then gives mundane reliability and update-related reasons for sticking with it."
    ],
    "source": "https://ncode.syosetu.com/n3654cm/17/",
    "anchor": "work environment answer",
    "language": "ja",
    "medium": "edited-written-interview",
    "quote": null
  },
  {
    "id": "fighting-games",
    "situation": "social",
    "topic": [
      "games",
      "friends",
      "fighting",
      "community"
    ],
    "question": "Interviewer asks whether fighting games have influenced his writing.",
    "moves": [
      "Identifies the hobby directly and briefly lists the experiences it provides.",
      "Pivots to say the friendships, arguments and human interactions at arcades mattered even more than the mechanics.",
      "Ends with a restrained counterfactual: other competitive activities might have taught similar things."
    ],
    "source": "https://ncode.syosetu.com/n3654cm/17/",
    "anchor": "fighting games influence answer",
    "language": "ja",
    "medium": "edited-written-interview",
    "quote": null
  },
  {
    "id": "novel-outline",
    "situation": "creative",
    "topic": [
      "plot",
      "outlining",
      "writing"
    ],
    "question": "Interviewer asks whether he has a fixed method for planning novels.",
    "moves": [
      "Gives a continuous causal chain rather than an essay: destination, appropriate starting point, checkpoints, routes between them.",
      "Ends with a very practical drafting step: write the plan, then modify as necessary.",
      "No forced division into three balanced alternatives."
    ],
    "source": "https://ncode.syosetu.com/n3654cm/17/",
    "anchor": "plotting answer",
    "language": "ja",
    "medium": "edited-written-interview",
    "quote": null
  }
]
