// Room + round state machine. Everything clients see goes through view();
// unrevealed answers never leave the server except to a human moderator
// holding the room's moderator token.

import crypto from 'node:crypto';
import { searchTitles, dedupe, mergeByRanks, randomPair } from './wiki.js';
import { matchGuess, normalize, startsWithLetters } from './match.js';
import * as ai from './ai.js';
import {
  QUESTION_VERDICTS,
  type Entry,
  type LogEntry,
  type LogType,
  type Pending,
  type QuestionVerdict,
  type RoomView,
  type RoundStatus,
  type Settings,
  type Slot,
  type Stats,
  type Suggestion,
  type Verdict,
  type ZoneHit,
} from '../shared/types.js';

const rooms = new Map<string, Room>();
const ROOM_TTL_MS = 12 * 60 * 60 * 1000;
const CANDIDATE_LIMIT = 100;
const MAX_ROOMS = Number(process.env.MAX_ROOMS || 500);
/** AI requests allowed per round (guess judging, questions, hints, dedupe). */
const AI_CALLS_PER_ROUND = Number(process.env.AI_CALLS_PER_ROUND || 40);

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export const DEFAULT_SETTINGS: Settings = {
  moderator: 'human',
  lives: 3,
  targets: 5,
  zone: 20,
  lang: 'en',
  dedupe: 'basic',
  letterMode: 'common',
  aiProvider: 'claude',
  freeQuestions: 0,
};

export type SettingsInput = { [K in keyof Settings]?: unknown } & { apiKey?: unknown; aiPassword?: unknown };

function oneOf<T extends string>(value: unknown, options: readonly T[]): value is T {
  return options.includes(value as T);
}

function int(value: unknown, fallback: number, lo: number, hi: number): number {
  const n = Math.round(Number(value));
  return clamp(Number.isFinite(n) ? n : fallback, lo, hi);
}

function sanitizeSettings(input: SettingsInput = {}, base: Settings = DEFAULT_SETTINGS): Settings {
  const s = { ...base };
  if (oneOf(input.moderator, ['human', 'ai'] as const)) s.moderator = input.moderator;
  if (input.lives != null) s.lives = int(input.lives, 3, 1, 99);
  if (input.targets != null) s.targets = int(input.targets, 5, 1, 20);
  if (input.zone != null) s.zone = int(input.zone, 20, 1, 100);
  s.zone = Math.max(s.zone, s.targets);
  if (typeof input.lang === 'string' && /^[a-z-]{2,12}$/.test(input.lang)) s.lang = input.lang;
  if (oneOf(input.dedupe, ['off', 'basic', 'aggressive'] as const)) s.dedupe = input.dedupe;
  if (oneOf(input.letterMode, ['common', 'any'] as const)) s.letterMode = input.letterMode;
  if (oneOf(input.aiProvider, ['claude', 'openai'] as const)) s.aiProvider = input.aiProvider;
  if (input.freeQuestions != null) s.freeQuestions = int(input.freeQuestions, 0, 0, 20);
  return s;
}

function newCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code: string;
  do {
    code = Array.from({ length: 4 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
  } while (rooms.has(code));
  return code;
}

export class GameError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

/** Check that switching to an AI moderator is allowed; returns whether the server key may be used. */
function authorizeAI(settings: Settings, apiKey: string | null, input: SettingsInput, alreadyAuthorized: boolean): boolean {
  const authorized = alreadyAuthorized || (input.aiPassword !== undefined && ai.checkAIPassword(input.aiPassword)) || !ai.aiPasswordRequired();
  if (settings.moderator !== 'ai') return authorized;
  if (!ai.aiAvailable({ provider: settings.aiProvider, apiKey })) {
    throw new GameError(`The AI moderator needs a ${settings.aiProvider === 'openai' ? 'OpenAI' : 'Claude'} API key`);
  }
  if (!apiKey && !authorized) {
    throw new GameError(input.aiPassword ? 'Wrong AI password' : 'Enter the AI password (or your own API key)', 403);
  }
  return authorized;
}

export function createRoom(input: SettingsInput = {}): Room {
  if (rooms.size >= MAX_ROOMS) throw new GameError('The server is full right now — try again later', 503);
  const settings = sanitizeSettings(input);
  const apiKey = typeof input.apiKey === 'string' && input.apiKey.trim() ? input.apiKey.trim() : null;
  const aiAuthorized = authorizeAI(settings, apiKey, input, false);
  const room = new Room(newCode(), settings, apiKey, aiAuthorized);
  rooms.set(room.code, room);
  return room;
}

export function getRoom(code: string): Room {
  const room = rooms.get(String(code || '').toUpperCase());
  if (!room) throw new GameError('Game not found — check the code', 404);
  return room;
}

setInterval(
  () => {
    const now = Date.now();
    for (const [code, room] of rooms) {
      if (now - room.lastActive > ROOM_TTL_MS && room.listeners.size === 0) rooms.delete(code);
    }
  },
  10 * 60 * 1000,
).unref();

interface Round {
  id: number;
  letters: string;
  status: RoundStatus;
  error: string | null;
  entries: Entry[];
  found: Record<number, { by: string | null; guess: string }>;
  revealed: Set<number>;
  zoneHits: ZoneHit[];
  womps: number;
  maxWomps: number;
  questions: number;
  hintCount: number;
  hints: Record<number, string[]>;
  qa: { q: string; a: string }[];
  pending: Pending[];
  log: LogEntry[];
  busy: boolean;
  aiCalls: number;
}

export interface Listener {
  send(view: RoomView): void;
  isMod: boolean;
}

// Statuses where every answer is shown. A lost round stays hidden so players
// can buy another life and carry on.
const SHOW_ALL: RoundStatus[] = ['won', 'revealed'];

export class Room {
  readonly modToken = crypto.randomBytes(16).toString('hex');
  round: Round | null = null;
  roundCounter = 0;
  logCounter = 0;
  stats: Stats = { rounds: 0, won: 0, lost: 0, wows: 0, whats: 0, womps: 0 };
  listeners = new Set<Listener>();
  lastActive = Date.now();

  constructor(
    readonly code: string,
    public settings: Settings,
    private apiKey: string | null,
    /** May this room use the server's own AI key? */
    private aiAuthorized: boolean,
  ) {}

  get aiCfg(): ai.AIConfig {
    return { provider: this.settings.aiProvider, apiKey: this.apiKey };
  }

  get hasAI(): boolean {
    return ai.aiAvailable(this.aiCfg) && (Boolean(this.apiKey) || this.aiAuthorized);
  }

  /** Spend one AI call from this round's budget; false when it's used up. */
  private spendAI(r: Round): boolean {
    if (!this.hasAI) return false;
    if (r.aiCalls >= AI_CALLS_PER_ROUND) {
      if (r.aiCalls === AI_CALLS_PER_ROUND) {
        r.aiCalls++; // only announce once
        this.log('system', 'The AI moderator is out of juice for this round: guesses are judged by spelling, hints are built-in.');
      }
      return false;
    }
    r.aiCalls++;
    return true;
  }

  isMod(token: unknown): boolean {
    return typeof token === 'string' && token === this.modToken;
  }

  // -- broadcasting -------------------------------------------------------

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener.send(this.view(listener.isMod));
    return () => this.listeners.delete(listener);
  }

  changed(): void {
    this.lastActive = Date.now();
    for (const l of this.listeners) l.send(this.view(l.isMod));
  }

  private log(type: LogType, text: string, extra: Partial<LogEntry> = {}): void {
    const r = this.round;
    if (!r) return;
    r.log.push({ id: ++this.logCounter, t: Date.now(), type, text, ...extra });
    if (r.log.length > 300) r.log.shift();
  }

  // -- views --------------------------------------------------------------

  view(isModToken: boolean): RoomView {
    const s = this.settings;
    const r = this.round;
    // Only a human moderator gets the answer key; with an AI moderator
    // nobody gets to peek.
    const isMod = isModToken && s.moderator === 'human';
    const view: RoomView = { code: this.code, isMod, settings: { ...s }, hasAI: this.hasAI, stats: { ...this.stats }, round: null };
    if (!r) return view;

    const over = SHOW_ALL.includes(r.status);
    const card = (e: Entry): Exclude<Slot, { hidden: true }> => ({
      rank: e.rank,
      title: e.title,
      description: e.description,
      thumb: e.thumb,
      url: e.url,
      members: e.members,
      by: r.found[e.rank]?.by ?? null,
      gaveUp: !r.found[e.rank],
    });
    view.round = {
      id: r.id,
      letters: r.letters,
      status: r.status,
      error: r.error,
      womps: r.womps,
      maxWomps: r.maxWomps,
      questions: r.questions,
      busy: r.busy,
      slots: r.entries
        .slice(0, s.targets)
        .map((e) => (over || r.found[e.rank] || r.revealed.has(e.rank) ? card(e) : { rank: e.rank, hidden: true as const })),
      zoneHits: r.zoneHits,
      zone: over ? r.entries.slice(s.targets, s.zone).map(card) : null,
      hintCount: r.hintCount,
      pending: isMod ? r.pending : r.pending.map(({ id, kind, text, by }) => ({ id, kind, text, by })),
      log: r.log.slice(-80),
      totalResults: r.entries.length,
    };
    if (isMod) {
      view.answerKey = r.entries.map((e) => ({
        rank: e.rank,
        title: e.title,
        description: e.description,
        members: e.members,
        found: Boolean(r.found[e.rank]),
        revealed: r.revealed.has(e.rank),
        zoneHit: r.zoneHits.some((z) => z.rank === e.rank),
      }));
    }
    return view;
  }

  // -- rounds -------------------------------------------------------------

  async newRound(letters?: unknown): Promise<void> {
    if (this.round?.status === 'loading') throw new GameError('Already fetching letters, hang on');
    const custom = typeof letters === 'string' ? letters.trim().toLowerCase() : '';
    if (custom && !/^\p{L}{1,3}$/u.test(custom)) throw new GameError('Letters must be 1–3 letters');
    const id = ++this.roundCounter;
    const s = this.settings;
    const round: Round = {
      id,
      letters: custom || '··',
      status: 'loading',
      error: null,
      entries: [],
      found: {},
      revealed: new Set(),
      zoneHits: [],
      womps: 0,
      maxWomps: s.lives,
      questions: s.freeQuestions,
      hintCount: 0,
      hints: {},
      qa: [],
      pending: [],
      log: [],
      busy: false,
      aiCalls: 0,
    };
    this.round = round;
    this.changed();
    const superseded = () => this.round?.id !== id;

    try {
      let entries: Entry[] = [];
      let pair = custom;
      for (let attempt = 0; attempt < 6; attempt++) {
        if (!custom) pair = randomPair(s.letterMode);
        const pages = await searchTitles(pair, s.lang);
        entries = dedupe(pages, s.dedupe).slice(0, CANDIDATE_LIMIT);
        if (custom || entries.length >= s.zone) break;
      }
      if (superseded()) return;
      if (entries.length < s.targets) {
        throw new GameError(`Only ${entries.length} results for "${pair.toUpperCase()}" — try other letters`);
      }

      if (s.moderator === 'ai' && s.dedupe !== 'off' && this.spendAI(round)) {
        try {
          const top = entries.slice(0, Math.min(entries.length, s.zone + 15));
          const groups = await ai.suggestMerges(this.aiCfg, { letters: pair, entries: top });
          entries = [...mergeByRanks(top, groups), ...entries.slice(top.length)].map((e, i) => ({ ...e, rank: i + 1 }));
        } catch (err) {
          console.warn('[ai] dedupe failed, using heuristic only:', (err as Error).message);
        }
      }
      if (superseded()) return;
      Object.assign(round, { letters: pair, entries, status: 'playing' });
      this.stats.rounds++;
      this.log('system', `New round: ${pair.toUpperCase()}. Find the top ${s.targets}!`);
    } catch (err) {
      if (superseded()) return;
      round.status = 'error';
      round.error = (err as Error).message;
    }
    this.changed();
  }

  private requireRound(statuses: RoundStatus[] = ['playing']): Round {
    const r = this.round;
    if (!r) throw new GameError('No round in progress');
    if (!statuses.includes(r.status)) throw new GameError(`The round is ${r.status}`);
    return r;
  }

  private hiddenTargets(r: Round): Entry[] {
    return r.entries.slice(0, this.settings.targets).filter((e) => !r.found[e.rank] && !r.revealed.has(e.rank));
  }

  private checkEnd(): void {
    const r = this.round!;
    if (r.status !== 'playing') return;
    if (this.hiddenTargets(r).length === 0) {
      const anyGivenUp = r.entries.slice(0, this.settings.targets).some((e) => !r.found[e.rank]);
      r.status = anyGivenUp ? 'revealed' : 'won';
      if (!anyGivenUp) this.stats.won++;
      this.log('system', anyGivenUp ? 'All answers are out!' : '🎉 You found them all!');
    } else if (r.womps >= r.maxWomps) {
      r.status = 'lost';
      this.stats.lost++;
      this.log('system', 'Out of lives. Wiki womp womp… (add a life to keep playing)');
    }
  }

  // -- verdicts -----------------------------------------------------------

  private verdictFor(r: Round, rank: number): Verdict | 'dup' {
    const s = this.settings;
    if (r.found[rank]) return 'dup';
    return rank <= s.targets ? 'wow' : rank <= s.zone ? 'what' : 'womp';
  }

  /** Apply a verdict for a guess. rank may be null for a womp with no match. */
  private applyVerdict(guess: string, by: string | null, verdict: Verdict, rank: number | null, note?: string): void {
    const r = this.round!;
    const s = this.settings;
    const e = rank ? r.entries.find((x) => x.rank === rank) : undefined;
    if (verdict === 'wow') {
      if (!e || e.rank > s.targets) throw new GameError('Pick which answer it matches');
      if (r.found[e.rank]) return this.log('dup', `"${guess}" — already found (${e.title})`, { by });
      r.found[e.rank] = { by, guess };
      r.revealed.delete(e.rank);
      this.stats.wows++;
      this.log('wow', e.title, { by, guess, rank: e.rank });
    } else if (verdict === 'what') {
      if (e && r.zoneHits.some((z) => z.rank === e.rank)) {
        return this.log('dup', `"${guess}" — already a Wiki What (${e.title})`, { by });
      }
      if (e) r.zoneHits.push({ rank: e.rank, title: e.title, by });
      r.questions++;
      this.stats.whats++;
      this.log('what', e ? `${e.title} is in the top ${s.zone}` : `"${guess}" is in the top ${s.zone}`, {
        by,
        guess,
        rank: e?.rank,
        note: note || 'You earned a yes/no question.',
      });
    } else {
      r.womps++;
      this.stats.womps++;
      this.log('womp', `"${guess}"`, {
        by,
        guess,
        note: note || (e ? `That was #${e.rank} — outside the top ${s.zone}.` : 'Not in the top results.'),
        undoable: true,
      });
    }
    this.checkEnd();
  }

  /** What does the heuristic matcher think of a guess? */
  private suggest(guess: string): Suggestion {
    const r = this.round!;
    const m = matchGuess(guess, r.entries);
    if (!m) {
      return {
        verdict: 'womp',
        rank: null,
        strength: null,
        note: startsWithLetters(guess, r.letters) ? 'No match in the top results' : `Doesn't start with ${r.letters.toUpperCase()}`,
      };
    }
    return { verdict: this.verdictFor(r, m.entry.rank), rank: m.entry.rank, title: m.entry.title, strength: m.strength };
  }

  async guess(text: unknown, byInput: unknown): Promise<void> {
    const r = this.requireRound(['playing']);
    const guess = String(text ?? '').trim().slice(0, 120);
    if (!guess) throw new GameError('Type a guess');
    const by = cleanName(byInput);

    if (this.settings.moderator === 'human') {
      r.pending.push({ id: ++this.logCounter, kind: 'guess', text: guess, by, suggestion: this.suggest(guess) });
      return this.changed();
    }

    // AI moderator: obvious matches are judged locally, the rest by the model.
    if (r.busy) throw new GameError('Hang on, the moderator is thinking…');
    const sug = this.suggest(guess);
    if (sug.verdict === 'dup') {
      this.log('dup', `"${guess}" — already found (${sug.title})`, { by });
      return this.changed();
    }
    if (sug.rank && (sug.strength === 'exact' || sug.strength === 'close')) {
      this.applyVerdict(guess, by, sug.verdict, sug.rank);
      return this.changed();
    }
    if (!this.spendAI(r)) {
      // Out of AI budget: trust the matcher, including partial matches.
      if (sug.rank) this.applyVerdict(guess, by, sug.verdict as Verdict, sug.rank);
      else if (!startsWithLetters(guess, r.letters)) this.log('info', `"${guess}" doesn't start with ${r.letters.toUpperCase()} — no penalty, try again.`, { by });
      else this.applyVerdict(guess, by, 'womp', null);
      return this.changed();
    }

    r.busy = true;
    this.changed();
    try {
      const judged = await ai.judgeGuess(this.aiCfg, { letters: r.letters, guess, entries: r.entries });
      if (this.round !== r || r.status !== 'playing') return;
      if (judged.rank) {
        const v = this.verdictFor(r, judged.rank);
        if (v === 'dup') this.log('dup', `"${guess}" — already found`, { by });
        else this.applyVerdict(guess, by, v, judged.rank);
      } else if (!startsWithLetters(guess, r.letters)) {
        this.log('info', `"${guess}" doesn't start with ${r.letters.toUpperCase()} — no penalty, try again.`, { by });
      } else {
        this.applyVerdict(guess, by, 'womp', null, judged.reason);
      }
    } catch (err) {
      this.log('info', `Moderator error: ${(err as Error).message}. Guess not counted.`, { by });
    } finally {
      r.busy = false;
      this.changed();
    }
  }

  judge(pendingId: unknown, verdict: unknown, rank: unknown): void {
    const r = this.requireRound(['playing']);
    const idx = r.pending.findIndex((p) => p.id === Number(pendingId) && p.kind === 'guess');
    if (idx < 0) throw new GameError('That guess was already judged');
    if (!oneOf(verdict, ['wow', 'what', 'womp', 'dismiss'] as const)) throw new GameError('Bad verdict');
    const p = r.pending[idx];
    // For a womp, fall back to the matcher's rank so the feed can say "that was #34".
    const chosen = rank ? Number(rank) : verdict === 'womp' ? (p.suggestion?.rank ?? null) : null;
    if (verdict !== 'dismiss') this.applyVerdict(p.text, p.by, verdict, chosen);
    r.pending.splice(idx, 1);
    this.changed();
  }

  // -- questions & hints ----------------------------------------------------

  async ask(question: unknown, byInput: unknown, free = false): Promise<void> {
    const r = this.requireRound(['playing', 'lost']);
    const q = String(question ?? '').trim().slice(0, 300);
    if (!q) throw new GameError('Type a question');
    if (!free && r.questions < 1) throw new GameError('No questions left — get a Wiki What first (or bend the rules)');
    const by = cleanName(byInput);

    if (this.settings.moderator === 'human') {
      if (!free) r.questions--;
      r.pending.push({ id: ++this.logCounter, kind: 'question', text: q, by, charged: !free });
      return this.changed();
    }
    if (r.busy) throw new GameError('Hang on, the moderator is thinking…');
    if (!this.spendAI(r)) throw new GameError('The AI has answered all the questions it can this round');
    if (!free) r.questions--;
    r.busy = true;
    this.changed();
    try {
      const targets = r.entries
        .slice(0, this.settings.targets)
        .map((e) => ({ ...e, found: Boolean(r.found[e.rank] || r.revealed.has(e.rank)) }));
      const out = await ai.answerQuestion(this.aiCfg, { letters: r.letters, question: q, targets, history: r.qa });
      this.recordAnswer(q, by, out.verdict, out.explanation, !free);
    } catch (err) {
      if (!free) r.questions++;
      this.log('info', `Moderator error: ${(err as Error).message}. Question refunded.`, { by });
    } finally {
      r.busy = false;
      this.changed();
    }
  }

  private recordAnswer(q: string, by: string | null, verdict: QuestionVerdict, explanation: string, charged: boolean): void {
    const r = this.round!;
    const refund = verdict === 'too direct' || verdict === 'not yes/no';
    // The AI's explanation must not give away a hidden answer, whatever the
    // players typed into their question.
    if (explanation && leaksAnswer(explanation, this.hiddenTargets(r))) explanation = '';
    if (refund && charged) r.questions++;
    r.qa.push({ q, a: verdict });
    this.log('answer', q, {
      by,
      verdict,
      note: [explanation, refund && charged ? '(question refunded)' : ''].filter(Boolean).join(' '),
    });
  }

  answer(pendingId: unknown, verdict: unknown, note: unknown): void {
    const r = this.requireRound(['playing', 'lost']);
    const idx = r.pending.findIndex((p) => p.id === Number(pendingId) && p.kind === 'question');
    if (idx < 0) throw new GameError('That question was already answered');
    if (!oneOf(verdict, QUESTION_VERDICTS)) throw new GameError('Bad answer');
    const [p] = r.pending.splice(idx, 1);
    this.recordAnswer(p.text, p.by, verdict, String(note ?? '').slice(0, 300), Boolean(p.charged));
    this.changed();
  }

  async hint(byInput: unknown): Promise<void> {
    const r = this.requireRound(['playing', 'lost']);
    const by = cleanName(byInput);
    const hidden = this.hiddenTargets(r);
    if (!hidden.length) throw new GameError('Nothing left to hint at');
    // Hint the hidden answer that has had the fewest hints so far.
    const count = (e: Entry) => r.hints[e.rank]?.length ?? 0;
    const target = hidden.reduce((a, b) => (count(b) < count(a) ? b : a));
    const prev = r.hints[target.rank] ?? [];

    let text: string | undefined;
    if (this.settings.moderator === 'ai' && prev.length < 2 && !r.busy && this.spendAI(r)) {
      r.busy = true;
      this.changed();
      try {
        text = await ai.giveHint(this.aiCfg, { letters: r.letters, target, previousHints: prev });
      } catch (err) {
        console.warn('[ai] hint failed:', (err as Error).message);
      } finally {
        r.busy = false;
      }
    }
    text ||= builtinHint(target, prev.length);
    r.hints[target.rank] = [...prev, text];
    r.hintCount++;
    this.log('hint', text, { by });
    this.changed();
  }

  // -- house rules ----------------------------------------------------------

  say(text: unknown): void {
    this.requireRound(['playing', 'lost', 'won', 'revealed']);
    const t = String(text ?? '').trim().slice(0, 300);
    if (!t) return;
    this.log('mod', t);
    this.changed();
  }

  adjustLives(delta: number): void {
    const r = this.requireRound(['playing', 'lost']);
    const before = r.maxWomps;
    r.maxWomps = clamp(r.maxWomps + Math.sign(delta), r.womps + 1, 99);
    if (r.maxWomps === before) throw new GameError("Can't go lower than that");
    if (r.status === 'lost' && r.womps < r.maxWomps) {
      r.status = 'playing';
      this.stats.lost--;
      this.log('system', 'Extra life granted — back in the game!');
    } else {
      this.log('system', delta > 0 ? 'House rule: +1 life' : 'House rule: −1 life');
    }
    this.changed();
  }

  adjustQuestions(delta: number): void {
    const r = this.requireRound(['playing', 'lost']);
    const before = r.questions;
    r.questions = clamp(r.questions + Math.sign(delta), 0, 99);
    if (r.questions === before) throw new GameError('No questions to take away');
    this.log('system', delta > 0 ? 'House rule: +1 question' : 'House rule: −1 question');
    this.changed();
  }

  undoWomp(logId: unknown): void {
    const r = this.requireRound(['playing', 'lost']);
    const entry = r.log.find((l) => l.id === Number(logId) && l.type === 'womp' && l.undoable);
    if (!entry) throw new GameError('Nothing to undo');
    entry.undoable = false;
    entry.overruled = true;
    r.womps = Math.max(0, r.womps - 1);
    this.stats.womps--;
    if (r.status === 'lost' && r.womps < r.maxWomps) {
      r.status = 'playing';
      this.stats.lost--;
    }
    this.log('system', `Overruled: "${entry.guess}" doesn't count as a womp`);
    this.changed();
  }

  revealOne(): void {
    const r = this.requireRound(['playing', 'lost']);
    const hidden = this.hiddenTargets(r);
    if (!hidden.length) throw new GameError('Nothing left to reveal');
    const e = hidden[hidden.length - 1]; // give away the lowest-ranked one
    r.revealed.add(e.rank);
    this.log('reveal', `Revealed #${e.rank}: ${e.title}`);
    this.checkEnd();
    this.changed();
  }

  giveUp(): void {
    const r = this.requireRound(['playing', 'lost']);
    if (r.status === 'playing') this.stats.lost++;
    r.status = 'revealed';
    r.pending = [];
    this.log('system', 'Answers revealed.');
    this.changed();
  }

  updateSettings(input: SettingsInput): void {
    const next = sanitizeSettings(input, this.settings);
    const apiKey = typeof input.apiKey === 'string' && input.apiKey.trim() ? input.apiKey.trim() : this.apiKey;
    this.aiAuthorized = authorizeAI(next, apiKey, input, this.aiAuthorized);
    this.apiKey = apiKey;
    // Pending items only make sense with a human moderator.
    if (next.moderator === 'ai' && this.round) {
      for (const p of this.round.pending) if (p.kind === 'question' && p.charged) this.round.questions++;
      this.round.pending = [];
    }
    this.settings = next;
    this.changed();
  }
}

