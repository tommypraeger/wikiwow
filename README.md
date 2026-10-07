# WikiWow

A party game: you get two letters and try to guess the top 5 Wikipedia articles that show up in Wikipedia's search autocomplete for them.

- **Wiki Wow**: your guess is in the top 5.
- **Wiki What**: it's in the top 20 but not the top 5. You earn one yes/no question about the answers (nothing too direct).
- **Wiki Womp**: it's outside the top 20. You lose a life.

House rules are built in: anyone can add or remove lives and questions, ask a free question, get a hint, reveal one answer, overrule a womp, or pick their own letters. All of it lives in the ☰ menu.

## Running locally

```sh
npm install
npm run dev          # http://localhost:3000, rebuilds on change
```

Open the URL on your phone (same Wi-Fi, use your computer's LAN IP), start a game, and share the 4-letter code or the 🔗 link.

Production:

```sh
npm run build
npm start
```

Configuration lives in environment variables or a `.env` file (see [`.env.example`](.env.example)).

## Moderators

**Human moderator**: whoever creates the game is the moderator, sees the answer key, and rules on guesses. For each guess the app suggests a verdict (fuzzy-matched against the top 100, e.g. "looks like #3 Thailand → wow"), and the moderator taps Wow / What / Womp. Questions show up with Yes / No / Sort of / Too direct buttons. The moderator can hand the role to another device with **Copy moderator link**.

**AI moderator**: needs `ANTHROPIC_API_KEY` (Claude, the default) or `OPENAI_API_KEY` on the server. You can also paste a key when creating a game; it stays in server memory for that game only. Then:

- obvious guesses (exact or near-exact titles) are judged locally with no AI call
- fuzzy guesses ("Lincoln", "Abu Ghraib") are judged by the model
- yes/no questions are answered by the model, which refuses ones that are too direct and refunds them
- hints come from the model, and the built-in hints take over if the AI fails
- near-duplicates such as "Windows 10" and "Windows 10 version history" are merged by the model on top of the built-in heuristics
- nobody sees the answer key, not even the game creator

If an AI call fails, the guess isn't counted and the question is refunded.

## Wikipedia API usage

Each round makes **one** request to the same endpoint the Wikipedia search box uses:

```
GET https://en.wikipedia.org/w/rest.php/v1/search/title?q=ab&limit=100
```

It returns the top 100 titles in autocomplete order, along with short descriptions, thumbnails and redirect targets. That one call supplies the answers, the "what" zone, the "that was #34" feedback, the descriptions used in hints, and the images. To follow [Wikimedia's API etiquette](https://www.mediawiki.org/wiki/API:Etiquette):

- requests send a descriptive `User-Agent` (set `WIKI_CONTACT`)
- requests go through a single queue at least `WIKI_MIN_INTERVAL_MS` apart (default 500ms)
- identical in-flight requests are coalesced
- results are cached for 6 hours in memory and in `data/wiki-cache.json`, so replayed letters cost nothing
- `429`/`5xx` responses are retried with `Retry-After` backoff

Browsers never call Wikipedia directly, except to load thumbnails.

## Deduping

Autocomplete is noisy, so results are merged before ranking. The **Basic** mode (the default):

- drops disambiguation pages
- merges redirects to the same page
- merges the same title with or without a qualifier ("Usher" / "Usher (musician)")
- merges short version suffixes ("USB" / "USB-C" / "USB 3.0")

**Aggressive** also merges whole-word prefixes ("Abu Ghraib" / "Abu Ghraib prison"). **Off** uses the raw list.

## Security

The game has no accounts, so anyone with a game code can join it and use the house rules. Everything else is locked down:

- **AI password.** Set `AI_PASSWORD` and nobody can use the server's AI keys without it. Players can still bring their own key. The server warns at startup if a key is set on a public interface without a password.
- **AI budget.** Each round gets `AI_CALLS_PER_ROUND` AI requests (default 40). After that, guesses are judged by spelling, hints are built-in, and questions stop.
- **Rate limits per IP.** 5 new games per 10 minutes, bursts of 30 actions, and throttled lookups so game codes can't be brute-forced. Behind a proxy, set `TRUST_PROXY=1` so limits use the real client IP.
- **Caps** on games (`MAX_ROOMS`), live connections (`MAX_CONNECTIONS`, `MAX_CONNECTIONS_PER_ROOM`), and the Wikipedia request queue.
- **Moderator token** is sent in an `X-Mod-Token` header, never in a URL. The live-update stream is read with `fetch()` for this reason.
- **Headers:** a strict Content-Security-Policy (scripts and styles from this site only, images from Wikimedia), `X-Frame-Options: DENY`, `nosniff`, `no-referrer`.
- **AI answers are filtered.** Player text is wrapped as data in the prompt, and an explanation that mentions a hidden title is dropped before it reaches the feed.
- **Use HTTPS** for any public deploy. The UI warns before you paste a key over plain HTTP.

## Deploying

The server is a single Node process with no database. Games live in memory and expire after 12 idle hours. Any host that runs Node 20+ or Docker will work:

```sh
docker build -t wikiwow .
docker run -p 3000:3000 -e ANTHROPIC_API_KEY=... -e AI_PASSWORD=... -e WIKI_CONTACT=you@example.com wikiwow
```

Live updates use Server-Sent Events. If you put nginx in front, the server already sends `X-Accel-Buffering: no`. Because games are in memory, run a single instance, or add sticky sessions before scaling out.

## Project layout

```
src/server.ts        HTTP server: static files, JSON API, SSE
src/lib/wiki.ts      Wikipedia client: queue, cache, dedupe, letter pairs
src/lib/match.ts     fuzzy guess matching
src/lib/game.ts      rooms, rounds, verdicts, house rules
src/lib/ai.ts        AI moderator (Claude via @anthropic-ai/sdk, or OpenAI)
src/lib/ratelimit.ts per-IP token buckets
src/shared/types.ts  types shared by server and client
src/client/          React UI (bundled by esbuild into public/app.js)
public/              index.html, style.css
test/                node:test unit tests (npm test)
```
