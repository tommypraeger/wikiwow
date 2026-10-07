// AI moderator: judges fuzzy guesses, answers yes/no questions, gives hints,
// and optionally groups near-duplicate articles.
//
// Providers:
//   claude - ANTHROPIC_API_KEY (model: CLAUDE_MODEL, default claude-opus-5-5)
//   openai - OPENAI_API_KEY    (model: OPENAI_MODEL, default gpt-5-mini)
// A key can also be supplied per game from the UI; it stays in server memory.

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import OpenAI from 'openai';
import { z } from 'zod';
import type { AIProvider, Entry } from '../shared/types.js';

export interface AIConfig {
  provider: AIProvider;
  apiKey: string | null;
}

const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5-mini';

export function serverProviders(): Record<AIProvider, boolean> {
  return {
    claude: Boolean(process.env.ANTHROPIC_API_KEY),
    openai: Boolean(process.env.OPENAI_API_KEY),
  };
}

const anthropicClients = new Map<string, Anthropic>();
const openaiClients = new Map<string, OpenAI>();

function keyFor({ provider, apiKey }: AIConfig): string {
  const key = apiKey || (provider === 'openai' ? process.env.OPENAI_API_KEY : process.env.ANTHROPIC_API_KEY);
  if (!key) throw new Error(`No API key configured for ${provider}`);
  return key;
}

function claudeClient(cfg: AIConfig): Anthropic {
  const key = keyFor(cfg);
  let c = anthropicClients.get(key);
  if (!c) anthropicClients.set(key, (c = new Anthropic({ apiKey: key })));
  return c;
}

function openaiClient(cfg: AIConfig): OpenAI {
  const key = keyFor(cfg);
  let c = openaiClients.get(key);
  if (!c) openaiClients.set(key, (c = new OpenAI({ apiKey: key })));
  return c;
}

export function aiAvailable({ provider, apiKey }: AIConfig): boolean {
  if (apiKey) return true;
  return serverProviders()[provider] || false;
}

/** Turn provider errors into something worth showing in the game feed. */
function friendly(err: unknown): Error {
  const status = (err as { status?: number }).status;
  if (status === 401 || status === 403) return new Error('the AI API key was rejected');
  if (status === 429) return new Error('the AI is rate limited, try again in a moment');
  if (status && status >= 500) return new Error('the AI service is having trouble');
  if (err instanceof z.ZodError || err instanceof SyntaxError) return new Error('the AI gave an unreadable answer');
  return err instanceof Error ? err : new Error(String(err));
}

async function structured<S extends z.ZodType>(cfg: AIConfig, system: string, user: string, schema: S): Promise<z.infer<S>> {
  try {
    return await callModel(cfg, system, user, schema);
  } catch (err) {
    throw friendly(err);
  }
}

async function callModel<S extends z.ZodType>(cfg: AIConfig, system: string, user: string, schema: S): Promise<z.infer<S>> {
  if (cfg.provider === 'openai') {
    const res = await openaiClient(cfg).chat.completions.create({
      model: OPENAI_MODEL,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content: `${user}\n\nRespond with only a JSON object matching this JSON Schema:\n${JSON.stringify(z.toJSONSchema(schema))}`,
        },
      ],
    });
    return schema.parse(JSON.parse(res.choices[0]?.message.content || '{}'));
  }
  const res = await claudeClient(cfg).messages.parse({
    model: CLAUDE_MODEL,
    max_tokens: 4000,
    // Moderation is latency-sensitive and simple; keep thinking light.
    output_config: { effort: 'low', format: zodOutputFormat(schema) },
    system,
    messages: [{ role: 'user', content: user }],
  });
  if (res.stop_reason === 'refusal') throw new Error('The AI moderator declined to answer');
  if (!res.parsed_output) throw new Error('The AI moderator returned an unreadable answer');
  return res.parsed_output as z.infer<S>;
}

const GAME_RULES = `You are the moderator of WikiWow, a party guessing game.
Players are given two letters and try to guess the top Wikipedia articles that appear in Wikipedia's search autocomplete for those letters.
A correct guess (one of the top answers) is a "Wiki Wow". A guess in the top 20 that isn't a top answer is a "Wiki What" and earns a yes/no question. Anything else is a "Wiki Womp" and costs a life.
Be fun and brief. Never reveal unrevealed answer titles.`;

const fmtEntry = (e: Entry) =>
  `#${e.rank}: ${e.title}${e.description ? ` — ${e.description}` : ''}${
    e.members.length > 1 ? ` (also covers: ${e.members.slice(1).join('; ')})` : ''
  }`;

