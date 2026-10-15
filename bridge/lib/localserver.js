'use strict';
// 本机服务:127.0.0.1:3599 —— 静态 Web UI + WebSocket(与手机端同一套 UI/协议)。

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { log, logErr } = require('./util');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

function startLocalServer(hub, { port, webRoot, onRelayStatus, listeningServer }) {
  const rootNorm = path.normalize(webRoot);
  const server = listeningServer || http.createServer();
  server.on('request', (req, res) => {
    const url = (req.url || '/').split('?')[0];
    if (url === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, ts: Date.now() }));
    }
    // 静态 Web UI(先剥 ..,再 normalize + 前缀校验,双保险防目录逃逸)
    let file = url === '/' ? '/index.html' : url;
    file = file.replace(/\.\./g, '');
    const full = path.normalize(path.join(rootNorm, file));
    if (full !== rootNorm && !full.startsWith(rootNorm + path.sep)) { res.writeHead(404); return res.end('not found'); }
    fs.readFile(full, (err, data) => {
      if (err) {
        res.writeHead(404); return res.end('not found');
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      if (file === '/index.html') {
        // 注入本地模式标记(前端据此跳过登录直连本机)
        data = Buffer.from(data.toString('utf8').replace('</head>', '<script>window.__CW_LOCAL__=1;</script></head>'));
      }
      res.end(data);
    });
  });

  // 浏览器发起的 WebSocket 必带 Origin;只放行本机页面。
  // 否则公网上任意网页都能借用户浏览器连 ws://127.0.0.1:3599 操控 Codex(读目录/发任务)。
  // 无 Origin 头的连接来自非浏览器客户端(测试脚本等),放行。
  const LOCAL_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i;
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4 * 1024 * 1024 });
  wss.on('connection', (ws, req) => {
    const origin = req.headers.origin;
    if (origin && !LOCAL_ORIGIN.test(origin)) {
      log('[local] 拒绝跨站 WebSocket:', origin);
      ws.close(); return;
    }
    if (req.socket.remoteAddress !== '127.0.0.1' && req.socket.remoteAddress !== '::1' && req.socket.remoteAddress !== '::ffff:127.0.0.1') { ws.close(); return; }
    const sink = hub.addSink((frame) => { if (ws.readyState === 1) ws.send(JSON.stringify(frame)); }, 'local:' + (origin || req.socket.remoteAddress || ''));
    ws.on('message', (data) => {
      let frame;
      try { frame = JSON.parse(data.toString()); } catch { return; }
      hub.handleFrame(frame, sink);
    });
    ws.on('close', () => hub.removeSink(sink));
    ws.on('error', () => {});
  });

  if (!server.listening) server.listen(port, '127.0.0.1', () => log('[local] http://127.0.0.1:' + server.address().port + '/ (本机预览)'));
  else log('[local] http://127.0.0.1:' + server.address().port + '/ (本机预览)');
  server.on('error', (e) => logErr('[local] 端口占用?', e.message));
  return server;
}

module.exports = { startLocalServer };
