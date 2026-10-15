'use strict';
// 原始 UTF-8 字节落盘，避免 Windows PowerShell 重编码日志。
const {spawn}=require('child_process');
const fs=require('fs');
const path=require('path');
const child=spawn(process.execPath,['index.js','--port','3599'],{cwd:__dirname,windowsHide:true,stdio:['ignore','pipe','pipe']});
child.stdout.pipe(fs.createWriteStream(path.join(__dirname,'bridge-service.stdout.log'),{flags:'a'}));
child.stderr.pipe(fs.createWriteStream(path.join(__dirname,'bridge-service.stderr.log'),{flags:'a'}));
child.on('error',()=>{process.exitCode=1});
child.on('close',code=>{process.exitCode=code===null?1:code});
