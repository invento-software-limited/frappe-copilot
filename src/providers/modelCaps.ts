/** What a model accepts — effort levels, thinking style, sampling params —
 *  so providers send only valid request fields and the UI only offers
 *  settings the model honours. Unknown models get the conservative answer. */

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export interface ModelCaps {
  /** Effort levels the model accepts, lowest first; empty = no effort control. */
  effortLevels: EffortLevel[];
  /** What the model does when effort is not sent. */
  defaultEffort?: EffortLevel;
  /** 'adaptive' = thinking: {type: 'adaptive'}; 'budget' = legacy budget_tokens; 'none'. */
  thinking: 'adaptive' | 'budget' | 'none';
  /** Model thinks even when `thinking` is omitted. */
  thinksByDefault: boolean;
  /** Custom temperature accepted (removed on newer Claude and OpenAI reasoning models). */
  temperature: boolean;
  /** Output-token ceiling worth asking for when streaming. */
  maxOutput: number;
}

const ALL: EffortLevel[] = EFFORT_LEVELS;

/** First match wins. Ordered newest/most specific first. */
const CLAUDE: [RegExp, ModelCaps][] = [
  [/claude-(fable|mythos)-/, { effortLevels: ALL, defaultEffort: 'high', thinking: 'adaptive', thinksByDefault: true, temperature: false, maxOutput: 64000 }],
  [/claude-opus-5-5/, { effortLevels: ALL, defaultEffort: 'medium', thinking: 'adaptive', thinksByDefault: true, temperature: false, maxOutput: 64000 }],
  [/claude-(opus-5|sonnet-5)/, { effortLevels: ALL, defaultEffort: 'high', thinking: 'adaptive', thinksByDefault: true, temperature: false, maxOutput: 64000 }],
  [/claude-opus-4-[78]/, { effortLevels: ALL, defaultEffort: 'high', thinking: 'adaptive', thinksByDefault: false, temperature: false, maxOutput: 64000 }],
  [/claude-(opus|sonnet)-4-6/, { effortLevels: ['low', 'medium', 'high', 'max'], defaultEffort: 'high', thinking: 'adaptive', thinksByDefault: false, temperature: true, maxOutput: 64000 }],
  [/claude-opus-4-5/, { effortLevels: ['low', 'medium', 'high'], defaultEffort: 'high', thinking: 'budget', thinksByDefault: false, temperature: true, maxOutput: 32000 }],
  [/claude-/, { effortLevels: [], thinking: 'budget', thinksByDefault: false, temperature: true, maxOutput: 32000 }],
];

/** OpenAI-style reasoning models take reasoning_effort (low/medium/high) and no temperature. */
const OPENAI_REASONING = /^(gpt-5|o\d)/;

export function capsFor(model: string): ModelCaps {
  const id = (model || '').toLowerCase();
  const claude = CLAUDE.find(([re]) => re.test(id));
  if (claude) return claude[1];
  if (OPENAI_REASONING.test(id)) {
    return { effortLevels: ['low', 'medium', 'high'], defaultEffort: 'medium', thinking: 'none', thinksByDefault: true, temperature: false, maxOutput: 32000 };
  }
  return { effortLevels: [], thinking: 'none', thinksByDefault: false, temperature: true, maxOutput: 16384 };
}

/** Nearest level the model supports — never above what was asked, unless nothing lower exists. */
export function clampEffort(requested: EffortLevel | undefined, caps: ModelCaps): EffortLevel | undefined {
  if (!requested || caps.effortLevels.length === 0) return undefined;
  if (caps.effortLevels.includes(requested)) return requested;
  const rank = EFFORT_LEVELS.indexOf(requested);
  const lower = caps.effortLevels.filter(l => EFFORT_LEVELS.indexOf(l) <= rank);
  return lower.length ? lower[lower.length - 1] : caps.effortLevels[0];
}

export function isEffortLevel(v: unknown): v is EffortLevel {
  return typeof v === 'string' && (EFFORT_LEVELS as string[]).includes(v);
}