/** Does the text mention a hidden answer's title or a distinctive word of it? */
export function leaksAnswer(text: string, hidden: Entry[]): boolean {
  const t = ` ${normalize(text)} `;
  return hidden.some((e) =>
    [e.title, ...e.members].some((name) => {
      const n = normalize(name);
      if (n.length >= 3 && t.includes(` ${n} `)) return true;
      return n.split(' ').some((w) => w.length >= 5 && t.includes(` ${w} `));
    }),
  );
}

function cleanName(by: unknown): string | null {
  const n = String(by ?? '').trim().slice(0, 24);
  return n || null;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Hints that need no AI: a scrubbed description, then a letter pattern. */
export function builtinHint(e: Entry, level: number): string {
  const words = e.title.replace(/\s*\([^)]*\)\s*$/, '').split(/\s+/);
  const mask = (keep: number) =>
    words.map((w) => [...w].map((ch, i) => (i < keep || !/[\p{L}\p{N}]/u.test(ch) ? ch : '_')).join(' ')).join('   ');
  const titleWords = words.filter((w) => w.length > 2).map(escapeRegExp);
  const scrubbed = titleWords.length
    ? e.description.replace(new RegExp(`\\b(${titleWords.join('|')})\\b`, 'gi'), '▢▢▢')
    : e.description;
  if (level === 0 && scrubbed) return `One answer is described as: “${scrubbed}”`;
  if (level <= 1) {
    return `One answer has ${words.length} word${words.length === 1 ? '' : 's'}: ${mask(words.length > 1 ? 1 : 2)}`;
  }
  return `Pattern: ${mask(level)}`;
}
