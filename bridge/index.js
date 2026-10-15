'use strict';
// CodexWatch Bridge 入口:会话监听 + 任务控制 + 本机 UI + 云中继连接。

const fs = require('fs');
const path = require('path');
const os = require('os');
const { ChatStore } = require('./lib/store');
const { Runner } = require('./lib/runner');
const { Hub } = require('./lib/hub');
const { AppServerLink } = require('./lib/appserver');
const { startLocalServer } = require('./lib/localserver');
const { RelayLink } = require('./lib/relaylink');
const { log, logErr, codexHome, readJson, writeJson, uuid } = require('./lib/util');

const args = process.argv.slice(2);
const argOf = (name) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : null; };
const PORT = parseInt(argOf('--port') || '3599', 10);
const RELAY = argOf('--relay');
const PAIR = argOf('--pair');
const NAME = argOf('--name') || os.hostname();
const RETAIN_DAYS = parseInt(argOf('--days') || '14', 10);

// 先占用本机端口，再启动会话监听和云连接，避免自启和手动启动互相踢下线。
const reservedServer = require('http').createServer();
reservedServer.once('error', e => {
  logErr(e.code === 'EADDRINUSE' ? 'Bridge 已在运行，请勿重复启动。' : 'Bridge 监听失败：' + e.message);
  process.exit(e.code === 'EADDRINUSE' ? 0 : 1);
});
reservedServer.listen(PORT, '127.0.0.1', () => main());

function main() {

const here = __dirname;
const cfgFile = path.join(here, 'config.json');
const cfg = readJson(cfgFile, {});
let cfgDirty = false;
if (!cfg.deviceId) { cfg.deviceId = uuid(); cfgDirty = true; }
if (RELAY) { cfg.server = RELAY; cfgDirty = true; }
if (PAIR) { cfg.pairCode = PAIR; delete cfg.deviceToken; cfgDirty = true; }
if (!cfg.name) { cfg.name = NAME; cfgDirty = true; }
const saveCfg = () => { try { writeJson(cfgFile, cfg); } catch (e) { logErr('保存配置失败', e.message); } };
if (cfgDirty) saveCfg();

const sessionsRoot = path.join(codexHome(), 'sessions');
if (!fs.existsSync(sessionsRoot)) { logErr('未找到 Codex 会话目录:', sessionsRoot); process.exit(1); }

log('=== CodexWatch Bridge ===');
log('会话目录:', sessionsRoot);
log('云端中继:', cfg.server || '(未配置,仅本机模式)');
log('设备ID:', cfg.deviceId.slice(0, 8), '名称:', cfg.name);

const store = new ChatStore(sessionsRoot, { retainDays: RETAIN_DAYS });
const runner = new Runner(store);

// app-server 交互式会话(授权/提问/打断/切模型)
const as = new AppServerLink(runner.codexJs);
as.on('down', () => log('[as] 交互服务不可用,任务将走 exec 模式'));
// 防止文件 watcher 把 app-server 会话重复收录
store.suppress = new Set();
as.on('chat_new', (chat) => store.suppress.add(chat.id));

const hub = new Hub(store, runner, as);

store.quickScan();
// 打开最 recent 的几个聊天详情(让首屏体验更顺)——只对今天活跃的
for (const s of store.summaries()) {
  if (Date.now() - (s.lastTs || 0) < 36e5 * 20) { try { store.ensureDetail(s.id); } catch {} }
  if (s.status === 'running') store.ensureDetail(s.id);
}

// 文件监听:fs.watch(Windows 支持递归) + 定时轮询兜底
let watchTimer = null;
const kick = () => {
  if (watchTimer) return;
  watchTimer = setTimeout(() => { watchTimer = null; try { store.poll(); } catch (e) { logErr('poll', e.message); } }, 400);
};
try {
  fs.watch(sessionsRoot, { recursive: true }, (ev, fn) => { if (!fn || fn.endsWith('.jsonl') || ev === 'rename') kick(); });
  log('[watch] fs.watch 递归监听已启动');
} catch (e) { log('[watch] fs.watch 不可用,退化为纯轮询:', e.message); }
setInterval(() => { try { store.poll(); } catch (e) { logErr('poll', e.message); } }, 2000);
// 文件没有结束事件时，仍定期从桌面核对最新轮次；断线重连后的全量状态也随之恢复。
const reconcile = () => store.reconcileStatuses(runner.desktop).catch(e => logErr('status reconcile', e.message));
reconcile();
setInterval(reconcile, 30000).unref();
// session_index(线程命名)可能更新,定时刷新
setInterval(() => { try { store.loadThreadNames(); } catch {} }, 60000).unref();

startLocalServer(hub, { port: PORT, webRoot: path.join(here, '..', 'web'), listeningServer: reservedServer });

if (cfg.server && (cfg.deviceToken || cfg.pairCode)) {
  const link = new RelayLink(hub, cfg, saveCfg);
  link.start();
} else if (!cfg.server) {
  log('[relay] 未配置 --relay <wss://...>,跳过云端连接(本机模式)。运行 --pair <配对码> 完成绑定。');
} else {
  log('[relay] 缺少 deviceToken/pairCode。用 --pair <手机上生成的6位配对码> 重新启动以绑定。');
}

process.on('uncaughtException', (e) => { logErr('uncaught', e.stack || e.message); });
process.on('unhandledRejection', (e) => { logErr('unhandled', String(e)); });
log('Bridge 就绪。');

// 保持前台运行
setInterval(() => {}, 1 << 30);
}
