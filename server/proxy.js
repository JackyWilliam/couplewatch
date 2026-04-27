import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';

const DEFAULT_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

export function handleProxy(req, res, params) {
  const target = params.get('url');
  if (!target) {
    res.writeHead(400); res.end('missing url'); return;
  }
  const ref = params.get('ref') || '';
  const ua = params.get('ua') || DEFAULT_UA;
  const token = params.get('t') || '';   // 透传 token，让重写后的子分片 URL 也能通过鉴权
  proxyOnce(target, ref, ua, token, req, res, 0);
}

function proxyOnce(target, ref, ua, token, req, res, depth) {
  if (depth > 5) {
    res.writeHead(508); res.end('too many redirects'); return;
  }
  let url;
  try { url = new URL(target); } catch {
    res.writeHead(400); res.end('bad url'); return;
  }

  const lib = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const headers = {
    'User-Agent': ua,
    'Accept': '*/*',
    'Accept-Encoding': 'identity',
  };
  if (ref) headers['Referer'] = ref;
  if (req.headers['range']) headers['Range'] = req.headers['range'];

  const upstream = lib({
    method: req.method,
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname + url.search,
    headers,
  }, (upRes) => {
    const sc = upRes.statusCode || 0;
    if ([301, 302, 303, 307, 308].includes(sc)) {
      const loc = upRes.headers.location;
      if (loc) {
        const next = new URL(loc, url).toString();
        upRes.resume();
        return proxyOnce(next, ref, ua, token, req, res, depth + 1);
      }
    }

    const ct = (upRes.headers['content-type'] || '').toLowerCase();
    const isM3u8 = ct.includes('mpegurl') || /\.m3u8(\?|$)/i.test(url.pathname);

    const out = {};
    if (upRes.headers['content-type']) out['content-type'] = upRes.headers['content-type'];
    if (upRes.headers['content-range']) out['content-range'] = upRes.headers['content-range'];
    if (upRes.headers['accept-ranges']) out['accept-ranges'] = upRes.headers['accept-ranges'];
    if (upRes.headers['content-length'] && !isM3u8) out['content-length'] = upRes.headers['content-length'];
    out['cache-control'] = 'no-cache';
    out['access-control-allow-origin'] = '*';

    if (isM3u8) {
      const chunks = [];
      upRes.on('data', c => chunks.push(c));
      upRes.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const rewritten = rewriteM3u8(text, target, ref, ua, token);
        const body = Buffer.from(rewritten, 'utf8');
        out['content-length'] = body.length;
        out['content-type'] = 'application/vnd.apple.mpegurl';
        res.writeHead(sc || 200, out);
        res.end(body);
      });
      upRes.on('error', () => safeFail(res, 502));
    } else {
      res.writeHead(sc || 200, out);
      upRes.pipe(res);
      upRes.on('error', () => res.destroy());
    }
  });

  upstream.on('error', (e) => {
    console.error('[proxy] upstream error:', e.message);
    safeFail(res, 502, e.message);
  });
  req.on('close', () => upstream.destroy());
  upstream.end();
}

function safeFail(res, code, msg = '') {
  if (res.headersSent) { try { res.destroy(); } catch {} return; }
  res.writeHead(code); res.end(msg);
}

function rewriteM3u8(text, baseUrl, ref, ua, token) {
  const base = new URL(baseUrl);
  const lines = text.split(/\r?\n/);
  return lines.map(line => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (trimmed.startsWith('#')) {
      // 处理 #EXT-X-KEY、#EXT-X-MAP 里的 URI=
      return line.replace(/URI="([^"]+)"/g, (_, u) => {
        try {
          const abs = new URL(u, base).toString();
          return `URI="${proxify(abs, ref, ua, token)}"`;
        } catch { return _; }
      });
    }
    try {
      const abs = new URL(line, base).toString();
      return proxify(abs, ref, ua, token);
    } catch {
      return line;
    }
  }).join('\n');
}

function proxify(url, ref, ua, token) {
  const params = new URLSearchParams({ url, ref, ua });
  if (token) params.set('t', token);
  return `/api/proxy?${params.toString()}`;
}
