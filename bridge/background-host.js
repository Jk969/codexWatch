'use strict';
// 原始 UTF-8 字节落盘，避免 Windows PowerShell 重编码日志。
// 每次启动时日志超过 10MB 就轮转为 .old，避免长期运行后日志无限增长。
const {spawn}=require('child_process');
const fs=require('fs');
const path=require('path');
const MAX_LOG=10*1024*1024;
function logStream(name){
  const file=path.join(__dirname,name);
  try{ if(fs.statSync(file).size>MAX_LOG) fs.renameSync(file,file+'.old'); }catch{}
  return fs.createWriteStream(file,{flags:'a'});
}
const child=spawn(process.execPath,['index.js','--port','3599'],{cwd:__dirname,windowsHide:true,stdio:['ignore','pipe','pipe']});
child.stdout.pipe(logStream('bridge-service.stdout.log'));
child.stderr.pipe(logStream('bridge-service.stderr.log'));
child.on('error',()=>{process.exitCode=1});
child.on('close',code=>{process.exitCode=code===null?1:code});
