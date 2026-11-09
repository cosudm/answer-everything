# Product

**Promise:** Ask anything. Get the strongest available answer, and see what supports it.

**Siblings:** Ricorsa's center of gravity is identity (intelligence built around me and the people I know). Answer Everything's center of gravity is the question (every available intelligence brought to what I'm asking). They share interaction patterns at the family level; Answer Everything has its own information architecture and visual identity.

## What the product distinguishes

Every answer is recorded with a disposition and classified claims:

| Disposition           | Statement shown                                                               |
| --------------------- | ----------------------------------------------------------------------------- |
| ANSWERED              | (none; the answer is the statement)                                           |
| PARTIALLY_ANSWERED    | Partially answered. Some aspects could not be established.                    |
| NEEDS_CLARIFICATION   | The question could not be reliably interpreted. Clarification is needed.      |
| INSUFFICIENT_EVIDENCE | The evidence was insufficient to support a reliable answer.                   |
| AUTHORIZATION_DENIED  | This information is not available in your authorized sources.                 |
| PROVIDER_RESTRICTED   | The selected provider declined this request. (+ "Try another approved model") |
| UNSUPPORTED           | The required capability is not currently connected.                           |
| FAILED                | The request could not be completed because of a platform or provider error.   |

Claims: sourced fact · user-provided fact · inference · recommendation · uncertain (not traced to a source). Confidence is evidence coverage, labelled as such, never the model's tone.

## Experience

Three regions. Left: Ask, Research, Knowledge, Projects, Models, History, Settings. Center: the question and its answer in a measured serif column. Right: the context panel (Sources, Models, Evidence, Knowledge, Answer path, Details) that makes provenance inspectable without cluttering the answer.

Home is a single large composer under "What do you want to know?", with quiet entry points and the user's recent work below. Nothing on the first screen is a dashboard.

Model selection is a capability choice: Auto, Frontier, Research, Private, High latitude, Experimental, then specific models grouped by deployment. Unselectable models stay visible with the reason, so users learn what their workspace permits. "Uncensored" is never used as product language.

Progressive disclosure: Level 1 (ask, attach, model, knowledge on/off) is always visible; Level 2 (compare, sources, evidence, answer path, privacy) lives in the panel and header; Level 3 (model lab, evaluation, routing, provider configuration) lives under Models and Controls.

## Personality

Curious, direct, rigorous, transparent, calm, non-judgmental, evidence-oriented. The product earns credibility by answering well and by saying exactly why when it cannot, never by sounding edgy.

## Implemented vs designed

Implemented: Ask, Compare, Knowledge, Projects, Models and Model detail, Controls, History, answer states, context panel, mobile layout.

Designed, not yet built: Research execution (visible step-by-step process), Go Deeper (expand an answer with more sources, other models, disagreements, evidence check, deeper synthesis), Challenge This (the platform attempts to disprove its own answer). These are the signature interactions; they are not rendered until they work. See ROADMAP.md.

## UX north star

First-time user, five seconds: _I can ask this almost anything and it will use the best intelligence available to give me the strongest answer it can support._ Sophisticated user, over time: _I control the models, sources, private knowledge, research depth, verification, privacy and evidence behind that answer._
