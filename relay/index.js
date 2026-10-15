'use strict';
// CodexWatch Relay —— 云端中继(单进程 Node,依赖仅 ws)。
// 职责:用户账号(邀请码注册)/ 设备配对 / 客户端⇄设备消息路由 / 离线通知暂存 / 托管 Web UI。
// 监听 127.0.0.1:35500,由 nginx(pcphone.jingxixi.top)反代 443。

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { pingConnections } = require('./heartbeat');

const PORT = parseInt(process.env.PORT || '35500', 10);
const DATA_DIR = process.env.CODEXWATCH_DATA_DIR || path.join(__dirname, 'data');
const NOTIFY_TTL = 24 * 3600e3;
const NOTIFY_CAP = 50;
const TOKEN_TTL = 30 * 24 * 3600e3;   // 登录 token 30 天滑动有效期
const WEB_ROOT_NORM = path.normalize(process.env.WEB_ROOT || path.join(__dirname, '..', 'web'));
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------------- 存储 ----------------
const dbFile = path.join(DATA_DIR, 'relay.json');
let db = { users: [], tokens: {}, devices: [], pairs: [], invites: [], pairCodes: [], queue: {} };
function load() { try { db = Object.assign(db, JSON.parse(fs.readFileSync(dbFile, 'utf8'))); } catch {} }
function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = dbFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
    fs.renameSync(tmp, dbFile);
    try { fs.chmodSync(dbFile, 0o600); } catch {}
  } catch (e) { log('save err', e.message); }
}
load();
// 旧版 token 值是纯 userId 字符串,统一迁移为 { uid, ts }(自迁移时刻起算 30 天)
(function migrateTokens() {
  let dirty = false;
  for (const t of Object.keys(db.tokens)) {
    const v = db.tokens[t];
    if (typeof v === 'string') { db.tokens[t] = { uid: v, ts: Date.now() }; dirty = true; }
  }
  if (dirty) { save(); log('token 存储已迁移到带有效期格式'); }
})();

function tokenUid(t) {
  const e = db.tokens[t];
  if (!e) return null;
  if (typeof e === 'string') return e;                       // 兼容迁移前的写入
  if (Date.now() - e.ts > TOKEN_TTL) { delete db.tokens[t]; saveSoon(); return null; }
  // 滑动续期：每小时最多落盘一次，避免每个请求都重写整个 relay.json。
  if (Date.now() - e.ts > 3600e3) { e.ts = Date.now(); saveSoon(); }
  return e.uid;
}

function uuid() { return crypto.randomUUID(); }
function token() { return crypto.randomBytes(24).toString('hex'); }
function hashPw(pw, salt) {
  salt = salt || crypto.randomBytes(8).toString('hex');
  const h = crypto.scryptSync(String(pw), salt, 32).toString('hex');
  return salt + ':' + h;
}
function checkPw(pw, stored) {
  try {
    const [s, h] = String(stored).split(':');
    const actual = crypto.scryptSync(String(pw ?? ''), s, 32);
    const expected = Buffer.from(h, 'hex');
    return expected.length === actual.length && crypto.timingSafeEqual(actual, expected);   // 常数时间比较
  } catch { return false; }
}
// 生成当前未被占用的 6 位配对码：重复时设备会被绑到先生成该码的用户名下。
function newPairCode() {
  for (;;) {
    const code = String(crypto.randomInt(100000, 1000000));
    if (!db.pairCodes.some(p => p.code === code)) return code;
  }
}
function revokeUserTokens(uid, keep) {
  for (const t of Object.keys(db.tokens)) {
    const e = db.tokens[t];
    if ((typeof e === 'string' ? e : e && e.uid) === uid && t !== keep) delete db.tokens[t];
  }
}
// reset-password.js 写入的待处理重置：中继运行时不能直接改 relay.json（会被内存数据覆盖）。
const resetFile = path.join(DATA_DIR, 'pending-resets.json');
function applyPendingResets() {
  let list;
  try { list = JSON.parse(fs.readFileSync(resetFile, 'utf8')); } catch { return; }
  try { fs.rmSync(resetFile, { force: true }); } catch {}
  let changed = false;
  for (const r of Array.isArray(list) ? list : []) {
    const user = db.users.find(u => u.name === r.name);
    if (!user || typeof r.pw !== 'string' || !r.pw.includes(':')) continue;
    user.pw = r.pw;
    revokeUserTokens(user.id);
    for (const ws of userSocks.get(user.id) || []) { try { ws.close(4001, 'password reset'); } catch {} }
    changed = true;
    log('已应用密码重置', user.name);
  }
  if (changed) save();
}
function cleanOld() {
  const now = Date.now();
  db.pairCodes = db.pairCodes.filter(p => p.expiresAt > now);
  for (const t of Object.keys(db.tokens)) {
    const e = db.tokens[t];
    if (!e || (typeof e !== 'string' && now - e.ts > TOKEN_TTL)) delete db.tokens[t];
  }
  for (const k of [...fails.keys()]) { const f = fails.get(k); if (f.lockUntil < now && now - f.ts > 600e3) fails.delete(k); }
  if (fails.size > 10000) { for (const k of [...fails.keys()].slice(0, fails.size - 5000)) fails.delete(k); }
  for (const uid of Object.keys(db.queue)) {
    db.queue[uid] = db.queue[uid].filter(n => now - n.ts < NOTIFY_TTL);
    if (!db.queue[uid].length) delete db.queue[uid];
  }
}

