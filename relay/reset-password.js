// 管理员密码重置工具(在服务器 relay 目录运行):node reset-password.js <账号> <新密码>
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const [name, pw] = process.argv.slice(2);
if (!name || !pw || pw.length < 6) { console.log('用法: node reset-password.js <账号> <新密码(至少6位)>'); process.exit(1); }
const file = path.join(__dirname, 'data', 'relay.json');
const db = JSON.parse(fs.readFileSync(file, 'utf8'));
const user = db.users.find(u => u.name === name);
if (!user) { console.log('账号不存在。现有用户:', db.users.map(u => u.name).join(', ')); process.exit(1); }
const salt = crypto.randomBytes(8).toString('hex');
user.pw = salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
fs.writeFileSync(file, JSON.stringify(db, null, 1));
console.log('已重置', name, '的密码');
