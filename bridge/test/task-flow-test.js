// 端到端任务流测试:发起 → 追踪 → 完成通知
const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:3599/ws');
const t0 = Date.now();
const ts = () => '[' + ((Date.now() - t0) / 1000).toFixed(1) + 's]';
let phase = 'wait_state';
let chatId = null;
ws.on('open', () => ws.send(JSON.stringify({ t: 'hello' })));
ws.on('message', d => {
  const f = JSON.parse(d);
  if (f.t === 'state' && phase === 'wait_state') {
    phase = 'submitted';
    ws.send(JSON.stringify({
      t: 'new_task',
      cwd: 'D:\\dev\\gpt\\codexWatch\\tmp-test',
      prompt: '请输出一句话:你好CodexWatch。然后用一句话说明你在哪个目录。不要执行其他操作。',
      sandbox: 'read-only',
      ref: 't1'
    }));
    console.log(ts(), 'new_task sent');
  }
  if (f.t === 'task_submitted') console.log(ts(), 'submitted:', JSON.stringify(f));
  if (f.t === 'chat_update' && f.chat && (f.chat.cwd || '').includes('tmp-test')) {
    chatId = f.chat.id;
    console.log(ts(), 'chat_update:', f.chat.status, '|', (f.chat.title || '').slice(0, 30), '| durable:', f.chat.durable, '| lastMsg:', (f.chat.lastMsg || '').slice(0, 40));
  }
  if (f.t === 'item' && f.chatId === chatId) {
    const it = f.item;
    if (['user', 'agent', 'sys', 'err'].includes(it.k)) console.log(ts(), 'item', it.k, ':', String(it.t || '').slice(0, 70).replace(/\n/g, ' '));
    if (it.k === 'tool') console.log(ts(), 'item tool:', it.name, String(it.args || '').slice(0, 50));
  }
  if (f.t === 'notify') console.log(ts(), 'NOTIFY:', f.d.level, f.d.title, '|', String(f.d.body || '').slice(0, 60));
  if (f.t === 'notify' && f.d.level === 'done') { console.log(ts(), 'DONE — 全链路通过'); process.exit(0); }
});
setTimeout(() => { console.log(ts(), 'TIMEOUT'); process.exit(1); }, 300000);
