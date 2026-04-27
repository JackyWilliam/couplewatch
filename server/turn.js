import { request as httpsRequest } from 'node:https';

const FALLBACK_ICE = [
  { urls: 'stun:stun.cloudflare.com:3478' },
];

export function handleTurnCredentials(req, res) {
  const KEY_ID = process.env.CF_TURN_KEY_ID || '';
  const API_TOKEN = process.env.CF_TURN_API_TOKEN || '';

  if (!KEY_ID || !API_TOKEN) {
    return reply(res, { iceServers: FALLBACK_ICE, source: 'fallback', warn: '未配置 Cloudflare TURN，跨境投屏可能打洞失败' });
  }

  const data = JSON.stringify({ ttl: 3600 });
  const r = httpsRequest({
    method: 'POST',
    hostname: 'rtc.live.cloudflare.com',
    path: `/v1/turn/keys/${KEY_ID}/credentials/generate`,
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data),
    },
  }, (up) => {
    const chunks = [];
    up.on('data', c => chunks.push(c));
    up.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const ice = body.iceServers;
        if (!ice) throw new Error('CF 返回缺 iceServers');
        const iceServers = [
          ...FALLBACK_ICE,
          { urls: ice.urls, username: ice.username, credential: ice.credential },
        ];
        reply(res, { iceServers, source: 'cloudflare', ttl: 3600 });
      } catch (e) {
        console.error('[turn] cf 错误:', e.message);
        reply(res, { iceServers: FALLBACK_ICE, source: 'fallback', error: e.message });
      }
    });
  });
  r.on('error', (e) => {
    reply(res, { iceServers: FALLBACK_ICE, source: 'fallback', error: e.message });
  });
  r.write(data);
  r.end();
}

function reply(res, obj) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
