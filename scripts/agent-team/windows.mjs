import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { assertMembershipStable } from './membership-state.mjs';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readJson,writeJson,safeDirectory,validateConfig} from './core.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
export function updateWindowTicket(file,config,member,status,details={}){
  const r=readJson(safeDirectory(file));
  if(r.schemaVersion!==1||r.config!==path.resolve(config)||r.member!==member||!['PENDING','OPEN','CLOSED','FAILED'].includes(status))throw Error('WINDOW_TICKET_MISMATCH');
  writeJson(file,{...r,...details,status,updatedAt:new Date().toISOString()});
}
export function windowTickets(config){
  const root=safeDirectory(path.join(path.dirname(config),'window-launches'));if(!fs.existsSync(root))return [];
  return fs.readdirSync(root).filter(n=>/^[a-f0-9-]{36}\.json$/.test(n)).map(n=>{
    const file=path.join(root,n),r=readJson(safeDirectory(file));
    if(r.schemaVersion!==1||r.config!==path.resolve(config)||!['PENDING','OPEN','CLOSED','FAILED'].includes(r.status))throw Error('WINDOW_TICKET_UNKNOWN');
    return {...r,file};
  });
}
export function processAbsent(pid){
  if(!Number.isInteger(pid)||pid<1)throw Error('WINDOW_PROCESS_ID_UNKNOWN');
  try{process.kill(pid,0);return false;}catch(e){if(e.code==='ESRCH')return true;throw Error('WINDOW_PROCESS_STATE_UNKNOWN');}
}
// A launch receipt is history, not a permanent lock. Observe both recorded
// processes without changing the receipt or touching the shared Codex daemon.
export function observeWindowTicket(ticket,{isAbsent=processAbsent}={}){
  if(ticket.status==='CLOSED')return {status:'CLOSED',reason:'已收到进程关闭回执'};
  const inspect=pid=>{
    if(!Number.isInteger(pid)||pid<1)return 'UNKNOWN';
    try{const absent=isAbsent(pid);return absent===true?'ABSENT':absent===false?'PRESENT':'UNKNOWN';}catch{return 'UNKNOWN';}
  };
  const wrapper=inspect(ticket.wrapperPid),child=inspect(ticket.childPid);
  if(wrapper==='ABSENT'&&child==='ABSENT')return {status:'EXITED',wrapper,child,reason:'两个记录进程均已退出；保留原回执，不推断退出码或任务成功'};
  const label=pid=>Number.isInteger(pid)&&pid>0?String(pid):'未记录';
  return {status:wrapper==='PRESENT'||child==='PRESENT'?'OPEN':'UNKNOWN',wrapper,child,reason:`启动进程 ${wrapper}（PID ${label(ticket.wrapperPid)}）；Codex TUI进程 ${child}（PID ${label(ticket.childPid)}）`};
}
export function windowTicketText(ticket,options){
  const observed=observeWindowTicket(ticket,options);
  return `${ticket.member}：记录 ${ticket.status}；实核 ${observed.status}（${observed.reason}）${ticket.exitCode!==undefined?`；退出码 ${ticket.exitCode}`:''}`;
}
export function assertNoPendingWindows(config,options={}){
  for(const ticket of windowTickets(config)){
    const observed=observeWindowTicket(ticket,options);
    if(['CLOSED','EXITED'].includes(observed.status))continue;
    throw Error(`WINDOW_LAUNCH_NOT_CLOSED: ${ticket.member} ${ticket.status}; ${observed.reason}。若TUI仍运行，请在该成员窗口正常/exit；若已经退出，请保留本记录并由Ops核对两个准确PID。记录：${ticket.file}`);
  }
}
export function claimExitPrompt(config){
  const file=safeDirectory(path.join(path.dirname(config),'window-exit-prompt.json'));
  const id=crypto.randomUUID();
  try{fs.writeFileSync(file,JSON.stringify({id,pid:process.pid,at:new Date().toISOString()}),{flag:'wx',mode:0o600});}
  catch(e){if(e.code==='EEXIST')return null;throw e;}
  return ()=>{if(readJson(file).id!==id)throw Error('EXIT_PROMPT_OWNER_CHANGED');fs.unlinkSync(file);};
}
export async function openWindows(config,{powershell,node=process.execPath,members,launch=spawn,wait=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now}={}){
  assertMembershipStable(config);
  config=path.resolve(config);const c=validateConfig(readJson(config));assertNoPendingWindows(config);
  if(members!==undefined&&!Array.isArray(members))throw Error('INVALID_WINDOW_MEMBER_SELECTION');
  const selected=members===undefined?c.members:c.members.filter(m=>members.includes(m.name));
  if(!selected.length||(members!==undefined&&(!Array.isArray(members)||new Set(members).size!==members.length||selected.length!==members.length)))throw Error('INVALID_WINDOW_MEMBER_SELECTION');
  if(!powershell||!path.isAbsolute(powershell)||!fs.existsSync(safeDirectory(powershell)))throw Error('ACTUAL_POWERSHELL_EXECUTABLE_REQUIRED');
  const dir=safeDirectory(path.join(path.dirname(config),'window-launches'));fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const tickets=selected.map(m=>{
    const file=path.join(dir,crypto.randomUUID()+'.json');writeJson(file,{schemaVersion:1,config,member:m.name,status:'PENDING',createdAt:new Date().toISOString()});return file;
  });
  const manifest=path.join(dir,`batch-${crypto.randomUUID()}.json`);writeJson(manifest,{schemaVersion:1,config,node,tickets});
  // This PowerShell script uses normal Start-Process; no policy override, shell text or token arguments.
  const child=launch(powershell,['-NoProfile','-File',path.join(here,'Open-Windows.ps1'),'-Batch',manifest],{windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
  let diagnostic='';child.stdout?.on('data',()=>{});child.stderr?.on('data',b=>{diagnostic=(diagnostic+b.toString()).slice(-2000);});
  const exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  if(exit!==0)throw Error(`WINDOW_LAUNCHER_EXIT_${exit}: ${diagnostic}`);
  const start=now();
  while(now()-start<15000){
    const rows=tickets.map(readJson);
    if(rows.every(r=>r.status!=='PENDING'))return {status:rows.some(r=>r.status==='FAILED'||(r.exitCode!==undefined&&r.exitCode!==0))?'WINDOWS_NEED_ATTENTION':'WINDOWS_OPENED',opened:rows.filter(r=>r.openedAt).length,total:rows.length};
    await wait(250);
  }
  return {status:'WINDOWS_OPEN_PENDING',opened:tickets.map(readJson).filter(r=>r.openedAt).length,total:tickets.length};
}
