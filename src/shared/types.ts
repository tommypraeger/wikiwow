// Types shared by the server and the browser client.

export type ModeratorKind = 'human' | 'ai';
export type DedupeMode = 'off' | 'basic' | 'aggressive';
export type LetterMode = 'common' | 'any';
export type AIProvider = 'claude' | 'openai';
export type RoundStatus = 'loading' | 'playing' | 'won' | 'lost' | 'revealed' | 'error';
export type Verdict = 'wow' | 'what' | 'womp';
export type QuestionVerdict = 'yes' | 'no' | 'sort of' | 'too direct' | 'not yes/no';
export const QUESTION_VERDICTS: QuestionVerdict[] = ['yes', 'no', 'sort of', 'too direct', 'not yes/no'];

export interface Settings {
  moderator: ModeratorKind;
  /** Wiki womps allowed before the round is lost. */
  lives: number;
  /** Number of answers to find. */
  targets: number;
  /** Size of the "wiki what" zone (top N). */
  zone: number;
  lang: string;
  dedupe: DedupeMode;
  letterMode: LetterMode;
  aiProvider: AIProvider;
  /** Questions available at the start of each round. */
  freeQuestions: number;
}

/** One answer candidate after deduping, in autocomplete order. */
export interface Entry {
  rank: number;
  title: string;
  description: string;
  thumb: string | null;
  url: string;
  /** Titles merged into this entry (first is `title`). */
  members: string[];
  /** Redirect / merged titles that also count as this entry. */
  aliases: string[];
}

export type LogType = 'system' | 'wow' | 'what' | 'womp' | 'dup' | 'info' | 'answer' | 'hint' | 'reveal' | 'mod';

export interface LogEntry {
  id: number;
  t: number;
  type: LogType;
  text: string;
  by?: string | null;
  guess?: string;
  rank?: number;
  note?: string;
  verdict?: QuestionVerdict;
  undoable?: boolean;
  overruled?: boolean;
}

export interface Suggestion {
  verdict: Verdict | 'dup';
  rank: number | null;
  title?: string;
  strength: 'exact' | 'close' | 'partial' | null;
  note?: string;
}

export interface Pending {
  id: number;
  kind: 'guess' | 'question';
  text: string;
  by: string | null;
  /** Moderator-only: what the matcher thinks of a guess. */
  suggestion?: Suggestion;
  charged?: boolean;
}

export type Slot =
  | { rank: number; hidden: true }
  | (Pick<Entry, 'rank' | 'title' | 'description' | 'thumb' | 'url' | 'members'> & {
      hidden?: false;
      by: string | null;
      gaveUp: boolean;
    });

export interface ZoneHit {
  rank: number;
  title: string;
  by: string | null;
}

export interface RoundView {
  id: number;
  letters: string;
  status: RoundStatus;
  error: string | null;
  womps: number;
  maxWomps: number;
  questions: number;
  busy: boolean;
  slots: Slot[];
  zoneHits: ZoneHit[];
  /** The rest of the "wiki what" zone, only once the round is over. */
  zone: Exclude<Slot, { hidden: true }>[] | null;
  hintCount: number;
  pending: Pending[];
  log: LogEntry[];
  totalResults: number;
}

export interface AnswerKeyEntry {
  rank: number;
  title: string;
  description: string;
  members: string[];
  found: boolean;
  revealed: boolean;
  zoneHit: boolean;
}

export interface Stats {
  rounds: number;
  won: number;
  lost: number;
  wows: number;
  whats: number;
  womps: number;
}

export interface RoomView {
  code: string;
  /** True only for a human moderator. */
  isMod: boolean;
  settings: Settings;
  hasAI: boolean;
  stats: Stats;
  round: RoundView | null;
  answerKey?: AnswerKeyEntry[];
}

export interface ServerConfig {
  providers: Record<AIProvider, boolean>;
  /** Using the server's AI keys requires a password. */
  aiPasswordRequired: boolean;
  defaults: Settings;
}

export type Action =
  | { type: 'newRound'; letters?: string }
  | { type: 'guess'; text: string; by?: string }
  | { type: 'judge'; id: number; verdict: Verdict | 'dismiss'; rank?: number }
  | { type: 'ask'; text: string; by?: string; free?: boolean }
  | { type: 'answer'; id: number; verdict: QuestionVerdict; note?: string }
  | { type: 'hint'; by?: string }
  | { type: 'say'; text: string }
  | { type: 'lives'; delta: number }
  | { type: 'questions'; delta: number }
  | { type: 'undoWomp'; id: number }
  | { type: 'revealOne' }
  | { type: 'giveUp' }
  | { type: 'settings'; settings: Partial<Settings> & { apiKey?: string; aiPassword?: string } };
