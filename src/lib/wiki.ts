// Wikipedia autocomplete client.
//
// Uses the same endpoint as the Wikipedia search box (Vector 2022 skin):
//   GET https://{lang}.wikipedia.org/w/rest.php/v1/search/title?q=ab&limit=100
// One request returns up to 100 ranked titles, with short descriptions,
// thumbnails, and redirect resolution (`matched_title`), so a whole round
// costs a single API call.
//
// Rate-limit etiquette (https://www.mediawiki.org/wiki/API:Etiquette):
//   - descriptive User-Agent with contact info
//   - requests are serialized through one queue with a minimum spacing
//   - identical in-flight requests are coalesced
//   - results are cached in memory + on disk (Wikipedia itself sends
//     max-age=10800), so replaying letters never re-hits the API
//   - 429/503 responses honour Retry-After with bounded retries

import fs from 'node:fs';
import path from 'node:path';
import type { DedupeMode, Entry, LetterMode } from '../shared/types.js';

/** A raw autocomplete result. */
export interface WikiPage {
  id: number;
  key: string;
  title: string;
  matched: string | null;
  description: string;
  thumb: string | null;
  url: string;
}

interface RestSearchPage {
  id: number;
  key: string;
  title: string;
  matched_title?: string | null;
  description?: string | null;
  thumbnail?: { url?: string } | null;
}

const CACHE_TTL_MS = Number(process.env.WIKI_CACHE_TTL_MS || 6 * 60 * 60 * 1000);
const MIN_INTERVAL_MS = Number(process.env.WIKI_MIN_INTERVAL_MS || 500);
const CACHE_FILE = process.env.WIKI_CACHE_FILE || path.resolve('data/wiki-cache.json');
const MAX_CACHE_ENTRIES = 2000;
const USER_AGENT =
  process.env.WIKI_USER_AGENT ||
  `WikiWow/1.0 (party game; contact: ${process.env.WIKI_CONTACT || 'set WIKI_CONTACT env var'})`;

const cache = new Map<string, { at: number; pages: WikiPage[] }>();
const inflight = new Map<string, Promise<WikiPage[]>>();
let lastRequestAt = 0;
let queue: Promise<unknown> = Promise.resolve();

loadDiskCache();

function loadDiskCache() {
  try {
    const raw: Record<string, { at: number; pages: WikiPage[] }> = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    const now = Date.now();
    for (const [k, v] of Object.entries(raw)) {
      if (now - v.at < CACHE_TTL_MS) cache.set(k, v);
    }
  } catch {
    // no cache yet
  }
}

let saveTimer: NodeJS.Timeout | null = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
      fs.writeFileSync(CACHE_FILE, JSON.stringify(Object.fromEntries(cache)));
    } catch (err) {
      console.warn('[wiki] could not persist cache:', (err as Error).message);
    }
  }, 2000);
  saveTimer.unref?.();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Serialize all outgoing requests and space them out.
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    return fn();
  });
  queue = run.catch(() => {});
  return run;
}

async function fetchWithRetry(url: string, attempts = 3): Promise<{ pages?: RestSearchPage[] }> {
  for (let i = 0; ; i++) {
    const res = await enqueue(() =>
      fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Api-User-Agent': USER_AGENT } }),
    );
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && i < attempts - 1) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const delay = Math.min(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000 * (i + 1), 30000);
      console.warn(`[wiki] ${res.status} from Wikipedia, retrying in ${delay}ms`);
      await sleep(delay);
      continue;
    }
    throw new Error(`Wikipedia returned HTTP ${res.status}`);
  }
}

