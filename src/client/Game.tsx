import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  QUESTION_VERDICTS,
  type Action,
  type AnswerKeyEntry,
  type LogEntry,
  type Pending,
  type RoomView,
  type RoundView,
  type Settings,
  type Slot,
} from '../shared/types';
import { api, ApiError, navigate, share, store, toast, usePlayerName } from './util';

type Act = (a: Action) => Promise<boolean>;

/** Live room state over Server-Sent Events. */
function useRoom(code: string) {
  const [view, setView] = useState<RoomView | null>(null);
  const [missing, setMissing] = useState(false);
  const [modToken] = useState(() => {
    // A moderator link (#mod=token) moves the moderator role to this device.
    const fromHash = new URLSearchParams(location.hash.slice(1)).get('mod');
    if (fromHash) {
      store.set(`mod:${code}`, fromHash);
      history.replaceState(null, '', `/r/${code}`);
    }
    return store.get(`mod:${code}`) || '';
  });

  useEffect(() => {
    const es = new EventSource(`/api/rooms/${code}/events${modToken ? `?mod=${encodeURIComponent(modToken)}` : ''}`);
    es.onmessage = (e) => setView(JSON.parse(e.data));
    es.onerror = () => {
      // EventSource reconnects on its own; just detect a game that is gone.
      api(`/api/rooms/${code}`).catch((err) => {
        if (err instanceof ApiError && err.status === 404) {
          es.close();
          setMissing(true);
        }
      });
    };
    return () => es.close();
  }, [code, modToken]);

  const act: Act = useCallback(
    async (action) => {
      try {
        await api(`/api/rooms/${code}/action`, { json: action, headers: { 'X-Mod-Token': modToken } });
        return true;
      } catch (err) {
        toast((err as Error).message);
        return false;
      }
    },
    [code, modToken],
  );

  return { view, missing, act, modToken };
}

export function Game({ code }: { code: string }) {
  const { view, missing, act, modToken } = useRoom(code);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [name] = usePlayerName();

  useEffect(() => {
    document.title = `WikiWow · ${code}`;
  }, [code]);

  if (missing) {
    return (
      <main>
        <div className="card stack center" style={{ marginTop: 40 }}>
          <h2>Game {code} not found</h2>
          <p className="muted">It may have expired, or the server restarted.</p>
          <button className="primary" onClick={() => navigate('/')}>
            Back home
          </button>
        </div>
      </main>
    );
  }

  const r = view?.round ?? null;
  return (
    <main>
      <div className="topbar">
        <a
          className="brand"
          href="/"
          onClick={(e) => {
            e.preventDefault();
            navigate('/');
          }}
        >
          Wiki<b>Wow</b>
        </a>
        <button className="chip" onClick={() => share(`${location.origin}/r/${code}`, 'Join my WikiWow game')}>
          🔗 {code}
        </button>
        {view?.isMod && <span className="chip mod">Moderator</span>}
        {view?.settings.moderator === 'ai' && <span className="chip">🤖 AI mod</span>}
        <span className="spacer" />
        <button className="icon ghost" aria-label="House rules and settings" onClick={() => setSheetOpen(true)} disabled={!view}>
          ☰
        </button>
      </div>

      <Letters round={r} />
      {!view ? null : !r ? (
        <div className="banner revealed">
          <button className="primary" onClick={() => act({ type: 'newRound' })}>
            Start a round
          </button>
        </div>
      ) : (
        <>
          {r.status !== 'loading' && r.status !== 'error' && <Meters round={r} act={act} />}
          <RoundOver round={r} zoneSize={view.settings.zone} act={act} />
          {r.status === 'loading' ? (
            <p className="muted center">Asking Wikipedia…</p>
          ) : (
            <ol className="slots">
              {r.slots.map((s) => (
                <SlotCard key={s.rank} slot={s} />
              ))}
            </ol>
          )}
          {r.zoneHits.length > 0 && (
            <div className="whats">
              <span className="small muted">Wiki whats:</span>
              {r.zoneHits.map((z) => (
                <span key={z.rank} className="chip">
                  {z.title}
                </span>
              ))}
            </div>
          )}
          {view.isMod && <ModPanel round={r} answerKey={view.answerKey ?? []} settings={view.settings} act={act} />}
          <Feed round={r} act={act} />
          <Splash round={r} />
        </>
      )}

      {r && <Composer round={r} isMod={view!.isMod} act={act} name={name} />}
      {sheetOpen && view && (
        <Sheet view={view} act={act} modToken={modToken} code={code} name={name} onClose={() => setSheetOpen(false)} />
      )}
    </main>
  );
}

