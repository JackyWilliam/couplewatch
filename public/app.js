// CoupleWatch · 单文件前端
// 模块：鉴权 → WS 连接 → 同步播放器 / WebRTC 投屏 / 聊天

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const log = (...a) => console.log('[CW]', ...a);

// —— 全局状态 ——
const state = {
  token: null,
  ws: null,
  self: null,        // { id, name }
  peers: [],         // [{ id, name }]
  hostId: null,
  mode: 'video',     // 'video' | 'screen'
  videoLoad: null,   // { src, kind, title, original, headers }
  hls: null,
  pc: null,
  localStream: null,
  iceServers: null,
  reconnectTimer: null,
};
const isHost = () => state.self && state.hostId === state.self.id;

// —— 入口 ——
function init() {
  const saved = sessionStorage.getItem('cw_token');
  if (saved) {
    state.token = saved;
    enterRoom();
    return;
  }
  $('#pin-submit').addEventListener('click', tryAuthFlow);
  $('#pin-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') tryAuthFlow(); });
  $('#pin-input').focus();
}

async function tryAuthFlow() {
  const pin = $('#pin-input').value.trim();
  if (!/^\d{4}$/.test(pin)) {
    $('#pin-error').textContent = '请输入 4 位数字';
    return;
  }
  try {
    const r = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin }),
    });
    const data = await r.json();
    if (!r.ok || !data.ok) throw new Error(data.error || '鉴权失败');
    state.token = data.token;
    sessionStorage.setItem('cw_token', data.token);
    enterRoom();
  } catch (e) {
    $('#pin-error').textContent = e.message;
  }
}

function enterRoom() {
  $('#auth-overlay').classList.add('hidden');
  $('#app').classList.remove('hidden');
  setupTabs();
  setupActions();
  setupChat();
  setupVideoEventForwarding();
  setupFullscreen();
  startTsHeartbeat();
  connectWs();
}

