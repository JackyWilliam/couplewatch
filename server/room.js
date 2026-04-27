import { randomBytes } from 'node:crypto';

// 单房间双人模型（异地恋专用）
// host 模型：第一个进房自动当 host；host 离开自动转给下一个；任意人可主动 host-claim 抢
// host 专属操作：play / pause / seek / load / mode / ts 心跳
// 任何人都可以：chat / webrtc 信令 / rename / host-claim / ping
//
// 同步协议借鉴 WatchParty：
//   - host 客户端每秒发 ts {videoTS, paused}，服务端中转给 follower
//   - 服务端记录 lastTs，新人入会回放最近一次状态
//   - 显式 play/pause/seek 同时更新 lastTs，保证 seek 倒退也能正确同步
export class Room {
  constructor() {
    this.clients = new Map();          // ws -> { id, name }
    this.hostId = null;
    this.lastTs = { videoTS: 0, paused: true, at: 0 };
    this.lastLoad = null;              // { src, kind, title, original, headers }
    this.lastMode = 'video';
  }

  add(ws) {
    const id = randomBytes(4).toString('hex');
    const name = `用户${this.clients.size + 1}`;
    this.clients.set(ws, { id, name });
    ws.on('message', (data) => this.onMessage(ws, data));
    ws.on('close', () => this.remove(ws));
    ws.on('error', () => {});

    if (!this.hostId) this.hostId = id;

    this.send(ws, {
      type: 'welcome',
      self: { id, name },
      peers: this.peerList(ws),
      hostId: this.hostId,
      mode: this.lastMode,
      load: this.lastLoad,
      ts: this.lastTs,
    });
    this.broadcast({ type: 'peer-join', peer: { id, name }, hostId: this.hostId }, ws);
    console.log(`[room] +${name} (${id})${id === this.hostId ? ' (host)' : ''}, total=${this.clients.size}`);
  }

  remove(ws) {
    const info = this.clients.get(ws);
    if (!info) return;
    this.clients.delete(ws);

    if (this.hostId === info.id) {
      const next = [...this.clients.values()][0];
      this.hostId = next ? next.id : null;
      if (this.hostId) this.broadcast({ type: 'host-change', hostId: this.hostId });
    }
    this.broadcast({ type: 'peer-leave', peer: info, hostId: this.hostId });
    console.log(`[room] -${info.name} (${info.id}), total=${this.clients.size}, host=${this.hostId}`);
  }

  peerList(exclude) {
    return [...this.clients.entries()]
      .filter(([w]) => w !== exclude)
      .map(([, info]) => info);
  }

  send(ws, obj) {
    if (ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  broadcast(obj, except) {
    const data = JSON.stringify(obj);
    for (const ws of this.clients.keys()) {
      if (ws !== except && ws.readyState === 1) ws.send(data);
    }
  }

  // 油猴脚本/扩展通过 HTTP API 直接推视频，不走 host 校验
  // 服务端记 lastLoad，广播给所有在线 client；离线 client 下次 welcome 时回放
  directLoad(load) {
    this.lastLoad = load;
    this.lastTs = { videoTS: 0, paused: true, at: Date.now() };
    this.broadcast({
      type: 'load',
      src: load.src,
      kind: load.kind,
      title: load.title,
      original: load.original,
      headers: load.headers || {},
      from: { id: 'ext', name: load.from || '油猴脚本' },
    });
  }

  onMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (typeof msg !== 'object' || !msg.type) return;
    const me = this.clients.get(ws);
    if (!me) return;
    const isHost = me.id === this.hostId;

    switch (msg.type) {
      case 'play':
      case 'pause':
      case 'seek':
      case 'load':
      case 'mode': {
        if (!isHost) return;
        if (msg.type === 'load') {
          this.lastLoad = {
            src: msg.src, kind: msg.kind, title: msg.title,
            original: msg.original, headers: msg.headers || {},
          };
          this.lastTs = { videoTS: 0, paused: true, at: Date.now() };
        }
        if (msg.type === 'mode' && (msg.mode === 'video' || msg.mode === 'screen')) {
          this.lastMode = msg.mode;
        }
        if (msg.type === 'play') {
          this.lastTs = { ...this.lastTs, paused: false, at: Date.now() };
        }
        if (msg.type === 'pause') {
          this.lastTs = { ...this.lastTs, paused: true, at: Date.now() };
        }
        if (msg.type === 'seek' && typeof msg.t === 'number') {
          this.lastTs = { ...this.lastTs, videoTS: msg.t, at: Date.now() };
        }
        this.broadcast({ ...msg, from: me }, ws);
        break;
      }

      case 'ts': {
        if (!isHost) return;
        if (typeof msg.videoTS !== 'number') return;
        // 单调递增 + 暂停态变化才更新（过滤网络乱序），但允许 seek 显式打破
        const prev = this.lastTs.videoTS || 0;
        const stateChanged = !!msg.paused !== !!this.lastTs.paused;
        if (msg.videoTS >= prev || stateChanged) {
          this.lastTs = { videoTS: msg.videoTS, paused: !!msg.paused, at: Date.now() };
          this.broadcast({ type: 'ts', videoTS: msg.videoTS, paused: !!msg.paused, from: me }, ws);
        }
        break;
      }

      case 'chat':
      case 'webrtc':
        this.broadcast({ ...msg, from: me }, ws);
        break;

      case 'rename':
        if (typeof msg.name === 'string' && msg.name.length > 0 && msg.name.length <= 20) {
          me.name = msg.name;
          this.broadcast({ type: 'peer-rename', peer: me });
        }
        break;

      case 'host-claim':
        if (this.hostId !== me.id) {
          this.hostId = me.id;
          this.broadcast({ type: 'host-change', hostId: this.hostId });
        }
        break;

      case 'pong':
        break;

      case 'ping':
        this.send(ws, { type: 'pong', t: msg.t });
        break;
    }
  }
}
