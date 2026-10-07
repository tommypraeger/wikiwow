// WikiWow server: static files + JSON API + Server-Sent Events.
// No framework; Node >= 20.

import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRoom, getRoom, GameError, DEFAULT_SETTINGS, type Room } from './lib/game.js';
import { serverProviders, aiPasswordRequired } from './lib/ai.js';
import { clientIp, take, type Limit } from './lib/ratelimit.js';
import type { RoomView, ServerConfig } from './shared/types.js';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
// public/ sits next to src/ and dist/
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

// Per-IP rate limits.
const LIMITS = {
  create: { capacity: 5, perSecond: 5 / 600 }, // 5 new games per 10 minutes
  action: { capacity: 30, perSecond: 1 }, // bursts of 30, then 1/s
  read: { capacity: 30, perSecond: 0.5 }, // joins, reconnects, lookups
} satisfies Record<string, Limit>;
const MAX_CONNECTIONS = Number(process.env.MAX_CONNECTIONS || 1000);
const MAX_CONNECTIONS_PER_ROOM = Number(process.env.MAX_CONNECTIONS_PER_ROOM || 50);
let connections = 0;

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "img-src 'self' data: https://*.wikimedia.org",
    "connect-src 'self'",
    "style-src 'self'",
    "script-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

function rateLimit(req: IncomingMessage, bucket: keyof typeof LIMITS, cost = 1): void {
  const wait = take(`${bucket}:${clientIp(req)}`, LIMITS[bucket], cost);
  if (wait) throw Object.assign(new GameError(`Slow down! Try again in ${wait}s`, 429), { retryAfter: wait });
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function sendJSON(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

type Body = Record<string, any>;

async function readBody(req: IncomingMessage): Promise<Body> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new GameError('Request too large', 413);
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new GameError('Bad JSON');
  }
}

function serveStatic(res: ServerResponse, pathname: string): void {
  // SPA: any non-file path (e.g. /r/ABCD) gets index.html
  let file = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJSON(res, 403, { error: 'Forbidden' });
  if (!path.extname(file) || !fs.existsSync(file)) file = path.join(PUBLIC_DIR, 'index.html');
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=300',
  });
  fs.createReadStream(file).pipe(res);
}

function events(req: IncomingMessage, res: ServerResponse, room: Room, isMod: boolean): void {
  if (connections >= MAX_CONNECTIONS || room.listeners.size >= MAX_CONNECTIONS_PER_ROOM) {
    throw new GameError('Too many people connected right now', 503);
  }
  connections++;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // let nginx stream it
  });
  const send = (view: RoomView) => res.write(`data: ${JSON.stringify(view)}\n\n`);
  const unsubscribe = room.subscribe({ send, isMod });
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    connections--;
    clearInterval(ping);
    unsubscribe();
  });
}

// Actions anyone in the room can take (it's a party game: house rules are
// everyone's business). Moderator-only ones are checked below.
const MOD_ONLY = new Set(['judge', 'answer', 'say']);

async function action(room: Room, body: Body, isMod: boolean): Promise<void> {
  const { type } = body;
  if (MOD_ONLY.has(type) && !isMod) throw new GameError('Only the moderator can do that', 403);
  switch (type) {
    case 'newRound':
      // don't await: the round shows a loading state over SSE
      room.newRound(body.letters).catch((err) => console.error(err));
      return;
    case 'guess':
      return room.guess(body.text, body.by);
    case 'judge':
      return room.judge(body.id, body.verdict, body.rank);
    case 'ask':
      return room.ask(body.text, body.by, Boolean(body.free));
    case 'answer':
      return room.answer(body.id, body.verdict, body.note);
    case 'hint':
      return room.hint(body.by);
    case 'say':
      return room.say(body.text);
    case 'lives':
      return room.adjustLives(Number(body.delta));
    case 'questions':
      return room.adjustQuestions(Number(body.delta));
    case 'undoWomp':
      return room.undoWomp(body.id);
    case 'revealOne':
      return room.revealOne();
    case 'giveUp':
      return room.giveUp();
    case 'settings':
      return room.updateSettings(body.settings || {});
    default:
      throw new GameError('Unknown action');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://x');
  const parts = url.pathname.split('/').filter(Boolean);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  try {
    if (parts[0] !== 'api') return serveStatic(res, url.pathname);

    // GET /api/config
    if (parts[1] === 'config' && req.method === 'GET') {
      const config: ServerConfig = { providers: serverProviders(), aiPasswordRequired: aiPasswordRequired(), defaults: DEFAULT_SETTINGS };
      return sendJSON(res, 200, config);
    }
    // POST /api/rooms
    if (parts[1] === 'rooms' && parts.length === 2 && req.method === 'POST') {
      rateLimit(req, 'create');
      const body = await readBody(req);
      const room = createRoom(body);
      room.newRound(body.letters).catch((err) => console.error(err));
      return sendJSON(res, 201, { code: room.code, modToken: room.modToken });
    }
    if (parts[1] === 'rooms' && parts[2]) {
      const isAction = parts[3] === 'action' && req.method === 'POST';
      rateLimit(req, isAction ? 'action' : 'read');
      let room: Room;
      try {
        room = getRoom(parts[2]);
      } catch (err) {
        // Make guessing game codes expensive.
        take(`read:${clientIp(req)}`, LIMITS.read, 5);
        throw err;
      }
      // The moderator token travels in a header only, so it never ends up in
      // URLs or proxy logs.
      const token = req.headers['x-mod-token'];
      const isMod = room.isMod(token);
      // GET /api/rooms/:code/events
      if (parts[3] === 'events' && req.method === 'GET') return events(req, res, room, isMod);
      // GET /api/rooms/:code
      if (!parts[3] && req.method === 'GET') return sendJSON(res, 200, room.view(isMod));
      // POST /api/rooms/:code/action
      if (isAction) {
        await action(room, await readBody(req), isMod);
        return sendJSON(res, 200, { ok: true });
      }
    }
    sendJSON(res, 404, { error: 'Not found' });
  } catch (err) {
    if (!(err instanceof GameError)) console.error(err);
    const status = err instanceof GameError ? err.status : 500;
    const retryAfter = (err as { retryAfter?: number }).retryAfter;
    if (retryAfter) res.setHeader('Retry-After', String(retryAfter));
    if (!res.headersSent) sendJSON(res, status, { error: err instanceof GameError ? err.message : 'Server error' });
  }
});

server.listen(PORT, HOST, () => {
  const p = serverProviders();
  console.log(`WikiWow running at http://localhost:${PORT}`);
  console.log(`AI moderator keys on server: Claude ${p.claude ? '✓' : '✗'}  OpenAI ${p.openai ? '✓' : '✗'}`);
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(HOST);
  if ((p.claude || p.openai) && !aiPasswordRequired() && !loopback) {
    console.warn('⚠️  The server AI key is usable by anyone who can reach this server. Set AI_PASSWORD to protect it.');
  }
});
