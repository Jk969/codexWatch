'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

function log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }
function logErr(...a) { console.error(new Date().toISOString().slice(11, 19), '[ERR]', ...a); }

function codexHome() {
  if (process.env.CODEX_HOME) return process.env.CODEX_HOME;
  return path.join(os.homedir(), '.codex');
}

function readJson(file, dflt) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return dflt; }
}
function writeJson(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

function uuid() { return crypto.randomUUID(); }
function randToken() { return crypto.randomBytes(24).toString('hex'); }

function hhmmss(ts) {
  const d = new Date(ts);
  return d.toTimeString().slice(0, 8);
}

function truncate(s, n) {
  if (typeof s !== 'string') return '';
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// 相对时间(微信风格):刚写的时间,列表场景
function relTime(tsMs, nowMs) {
  const now = nowMs || Date.now();
  const diff = now - tsMs;
  if (diff < 0) return '';
  if (diff < 60e3) return '刚刚';
  const d = new Date(tsMs), n = new Date(now);
  const sameDay = d.toDateString() === n.toDateString();
  if (sameDay) {
    const h = d.getHours(), m = String(d.getMinutes()).padStart(2, '0');
    if (h < 6) return '凌晨 ' + h + ':' + m;
    return h + ':' + m;
  }
  const yesterday = new Date(now - 864e5);
  if (d.toDateString() === yesterday.toDateString()) return '昨天';
  if (d.getFullYear() === n.getFullYear()) return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate();
}

module.exports = { log, logErr, codexHome, readJson, writeJson, uuid, randToken, hhmmss, truncate, relTime };