/** Raw autocomplete results for a prefix, up to 100, in Wikipedia's order. */
export async function searchTitles(prefix: string, lang = 'en'): Promise<WikiPage[]> {
  if (!/^[a-z-]{2,12}$/.test(lang)) throw new Error('Bad language code');
  const q = prefix.trim();
  const key = `${lang}:${q.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.pages;
  const pending = inflight.get(key);
  if (pending) return pending;

  const url = `https://${lang}.wikipedia.org/w/rest.php/v1/search/title?q=${encodeURIComponent(q)}&limit=100`;
  const p = fetchWithRetry(url)
    .then((data) => {
      const pages: WikiPage[] = (data.pages || []).map((p) => ({
        id: p.id,
        key: p.key,
        title: p.title,
        matched: p.matched_title || null,
        description: p.description || '',
        thumb: p.thumbnail?.url ? (p.thumbnail.url.startsWith('//') ? 'https:' + p.thumbnail.url : p.thumbnail.url) : null,
        url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(p.key)}`,
      }));
      cache.set(key, { at: Date.now(), pages });
      if (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
      scheduleSave();
      return pages;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// ---------------------------------------------------------------------------
// Deduping

const DISAMBIG_DESCRIPTIONS = new Set([
  'topics referred to by the same term',
  'topics referred to by the same name',
  'disambiguation page providing links to topics that could be referred to by the same search term',
]);

export function isDisambiguation(page: Pick<WikiPage, 'title' | 'description'>): boolean {
  return (
    /\(disambiguation\)$/i.test(page.title) ||
    DISAMBIG_DESCRIPTIONS.has((page.description || '').trim().toLowerCase())
  );
}

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[‐-―]/g, '-')
    .trim();

/** Title with a trailing "(qualifier)" removed: "Usher (musician)" -> "usher". */
export const baseTitle = (t: string) => fold(t.replace(/\s*\([^)]*\)\s*$/, ''));

// "USB" vs "USB-C" / "USB 3.0" / "Windows 11": a short version-ish suffix.
function isShortVariant(longer: string, shorter: string): boolean {
  if (!longer.startsWith(shorter) || longer === shorter) return false;
  const rest = longer.slice(shorter.length);
  // a number ("Windows 11", "USB 3.0"), roman numeral, or 1-2 letters ("USB-C")
  return /^[\s\-:]+(\d[\w.]{0,4}|[ivx]{1,4}|[a-z]{1,2})$/i.test(rest);
}

function isWordPrefix(longer: string, shorter: string): boolean {
  return longer !== shorter && longer.startsWith(shorter + ' ');
}

/**
 * Collapse near-duplicate articles into groups, preserving rank order.
 * mode: 'off'      - only identical page ids are merged
 *       'basic'    - also drop disambiguation pages, merge same base title
 *                    ("Mercury (planet)"/"Mercury (element)" are NOT merged
 *                    unless one has no qualifier), and short version suffixes
 *       'aggressive' - also merge when one title is a whole-word prefix of a
 *                    higher-ranked one ("Abu Ghraib" + "Abu Ghraib prison")
 * Returns entries: { rank, title, description, thumb, url, aliases[], members[] }
 */
interface Group {
  ids: number[];
  title: string;
  description: string;
  thumb: string | null;
  url: string;
  members: string[];
  aliases: Set<string>;
}

export function dedupe(pages: WikiPage[], mode: DedupeMode = 'basic'): Entry[] {
  const groups: Group[] = [];
  const seenIds = new Set<number>();
  for (const p of pages) {
    if (seenIds.has(p.id)) {
      const g = groups.find((g) => g.ids.includes(p.id));
      if (g && p.matched) g.aliases.add(p.matched);
      continue;
    }
    seenIds.add(p.id);
    if (mode !== 'off' && isDisambiguation(p)) continue;

    let target: Group | undefined;
    if (mode !== 'off') {
      const b = baseTitle(p.title);
      const hasQual = /\)\s*$/.test(p.title);
      target = groups.find((g) => {
        const gb = baseTitle(g.title);
        const gHasQual = /\)\s*$/.test(g.title);
        if (gb === b && (!hasQual || !gHasQual)) return true;
        if (isShortVariant(b, gb) || isShortVariant(gb, b)) return true;
        if (mode === 'aggressive' && (isWordPrefix(b, gb) || isWordPrefix(gb, b))) return true;
        return false;
      });
    }
    if (target) {
      target.ids.push(p.id);
      target.members.push(p.title);
      target.aliases.add(p.title);
      if (p.matched) target.aliases.add(p.matched);
      continue;
    }
    groups.push({
      ids: [p.id],
      title: p.title,
      description: p.description,
      thumb: p.thumb,
      url: p.url,
      members: [p.title],
      aliases: new Set(p.matched ? [p.matched] : []),
    });
  }
  return groups.map((g, i) => ({
    rank: i + 1,
    title: g.title,
    description: g.description,
    thumb: g.thumb,
    url: g.url,
    members: g.members,
    aliases: [...g.aliases],
  }));
}

/** Re-group already-deduped entries by explicit merge lists of ranks (used by the AI dedupe). */
export function mergeByRanks(entries: Entry[], groupsOfRanks: number[][]): Entry[] {
  const absorbed = new Map<number, number>(); // rank -> leader rank
  for (const grp of groupsOfRanks) {
    const ranks = [...new Set(grp)].filter((r) => entries[r - 1]).sort((a, b) => a - b);
    if (ranks.length < 2) continue;
    for (const r of ranks.slice(1)) if (!absorbed.has(ranks[0])) absorbed.set(r, ranks[0]);
  }
  const byRank = new Map(entries.map((e) => [e.rank, { ...e, members: [...e.members], aliases: [...e.aliases] }]));
  for (const [r, leader] of absorbed) {
    const e = byRank.get(r)!;
    const l = byRank.get(leader)!;
    l.members.push(...e.members);
    l.aliases.push(e.title, ...e.aliases);
    byRank.delete(r);
  }
  return [...byRank.values()].sort((a, b) => a.rank - b.rank).map((e, i) => ({ ...e, rank: i + 1 }));
}

// ---------------------------------------------------------------------------
// Letter pairs

// Common English word-initial bigrams: these reliably give 20+ good results.
export const COMMON_PAIRS = (
  'ab ac ad af ag al am an ap ar as at au av ba be bi bl bo br bu ca ce ch ci cl co cr cu cy ' +
  'da de di do dr du dy ea ec ed el em en ep er es eu ev ex fa fe fi fl fo fr fu ga ge gi gl go gr gu ' +
  'ha he hi ho hu hy ic id il im in ir is it ja je jo ju ka ke ki kn ko ku la le li lo lu ly ' +
  'ma me mi mo mu my na ne ni no nu ob oc od of ol om on op or os ot ou ov ox pa pe ph pi pl po pr ps pu ' +
  'qu ra re rh ri ro ru sa sc se sh si sk sl sm sn so sp sq st su sw sy ta te th ti to tr tu tw ty ' +
  'ul un up ur us ut va ve vi vo wa we wh wi wo wr ya ye yo za ze zo'
).split(' ');

export function randomPair(mode: LetterMode = 'common'): string {
  if (mode === 'any') {
    const a = 'abcdefghijklmnopqrstuvwxyz';
    return a[Math.floor(Math.random() * 26)] + a[Math.floor(Math.random() * 26)];
  }
  return COMMON_PAIRS[Math.floor(Math.random() * COMMON_PAIRS.length)];
}