function Letters({ round }: { round: RoundView | null }) {
  const loading = !round || round.status === 'loading';
  const letters = loading ? '··' : round.letters;
  return (
    <div className="letters" aria-label={loading ? 'Loading letters' : `Letters: ${letters.toUpperCase()}`}>
      {[...letters].map((ch, i) => (
        <div key={i} className={`tile${loading ? ' loading' : ''}`}>
          {ch}
        </div>
      ))}
    </div>
  );
}

function Meters({ round: r, act }: { round: RoundView; act: Act }) {
  const left = Math.max(0, r.maxWomps - r.womps);
  const hearts = left + r.womps <= 10 ? '❤️'.repeat(left) + '🖤'.repeat(r.womps) : `❤️×${left}`;
  return (
    <div className="meters">
      <div className="meter lives" title="Lives">
        <button className="small" aria-label="remove a life" onClick={() => act({ type: 'lives', delta: -1 })}>
          −
        </button>
        <span className="val" aria-label={`${left} lives left`}>
          {hearts}
        </span>
        <button className="small" aria-label="add a life" onClick={() => act({ type: 'lives', delta: 1 })}>
          +
        </button>
      </div>
      <div className="meter" title="Yes/no questions">
        <button className="small" aria-label="remove a question" onClick={() => act({ type: 'questions', delta: -1 })}>
          −
        </button>
        <span className="val" aria-label={`${r.questions} questions`}>
          ❓{r.questions}
        </span>
        <button className="small" aria-label="add a question" onClick={() => act({ type: 'questions', delta: 1 })}>
          +
        </button>
      </div>
    </div>
  );
}

function SlotCard({ slot: s }: { slot: Slot }) {
  if (s.hidden) {
    return (
      <li className="slot hidden-slot">
        <span className="num">{s.rank}</span>
        <span className="q" aria-label="hidden answer" />
      </li>
    );
  }
  return (
    <li className={`slot ${s.gaveUp ? 'gaveup' : 'found'}`}>
      <span className="num">{s.rank}</span>
      {s.thumb ? <img src={s.thumb} alt="" loading="lazy" /> : <span className="noimg" />}
      <div className="body">
        <div className="title">
          <a href={s.url} target="_blank" rel="noopener">
            {s.title}
          </a>
        </div>
        <div className="desc">{s.description}</div>
        {s.by ? <div className="by">found by {s.by}</div> : s.gaveUp ? <div className="desc">revealed</div> : null}
      </div>
    </li>
  );
}

function NewRoundButtons({ act }: { act: Act }) {
  const [custom, setCustom] = useState<string | null>(null);
  if (custom !== null) {
    return (
      <form
        className="row"
        onSubmit={async (e) => {
          e.preventDefault();
          if (custom.trim() && (await act({ type: 'newRound', letters: custom }))) setCustom(null);
        }}
      >
        <input type="text" maxLength={3} placeholder="Letters" autoFocus value={custom} onChange={(e) => setCustom(e.target.value)} />
        <button className="primary" type="submit">
          Go
        </button>
        <button type="button" className="ghost" onClick={() => setCustom(null)} aria-label="Cancel">
          ✕
        </button>
      </form>
    );
  }
  return (
    <div className="row wrap">
      <button className="primary" onClick={() => act({ type: 'newRound' })}>
        🎲 New letters
      </button>
      <button onClick={() => setCustom('')}>✏️ Choose letters</button>
    </div>
  );
}