// ---------------- 首次启动引导 ----------------
function bootstrap() {
  if (db.users.length) return;
  const pw = crypto.randomBytes(6).toString('base64url');
  const invite = crypto.randomBytes(4).toString('hex');
  const admin = { id: uuid(), name: 'admin', pw: hashPw(pw), role: 'admin', createdAt: Date.now() };
  db.users.push(admin);
  db.invites.push({ code: invite, createdBy: admin.id, createdAt: Date.now(), note: '初始邀请码' });
  save();
  const out = `\n========== CodexWatch 首次启动 ==========
管理员账号: admin
管理员密码: ${pw}
注册邀请码: ${invite}
(已写入 data/bootstrap.txt,请妥善保管)
==========================================\n`;
  console.log(out);
  try { fs.writeFileSync(path.join(DATA_DIR, 'bootstrap.txt'), `admin / ${pw}\ninvite: ${invite}\n`); } catch {}
}
bootstrap();

// ---------------- 在线连接表 ----------------
const userSocks = new Map();  // userId -> Set<ws>
const sockById = new Map();   // 连接编号 -> ws（设备回执定向发送）
const devSocks = new Map();   // deviceId -> ws
const sockUser = new Map();   // ws -> {userId}
const sockDev = new Map();    // ws -> {deviceId}

function userDeviceIds(userId) {
  return db.pairs.filter(p => p.userId === userId).map(p => p.deviceId);
}
function deviceUserIds(deviceId) {
  return db.pairs.filter(p => p.deviceId === deviceId).map(p => p.userId);
}
function sendWs(ws, obj) { if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch {} } }
function pushDevices(userId) {
  const set = userSocks.get(userId);
  if (!set) return;
  const list = userDeviceIds(userId).map(id => {
    const d = db.devices.find(x => x.id === id) || {};
    return { id, name: d.name || '未命名设备', online: devSocks.has(id), lastSeen: d.lastSeen || null, pairedAt: d.createdAt };
  });
  for (const ws of set) sendWs(ws, { t: 'devices', devices: list });
}
function pushDevicesOf(deviceId) { for (const uid of deviceUserIds(deviceId)) pushDevices(uid); }

function queueNotify(userId, frame, deviceId) {
  db.queue[userId] = db.queue[userId] || [];
  db.queue[userId].push({ frame, ts: Date.now(), deviceId });
  if (db.queue[userId].length > NOTIFY_CAP) db.queue[userId].splice(0, db.queue[userId].length - NOTIFY_CAP);
}
let saveTimer = null;
function saveSoon() { if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; save(); }, 2000); }

// ---------------- HTTP API ----------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };

