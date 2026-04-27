import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TIMEOUT = 30_000;
const __dirname = dirname(fileURLToPath(import.meta.url));

// 优先用项目内 nightly 二进制（解决 brew stable 的 B 站 bug 之类版本锁定）
const LOCAL_YTDLP = join(__dirname, '..', 'bin', 'yt-dlp');
const YTDLP_BIN = existsSync(LOCAL_YTDLP) ? LOCAL_YTDLP : 'yt-dlp';

export function handleResolve(req, res, body) {
  const url = String(body.url || '').trim();
  if (!url || !/^https?:\/\//.test(url)) {
    return reply(res, 400, { ok: false, error: '请输入合法的 http(s) 链接' });
  }

  const args = ['-j', '--no-warnings', '--no-playlist', url];
  // 可选代理（环境变量 YTDLP_PROXY，例如走本地 clash）
  if (process.env.YTDLP_PROXY) {
    args.push('--proxy', process.env.YTDLP_PROXY);
  }
  // 可选 cookies 文件（解决登录墙）
  if (process.env.YTDLP_COOKIES && existsSync(process.env.YTDLP_COOKIES)) {
    args.push('--cookies', process.env.YTDLP_COOKIES);
  }
  const child = spawn(YTDLP_BIN, args);

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d.toString()));
  child.stderr.on('data', (d) => (stderr += d.toString()));

  const killer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT);

  child.on('close', (code) => {
    clearTimeout(killer);
    if (code !== 0) {
      const lastLine = stderr.split('\n').filter(Boolean).pop() || `yt-dlp exit ${code}`;
      console.error('[resolve] 失败:', lastLine);
      return reply(res, 502, { ok: false, error: lastLine });
    }
    try {
      const firstJsonLine = stdout.split('\n').find(l => l.trim().startsWith('{'));
      if (!firstJsonLine) throw new Error('未拿到 JSON');
      const info = JSON.parse(firstJsonLine);
      const result = pickFormat(info);
      reply(res, 200, { ok: true, ...result });
    } catch (e) {
      console.error('[resolve] 解析返回数据失败:', e.message);
      reply(res, 500, { ok: false, error: '解析数据异常: ' + e.message });
    }
  });

  child.on('error', (e) => {
    clearTimeout(killer);
    reply(res, 500, { ok: false, error: 'yt-dlp 调用失败：' + e.message });
  });
}

function reply(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function pickFormat(info) {
  const title = info.title || '(未命名)';
  const duration = info.duration || 0;
  const webpage = info.webpage_url || '';
  const referer = (info.http_headers && info.http_headers.Referer) || webpage;
  const userAgent = (info.http_headers && info.http_headers['User-Agent']) || '';

  const formats = (info.formats || []).filter(f => f.url);

  // 1. 渐进式 mp4：同时含视频+音频
  const mp4 = formats
    .filter(f => f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none')
    .filter(f => (f.protocol === 'https' || f.protocol === 'http') && (f.ext === 'mp4' || f.ext === 'webm'))
    .sort((a, b) => (b.height || 0) - (a.height || 0))[0];

  if (mp4) {
    return {
      title, duration, kind: 'mp4',
      src: mp4.url,
      headers: { Referer: referer, 'User-Agent': userAgent },
    };
  }

  // 2. m3u8（HLS）
  const m3u8 = formats
    .filter(f => f.protocol && f.protocol.toLowerCase().includes('m3u8'))
    .sort((a, b) => (b.height || 0) - (a.height || 0))[0];

  if (m3u8) {
    return {
      title, duration, kind: 'hls',
      src: m3u8.url,
      headers: { Referer: referer, 'User-Agent': userAgent },
    };
  }

  // 3. 兜底
  if (info.url) {
    const looksHls = /\.m3u8(\?|$)/i.test(info.url);
    return {
      title, duration, kind: looksHls ? 'hls' : 'mp4',
      src: info.url,
      headers: { Referer: referer, 'User-Agent': userAgent },
    };
  }

  throw new Error('未找到可播放的视频流（可能此站点暂不支持）');
}
