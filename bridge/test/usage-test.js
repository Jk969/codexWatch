'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {AppServerLink}=require('../lib/appserver');
const {translate}=require('../lib/rollout');
test('上下文使用最近一次用量，兼容 v2 嵌套通知',()=>{
  const record={type:'event_msg',payload:{type:'token_count',info:{model_context_window:100000,total_token_usage:{total_tokens:900000},last_token_usage:{total_tokens:25000}}}};
  assert.equal(translate(record).tokens.lastTotal,25000);
  delete record.payload.info.last_token_usage.total_tokens;assert.equal(translate(record).tokens.lastTotal,null);
  const link=Object.create(AppServerLink.prototype),chat={};link.chats=new Map([['c',chat]]);let updated=false;link.summary=x=>x;link.emit=()=>updated=true;
  link.onNotification({method:'thread/tokenUsage/updated',params:{threadId:'c',tokenUsage:{total:{totalTokens:900000},last:{totalTokens:25000},modelContextWindow:100000}}});
  assert.equal(chat.tokens.lastTotal,25000);assert.equal(chat.tokens.ctx,100000);assert(updated);
});
test('重置卡转发幂等编号，账号变化先拒绝，不误消耗',async()=>{
  const link=Object.create(AppServerLink.prototype);link.refreshAccount=()=>{};link.available=true;link.accountStamp=()=> 'account-a';let calls=0;
  link.send=async(method,p)=>{calls++;assert.equal(method,'account/rateLimitResetCredit/consume');assert.equal(p.idempotencyKey,'12345678-1234-1234-1234-123456789abc');return {outcome:'alreadyRedeemed'}};
  const args={idempotencyKey:'12345678-1234-1234-1234-123456789abc',accountRevision:'account-a'};
  assert.equal((await link.consumeReset(args)).outcome,'alreadyRedeemed');
  await assert.rejects(link.consumeReset({...args,accountRevision:'old'}),/登录状态已变化/);assert.equal(calls,1);
});