// 真实客户端 IP:nginx 在本机回环,取 X-Forwarded-For 最后一项(由我们的 nginx 追加,可信)
function clientIp(req) {
  const ra = req.socket.remoteAddress || '';
  if (ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1') {
    const parts = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return ra;
}
// 失败次数限速(登录/注册/配对码防暴力猜解):10 分钟滑动窗口,达上限后锁定
const fails = new Map(); // key -> {n, ts, lockUntil}
function isLocked(key) {
  const f = fails.get(key);
  return !!(f && f.lockUntil > Date.now());
}
function noteFail(key, max, lockMs) {
  const now = Date.now();
  const f = fails.get(key) || { n: 0, ts: now, lockUntil: 0 };
  if (now - f.ts > 600e3) { f.n = 0; f.ts = now; }
  f.n++;
  if (f.n >= max) { f.lockUntil = now + lockMs; f.n = 0; f.ts = now; }
  fails.set(key, f);
}

function json(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(JSON.stringify(obj));
}
function readBody(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    let buf = ''; let over = false;
    req.on('data', d => { buf += d; if (buf.length > limit) { over = true; req.destroy(); reject(new Error('too large')); } });
    req.on('end', () => { if (!over) { try { resolve(JSON.parse(buf || '{}')); } catch { reject(new Error('bad json')); } } });
    req.on('error', reject);
  });
}
function authUser(req) {
  const m = /Bearer\s+(\S+)/i.exec(req.headers.authorization || '');
  if (!m) return null;
  const uid = tokenUid(m[1]);
  if (!uid) return null;
  const user = db.users.find(u => u.id === uid);
  return user ? { user, token: m[1] } : null;
}

