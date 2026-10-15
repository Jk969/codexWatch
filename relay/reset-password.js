// 密码重置工具(在服务器 relay 目录运行):node reset-password.js <账号> <新密码>
// 中继运行中时，直接改 relay.json 会被中继内存里的旧数据覆盖；
// 因此写入 data/pending-resets.json，由中继在 5 秒内应用（同时作废该账号的全部登录）。
// 中继未运行时同样有效：下次启动时应用。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const [name, pw] = process.argv.slice(2);
if (!name || !pw || pw.length < 8) { console.log('用法: node reset-password.js <账号> <新密码(至少8位)>'); process.exit(1); }
const dataDir = process.env.CODEXWATCH_DATA_DIR || path.join(__dirname, 'data');
const file = path.join(dataDir, 'relay.json');
let db;
try { db = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.log('读取', file, '失败:', e.message); process.exit(1); }
if (!(db.users || []).some(u => u.name === name)) { console.log('账号不存在。现有用户:', (db.users || []).map(u => u.name).join(', ')); process.exit(1); }
const salt = crypto.randomBytes(8).toString('hex');
const hash = salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
const pendingFile = path.join(dataDir, 'pending-resets.json');
let pending = [];
try { pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8')); if (!Array.isArray(pending)) pending = []; } catch {}
pending = pending.filter(r => r.name !== name).concat({ name, pw: hash, at: Date.now() });
const tmp = pendingFile + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(pending), { mode: 0o600 });
fs.renameSync(tmp, pendingFile);
console.log('已提交', name, '的密码重置：中继运行中会在 5 秒内生效（旧登录全部失效）；未运行则在下次启动时生效。');
