// ==UserScript==
// @name         CoupleWatch Sender
// @namespace    https://couplewatch.uk/
// @version      0.4.0
// @description  在任何视频网站抓取 m3u8/mp4 流地址，一键发送到 CoupleWatch 让对方同步看
// @author       CoupleWatch
// @match        *://*/*
// @run-at       document-start
// @grant        GM.xmlHttpRequest
// @grant        GM.setValue
// @grant        GM.getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @connect      *
// ==/UserScript==

(async function () {
  'use strict';

  // —— 跨油猴扩展兼容（Tampermonkey 用 GM_*，Userscripts/Violentmonkey 用 GM.*）——
  const GMx = {
    getValue: async (k, d) => {
      try {
        if (typeof GM !== 'undefined' && GM.getValue) return await GM.getValue(k, d);
      } catch {}
      if (typeof GM_getValue === 'function') return GM_getValue(k, d);
      return d;
    },
    setValue: async (k, v) => {
      try {
        if (typeof GM !== 'undefined' && GM.setValue) return await GM.setValue(k, v);
      } catch {}
      if (typeof GM_setValue === 'function') return GM_setValue(k, v);
    },
    xhr: (opts) => {
      try {
        if (typeof GM !== 'undefined' && GM.xmlHttpRequest) return GM.xmlHttpRequest(opts);
      } catch {}
      if (typeof GM_xmlhttpRequest === 'function') return GM_xmlhttpRequest(opts);
      throw new Error('GM xhr 不可用');
    },
    addStyle: (css) => {
      try {
        if (typeof GM !== 'undefined' && GM.addStyle) return GM.addStyle(css);
      } catch {}
      if (typeof GM_addStyle === 'function') return GM_addStyle(css);
      const style = document.createElement('style');
      style.textContent = css;
      (document.head || document.documentElement).appendChild(style);
    },
    registerMenu: (label, fn) => {
      try {
        if (typeof GM_registerMenuCommand === 'function') GM_registerMenuCommand(label, fn);
      } catch {}
    },
  };

  // —— 配置 ——
  const cfg = {
    server: await GMx.getValue('server', ''),
    pin: await GMx.getValue('pin', ''),
    token: await GMx.getValue('token', ''),
  };

  // —— 抓视频流 ——
  const captured = [];
  const captureSet = new Set();
  function record(url, type) {
    if (!url || captureSet.has(url)) return;
    if (!/^https?:\/\//i.test(url)) return;
    captureSet.add(url);
    captured.unshift({ url, type, ts: Date.now() });
    if (captured.length > 30) captured.pop();
    updateBadge();
  }
  function looksLikeStream(url) {
    return /\.(m3u8|mp4|webm|flv|m4s|ts)(\?|$)/i.test(url);
  }
  function streamType(url) {
    if (/\.m3u8(\?|$)/i.test(url)) return 'hls';
    if (/\.(mp4|webm|m4s)(\?|$)/i.test(url)) return 'mp4';
    if (/\.flv(\?|$)/i.test(url)) return 'flv';
    return 'unknown';
  }

  // —— 注入到 page context（关键：Userscripts 默认在 content context 跑，hook 不到页面真实 XHR）——
  // 通过 <script> 标签把 hook 代码塞进 page world，抓到 URL 后用 postMessage 回传
  function injectPageHook() {
    const code = `(function() {
      const re = /\\.(m3u8|mp4|webm|flv|m4s|ts)(\\?|$)/i;
      const looks = u => typeof u === 'string' && re.test(u);
      function emit(url) {
        try {
          window.postMessage({ __cwStream: true, url: url }, '*');
          if (window.top !== window) {
            try { window.top.postMessage({ __cwStream: true, url: url }, '*'); } catch(e) {}
          }
        } catch(e) {}
      }
      try {
        const _open = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(m, u) {
          try { if (looks(u)) emit(u); } catch(e) {}
          return _open.apply(this, arguments);
        };
      } catch(e) {}
      try {
        const _f = window.fetch;
        if (_f) {
          window.fetch = function(input, init) {
            try {
              const u = typeof input === 'string' ? input : (input && input.url) || '';
              if (looks(u)) emit(u);
            } catch(e) {}
            return _f.apply(this, arguments);
          };
        }
      } catch(e) {}
      try {
        const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
        if (desc && desc.set) {
          Object.defineProperty(HTMLMediaElement.prototype, 'src', {
            set(v) { try { if (looks(v)) emit(v); } catch(e) {} return desc.set.call(this, v); },
            get() { return desc.get.call(this); },
            configurable: true,
          });
        }
      } catch(e) {}
      console.log('[CoupleWatch Sender] page hook installed');
    })();`;
    try {
      const s = document.createElement('script');
      s.textContent = code;
      (document.head || document.documentElement).appendChild(s);
      s.remove();
    } catch (e) {
      console.warn('[CoupleWatch Sender] page inject failed:', e);
    }
  }
  injectPageHook();

  // —— content context 监听 page context 抛上来的 URL ——
  window.addEventListener('message', (e) => {
    if (!e.data || !e.data.__cwStream || typeof e.data.url !== 'string') return;
    record(e.data.url, streamType(e.data.url));
  });

  // —— DOM ready 后注入 UI ——
  function whenReady(fn) {
    if (document.body) return fn();
    const obs = new MutationObserver(() => { if (document.body) { obs.disconnect(); fn(); } });
    obs.observe(document.documentElement, { childList: true });
  }

  let panel = null;
  let btn = null;

  whenReady(() => {
    if (window.top !== window) return; // 只在主框架显示按钮，避免广告 iframe 重复注入

    GMx.addStyle(`
      #cw-sender-btn {
        position: fixed !important; right: 20px !important; bottom: 20px !important;
        z-index: 2147483647 !important;
        background: #e74c3c !important; color: white !important; border: none !important;
        border-radius: 999px !important; padding: 10px 16px !important;
        font-size: 14px !important; font-family: -apple-system, sans-serif !important;
        cursor: pointer !important; font-weight: 600 !important;
        box-shadow: 0 4px 16px rgba(0,0,0,0.3) !important;
        user-select: none !important;
      }
      #cw-sender-btn:hover { background: #d63b2d !important; }
      #cw-sender-btn .badge {
        background: white !important; color: #e74c3c !important; border-radius: 10px !important;
        padding: 1px 7px !important; margin-left: 6px !important;
        font-size: 12px !important; font-weight: 700 !important;
      }
      #cw-sender-panel {
        position: fixed !important; right: 20px !important; bottom: 70px !important;
        z-index: 2147483647 !important;
        background: #1f1f1f !important; color: #eee !important;
        border: 1px solid #3a3a3a !important; border-radius: 10px !important;
        width: 380px !important; max-height: 70vh !important;
        font-family: -apple-system, sans-serif !important; font-size: 13px !important;
        box-shadow: 0 8px 32px rgba(0,0,0,0.5) !important;
        overflow: hidden !important; display: flex !important; flex-direction: column !important;
      }
      #cw-sender-panel .head {
        padding: 10px 14px !important; background: #2a2a2a !important;
        border-bottom: 1px solid #3a3a3a !important;
        display: flex !important; align-items: center !important; justify-content: space-between !important;
      }
      #cw-sender-panel .head .title { font-weight: 600 !important; }
      #cw-sender-panel .head .close { cursor: pointer !important; color: #888 !important; padding: 0 4px !important; }
      #cw-sender-panel .body { overflow-y: auto !important; flex: 1 !important; padding: 6px !important; }
      #cw-sender-panel .empty { padding: 30px 14px !important; color: #888 !important; text-align: center !important; line-height: 1.6 !important; }
      #cw-sender-panel .item {
        padding: 8px 10px !important; border-radius: 6px !important; cursor: pointer !important;
        margin: 2px 0 !important; border: 1px solid transparent !important;
      }
      #cw-sender-panel .item:hover { background: #2a2a2a !important; border-color: #3a3a3a !important; }
      #cw-sender-panel .item .type {
        display: inline-block !important; background: #e74c3c !important; color: white !important;
        padding: 1px 6px !important; border-radius: 3px !important; font-size: 11px !important;
        font-weight: 600 !important; margin-right: 6px !important;
      }
      #cw-sender-panel .item .type.mp4 { background: #3498db !important; }
      #cw-sender-panel .item .type.unknown { background: #888 !important; }
      #cw-sender-panel .item .url {
        word-break: break-all !important; color: #ddd !important; font-size: 12px !important;
        font-family: ui-monospace, monospace !important; line-height: 1.4 !important;
      }
      #cw-sender-panel .foot {
        padding: 8px 12px !important; background: #1a1a1a !important;
        border-top: 1px solid #3a3a3a !important;
        font-size: 12px !important; color: #888 !important;
        display: flex !important; justify-content: space-between !important;
      }
      #cw-sender-panel .foot a { color: #e74c3c !important; cursor: pointer !important; }
      #cw-sender-toast {
        position: fixed !important; left: 50% !important; top: 30px !important;
        transform: translateX(-50%) !important;
        background: #1f1f1f !important; color: white !important;
        padding: 10px 18px !important; border-radius: 8px !important;
        z-index: 2147483647 !important;
        font-family: -apple-system, sans-serif !important; font-size: 14px !important;
        box-shadow: 0 4px 16px rgba(0,0,0,0.3) !important;
      }
      #cw-sender-toast.ok { background: #27ae60 !important; }
      #cw-sender-toast.err { background: #e74c3c !important; }
    `);

    btn = document.createElement('button');
    btn.id = 'cw-sender-btn';
    btn.innerHTML = '📺 CoupleWatch <span class="badge">0</span>';
    document.body.appendChild(btn);
    btn.addEventListener('click', togglePanel);

    console.log('[CoupleWatch Sender] 已注入按钮，配置:', cfg);
  });

  function togglePanel() {
    if (panel) { panel.remove(); panel = null; return; }
    panel = document.createElement('div');
    panel.id = 'cw-sender-panel';
    panel.innerHTML = `
      <div class="head">
        <span class="title">📺 抓到的视频流</span>
        <span class="close">✕</span>
      </div>
      <div class="body"></div>
      <div class="foot">
        <span>${escapeHtml(cfg.server.replace(/^https?:\/\//, ''))} · ${cfg.pin ? 'PIN ' + escapeHtml(cfg.pin) : '⚠️ 未设 PIN'}</span>
        <a class="config-btn">配置</a>
      </div>
    `;
    document.body.appendChild(panel);
    panel.querySelector('.close').addEventListener('click', togglePanel);
    panel.querySelector('.config-btn').addEventListener('click', openConfig);
    renderList();
  }

  function renderList() {
    if (!panel) return;
    const body = panel.querySelector('.body');
    if (captured.length === 0) {
      body.innerHTML = `<div class="empty">还没抓到视频流。<br>开始播放视频再回来看。</div>`;
      return;
    }
    body.innerHTML = '';
    for (const item of captured) {
      const div = document.createElement('div');
      div.className = 'item';
      div.innerHTML = `
        <div><span class="type ${item.type}">${item.type.toUpperCase()}</span></div>
        <div class="url">${escapeHtml(item.url)}</div>
      `;
      div.addEventListener('click', () => sendToServer(item));
      body.appendChild(div);
    }
  }

  function updateBadge() {
    if (btn) { const b = btn.querySelector('.badge'); if (b) b.textContent = captured.length; }
    if (panel) renderList();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
  }
  function toast(msg, kind = '') {
    const old = document.getElementById('cw-sender-toast');
    if (old) old.remove();
    const t = document.createElement('div');
    t.id = 'cw-sender-toast';
    if (kind) t.classList.add(kind);
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3500);
  }

  async function openConfig() {
    const server = prompt('CoupleWatch 服务地址（含 https://）', cfg.server);
    if (server === null) return;
    const pin = prompt('房间 PIN（4 位数字）', cfg.pin || '');
    if (pin === null) return;
    cfg.server = server.replace(/\/+$/, '');
    cfg.pin = pin;
    cfg.token = '';
    await GMx.setValue('server', cfg.server);
    await GMx.setValue('pin', cfg.pin);
    await GMx.setValue('token', '');
    toast('配置已保存', 'ok');
    if (panel) { panel.remove(); panel = null; togglePanel(); }
  }

  GMx.registerMenu('⚙️ 设置 CoupleWatch 服务和 PIN', openConfig);

  // 用浏览器原生 fetch（要求 server 开 CORS），跨油猴扩展兼容性最好
  async function gmFetch(method, url, body, headers = {}) {
    console.log('[CW] fetch:', method, url);
    const r = await fetch(url, {
      method,
      mode: 'cors',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data; try { data = await r.json(); } catch { data = { _raw: '' }; }
    console.log('[CW] response:', r.status, data);
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  }

  async function ensureToken() {
    if (cfg.token) return cfg.token;
    if (!cfg.pin) throw new Error('未设置 PIN，点面板「配置」');
    if (!cfg.server) throw new Error('未设置服务地址');
    const data = await gmFetch('POST', cfg.server + '/api/auth', { pin: cfg.pin });
    if (!data.ok) throw new Error(data.error || '鉴权失败');
    cfg.token = data.token;
    await GMx.setValue('token', data.token);
    return data.token;
  }

  async function sendToServer(item) {
    try {
      toast('发送中…');
      let token;
      try { token = await ensureToken(); }
      catch (e) { toast('鉴权失败：' + e.message, 'err'); return; }

      const payload = {
        src: item.url,
        kind: item.type === 'flv' ? 'mp4' : item.type,
        title: document.title || item.url.split('/').pop(),
        original: location.href,
        headers: {
          Referer: location.origin + '/',
          'User-Agent': navigator.userAgent,
        },
        from: location.host,
      };

      let res;
      try {
        res = await gmFetch('POST', cfg.server + '/api/load', payload, {
          'Authorization': 'Bearer ' + token,
        });
      } catch (e) {
        if (/401|Unauth/i.test(e.message)) {
          cfg.token = ''; await GMx.setValue('token', '');
          token = await ensureToken();
          res = await gmFetch('POST', cfg.server + '/api/load', payload, {
            'Authorization': 'Bearer ' + token,
          });
        } else { throw e; }
      }

      if (res.ok) toast(`✅ 已推送：${res.title || ''}`, 'ok');
      else toast('失败：' + (res.error || '未知'), 'err');
    } catch (e) {
      toast('失败：' + e.message, 'err');
    }
  }
})();
