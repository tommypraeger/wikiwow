import { useState, type FormEvent, type ReactNode } from 'react';
import type { ServerConfig, Settings } from '../shared/types';
import { api, isPlainHttp, navigate, store, toast, usePlayerName } from './util';

const FALLBACK: Settings = {
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

export function Seg<T extends string>({ value, options, onChange }: { value: T; options: [T, ReactNode][]; onChange: (v: T) => void }) {
  return (
    <div className="seg">
      {options.map(([v, label]) => (
        <button key={v} type="button" aria-pressed={value === v} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}

export function Stepper({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (n: number) => void }) {
  return (
    <div className="stepper">
      <span>{label}</span>
      <span className="ctl">
        <button type="button" className="icon small" aria-label={`fewer: ${label}`} disabled={value <= min} onClick={() => onChange(value - 1)}>
          −
        </button>
        <output>{value}</output>
        <button type="button" className="icon small" aria-label={`more: ${label}`} disabled={value >= max} onClick={() => onChange(value + 1)}>
          +
        </button>
      </span>
    </div>
  );
}

export function Home({ config }: { config: ServerConfig | null }) {
  const providers = config?.providers ?? { claude: false, openai: false };
  const [name, setName] = usePlayerName();
  const [joinCode, setJoinCode] = useState('');
  const [s, setS] = useState<Settings>(() => ({
    ...FALLBACK,
    ...config?.defaults,
    ...(JSON.parse(store.get('lastSettings') || '{}') as Partial<Settings>),
  }));
  const [letterChoice, setLetterChoice] = useState<'random' | 'custom'>('random');
  const [letters, setLetters] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [aiPassword, setAiPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) =>
    setS((prev) => {
      const next = { ...prev, [k]: v };
      if (k === 'targets' && next.zone < next.targets) next.zone = next.targets;
      if (k === 'zone' && next.zone < next.targets) next.targets = next.zone;
      return next;
    });

  const join = (e: FormEvent) => {
    e.preventDefault();
    const code = joinCode.trim().toUpperCase();
    if (!/^[A-Z]{4}$/.test(code)) return toast('Codes are 4 letters');
    navigate(`/r/${code}`);
  };

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (letterChoice === 'custom' && !letters.trim()) return toast('Type some letters, or pick Random');
    setBusy(true);
    try {
      store.set('lastSettings', JSON.stringify(s));
      const res = await api<{ code: string; modToken: string }>('/api/rooms', {
        json: { ...s, letters: letterChoice === 'custom' ? letters.trim() : '', apiKey: apiKey.trim() || undefined, aiPassword: aiPassword || undefined },
      });
      store.set(`mod:${res.code}`, res.modToken);
      navigate(`/r/${res.code}`);
    } catch (err) {
      toast((err as Error).message);
      setBusy(false);
    }
  };

  const ai = s.moderator === 'ai';
  return (
    <main>
      <header className="logo">
        <h1>
          Wiki<b>Wow</b>
        </h1>
        <p>Two letters. Five Wikipedia articles. Can you read the hive mind?</p>
      </header>
      <div className="stack">
        <label className="field">
          <span>Your name (optional)</span>
          <input type="text" maxLength={24} autoComplete="nickname" placeholder="e.g. Sam" value={name} onChange={(e) => setName(e.target.value)} />
        </label>

        <form className="card stack" onSubmit={join}>
          <h2>Join a game</h2>
          <div className="row">
            <input
              type="text"
              className="code-input"
              maxLength={4}
              placeholder="CODE"
              autoCapitalize="characters"
              autoComplete="off"
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value)}
            />
            <button className="primary" type="submit">
              Join
            </button>
          </div>
        </form>

        <form className="card stack" onSubmit={create}>
          <h2>Start a game</h2>
          <div>
            <div className="small muted label">Moderator</div>
            <Seg
              value={s.moderator}
              onChange={(v) => set('moderator', v)}
              options={[
                ['human', '🧑 Human'],
                ['ai', '🤖 AI'],
              ]}
            />
            <p className="small muted">
              {ai
                ? 'The AI judges guesses, answers yes/no questions and gives hints. Everyone plays.'
                : 'Whoever starts the game sees the answers and judges guesses. Everyone else joins with the code.'}
            </p>
          </div>
          {ai && (
            <div className="stack">
              <Seg
                value={s.aiProvider}
                onChange={(v) => set('aiProvider', v)}
                options={[
                  ['claude', `Claude${providers.claude ? ' ✓' : ''}`],
                  ['openai', `ChatGPT${providers.openai ? ' ✓' : ''}`],
                ]}
              />
              {providers[s.aiProvider] && config?.aiPasswordRequired && !apiKey && (
                <label className="field">
                  <span>AI password (ask whoever runs this server)</span>
                  <input type="password" autoComplete="off" value={aiPassword} onChange={(e) => setAiPassword(e.target.value)} />
                </label>
              )}
              {(!providers[s.aiProvider] || config?.aiPasswordRequired) && (
                <label className="field">
                  <span>{providers[s.aiProvider] ? '…or your own API key' : 'API key (kept in server memory for this game only)'}</span>
                  <input type="password" autoComplete="off" placeholder="sk-…" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
                  {isPlainHttp() && <span className="warn-text">This connection isn’t encrypted. Only paste a key on a network you trust.</span>}
                </label>
              )}
            </div>
          )}
          <Stepper label="Wiki womps allowed" value={s.lives} min={1} max={20} onChange={(n) => set('lives', n)} />
          <Stepper label="Answers to find" value={s.targets} min={1} max={20} onChange={(n) => set('targets', n)} />
          <Stepper label="“Wiki what” zone (top N)" value={s.zone} min={1} max={100} onChange={(n) => set('zone', n)} />
          <div>
            <div className="small muted label">Letters</div>
            <Seg
              value={letterChoice}
              onChange={setLetterChoice}
              options={[
                ['random', '🎲 Random'],
                ['custom', '✏️ Choose'],
              ]}
            />
            {letterChoice === 'custom' && (
              <input
                type="text"
                className="letters-input"
                maxLength={3}
                placeholder="e.g. TH"
                autoComplete="off"
                autoFocus
                value={letters}
                onChange={(e) => setLetters(e.target.value)}
              />
            )}
          </div>
          <details>
            <summary>More options</summary>
            <div className="stack" style={{ marginTop: 8 }}>
              <label className="field">
                <span>Random letter pool</span>
                <select value={s.letterMode} onChange={(e) => set('letterMode', e.target.value as Settings['letterMode'])}>
                  <option value="common">Common starts (TH, BA, MO…)</option>
                  <option value="any">Any two letters (chaos)</option>
                </select>
              </label>
              <label className="field">
                <span>Merge near-duplicate articles</span>
                <select value={s.dedupe} onChange={(e) => set('dedupe', e.target.value as Settings['dedupe'])}>
                  <option value="basic">Basic — USB / USB-C, Usher / Usher (musician)</option>
                  <option value="aggressive">Aggressive — also “X” / “X something”</option>
                  <option value="off">Off — raw autocomplete</option>
                </select>
              </label>
              <label className="field">
                <span>Wikipedia language code</span>
                <input type="text" maxLength={12} value={s.lang} onChange={(e) => set('lang', e.target.value.trim().toLowerCase())} />
              </label>
              <Stepper label="Free questions per round" value={s.freeQuestions} min={0} max={10} onChange={(n) => set('freeQuestions', n)} />
            </div>
          </details>
          <button className="accent block" type="submit" disabled={busy}>
            {busy ? 'Starting…' : 'Start game'}
          </button>
        </form>

        <details className="card rules">
          <summary>How to play</summary>
          <ul>
            <li>
              You get two letters. Guess the <b>top 5</b> Wikipedia articles that autocomplete for them.
            </li>
            <li>
              <b>Wiki Wow</b>: it's in the top 5!
            </li>
            <li>
              <b>Wiki What</b>: not top 5, but in the top 20. You earn one <b>yes/no question</b> about the answers (nothing too direct!).
            </li>
            <li>
              <b>Wiki Womp</b>: not in the top 20. You lose a life.
            </li>
            <li>Rules are meant to be bent: grab a hint, an extra question, or another life from the ☰ menu any time.</li>
          </ul>
        </details>
      </div>
    </main>
  );
}
