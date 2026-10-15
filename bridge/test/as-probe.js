// 直接探针 app-server:thread/start 返回形状 + turn/start + 通知流
const { spawn } = require('child_process');
const codexJs = 'D:/soft/nvm4w/nodejs/node_modules/@openai/codex/bin/codex.js';
const child = spawn(process.execPath, [codexJs, 'app-server'], { stdio: ['pipe','pipe','pipe'], windowsHide: true });
let buf = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stderr.on('data', () => {});
const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n');
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'CodexWatch-probe', title: 'probe', version: '1.0.0' } } });
child.stdout.on('data', d => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id === 1) {
      console.log('INIT OK');
      send({ jsonrpc: '2.0', method: 'initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'thread/start', params: { cwd: 'D:\\dev\\gpt\\codexWatch\\tmp-appr' } });
    } else if (m.id === 2) {
      console.log('THREAD_START RESULT:', JSON.stringify(m).slice(0, 300));
      const tid = (m.result && m.result.thread && m.result.thread.id) || (m.result && m.result.id) || m.result;
      console.log('使用 threadId =', tid);
      send({ jsonrpc: '2.0', id: 3, method: 'turn/start', params: { threadId: tid, input: [{ type: 'text', text: '输出一句话:probe-ok' }] } });
    } else if (m.id === 3) {
      console.log('TURN_START RESULT:', JSON.stringify(m).slice(0, 300));
    } else if (m.method) {
      const p = m.params || {};
      const tid = p.threadId || (p.thread && p.thread.id) || '';
      if (/turn|item/.test(m.method) || /thread\/(started|name)/.test(m.method)) {
        console.log('NOTIF:', m.method, 'tid=' + String(tid).slice(0, 8), JSON.stringify(p).slice(0, 260));
      }
    }
  }
});
setTimeout(() => { child.kill(); process.exit(0); }, 60000);
