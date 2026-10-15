#!/usr/bin/env node
/**
 * CodexWatch 启动图标生成器(零依赖:Node 内置 zlib + 手写 PNG 编码)。
 *
 * 视觉:微信绿(#07C160 -> #06AD56 轻微对角渐变)圆角方块,
 *       中央白色"环眼"——大白色圆环 + 中心绿色圆瞳 + 瞳中白色高光点。
 * 抗锯齿:4x 超采样后盒式降采样。
 *
 * 输出:app/res/mipmap-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}/ic_launcher.png
 *       (48 / 72 / 96 / 144 / 192)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------- PNG 编码器 ----------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
  return out;
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace
  // 扫描行:每行 filter byte 0 + RGBA 数据
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4);
    raw[rowStart] = 0;
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- 几何绘制 ----------

const SS = 4; // 超采样倍数

// 颜色
const C_TOP = [0x07, 0xC1, 0x60]; // #07C160
const C_BOT = [0x06, 0xAD, 0x56]; // #06AD56
const C_WHITE = [0xFF, 0xFF, 0xFF];

function lerp(a, b, t) { return a + (b - a) * t; }

/** 单个(超采样)采样点的颜色与 alpha,单位坐标 [0,1) */
function sample(u, v) {
  // 对角渐变
  const t = Math.min(1, Math.max(0, (u + v - 1.0) / 1.0)); // 左上0 -> 右下1
  let r = lerp(C_TOP[0], C_BOT[0], t);
  let g = lerp(C_TOP[1], C_BOT[1], t);
  let b = lerp(C_TOP[2], C_BOT[2], t);

  // 圆角方块(中心 0.5,0.5;半边 0.46;角半径 0.225)
  const cx = 0.5, cy = 0.5, half = 0.46, rad = 0.225;
  const dx = Math.max(Math.abs(u - cx) - (half - rad), 0);
  const dy = Math.max(Math.abs(v - cy) - (half - rad), 0);
  const distRect = Math.sqrt(dx * dx + dy * dy) - rad;
  if (distRect > 0) return [0, 0, 0, 0]; // 透明

  // 环眼:白色圆环(0.185 < d < 0.30)
  const d = Math.hypot(u - cx, v - cy);
  if (d > 0.185 && d < 0.30) {
    return [C_WHITE[0], C_WHITE[1], C_WHITE[2], 255];
  }
  // d <= 0.185:中心绿色圆瞳(即背景渐变绿,环把瞳与外部区分开)
  // 瞳中白色高光点(偏左上)
  const h = Math.hypot(u - (cx - 0.055), v - (cy - 0.055));
  if (h < 0.042) {
    return [C_WHITE[0], C_WHITE[1], C_WHITE[2], 255];
  }
  return [Math.round(r), Math.round(g), Math.round(b), 255];
}

function renderIcon(size) {
  const W = size * SS;
  const rgba = Buffer.alloc(size * size * 4);
  const acc = new Float64Array(size * size * 4);
  for (let sy = 0; sy < W; sy++) {
    const row = Math.floor(sy / SS);
    for (let sx = 0; sx < W; sx++) {
      const col = Math.floor(sx / SS);
      const u = (sx + 0.5) / W, v = (sy + 0.5) / W;
      const c = sample(u, v);
      const o = (row * size + col) * 4;
      acc[o] += c[0]; acc[o + 1] += c[1]; acc[o + 2] += c[2]; acc[o + 3] += c[3];
    }
  }
  const n = SS * SS;
  for (let i = 0; i < size * size; i++) {
    rgba[i * 4] = Math.round(acc[i * 4] / n);
    rgba[i * 4 + 1] = Math.round(acc[i * 4 + 1] / n);
    rgba[i * 4 + 2] = Math.round(acc[i * 4 + 2] / n);
    rgba[i * 4 + 3] = Math.round(acc[i * 4 + 3] / n);
  }
  return rgba;
}

// ---------- 校验 ----------

function verifyPng(file, expectSize) {
  const buf = fs.readFileSync(file);
  const sigOk = buf.length > 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a;
  if (!sigOk) throw new Error('PNG signature invalid: ' + file);
  if (buf.readUInt32BE(8) !== 13 || buf.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('IHDR missing: ' + file);
  }
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  if (w !== expectSize || h !== expectSize) throw new Error('IHDR dims mismatch: ' + file);
  // 解压 IDAT 并核对原始像素长度
  let idat = [];
  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    if (type === 'IDAT') idat.push(buf.slice(off + 8, off + 8 + len));
    if (type === 'IEND') break;
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  if (raw.length !== h * (1 + w * 4)) throw new Error('pixel data length mismatch: ' + file);
  return { w, h, bytes: buf.length };
}

// ---------- 主流程 ----------

const resDir = path.join(__dirname, 'res');
const densities = [
  ['mdpi', 48], ['hdpi', 72], ['xhdpi', 96], ['xxhdpi', 144], ['xxxhdpi', 192],
];

for (const [name, size] of densities) {
  const dir = path.join(resDir, 'mipmap-' + name);
  fs.mkdirSync(dir, { recursive: true });
  const png = encodePng(size, size, renderIcon(size));
  const file = path.join(dir, 'ic_launcher.png');
  fs.writeFileSync(file, png);
  const info = verifyPng(file, size);
  console.log(`mipmap-${name}/ic_launcher.png  ${info.w}x${info.h}  ${info.bytes} bytes  OK`);
}
console.log('All launcher icons generated and verified.');
