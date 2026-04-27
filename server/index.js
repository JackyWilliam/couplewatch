import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { WebSocketServer } from 'ws';
import { randomBytes } from 'node:crypto';

import { handleResolve } from './resolve.js';
import { handleProxy } from './proxy.js';
import { handleTurnCredentials } from './turn.js';
import { Room } from './room.js';

loadDotEnv();

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');

const PORT = parseInt(process.env.PORT || '8787', 10);
const ROOM_PIN = (process.env.ROOM_PIN || randomDigits(4)).padStart(4, '0');

const sessions = new Map();

function randomDigits(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 10);
  return s;
}

function newToken() {
  return randomBytes(16).toString('hex');
}

function getToken(req, url) {
  if (url && url.searchParams.has('t')) return url.searchParams.get('t');
  const auth = req.headers['authorization'] || '';
  const m = auth.match(/^Bearer\s+(\S+)/);
  return m ? m[1] : null;
}

function checkAuth(req, url) {
  const token = getToken(req, url);
  return !!(token && sessions.has(token));
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

async function serveStatic(req, res) {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  const safe = normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  const file = join(PUBLIC_DIR, safe);
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  try {
    const buf = await readFile(file);
    const mime = MIME[extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
    res.end(buf);
  } catch {
    res.writeHead(404); res.end('Not Found');
  }
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { return {}; }
}

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  // CORS: 允许油猴脚本从任意网站 POST 到 /api/auth 和 /api/load
  if (path.startsWith('/api/')) {
    const reqOrigin = req.headers.origin;
    if (reqOrigin) {
      res.setHeader('Access-Control-Allow-Origin', reqOrigin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
  }

  if (req.method === 'POST' && path === '/api/auth') {
    const body = await readJson(req);
    if (String(body.pin || '').padStart(4, '0') !== ROOM_PIN) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'PIN 错误' }));
      return;
    }
    const token = newToken();
    sessions.set(token, { issuedAt: Date.now() });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, token }));
    return;
  }

  if (path.startsWith('/api/') && !checkAuth(req, url)) {
    res.writeHead(401); res.end('Unauthorized'); return;
  }

  if (req.method === 'POST' && path === '/api/resolve') {
    const body = await readJson(req);
    return handleResolve(req, res, body);
  }

  if (req.method === 'POST' && path === '/api/load') {
    const body = await readJson(req);
    const src = String(body.src || '').trim();
    if (!src || !/^https?:\/\//.test(src)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: '需要合法的 src URL' }));
      return;
    }
    const load = {
      src,
      kind: body.kind || (/\.m3u8(\?|$)/i.test(src) ? 'hls' : 'mp4'),
      title: String(body.title || src.split('/').pop() || '未命名').slice(0, 80),
      original: String(body.original || ''),
      headers: body.headers && typeof body.headers === 'object' ? body.headers : {},
      from: String(body.from || '油猴脚本').slice(0, 30),
    };
    room.directLoad(load);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, title: load.title }));
    return;
  }
  if ((req.method === 'GET' || req.method === 'HEAD') && path === '/api/proxy') {
    return handleProxy(req, res, url.searchParams);
  }
  if (req.method === 'GET' && path === '/api/turn') {
    return handleTurnCredentials(req, res);
  }

  return serveStatic(req, res);
});

const wss = new WebSocketServer({ noServer: true });
const room = new Room();

httpServer.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get('token') || url.searchParams.get('t');
  if (!token || !sessions.has(token)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => room.add(ws));
});

httpServer.listen(PORT, () => {
  console.log(`\n🎬 CoupleWatch 已启动`);
  console.log(`   本地访问:  http://localhost:${PORT}`);
  console.log(`   房间 PIN:  ${ROOM_PIN}\n`);
});

function loadDotEnv() {
  try {
    if (!existsSync('.env')) return;
    const content = readFileSync('.env', 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
      if (!m) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (!process.env[m[1]]) process.env[m[1]] = v;
    }
  } catch {}
}
