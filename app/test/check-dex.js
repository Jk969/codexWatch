'use strict';
// 检查 DEX 的类定义表；字符串表中出现类名也可能只是未满足的引用。
const fs = require('node:fs');
const assert = require('node:assert/strict');
const dex = fs.readFileSync(process.argv[2]);
assert.equal(dex.toString('ascii', 0, 4), 'dex\n');
const stringsOffset = dex.readUInt32LE(60);
const typesOffset = dex.readUInt32LE(68);
const classesSize = dex.readUInt32LE(96);
const classesOffset = dex.readUInt32LE(100);
const names = new Set();
for (let i = 0; i < classesSize; i++) {
  const type = dex.readUInt32LE(classesOffset + i * 32);
  const string = dex.readUInt32LE(typesOffset + type * 4);
  let start = dex.readUInt32LE(stringsOffset + string * 4);
  while (dex[start++] & 0x80) { }
  names.add(dex.toString('utf8', start, dex.indexOf(0, start)));
}
for (const name of [
  'org/java_websocket/client/WebSocketClient',
  'org/slf4j/LoggerFactory', 'org/slf4j/Logger',
  'org/slf4j/nop/NOPServiceProvider',
  'top/jingxixi/codexwatch/GatewayService',
]) {
  assert(names.has('L' + name + ';'), 'DEX 缺少类定义: ' + name);
}
console.log('DEX runtime dependencies passed');
