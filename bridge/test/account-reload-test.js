'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {AppServerLink}=require('../lib/appserver');

test('登录状态变更只在空闲时重载，模型请求给出重连提示',async()=>{
  const link=Object.create(AppServerLink.prototype);let kills=0;
  Object.assign(link,{authStamp:'old',available:true,child:{killed:false,kill(){kills++}},chats:new Map([['c',{status:'running'}]])});
  link.accountStamp=()=> 'new';
  link.refreshAccount();assert.equal(kills,0);assert.equal(link.authStamp,'old');
  link.chats.get('c').status='idle';
  await assert.rejects(link.listModels(),/登录状态正在更新/);
  assert.equal(kills,1);assert.equal(link.available,false);
  link.available=true;link.send=async(method,params,timeout)=>{assert.equal(method,'model/list');assert.equal(timeout,8000);return {data:[{model:'new-account-model'}]}};
  assert.equal((await link.listModels())[0].model,'new-account-model');
});
