'use strict';
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { WebSocketServer } = require('../../relay/node_modules/ws');
const root = path.resolve(__dirname, '../..');
const java = path.join(root, '.tools/jdk/bin/java.exe');
const cp = ['app/build/smoke', '.tools/Java-WebSocket-1.5.7.jar',
  '.tools/slf4j-api-2.0.6.jar', '.tools/slf4j-nop-2.0.6.jar'].join(';');
const compile = spawnSync(path.join(root, '.tools/jdk/bin/javac.exe'),
  ['-classpath', cp, '-d', 'app/build/smoke', 'app/test/WebSocketSmoke.java'],
  { cwd: root, stdio: 'inherit' });
if (compile.status !== 0) process.exit(1);
const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
server.on('connection', ws => ws.on('message', data => ws.send(data.toString())));
server.on('listening', () => {
  const child = spawn(java, ['-classpath', cp, 'WebSocketSmoke',
    'ws://127.0.0.1:' + server.address().port], { cwd: root, stdio: 'inherit' });
  const timeout = setTimeout(() => child.kill(), 20000);
  child.on('error', error => { console.error(error); process.exitCode = 1; server.close(); });
  child.on('exit', code => {
    clearTimeout(timeout);
    process.exitCode = code === 0 ? 0 : 1;
    server.close();
  });
});
