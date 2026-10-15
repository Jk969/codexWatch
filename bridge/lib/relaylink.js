'use strict';
// RelayLink:PC → 云端中继的出站 WebSocket(设备通道),含首次配对码换 token。

const https = require('https');
const http = require('http');
const crypto = require('crypto');
const WebSocket = require('ws');
const { log, logErr } = require('./util');

// 规范化服务器地址:接受 https://host、wss://host[/ws-device] 等写法
function normalizeServer(raw) {
  let s = String(raw || '').replace(/\/+$/, '');
  if (/\/ws-device$/.test(s)) s = s.slice(0, -s.match(/\/ws-device$/)[0].length);
  const httpsBase = s.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:');
  const wsDevice = httpsBase.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:') + '/ws-device';
  return { httpsBase, wsDevice };
}

class RelayLink {
  constructor(hub, config, configStore) {
    this.hub = hub;
    this.cfg = config;          // {server, deviceId, deviceToken, pairCode, name}
    this.store = configStore;   // saveConfig()
    this.ws = null;
    this.sink = null;
    this.backoff = 2000;
    this.status = 'init';
    this.timer = null;
    const n = normalizeServer(config.server);
    this.httpsBase = n.httpsBase;
    this.wsDeviceUrl = n.wsDevice;
    if (config.server !== n.httpsBase) { config.server = n.httpsBase; try { configStore(); } catch {} }
  }

  start() {
    this.pairIfNeeded().then((ok) => {
      if (!ok) { logErr('[relay] 配对失败,60s 后重试(检查 config.json 的 pairCode/server)'); this.schedule(60000); return; }
      this.connect();
    }).catch((e) => { logErr('[relay] pair error', e.message); this.schedule(30000); });
  }

  pairIfNeeded() {
    const cfg = this.cfg;
    if (!cfg.server) return Promise.resolve(false);
    if (cfg.deviceToken) return Promise.resolve(true);
    if (!cfg.pairCode) return Promise.resolve(false);
    return new Promise((resolve) => {
      const body = JSON.stringify({ code: cfg.pairCode.trim(), deviceId: cfg.deviceId, name: cfg.name || require('os').hostname() });
      const u = new URL(this.httpsBase + '/api/pair-device');
      const mod = u.protocol === 'https:' ? https : http;
      const req = mod.request(u, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 15000 }, (res) => {
        let buf = '';
        res.on('data', d => buf += d);
        res.on('end', () => {
          try {
            const j = JSON.parse(buf);
            if (res.statusCode === 200 && j.token) {
              cfg.deviceToken = j.token;
              delete cfg.pairCode;
              this.store();
              log('[relay] 配对成功,设备 token 已保存');
              resolve(true);
            } else { logErr('[relay] 配对被拒:', j.error || res.statusCode); resolve(false); }
          } catch { logErr('[relay] 配对响应异常', res.statusCode); resolve(false); }
        });
      });
      req.on('error', (e) => { logErr('[relay] 配对请求失败', e.message); resolve(false); });
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end(body);
    });
  }

  setStatus(s, extra) {
    this.status = s;
    this.hub.broadcast({ t: 'relay_status', status: s, url: this.cfg.server, error: extra || null, ts: Date.now() });
  }

  schedule(ms) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.start(), ms);
  }

  connect() {
    if (!this.cfg.deviceToken) return;
    const u = new URL(this.wsDeviceUrl);
    u.searchParams.set('token', this.cfg.deviceToken);
    u.searchParams.set('id', this.cfg.deviceId);
    log('[relay] 连接', this.wsDeviceUrl);
    const ws = new WebSocket(u, { handshakeTimeout: 15000, headers: { 'X-CodexWatch-Protocol': '2' } });
    this.ws = ws;

    ws.on('open', () => {
      this.backoff = 2000;
      this.setStatus('connected');
      // 中继通道作为一个 sink 加入广播
      this.sink = this.hub.addSink((frame) => { if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'frame', d: frame })); }, 'relay');
      ws.send(JSON.stringify({ t: 'hello', name: this.cfg.name }));
      // 设备上线即向所有手机端同步全量状态
      ws.send(JSON.stringify({ t: 'frame', d: this.hub.stateFrame() }));
    });

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.t === 'frame' && msg.d) this.hub.handleFrame(msg.d, this.sink || { send: () => {}, label: 'relay-null' });
      else if (msg.t === 'ping') ws.send(JSON.stringify({ t: 'pong' }));
    });

    const drop = (why) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.sink) { this.hub.removeSink(this.sink); this.sink = null; }
      this.setStatus('disconnected', why);
      const wait = Math.min(this.backoff, 60000);
      this.backoff = Math.min(this.backoff * 2, 60000);
      this.schedule(wait);
    };
    ws.on('close', (code, reason) => {
      const why = 'closed ' + code + (reason.length ? ' ' + reason.toString().slice(0, 100) : '');
      log('[relay]', why);
      drop(why);
    });
    ws.on('error', (e) => { logErr('[relay] ws error', e.message); drop(e.message); });

    // 心跳
    let alive=true;
    ws.on('pong',()=>{alive=true;});
    const heartbeat=setInterval(()=>{
      if(ws.readyState!==WebSocket.OPEN)return;
      if(!alive){logErr('[relay] 心跳超时，重建连接');ws.terminate();return;}
      alive=false;ws.ping();
    },25000);
    ws.on('close', () => clearInterval(heartbeat));
  }
}

module.exports = { RelayLink };
