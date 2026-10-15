// 交互式任务测试:app-server 会话 + 命令审批 + 打断
const WebSocket = require('ws');
const fs = require('fs');
const ws = new WebSocket('ws://127.0.0.1:3599/ws');
const t0 = Date.now();
const ts = () => '[' + ((Date.now() - t0) / 1000).toFixed(1) + 's]';
let phase = 0, chatId = null, interactiveOk = false;

fs.mkdirSync('D:\\dev\\gpt\\codexWatch\\tmp-appr', { recursive: true });

ws.on('open', () => ws.send(JSON.stringify({ t: 'hello' })));
ws.on('message', d => {
  const f = JSON.parse(d);
  if (f.t === 'state' && phase === 0) {
    interactiveOk = !!f.interactive;
    console.log(ts(), 'state:', f.chats.length, '个任务 | interactive(app-server):', interactiveOk);
    phase = 1;
    ws.send(JSON.stringify({
      t: 'new_task', cwd: 'D:\\dev\\gpt\\codexWatch\\tmp-appr',
      prompt: '执行命令: echo approval-card-test > appr-output.txt 然后读出这个文件内容',
      approvalPolicy: 'untrusted', sandbox: 'read-only', ref: 'a1',
    }));
    console.log(ts(), '已发起交互式任务(on-request 审批)');
  }
  if (f.t === 'task_submitted' && f.ref === 'a1') {
    console.log(ts(), 'submitted ok=' + f.ok, 'interactive=' + f.interactive, f.error || '');
    if (f.ok && f.chatId) chatId = f.chatId;
  }
  if (f.t === 'chat_update' && f.chat && f.chat.id === chatId) {
    console.log(ts(), 'chat:', f.chat.status, '| durable', f.chat.durable, '|', (f.chat.lastMsg || '').slice(0, 40).replace(/\n/g, ' '));
  }
  if (f.t === 'item' && f.chatId === chatId) {
    const it = f.item;
    if (it.k === 'approval') {
      console.log(ts(), '★ 收到授权卡片:', it.title, '|', String(it.command || '').slice(0, 50));
      setTimeout(() => {
        console.log(ts(), '→ 手机点击[允许]');
        ws.send(JSON.stringify({ t: 'answer_approval', reqId: it.reqId, decision: 'accept' }));
      }, 600);
    } else if (it.k === 'askuser') {
      console.log(ts(), '★ 收到提问卡片:', JSON.stringify(it.questions && it.questions[0] && it.questions[0].question || '').slice(0, 60));
    } else if (['user', 'agent', 'sys', 'err'].includes(it.k)) {
      console.log(ts(), 'item', it.k, ':', String(it.t || '').slice(0, 60).replace(/\n/g, ' '));
    }
  }
  if (f.t === 'notify' && f.d && f.d.chatId === chatId) console.log(ts(), 'NOTIFY:', f.d.level, '|', String(f.d.body || '').slice(0, 40));
  if (f.t === 'notify' && f.d && f.d.level === 'done' && f.d.chatId === chatId) {
    console.log(ts(), '=== 审批全流程通过(interactive=' + interactiveOk + ') ===');
    // 追加消息测试(切换模型/effort)
    setTimeout(() => {
      ws.send(JSON.stringify({ t: 'send_msg', chatId, text: '很好,请再输出一遍那个echo的输出。', model: '', effort: 'low' }));
      console.log(ts(), '→ 追加消息(effort=low)');
    }, 1000);
    setTimeout(() => { console.log(ts(), '结束'); process.exit(0); }, 30000);
  }
});
setTimeout(() => { console.log(ts(), 'TIMEOUT phase=' + phase); process.exit(1); }, 300000);