const server = http.createServer(async (req, res) => {
  const u = (req.url || '/').split('?')[0];
  try {
    if (req.method === 'OPTIONS') { json(res, 204, {}); return; }
    if (u === '/api/health') return json(res, 200, { ok: true, ts: Date.now() });
    if (u.startsWith('/api/')) {
      // 注册
      if (u === '/api/register' && req.method === 'POST') {
        const b = await readBody(req);
        if (isLocked('reg:' + clientIp(req))) return json(res, 429, { error: '尝试过于频繁,请稍后再试' });
        const inv = db.invites.find(i => i.code === String(b.invite || '').trim() && !i.usedBy);
        if (!inv) { noteFail('reg:' + clientIp(req), 20, 600e3); return json(res, 400, { error: '邀请码无效或已被使用' }); }
        const name = String(b.name || '').trim();
        const pw = String(b.password || '');
        if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]{2,20}$/.test(name)) return json(res, 400, { error: '昵称需 2-20 位(字母数字下划线中文)' });
        if (pw.length < 8) return json(res, 400, { error: '密码至少 8 位' });
        if (db.users.find(x => x.name === name)) return json(res, 400, { error: '昵称已存在' });
        fails.delete('reg:' + clientIp(req));
        const user = { id: uuid(), name, pw: hashPw(pw), role: 'member', createdAt: Date.now() };
        db.users.push(user);
        inv.usedBy = user.id; inv.usedAt = Date.now();
        const t = token(); db.tokens[t] = { uid: user.id, ts: Date.now() };
        save();
        return json(res, 200, { token: t, user: { id: user.id, name: user.name, role: user.role } });
      }
      // 登录
      if (u === '/api/login' && req.method === 'POST') {
        const b = await readBody(req);
        const ip = clientIp(req);
        if (isLocked('login:' + ip)) return json(res, 429, { error: '尝试过于频繁,请稍后再试' });
        const user = db.users.find(x => x.name === String(b.name || '').trim());
        if (!user || !checkPw(b.password, user.pw)) {
          noteFail('login:' + ip, 10, 600e3);
          log('login fail', user ? 'pw' : 'name', ip);
          return json(res, 401, { error: '账号或密码错误' });
        }
        fails.delete('login:' + ip);
        const t = token(); db.tokens[t] = { uid: user.id, ts: Date.now() };
        save();
        return json(res, 200, { token: t, user: { id: user.id, name: user.name, role: user.role } });
      }
      // 设备配对(桥接端调用,凭一次性配对码,无需用户登录态)
      if (u === '/api/pair-device' && req.method === 'POST') {
        const b = await readBody(req);
        const pip = clientIp(req);
        if (isLocked('pair:' + pip)) return json(res, 429, { error: '尝试过于频繁,请稍后再试' });
        cleanOld();
        const pc = db.pairCodes.find(p => p.code === String(b.code || '').trim() && p.expiresAt > Date.now());
        if (!pc) { noteFail('pair:' + pip, 20, 600e3); log('pair fail', pip); return json(res, 400, { error: '配对码无效或已过期' }); }
        if (!b.deviceId || !String(b.deviceId).match(/^[0-9a-fA-F-]{8,64}$/)) return json(res, 400, { error: 'deviceId 非法' });
        fails.delete('pair:' + pip);
        let dev = db.devices.find(d => d.id === b.deviceId);
        const isNew = !dev;
        if (isNew) dev = { id: b.deviceId, createdAt: Date.now() };
        dev.name = String(b.name || '我的电脑').slice(0, 40);
        dev.token = token();
        dev.lastSeen = Date.now();
        if (isNew) db.devices.push(dev);
        const pair = db.pairs.find(p => p.userId === pc.userId && p.deviceId === dev.id);
        if (!pair) db.pairs.push({ userId: pc.userId, deviceId: dev.id, role: 'owner', at: Date.now() });
        db.pairCodes = db.pairCodes.filter(p => p !== pc);
        save();
        pushDevicesOf(dev.id);
        log('设备配对', dev.id.slice(0, 8), dev.name, 'by user', pc.userId.slice(0, 8));
        return json(res, 200, { token: dev.token, device: { id: dev.id, name: dev.name } });
      }
      const au = authUser(req);
      if (!au) return json(res, 401, { error: '未登录' });
      // 我的信息
      if (u === '/api/me') return json(res, 200, { user: { id: au.user.id, name: au.user.name, role: au.user.role } });
      // 修改自己的密码
      if (u === '/api/change-password' && req.method === 'POST') {
        const b = await readBody(req);
        if (!checkPw(b.oldPassword, au.user.pw)) return json(res, 400, { error: '原密码错误' });
        if (String(b.newPassword || '').length < 8) return json(res, 400, { error: '新密码至少 8 位' });
        au.user.pw = hashPw(b.newPassword);
        // 改密后其他设备上的旧登录全部失效，只保留当前会话。
        revokeUserTokens(au.user.id, au.token);
        for (const ws of userSocks.get(au.user.id) || []) if (ws.cwToken !== au.token) { try { ws.close(4001, 'password changed'); } catch {} }
        save();
        return json(res, 200, { ok: true });
      }
      // 退出登录：服务端同时作废 token
      if (u === '/api/logout' && req.method === 'POST') {
        delete db.tokens[au.token];
        for (const ws of userSocks.get(au.user.id) || []) if (ws.cwToken === au.token) { try { ws.close(4001, 'logout'); } catch {} }
        save();
        return json(res, 200, { ok: true });
      }
      // 设备列表
      if (u === '/api/devices') {
        const list = userDeviceIds(au.user.id).map(id => {
          const d = db.devices.find(x => x.id === id) || {};
          return { id, name: d.name || '未命名设备', online: devSocks.has(id), lastSeen: d.lastSeen, pairedAt: d.createdAt };
        });
        return json(res, 200, { devices: list });
      }
      // 生成设备配对码
      if (u === '/api/pair-code' && req.method === 'POST') {
        cleanOld();
        const code = newPairCode();
        db.pairCodes.push({ code, userId: au.user.id, expiresAt: Date.now() + 10 * 60e3 });
        save();
        return json(res, 200, { code, expiresAt: Date.now() + 10 * 60e3 });
      }
      // 管理员:邀请码
      if (u === '/api/invites') {
        if (au.user.role !== 'admin') return json(res, 403, { error: '需要管理员权限' });
        if (req.method === 'POST') {
          const b = await readBody(req);
          const code = crypto.randomBytes(4).toString('hex');
          db.invites.push({ code, createdBy: au.user.id, createdAt: Date.now(), note: String(b.note || '').slice(0, 50) });
          save();
          return json(res, 200, { code });
        }
        const list = db.invites.slice(-30).map(i => ({
          code: i.code, note: i.note || '', createdAt: i.createdAt,
          used: !!(i.usedBy), usedBy: (db.users.find(x => x.id === i.usedBy) || {}).name || null,
        }));
        return json(res, 200, { invites: list });
      }
      return json(res, 404, { error: 'not found' });
    }
    // 静态 Web UI(先剥 ..,再 normalize + 前缀校验,双保险防目录逃逸)
    let file = u === '/' ? '/index.html' : u;
    file = file.replace(/\.\./g, '');
    const full = path.normalize(path.join(WEB_ROOT_NORM, file));
    if (full !== WEB_ROOT_NORM && !full.startsWith(WEB_ROOT_NORM + path.sep)) { res.writeHead(404); return res.end('not found'); }
    fs.readFile(full, (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  } catch (e) {
    try { json(res, 500, { error: e.message }); } catch {}
  }
});

