'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {EventEmitter}=require('node:events');

test('电脑中继长连接收不到 pong 时关闭并自动重连，旧连接清理心跳',async()=>{
  const sockets=[];let heartbeat,retry,cleared=false,removed=0;
  class Socket extends EventEmitter{
    static OPEN=1;
    constructor(){super();this.readyState=1;this.pings=0;sockets.push(this);}
    send(){}ping(){this.pings++;}
    terminate(){this.readyState=3;this.emit('close',1006,Buffer.alloc(0));}
  }
  const sandbox={module:{exports:{}},URL,Buffer,
    require:name=>name==='ws'?Socket:name==='./util'?{log(){},logErr(){}}:require(name),
    setInterval:fn=>{heartbeat=fn;return 1;},clearInterval:()=>{cleared=true;},
    setTimeout:fn=>{retry=fn;return 2;},clearTimeout(){}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../lib/relaylink.js'),'utf8'),sandbox);
  const {RelayLink}=sandbox.module.exports;
  const hub={broadcast(){},addSink:()=>({}),removeSink:()=>removed++,stateFrame:()=>({})};
  const link=new RelayLink(hub,{server:'https://example.com',deviceToken:'test',deviceId:'fixture'},()=>{});
  link.connect();sockets[0].emit('open');heartbeat();
  assert.equal(sockets[0].pings,1);
  sockets[0].emit('pong');heartbeat();assert.equal(sockets[0].pings,2);
  heartbeat();assert.equal(cleared,true);assert.equal(removed,1);assert.equal(link.status,'disconnected');
  retry();await new Promise(r=>setImmediate(r));assert.equal(sockets.length,2);
  sockets[1].emit('open');assert.equal(link.status,'connected');
});
