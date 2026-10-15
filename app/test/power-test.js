'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {pingConnections}=require('../../relay/heartbeat');

test('省电客户端两分钟才收到服务端心跳，旧客户端和电脑保留 25 秒',()=>{
  const socket=period=>({readyState:1,cwHeartbeatMs:period,cwLastPing:0,pings:0,ping(){this.pings++;}});
  const mobile=socket(120000),legacy=socket(25000),desktop=socket(undefined);
  const closed=socket(120000);closed.readyState=3;
  const clients=[mobile,legacy,desktop,closed];
  for(let now=5000;now<=120000;now+=5000)pingConnections(clients,now);
  assert.equal(mobile.pings,1);assert.equal(legacy.pings,4);assert.equal(desktop.pings,4);assert.equal(closed.pings,0);
  pingConnections(clients,120000);assert.equal(mobile.pings,1);
  // 服务端调度延迟后只补一次，不能把休眠期间的心跳堆成突发网络请求。
  pingConnections(clients,3600000);assert.equal(mobile.pings,2);
});

test('异常连接不影响其余客户端的心跳',()=>{
  let sent=0;
  pingConnections([{readyState:1,ping(){throw Error('closed');}},{readyState:1,ping(){sent++;}}],120000);
  assert.equal(sent,1);
});