// —— WebSocket ——
let wsHasOpened = false;
function connectWs() {
  if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
  setConn('连接中…', '');
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws?t=${state.token}`);
  state.ws = ws;
  let openedThisRound = false;
  ws.onopen = () => { openedThisRound = true; wsHasOpened = true; log('ws open'); setConn('已连接', 'ok'); };
  ws.onclose = (ev) => {
    log('ws close', ev.code, 'opened=', openedThisRound);
    setConn('已断开 · 重连中', 'err');
    // 从未成功连过 = token 大概率失效（服务端 401 destroy socket）
    if (!openedThisRound && !wsHasOpened) {
      sessionStorage.removeItem('cw_token');
      alert('鉴权失效，请重新输入 PIN');
      location.reload();
      return;
    }
    state.reconnectTimer = setTimeout(connectWs, 2000);
  };
  ws.onerror = (e) => log('ws error', e);
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    handleWs(m);
  };
}

function wsSend(obj) {
  if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify(obj));
}

function setConn(text, kind) {
  const el = $('#conn-status');
  el.textContent = text;
  el.className = 'conn' + (kind ? ' ' + kind : '');
}

// —— 消息分发 ——
function handleWs(msg) {
  switch (msg.type) {
    case 'welcome':
      state.self = msg.self;
      state.peers = msg.peers || [];
      state.hostId = msg.hostId;
      state.mode = msg.mode || 'video';
      updateHeader();
      switchMode(state.mode, false);
      if (msg.load) {
        loadVideo(msg.load, msg.ts);
      }
      addChat(`你（${msg.self.name}）进入房间`, true);
      break;
    case 'peer-join':
      state.peers.push(msg.peer);
      if (msg.hostId) state.hostId = msg.hostId;
      updateHeader();
      addChat(`${msg.peer.name} 进入房间`, true);
      break;
    case 'peer-leave':
      state.peers = state.peers.filter(p => p.id !== msg.peer.id);
      if (msg.hostId) state.hostId = msg.hostId;
      if (state.pc) closePc();
      updateHeader();
      addChat(`${msg.peer.name} 离开了`, true);
      break;
    case 'peer-rename': {
      const p = state.peers.find(x => x.id === msg.peer.id);
      if (p) p.name = msg.peer.name;
      else if (state.self && state.self.id === msg.peer.id) state.self.name = msg.peer.name;
      updateHeader();
      break;
    }
    case 'host-change':
      state.hostId = msg.hostId;
      updateHeader();
      addChat(state.hostId === state.self.id ? '你成为了控制方' : '对方成为了控制方', true);
      break;
    case 'load':
      loadVideo({
        src: msg.src, kind: msg.kind, title: msg.title,
        original: msg.original, headers: msg.headers || {},
      });
      break;
    case 'mode':
      switchMode(msg.mode, false);
      break;
    case 'play':
      if (!isHost()) videoEl().play().catch(() => {});
      break;
    case 'pause':
      if (!isHost()) videoEl().pause();
      break;
    case 'seek':
      if (!isHost() && typeof msg.t === 'number') seekSilent(msg.t);
      break;
    case 'ts':
      if (!isHost()) followHostTs(msg);
      break;
    case 'chat':
      addChat(`${msg.from.name}: ${escapeHtml(msg.text)}`);
      break;
    case 'webrtc':
      handleWebrtcSignal(msg.payload || {});
      break;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
}

// —— UI 更新 ——
function updateHeader() {
  if (!state.self) return;
  $('#me-info').textContent = '我: ' + state.self.name;
  $('#peer-info').textContent = state.peers.length === 0
    ? '独自一人'
    : '对方: ' + state.peers.map(p => p.name).join(', ');
  const me = isHost();
  $('#role-badge').textContent = me ? '控制中' : '观看中';
  $('#role-badge').className = 'badge' + (me ? ' host' : '');
  $('#claim-host').classList.toggle('hidden', me);
}

// —— 模式切换 ——
function switchMode(mode, broadcast = true) {
  state.mode = mode;
  $('#panel-video').classList.toggle('hidden', mode !== 'video');
  $('#panel-screen').classList.toggle('hidden', mode !== 'screen');
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.mode === mode));
  if (broadcast) {
    if (!isHost()) { alert('只有控制方能切换模式'); return; }
    wsSend({ type: 'mode', mode });
  }
}
function setupTabs() {
  $$('.tab').forEach(t => t.addEventListener('click', () => switchMode(t.dataset.mode, true)));
}

// —— 操作按钮 ——
function setupActions() {
  $('#claim-host').addEventListener('click', () => wsSend({ type: 'host-claim' }));
  $('#rename-btn').addEventListener('click', () => {
    const name = prompt('改个昵称', state.self.name);
    if (name && name.trim() && name.length <= 20) wsSend({ type: 'rename', name: name.trim() });
  });
  $('#screen-start').addEventListener('click', startScreenShare);
  $('#screen-stop').addEventListener('click', stopScreenShare);
  $('#url-load').addEventListener('click', urlLoad);
  $('#url-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') urlLoad(); });
}

// —— 聊天 ——
function setupChat() {
  $('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const t = $('#chat-input').value.trim();
    if (!t) return;
    wsSend({ type: 'chat', text: t });
    addChat(`${state.self.name}: ${escapeHtml(t)}`, false, true);
    $('#chat-input').value = '';
  });
}

function addChat(html, system = false, me = false) {
  const div = document.createElement('div');
  div.className = 'chat-line' + (system ? ' system' : '') + (me ? ' me' : '');
  if (system) {
    div.textContent = html;
  } else {
    const idx = html.indexOf(': ');
    if (idx > 0) {
      const who = html.slice(0, idx);
      const text = html.slice(idx + 2);
      div.innerHTML = `<span class="who">${escapeHtml(who)}:</span>${text}`;
    } else {
      div.innerHTML = html;
    }
  }
  const box = $('#chat-messages');
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

// —— 播放器 ——
const SYNC_THRESHOLD = 1.5;
let suppressEventUntil = 0;
function videoEl() { return $('#video'); }
function suppressFor(ms) { suppressEventUntil = Date.now() + ms; }
function suppressed() { return Date.now() < suppressEventUntil; }
function seekSilent(t) {
  suppressFor(800);
  videoEl().currentTime = t;
}

async function urlLoad() {
  const url = $('#url-input').value.trim();
  if (!url) return;
  if (!isHost()) { alert('只有控制方能加载视频；请先点「取得控制权」'); return; }
  $('#url-load').disabled = true;
  $('#url-status').textContent = '解析中…';
  try {
    const r = await fetch('/api/resolve', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + state.token,
      },
      body: JSON.stringify({ url }),
    });
    const data = await r.json();
    if (!r.ok || !data.ok) throw new Error(data.error || '解析失败');
    $('#url-status').textContent = '已加载: ' + data.title;
    const load = {
      src: data.src, kind: data.kind, title: data.title,
      original: url, headers: data.headers || {},
    };
    loadVideo(load);
    wsSend({ type: 'load', ...load });
  } catch (e) {
    $('#url-status').textContent = '失败: ' + e.message;
  } finally {
    $('#url-load').disabled = false;
  }
}

function loadVideo(load, ts) {
  state.videoLoad = load;
  $('#video-title').textContent = load.title || '';
  if (state.hls) { try { state.hls.destroy(); } catch {} state.hls = null; }
  const v = videoEl();
  v.pause();
  v.removeAttribute('src');
  v.load();

  const proxied = buildProxyUrl(load.src, load.headers);
  const wantHls = load.kind === 'hls' || /\.m3u8(\?|$)/i.test(load.src);

  if (wantHls && window.Hls && window.Hls.isSupported()) {
    state.hls = new Hls({ enableWorker: true });
    state.hls.loadSource(proxied);
    state.hls.attachMedia(v);
  } else if (wantHls && v.canPlayType('application/vnd.apple.mpegurl')) {
    v.src = proxied;
  } else {
    v.src = proxied;
  }

  if (ts && typeof ts.videoTS === 'number' && ts.videoTS > 0) {
    const onMeta = () => {
      seekSilent(ts.videoTS);
      if (!ts.paused) v.play().catch(() => {});
    };
    v.addEventListener('loadedmetadata', onMeta, { once: true });
  }
}

function buildProxyUrl(src, headers = {}) {
  const params = new URLSearchParams({
    url: src,
    ref: headers.Referer || '',
    ua: headers['User-Agent'] || '',
    t: state.token,
  });
  // 用绝对 URL：Safari 的 hls.js 在解析时 new URL(src) 不接受纯相对路径
  return location.origin + '/api/proxy?' + params.toString();
}

function followHostTs(msg) {
  const v = videoEl();
  if (!v.src && !state.hls) return;
  if (msg.paused && !v.paused) { suppressFor(500); v.pause(); }
  if (!msg.paused && v.paused) { suppressFor(500); v.play().catch(() => {}); }
  const diff = Math.abs(v.currentTime - msg.videoTS);
  if (diff > SYNC_THRESHOLD) seekSilent(msg.videoTS);
}

let tsHeartbeat = null;
function startTsHeartbeat() {
  if (tsHeartbeat) clearInterval(tsHeartbeat);
  tsHeartbeat = setInterval(() => {
    if (!isHost()) return;
    const v = videoEl();
    if (!v.src && !state.hls) return;
    if (Number.isNaN(v.currentTime)) return;
    wsSend({ type: 'ts', videoTS: v.currentTime, paused: v.paused });
  }, 1000);
}

function setupVideoEventForwarding() {
  const v = videoEl();
  v.addEventListener('play', () => {
    if (isHost() && !suppressed()) wsSend({ type: 'play' });
  });
  v.addEventListener('pause', () => {
    if (isHost() && !suppressed()) wsSend({ type: 'pause' });
  });
  v.addEventListener('seeked', () => {
    if (isHost() && !suppressed()) wsSend({ type: 'seek', t: v.currentTime });
  });
}

// —— 全屏支持 ——
function toggleFullscreen(el) {
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  } else {
    const req = el.requestFullscreen || el.webkitRequestFullscreen || el.webkitEnterFullscreen;
    if (req) req.call(el);
  }
}

function currentVideoEl() {
  return state.mode === 'screen' ? $('#remote-video') : $('#video');
}

function setupFullscreen() {
  // 双击视频全屏
  $('#video').addEventListener('dblclick', (e) => { e.preventDefault(); toggleFullscreen($('#video')); });
  $('#remote-video').addEventListener('dblclick', (e) => { e.preventDefault(); toggleFullscreen($('#remote-video')); });

  // F 键快捷键全屏（聚焦在输入框时不触发）
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'f' && e.key !== 'F') return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    e.preventDefault();
    toggleFullscreen(currentVideoEl());
  });
}

// —— WebRTC 投屏 ——
async function fetchIceServers() {
  if (state.iceServers) return state.iceServers;
  const r = await fetch('/api/turn', {
    headers: { 'Authorization': 'Bearer ' + state.token },
  });
  const data = await r.json();
  state.iceServers = data.iceServers || [];
  if (data.warn) log('TURN warn:', data.warn);
  log('ICE servers:', state.iceServers, 'source:', data.source);
  return state.iceServers;
}

async function startScreenShare() {
  if (state.peers.length === 0) {
    alert('对方还没进房，等他/她进来再投屏');
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 60 } },
      audio: true,
    });
  } catch (e) {
    log('getDisplayMedia 失败', e);
    alert('未能获取屏幕：' + e.message);
    return;
  }
  state.localStream = stream;
  $('#screen-start').classList.add('hidden');
  $('#screen-stop').classList.remove('hidden');
  $('#screen-status').textContent = '正在投屏…';
  $('#screen-tip').classList.add('hidden');

  await ensurePc();
  for (const t of stream.getTracks()) {
    state.pc.addTrack(t, stream);
  }
  const offer = await state.pc.createOffer();
  await state.pc.setLocalDescription(offer);
  wsSend({ type: 'webrtc', payload: { kind: 'offer', sdp: offer } });

  stream.getVideoTracks()[0].onended = () => stopScreenShare();
}

function stopScreenShare() {
  if (state.localStream) {
    state.localStream.getTracks().forEach(t => t.stop());
    state.localStream = null;
  }
  closePc();
  $('#screen-start').classList.remove('hidden');
  $('#screen-stop').classList.add('hidden');
  $('#screen-status').textContent = '未在投屏';
  $('#screen-tip').classList.remove('hidden');
  wsSend({ type: 'webrtc', payload: { kind: 'bye' } });
}

async function ensurePc() {
  if (state.pc) return state.pc;
  const iceServers = await fetchIceServers();
  state.pc = new RTCPeerConnection({ iceServers });
  state.pc.ontrack = (ev) => {
    $('#remote-video').srcObject = ev.streams[0];
    $('#screen-status').textContent = '正在接收对方屏幕';
    $('#screen-tip').classList.add('hidden');
    if (state.mode !== 'screen') switchMode('screen', false);
  };
  state.pc.onicecandidate = (ev) => {
    if (ev.candidate) {
      wsSend({ type: 'webrtc', payload: { kind: 'ice', candidate: ev.candidate } });
    }
  };
  state.pc.onconnectionstatechange = () => {
    log('pc state:', state.pc && state.pc.connectionState);
  };
  return state.pc;
}

function closePc() {
  if (state.pc) { try { state.pc.close(); } catch {} state.pc = null; }
  $('#remote-video').srcObject = null;
  $('#screen-status').textContent = '未在投屏';
  $('#screen-tip').classList.remove('hidden');
}

async function handleWebrtcSignal(p) {
  if (p.kind === 'offer') {
    await ensurePc();
    await state.pc.setRemoteDescription(p.sdp);
    const ans = await state.pc.createAnswer();
    await state.pc.setLocalDescription(ans);
    wsSend({ type: 'webrtc', payload: { kind: 'answer', sdp: ans } });
  } else if (p.kind === 'answer') {
    if (state.pc) await state.pc.setRemoteDescription(p.sdp);
  } else if (p.kind === 'ice') {
    if (state.pc && p.candidate) {
      try { await state.pc.addIceCandidate(p.candidate); } catch (e) { log('ice add err', e); }
    }
  } else if (p.kind === 'bye') {
    closePc();
  }
}

init();