// ---------------- WebSocket ----------------
const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
server.on('upgrade', (req, sock, head) => {
  const u = (req.url || '').split('?')[0];
  if (u !== '/ws' && u !== '/ws-device') { sock.destroy(); return; }
  const q = new URL(req.url, 'http://x').searchParams;
  const t = q.get('token') || '';
  if (u === '/ws') {
    const uid = tokenUid(t);
    if (!uid) { sock.destroy(); return; }
    wss.handleUpgrade(req, sock, head, ws => { ws.cwToken = t; onUserWs(ws, uid, q.get('power') === 'balanced'); });
  } else {
    const dev = db.devices.find(d => d.token === t);
    if (!dev) { sock.destroy(); return; }
    dev.lastSeen = Date.now(); saveSoon();
    const protocol = req.headers['x-codexwatch-protocol'] === '2' ? 2 : 1;
    wss.handleUpgrade(req, sock, head, ws => onDevWs(ws, dev.id, protocol));
  }
});

function onUserWs(ws, userId, balanced) {
  const user = db.users.find(x => x.id === userId);
  if (!user) { ws.close(); return; }
  // 新 APK 降低锁屏心跳频率，旧版和电脑端维持原有协议。
  ws.cwHeartbeatMs = balanced ? 120000 : 25000;
  ws.cwLastPing = Date.now();
  ws.cwId = crypto.randomBytes(9).toString('base64url');
  sockById.set(ws.cwId, ws);
  sockUser.set(ws, userId);
  if (!userSocks.has(userId)) userSocks.set(userId, new Set());
  userSocks.get(userId).add(ws);
  log('用户上线', user.name);
  sendWs(ws, { t: 'authed', user: { id: user.id, name: user.name, role: user.role }, server: { time: Date.now() } });
  pushDevices(userId);
  // 排空离线通知
  cleanOld();
  const q = db.queue[userId] || [];
  if (q.length) {
    // 带上来源设备，客户端和 APK 才能准确定位聊天/匹配免打扰。
    for (const n of q) sendWs(ws, Object.assign({ queued: true }, n.deviceId ? { deviceId: n.deviceId } : {}, n.frame));
    db.queue[userId] = [];
    saveSoon();
  }
  ws.on('message', data => {
    let m; try { m = JSON.parse(data.toString()); } catch { return; }
    // 页面可能复用已连接的原生服务，错过最初设备快照；兼容旧版心跳补发列表。
    if (m.t === 'get_devices' || m.t === 'ping') {
      if(m.t==='ping')sendWs(ws,{t:'pong'});
      pushDevices(userId);return;
    }
    if (m.t === 'create_pair') {
      cleanOld();
      const code = newPairCode();
      db.pairCodes.push({ code, userId, expiresAt: Date.now() + 10 * 60e3 });
      save();
      return sendWs(ws, { t: 'pair_code', code, expiresAt: Date.now() + 10 * 60e3 });
    }
    if (m.t === 'dev_frame') {
      // 只能发到自己账号配对过的设备,防止越权操控他人电脑
      if (!m.deviceId || !userDeviceIds(userId).includes(m.deviceId)) {
        return sendWs(ws, { t: 'dev_frame', deviceId: m.deviceId, d: { t: 'err', ref: m.d && m.d.ref, error: '设备不存在或未配对' } });
      }
      const dws = devSocks.get(m.deviceId);
      // 设备连接正在关闭时（close 事件尚未触发）也按离线处理，否则请求会被静默丢弃、手机端只能等超时。
      if (dws && dws.readyState === 1) sendWs(dws, { t: 'frame', d: m.d, from: ws.cwId });
      else sendWs(ws, { t: 'dev_frame', deviceId: m.deviceId, d: { t: 'err', ref: m.d && m.d.ref, error: '设备不在线' } });
      return;
    }
  });
  const bye = () => {
    sockUser.delete(ws);
    sockById.delete(ws.cwId);
    const set = userSocks.get(userId);
    if (set) { set.delete(ws); if (!set.size) userSocks.delete(userId); }
  };
  ws.on('close', bye); ws.on('error', bye);
}