/** Which ranked entry (if any) does a free-text guess refer to? */
export async function judgeGuess(
  ai: AIConfig,
  { letters, guess, entries }: { letters: string; guess: string; entries: Entry[] },
): Promise<{ rank: number | null; reason: string }> {
  const schema = z.object({
    rank: z.number().int().nullable().describe('rank of the matching article, or null if none match'),
    reason: z.string().describe('one short sentence'),
  });
  const out = await structured(
    ai,
    GAME_RULES,
    `Letters: "${letters.toUpperCase()}"
Ranked autocomplete articles:
${entries.map(fmtEntry).join('\n')}

A player guessed: "${guess}"

Which article does the guess refer to? Accept misspellings, missing qualifiers, common names, and abbreviations when they clearly identify ONE article (e.g. "Lincoln" for "Abraham Lincoln", "Abu Ghraib" for "Abu Ghraib torture and prisoner abuse"). If the guess is a different topic that merely shares words, or is too vague to identify a specific listed article, return null.`,
    schema,
  );
  return out.rank && entries.some((e) => e.rank === out.rank) ? out : { rank: null, reason: out.reason };
}

/** Answer a yes/no question about the answers. */
export async function answerQuestion(
  ai: AIConfig,
  {
    letters,
    question,
    targets,
    history,
  }: { letters: string; question: string; targets: (Entry & { found: boolean })[]; history: { q: string; a: string }[] },
) {
  const schema = z.object({
    verdict: z.enum(['yes', 'no', 'sort of', 'too direct', 'not yes/no']),
    explanation: z
      .string()
      .describe('One short, playful sentence. Must not reveal any unrevealed title or spell out its letters.'),
  });
  return structured(
    ai,
    GAME_RULES,
    `Letters: "${letters.toUpperCase()}"
The answers (top ${targets.length}), with whether players have found them yet:
${targets.map((t) => `${fmtEntry(t)} [${t.found ? 'FOUND' : 'hidden'}]`).join('\n')}

Previous questions this round:
${history.length ? history.map((h) => `Q: ${h.q} -> ${h.a}`).join('\n') : '(none)'}

The players ask: "${question}"

Answer truthfully. Questions may be about a single answer (e.g. "the 2nd answer", "one of the hidden ones") or about the set (e.g. "are any of them people?"). When the question is about "any"/"all", consider only the hidden answers unless the question clearly includes found ones.
Return "too direct" if the question names or guesses a specific title, asks about spelling/letters/word count, or would by itself pin down one exact article (e.g. "is it Abraham Lincoln?", "is one a US president who was assassinated in 1865?"). Broad category questions are fine ("is one a person?", "is one a place in Asia?").
Return "not yes/no" if it can't be answered yes or no. Use "sort of" when the honest answer is mixed or ambiguous.`,
    schema,
  );
}

/** A gentle hint about one hidden answer. */
export async function giveHint(
  ai: AIConfig,
  { letters, target, previousHints }: { letters: string; target: Entry; previousHints: string[] },
): Promise<string> {
  const schema = z.object({ hint: z.string() });
  const out = await structured(
    ai,
    GAME_RULES,
    `Letters: "${letters.toUpperCase()}"
Give the players a hint for this hidden answer: ${fmtEntry(target)}
Hints already given for it: ${previousHints.length ? previousHints.join(' | ') : '(none)'}
Write one short hint that is a bit more specific than any previous hint but does NOT contain any word of the title. Don't spell out letters.`,
    schema,
  );
  return out.hint;
}

/** Ask the AI which of the top entries are really the same topic. */
export async function suggestMerges(ai: AIConfig, { letters, entries }: { letters: string; entries: Entry[] }): Promise<number[][]> {
  const schema = z.object({
    groups: z
      .array(z.array(z.number().int()))
      .describe('Each inner array lists ranks that are essentially the same topic. Omit singletons.'),
  });
  const out = await structured(
    ai,
    GAME_RULES,
    `Letters: "${letters.toUpperCase()}"
${entries.map(fmtEntry).join('\n')}

Some of these articles are near-duplicates that players would consider the same answer, e.g. "USB" / "USB-C" / "USB 3.0", "Windows 10" / "Windows 10 version history", "The Office (American TV series)" / "The Office (British TV series)", or a topic and its obvious sub-article. Group those. Do NOT group things that are merely related but clearly distinct (e.g. "Abraham" and "Abraham Lincoln", two different US Navy ships, two different people with the same surname).`,
    schema,
  );
  return out.groups;
}
