// 远程端到端:公网用户 WS 发起任务 → PC 执行 → 远程收到完成通知
const WebSocket = require('ws');
const https = require('https');

function post(path, body, tok) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request('https://pcphone.jingxixi.top' + path, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, tok ? { Authorization: 'Bearer ' + tok } : {}),
      timeout: 15000,
    }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve({ code: res.statusCode, json: JSON.parse(b) }); } catch { resolve({ code: res.statusCode, json: {} }); } }); });
    req.on('error', reject);
    req.end(data);
  });
}

(async () => {
  const t0 = Date.now();
  const ts = () => '[' + ((Date.now() - t0) / 1000).toFixed(1) + 's]';
  const login = await post('/api/login', { name: 'admin', password: process.argv[2] });
  if (!login.json.token) throw new Error('login failed: ' + JSON.stringify(login.json));
  console.log(ts(), '远程登录 OK');

  const ws = new WebSocket('wss://pcphone.jingxixi.top/ws?token=' + login.json.token);
  let deviceId = null, chatId = null, done = false;
  ws.on('open', async () => {
    console.log(ts(), '远程 WS 已连接(模拟手机前台服务)');
    // 等设备列表到达后再发任务
  });
  ws.on('message', async (d) => {
    const m = JSON.parse(d.toString());
    if (m.t === 'devices') {
      deviceId = (m.devices.find(x => x.online) || {}).id;
      console.log(ts(), '设备列表:', m.devices.map(x => x.name + ':' + x.online).join(','), '选中', deviceId);
      const r = await post('/api/health', {});
      ws.send(JSON.stringify({ t: 'dev_frame', deviceId, d: { t: 'new_task', cwd: 'D:\\dev\\gpt\\codexWatch\\tmp-test', prompt: '输出一句话:远程任务测试OK。', sandbox: 'read-only', ref: 'r1' } }));
      console.log(ts(), '已从公网发起任务');
    }
    if (m.t === 'dev_frame' && m.d) {
      const f = m.d;
      if (f.t === 'state') console.log(ts(), '收到 state:', f.chats.length, '个任务');
      if (f.t === 'chat_update' && (f.chat.cwd || '').includes('tmp-test')) {
        chatId = f.chat.id;
        console.log(ts(), 'chat_update:', f.chat.status, '| durable:', f.chat.durable, '|', (f.chat.lastMsg || '').slice(0, 40));
      }
      if (f.t === 'notify') {
        console.log(ts(), '★ 远程通知:', f.d.level, '|', f.d.title.slice(0, 26), '|', String(f.d.body || '').slice(0, 50));
        if (f.d.level === 'done') { console.log(ts(), '=== 远程端到端全链路通过 ==='); done = true; process.exit(0); }
      }
    }
  });
  setTimeout(() => { console.log(ts(), done ? 'DONE' : 'TIMEOUT'); process.exit(done ? 0 : 1); }, 300000);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