function RoundOver({ round: r, zoneSize, act }: { round: RoundView; zoneSize: number; act: Act }) {
  if (r.status === 'error') {
    return (
      <div className="banner lost">
        <h2>Hmm.</h2>
        <p>{r.error}</p>
        <NewRoundButtons act={act} />
      </div>
    );
  }
  if (r.status === 'lost') {
    return (
      <div className="banner lost">
        <h2>Wiki womp womp</h2>
        <p>Out of lives. Bend the rules?</p>
        <div className="row wrap">
          <button className="primary" onClick={() => act({ type: 'lives', delta: 1 })}>
            +1 life, keep going
          </button>
          <button onClick={() => act({ type: 'giveUp' })}>Reveal answers</button>
        </div>
      </div>
    );
  }
  if (r.status !== 'won' && r.status !== 'revealed') return null;
  const won = r.status === 'won';
  return (
    <>
      <div className={`banner ${won ? 'won' : 'revealed'}`}>
        <h2>{won ? 'WIKI WOW! 🎉' : 'Round over'}</h2>
        <p className="small">{won ? 'You found every answer.' : 'Here’s what everyone else searches for.'}</p>
        <NewRoundButtons act={act} />
      </div>
      {r.zone && r.zone.length > 0 && (
        <details className="card" open>
          <summary>The rest of the top {zoneSize}</summary>
          <ol className="zone-list">
            {r.zone.map((z) => (
              <li key={z.rank}>
                <span className="rk">{z.rank}.</span>{' '}
                <a className={r.zoneHits.some((h) => h.rank === z.rank) ? 'hit' : ''} href={z.url} target="_blank" rel="noopener">
                  {z.title}
                </a>
              </li>
            ))}
          </ol>
        </details>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// moderator

function ModPanel({ round: r, answerKey, settings, act }: { round: RoundView; answerKey: AnswerKeyEntry[]; settings: Settings; act: Act }) {
  return (
    <section className="card modpanel">
      <div className="row">
        <h2>Moderator</h2>
        <span className="spacer" />
        <span className="small muted">{r.pending.length} waiting</span>
      </div>
      {r.pending.length === 0 && (
        <p className="small muted">Guesses and questions from players show up here. You can also type guesses you hear below.</p>
      )}
      {r.pending.map((p) => (
        <PendingItem key={p.id} p={p} answerKey={answerKey} zone={settings.zone} act={act} />
      ))}
      <details className="answer-key">
        <summary>Answer key ({r.totalResults} results)</summary>
        <ol className="key">
          {answerKey.slice(0, Math.max(settings.zone, 30)).map((k) => (
            <li
              key={k.rank}
              className={[
                k.rank <= settings.targets ? 'target' : '',
                k.found || k.revealed ? 'done' : '',
                k.zoneHit ? 'zonehit' : '',
                k.rank === settings.targets || k.rank === settings.zone ? 'cut' : '',
              ].join(' ')}
            >
              <span className="rk">{k.rank}</span>
              <span className="t">
                {k.title}
                {k.members.length > 1 && <span className="muted small"> (+ {k.members.slice(1).join(', ')})</span>}
                <span className="d">{k.description}</span>
              </span>
            </li>
          ))}
        </ol>
      </details>
    </section>
  );
}

function PendingItem({ p, answerKey, zone, act }: { p: Pending; answerKey: AnswerKeyEntry[]; zone: number; act: Act }) {
  const sug = p.suggestion;
  const [rank, setRank] = useState<string>(sug?.rank && sug.rank <= zone ? String(sug.rank) : '');
  const by = p.by && <span className="small muted"> — {p.by}</span>;

  if (p.kind === 'question') {
    return (
      <div className="pending">
        <div className="text">
          ❓ {p.text}
          {by}
        </div>
        <div className="row wrap">
          {QUESTION_VERDICTS.map((v) => (
            <button
              key={v}
              className={`small ${v === 'yes' ? 'wow' : v === 'no' ? 'womp' : ''}`}
              onClick={() => act({ type: 'answer', id: p.id, verdict: v })}
            >
              {v}
            </button>
          ))}
        </div>
      </div>
    );
  }

  const judge = (verdict: 'wow' | 'what' | 'womp' | 'dismiss') =>
    act({ type: 'judge', id: p.id, verdict, rank: rank ? Number(rank) : undefined });
  return (
    <div className="pending">
      <div className="text">
        “{p.text}”{by}
      </div>
      <div className="sug">
        {!sug ? null : sug.verdict === 'dup' ? (
          <>
            Looks like <b>{sug.title}</b>, already found
          </>
        ) : sug.rank ? (
          <>
            Looks like{' '}
            <b className={sug.verdict}>
              #{sug.rank} {sug.title}
            </b>{' '}
            ({sug.strength} match) → <b className={sug.verdict}>{sug.verdict}</b>
          </>
        ) : (
          <>
            <b className="womp">No match</b> — {sug.note}
          </>
        )}
      </div>
      <div className="row wrap">
        <select value={rank} onChange={(e) => setRank(e.target.value)} aria-label="Matching article">
          <option value="">— no match —</option>
          {answerKey.slice(0, zone).map((k) => (
            <option key={k.rank} value={k.rank}>
              #{k.rank} {k.title.slice(0, 40)}
            </option>
          ))}
        </select>
        <button className="small wow" onClick={() => judge('wow')}>
          Wow
        </button>
        <button className="small what" onClick={() => judge('what')}>
          What
        </button>
        <button className="small womp" onClick={() => judge('womp')}>
          Womp
        </button>
        <button className="small ghost" aria-label="Ignore" onClick={() => judge('dismiss')}>
          ✕
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// feed & splash

const TAGS: Partial<Record<LogEntry['type'], string>> = {
  wow: 'Wiki Wow',
  what: 'Wiki What',
  womp: 'Wiki Womp',
  answer: 'Q',
  hint: 'Hint',
  mod: 'Moderator',
  reveal: 'Reveal',
};

function Feed({ round: r, act }: { round: RoundView; act: Act }) {
  return (
    <ul className="feed">
      {[...r.log].reverse().map((l) => (
        <li key={l.id} className={`${l.type}${l.overruled ? ' overruled' : ''}`}>
          {TAGS[l.type] && <span className="tag">{TAGS[l.type]}</span>}
          {l.text}
          {l.type === 'answer' && (
            <>
              {' → '}
              <span className="ans">{l.verdict}</span>
            </>
          )}
          {l.type === 'wow' && l.guess && l.guess.toLowerCase() !== l.text.toLowerCase() && <span className="by"> (“{l.guess}”)</span>}
          {l.by && <span className="by"> · {l.by}</span>}
          {l.type === 'womp' && l.undoable && r.status !== 'won' && r.status !== 'revealed' && (
            <button className="small ghost" title="Doesn't count" onClick={() => act({ type: 'undoWomp', id: l.id })}>
              ↩︎ overrule
            </button>
          )}
          {l.note && <span className="note">{l.note}</span>}
        </li>
      ))}
    </ul>
  );
}

const SPLASH = { wow: 'WIKI WOW!', what: 'WIKI WHAT?', womp: 'WIKI WOMP' } as const;

/** Big animated verdict whenever a new wow/what/womp lands. */
function Splash({ round: r }: { round: RoundView }) {
  const seen = useRef<{ round: number; id: number } | null>(null);
  const [shown, setShown] = useState<LogEntry | null>(null);

  useEffect(() => {
    const maxId = r.log.reduce((m, l) => Math.max(m, l.id), 0);
    const prev = seen.current;
    seen.current = { round: r.id, id: maxId };
    if (!prev || prev.round !== r.id) return; // don't replay history on join
    const fresh = r.log.filter((l) => l.id > prev.id && (l.type === 'wow' || l.type === 'what' || l.type === 'womp'));
    const last = fresh[fresh.length - 1];
    if (!last) return;
    setShown(last);
    navigator.vibrate?.(last.type === 'womp' ? [90, 50, 90] : 40);
    const t = setTimeout(() => setShown((cur) => (cur === last ? null : cur)), 1500);
    return () => clearTimeout(t);
  }, [r.id, r.log]);

  if (!shown) return null;
  const type = shown.type as keyof typeof SPLASH;
  const sub = type === 'wow' ? shown.text : type === 'what' ? '+1 yes/no question' : shown.guess;
  return (
    <div id="splash" aria-live="assertive">
      <div key={shown.id} className={`boom ${type}`}>
        {SPLASH[type]}
        <small>{sub}</small>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// composer

function Composer({ round: r, isMod, act, name }: { round: RoundView; isMod: boolean; act: Act; name: string }) {
  const [mode, setMode] = useState<'guess' | 'ask'>('guess');
  const [text, setText] = useState('');
  const [free, setFree] = useState(false);
  const [sending, setSending] = useState(false);

  const enabled = r.status === 'playing' || (mode === 'ask' && r.status === 'lost');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    setSending(true);
    setText('');
    const by = name || undefined;
    const ok = await act(mode === 'guess' ? { type: 'guess', text: t, by } : { type: 'ask', text: t, by, free });
    setSending(false);
    if (!ok) setText(t);
    else setFree(false);
  };

  const waiting = !isMod && r.pending.length > 0;
  return (
    <div className="composer">
      <div className="inner">
        <div className="seg">
          <button type="button" aria-pressed={mode === 'guess'} onClick={() => setMode('guess')}>
            Guess
          </button>
          <button type="button" aria-pressed={mode === 'ask'} onClick={() => setMode('ask')}>
            Ask yes/no ({r.questions})
          </button>
        </div>
        <form onSubmit={submit}>
          <input
            type="text"
            autoComplete="off"
            enterKeyHint="send"
            maxLength={300}
            autoCapitalize={mode === 'guess' ? 'words' : 'sentences'}
            placeholder={mode === 'guess' ? 'Type an article title…' : 'Is one of them a person?'}
            aria-label={mode === 'guess' ? 'Your guess' : 'Your yes/no question'}
            disabled={!enabled}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <button className="primary" type="submit" disabled={!enabled || r.busy || sending || !text.trim()}>
            Go
          </button>
        </form>
        <div className="meta">
          <span>
            {r.busy ? (
              <>
                <span className="thinking">
                  <i />
                  <i />
                  <i />
                </span>
                &nbsp;moderator is thinking…
              </>
            ) : waiting ? (
              'Waiting for the moderator…'
            ) : name ? (
              <>
                as <b>{name}</b>
              </>
            ) : null}
          </span>
          <span className="row">
            {mode === 'ask' && (
              <label title="House rule: ask without spending a question">
                <input type="checkbox" checked={free} onChange={(e) => setFree(e.target.checked)} /> free
              </label>
            )}
            <button type="button" className="small" disabled={r.status !== 'playing' && r.status !== 'lost'} onClick={() => act({ type: 'hint', by: name || undefined })}>
              💡 Hint
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// house rules sheet

function Sheet({
  view,
  act,
  modToken,
  code,
  name,
  onClose,
}: {
  view: RoomView;
  act: Act;
  modToken: string;
  code: string;
  name: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  const r = view.round;
  const active = Boolean(r && (r.status === 'playing' || r.status === 'lost'));
  const [s, setS] = useState(view.settings);
  const [apiKey, setApiKey] = useState('');
  const [say, setSay] = useState('');
  const [customLetters, setCustomLetters] = useState('');
  const doAndClose = async (a: Action) => {
    if (await act(a)) onClose();
  };
  const num = (k: 'lives' | 'targets' | 'zone' | 'freeQuestions') => (
    <input type="text" inputMode="numeric" value={String(s[k])} onChange={(e) => setS({ ...s, [k]: Number(e.target.value.replace(/\D/g, '')) || 0 })} />
  );

  return (
    <dialog ref={ref} onClose={onClose} onClick={(e) => e.target === ref.current && onClose()}>
      <div className="sheet">
        <div className="row">
          <h2>House rules</h2>
          <span className="spacer" />
          <button className="icon ghost" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>

        <h3>Bend the rules</h3>
        <div className="grid2">
          <button disabled={!active} onClick={() => act({ type: 'lives', delta: 1 })}>
            ❤️ +1 life
          </button>
          <button disabled={!active} onClick={() => act({ type: 'questions', delta: 1 })}>
            ❓ +1 question
          </button>
          <button disabled={!active} onClick={() => doAndClose({ type: 'hint', by: name || undefined })}>
            💡 Hint
          </button>
          <button disabled={!active} onClick={() => doAndClose({ type: 'revealOne' })}>
            🫣 Reveal one
          </button>
          <button disabled={!active} onClick={() => doAndClose({ type: 'giveUp' })}>
            🏳️ Reveal all
          </button>
          <button onClick={() => doAndClose({ type: 'newRound' })}>🎲 New letters</button>
        </div>
        <form
          className="row"
          style={{ marginTop: 8 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (customLetters.trim()) doAndClose({ type: 'newRound', letters: customLetters });
          }}
        >
          <input type="text" maxLength={3} placeholder="Choose letters, e.g. QU" value={customLetters} onChange={(e) => setCustomLetters(e.target.value)} />
          <button type="submit">Play</button>
        </form>

        {view.isMod && (
          <>
            <h3>Moderator</h3>
            <form
              className="row"
              onSubmit={async (e) => {
                e.preventDefault();
                if (say.trim() && (await act({ type: 'say', text: say }))) setSay('');
              }}
            >
              <input type="text" placeholder="Announce something…" maxLength={300} value={say} onChange={(e) => setSay(e.target.value)} />
              <button className="primary" type="submit">
                Post
              </button>
            </form>
            <p className="small muted">
              Moving to another device?{' '}
              <button className="small" onClick={() => share(`${location.origin}/r/${code}#mod=${modToken}`, 'WikiWow moderator link')}>
                Copy moderator link
              </button>
            </p>
          </>
        )}

        <h3>Settings</h3>
        <form
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await act({ type: 'settings', settings: { ...s, apiKey: apiKey || undefined } })) {
              toast('Settings saved');
              onClose();
            }
          }}
        >
          <label className="field">
            <span>Moderator</span>
            <select value={s.moderator} onChange={(e) => setS({ ...s, moderator: e.target.value as Settings['moderator'] })}>
              <option value="human">Human</option>
              <option value="ai">AI</option>
            </select>
          </label>
          {s.moderator === 'ai' && !view.hasAI && (
            <label className="field">
              <span>AI provider &amp; key</span>
              <div className="row">
                <select style={{ width: 'auto' }} value={s.aiProvider} onChange={(e) => setS({ ...s, aiProvider: e.target.value as Settings['aiProvider'] })}>
                  <option value="claude">Claude</option>
                  <option value="openai">ChatGPT</option>
                </select>
                <input type="password" placeholder="API key" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
              </div>
            </label>
          )}
          <div className="grid2">
            <label className="field">
              <span>Lives (next round)</span>
              {num('lives')}
            </label>
            <label className="field">
              <span>Answers</span>
              {num('targets')}
            </label>
            <label className="field">
              <span>“What” zone</span>
              {num('zone')}
            </label>
            <label className="field">
              <span>Free questions</span>
              {num('freeQuestions')}
            </label>
          </div>
          <label className="field">
            <span>Merge near-duplicates (next round)</span>
            <select value={s.dedupe} onChange={(e) => setS({ ...s, dedupe: e.target.value as Settings['dedupe'] })}>
              <option value="basic">Basic</option>
              <option value="aggressive">Aggressive</option>
              <option value="off">Off</option>
            </select>
          </label>
          <label className="field">
            <span>Random letters</span>
            <select value={s.letterMode} onChange={(e) => setS({ ...s, letterMode: e.target.value as Settings['letterMode'] })}>
              <option value="common">Common starts</option>
              <option value="any">Any two letters</option>
            </select>
          </label>
          <button className="primary block" type="submit">
            Save settings
          </button>
          <p className="small muted">
            {view.stats.rounds} round{view.stats.rounds === 1 ? '' : 's'} · {view.stats.won} won · {view.stats.wows} wows · {view.stats.whats}{' '}
            whats · {view.stats.womps} womps
          </p>
        </form>
      </div>
    </dialog>
  );
}