function onDevWs(ws, deviceId, protocol) {
  const dev = db.devices.find(d => d.id === deviceId);
  if (!dev) { ws.close(); return; }
  const old = devSocks.get(deviceId);
  // 旧守护进程会永久重连；新版在线时禁止旧版抢占，否则附件每几秒断一次。
  if (old && old.readyState === 1 && old.cwProtocol > protocol) {
    ws.close(4009, 'newer bridge is already online');
    return;
  }
  ws.cwProtocol = protocol;
  if (old && old !== ws && old.readyState === 1) { try { old.close(); } catch {} }
  devSocks.set(deviceId, ws);
  sockDev.set(ws, deviceId);
  dev.lastSeen = Date.now(); saveSoon();
  log('设备上线', dev.name, deviceId.slice(0, 8));
  sendWs(ws, { t: 'authed', device: { id: dev.id, name: dev.name } });
  pushDevicesOf(deviceId);
  ws.on('message', data => {
    let m; try { m = JSON.parse(data.toString()); } catch { return; }
    if (m.t === 'ping') return sendWs(ws, { t: 'pong' });
    if (m.t === 'hello') { dev.name = String(m.name || dev.name).slice(0, 40); saveSoon(); pushDevicesOf(deviceId); return; }
    if (m.t === 'frame' && m.d) {
      dev.lastSeen = Date.now();
      const uids = deviceUserIds(deviceId);
      // 定向回执：只发给发起请求的连接，且该连接的用户仍与此设备配对。
      if (typeof m.to === 'string') {
        const target = sockById.get(m.to);
        if (target && uids.includes(sockUser.get(target))) sendWs(target, { t: 'dev_frame', deviceId, d: m.d });
        return;
      }
      for (const uid of uids) {
        const set = userSocks.get(uid);
        const frame = { t: 'dev_frame', deviceId, d: m.d };
        if (set && set.size) { for (const s of set) sendWs(s, frame); }
        else if (m.d.t === 'notify') { queueNotify(uid, m.d, deviceId); saveSoon(); }
      }
      return;
    }
  });
  const bye = () => {
    sockDev.delete(ws);
    if (devSocks.get(deviceId) !== ws) return; // 已被新连接替换，不能再推送离线状态。
    devSocks.delete(deviceId);
    dev.lastSeen = Date.now(); saveSoon();
    pushDevicesOf(deviceId);
    log('设备离线', dev.name);
  };
  ws.on('close', bye); ws.on('error', bye);
}

setInterval(() => pingConnections(wss.clients, Date.now()), 5000);
applyPendingResets();
setInterval(applyPendingResets, 5000).unref();
setInterval(cleanOld, 600e3).unref();

server.listen(PORT, '127.0.0.1', () => log(`CodexWatch relay listening 127.0.0.1:${PORT}`));
process.on('uncaughtException', e => log('uncaught', e.stack || e.message));
// systemctl restart/stop 时把 2 秒防抖内尚未落盘的数据写入，避免丢失最近的设备/通知状态。
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { if (saveTimer) { clearTimeout(saveTimer); save(); } process.exit(0); });
