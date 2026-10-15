'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

// 仅列目标电脑的目录，不读取文件内容。空路径返回磁盘入口。
async function browseDirectories(directory) {
  if (!directory) {
    const candidates = process.platform === 'win32'
      ? Array.from({length:26}, (_,i)=>String.fromCharCode(65+i)+':\\') : ['/'];
    const entries = (await Promise.all(candidates.map(async p=>{
      try { return (await fs.stat(p)).isDirectory() ? {name:p,path:p} : null; } catch { return null; }
    }))).filter(Boolean);
    if (!entries.some(e=>e.path===os.homedir())) entries.push({name:'用户目录',path:os.homedir()});
    return {path:'',parent:null,entries};
  }
  if (typeof directory !== 'string' || directory.length > 4096 || !path.isAbsolute(directory)) throw Error('请选择有效的电脑文件夹');
  let resolved, entries;
  try {
    resolved = await fs.realpath(directory);
    entries = await fs.readdir(resolved,{withFileTypes:true});
  } catch { throw Error('文件夹不存在或没有访问权限，请选择其他目录'); }
  const dirs=entries.filter(e=>e.isDirectory()).sort((a,b)=>a.name.localeCompare(b.name,'zh-CN',{numeric:true}));
  return {path:resolved,parent:path.dirname(resolved)===resolved?'':path.dirname(resolved),
    entries:dirs.slice(0,1000).map(e=>({name:e.name,path:path.join(resolved,e.name)})),truncated:dirs.length>1000};
}
async function workspacePath(root,requested){
  if(!root || !path.isAbsolute(root))throw Error('这个聊天没有可用的电脑工作目录');
  if(requested && (typeof requested!=='string'||requested.length>4096||!path.isAbsolute(requested)))throw Error('文件引用路径无效');
  const base=await fs.realpath(root),target=await fs.realpath(requested||base);
  const relative=path.relative(base,target);
  if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw Error('只能引用当前工作目录内的文件');
  return {base,target};
}
async function browseWorkspace(root,requested){
  const {base,target}=await workspacePath(root,requested);
  const entries=await fs.readdir(target,{withFileTypes:true});
  const visible=entries.filter(e=>e.isFile()||e.isDirectory()).sort((a,b)=>Number(b.isDirectory())-Number(a.isDirectory())||a.name.localeCompare(b.name,'zh-CN'));
  return {path:target,parent:target===base?null:path.dirname(target),entries:visible.slice(0,1000).map(e=>({name:e.name,path:path.join(target,e.name),directory:e.isDirectory()})),truncated:visible.length>1000};
}
async function resolveReferences(root,references){
  if(!Array.isArray(references)||references.length>5)throw Error('每条消息最多引用 5 个文件');
  return Promise.all(references.map(async p=>{
    if(typeof p!=='string'||!path.isAbsolute(p))throw Error('文件引用路径无效');
    const {target}=await workspacePath(root,p);
    if(!(await fs.stat(target)).isFile())throw Error('请选择文件，不能引用文件夹');
    return {path:target,name:path.basename(target),image:false};
  }));
}
// ---------------- 项目文件浏览/预览/下载(手机端) ----------------
const PREVIEW_CAP = 64 * 1024;          // 文本预览最多读前 64KB
const DOWNLOAD_MAX = 20 * 1024 * 1024;  // 下载上限 20MB(与上传一致)
const READ_CHUNK = 512 * 1024;          // 每块 512KB(base64 后约 700KB,远小于中继单帧上限)
const TEXT_EXTS = new Set(['.txt','.md','.markdown','.mdx','.json','.js','.mjs','.cjs','.ts','.tsx','.jsx','.css','.scss','.less','.html','.htm','.xml','.svg','.yml','.yaml','.ini','.cfg','.conf','.env','.log','.csv','.tsv','.py','.pyw','.rb','.go','.rs','.java','.kt','.kts','.c','.h','.cpp','.hpp','.cc','.hh','.cs','.php','.sh','.bash','.zsh','.fish','.ps1','.psm1','.bat','.cmd','.sql','.toml','.lua','.pl','.pm','.r','.swift','.dart','.vue','.svelte','.proto','.gradle','.properties','.editorconfig','.gitignore','.gitattributes','.dockerignore','.npmrc','.nvmrc','.lock','.service','.plist','.tf','.tfvars']);
const TEXT_NAMES = new Set(['makefile','dockerfile','license','licence','readme','changelog','authors','contributors','notice']);

function looksTextual(name, head) {
  if (TEXT_EXTS.has(path.extname(name).toLowerCase())) return true;
  const lower = name.toLowerCase();
  if (TEXT_NAMES.has(lower) || lower.startsWith('dockerfile') || lower.startsWith('makefile')) return true;
  // 无扩展名/未知扩展名:按字节启发式判断(含 NUL 或过多控制字符视为二进制)
  let ctrl = 0;
  for (const b of head) { if (b === 0) return false; if (b < 32 && b !== 9 && b !== 10 && b !== 13 && b !== 12 && b !== 27) ctrl++; }
  return head.length === 0 || ctrl / head.length < 0.02;
}
// 手机端可内置预览的媒体类型(按扩展名;APK 端 <img>/<video>/<audio> 能力)
const IMG_EXTS = new Set(['.png','.jpg','.jpeg','.webp','.gif','.bmp']);
const VID_EXTS = new Set(['.mp4','.webm','.mkv','.mov','.avi','.m4v','.3gp','.flv','.ts']);
const AUD_EXTS = new Set(['.mp3','.wav','.m4a','.flac','.ogg','.oga','.aac','.opus','.amr']);
function mediaKindOf(name) {
  const ext = path.extname(name).toLowerCase();
  if (IMG_EXTS.has(ext)) return 'image';
  if (VID_EXTS.has(ext)) return 'video';
  if (AUD_EXTS.has(ext)) return 'audio';
  return null;
}
async function statWorkspaceFile(root, requested) {
  const { target } = await workspacePath(root, requested);
  const st = await fs.stat(target);
  if (!st.isFile()) throw Error('只能查看文件，不能是文件夹');
  return { target, size: st.size, mtime: st.mtimeMs };
}
async function previewWorkspaceFile(root, requested) {
  const { target, size, mtime } = await statWorkspaceFile(root, requested);
  const name = path.basename(target);
  const kind = mediaKindOf(name);
  const cap = Math.min(size, PREVIEW_CAP);
  const fh = await fs.open(target, 'r');
  const head = Buffer.alloc(cap);
  try { if (cap) await fh.read(head, 0, cap, 0); } finally { await fh.close(); }
  const isText = !kind && looksTextual(name, head);
  return {
    name, size, mtime, kind, isText,
    text: isText ? head.toString('utf8') : '',
    truncated: isText && size > PREVIEW_CAP,
  };
}
async function readWorkspaceChunk(root, requested, offset) {
  const { target, size } = await statWorkspaceFile(root, requested);
  if (size > DOWNLOAD_MAX) throw Error(`文件 ${(size / 1048576).toFixed(1)}MB 超过 20MB,暂不支持下载到手机`);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= size) throw Error('读取位置无效');
  const len = Math.min(READ_CHUNK, size - offset);
  const fh = await fs.open(target, 'r');
  const buf = Buffer.alloc(len);
  try { await fh.read(buf, 0, len, offset); } finally { await fh.close(); }
  return { total: size, offset, next: offset + len, done: offset + len >= size, data: buf.toString('base64') };
}
module.exports = {browseDirectories,browseWorkspace,resolveReferences,previewWorkspaceFile,readWorkspaceChunk};
