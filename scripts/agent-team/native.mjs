import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { readJson,writeJson,safeDirectory,hash,validateConfig } from './core.mjs';
import { HANDOFF_FILE, standaloneLaunch } from './handoff.mjs';
import { beginView, assertNoOpenViews } from './views.mjs';
import { updateWindowTicket, claimExitPrompt } from './windows.mjs';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function absent(pid){if(!Number.isInteger(pid)||pid<1)throw Error('OWNER_PID_UNKNOWN');try{process.kill(pid,0);return false;}catch(e){if(e.code==='ESRCH')return true;throw Error('OWNER_STATE_UNKNOWN');}}
function actualConfig(file){if(!path.isAbsolute(file))throw Error('ABSOLUTE_TEAM_CONFIG_REQUIRED');file=safeDirectory(file);return{file,dir:path.dirname(file),config:validateConfig(readJson(file))};}

export async function askYesNo(question){
  if(!process.stdin.isTTY||!process.stdout.isTTY)throw Error('INTERACTIVE_TERMINAL_REQUIRED_USE_NONINTERACTIVE_FOR_AUTOMATION');
  const rl=createInterface({input:process.stdin,output:process.stdout});
  try{
    for(;;){const answer=(await rl.question(question+' [y/N] ')).trim().toLowerCase();
      if(['y','yes','是'].includes(answer))return true;
      if(['','n','no','否'].includes(answer))return false;
      process.stdout.write('请输入 y/是 或 n/否；直接回车选择否。\n');
    }
  }finally{rl.close();}
}
export async function askChoice(question,choices){
  if(!process.stdin.isTTY||!process.stdout.isTTY)throw Error('INTERACTIVE_TERMINAL_REQUIRED');
  const rl=createInterface({input:process.stdin,output:process.stdout});
  try{
    process.stdout.write(question+'\n'+choices.map(([,label],i)=>`  ${i+1}. ${label}`).join('\n')+'\n');
    for(;;){const raw=(await rl.question('输入编号，回车选择 1：')).trim();const n=raw===''?1:Number(raw);if(Number.isInteger(n)&&n>=1&&n<=choices.length)return choices[n-1][0];process.stdout.write('请选择列表中的编号。\n');}
  }finally{rl.close();}
}
export async function openNative(configFile,member,{spawnNative=spawn,promptOnExit=false,ask=askYesNo,windowTicket}={}){
  const launch=standaloneLaunch(configFile,member);
  process.stdout.write('退出后可用普通 Codex /resume 接续。\n');
  const view=beginView(configFile,member);let code,child,childClosed=false,exitSignal=null,closeCode=null,executionError;
  try{
    // A concurrent handoff creates its marker before stopping. Do not attach a
    // new managed window after it started; the handoff checks our view too.
    if(!launch.standalone&&fs.existsSync(path.join(path.dirname(configFile),HANDOFF_FILE)))throw Error('HANDOFF_STARTED_NO_NEW_TUI');
    child=spawnNative(launch.executable,launch.args,{cwd:launch.cwd,env:launch.env,stdio:'inherit',windowsHide:false,shell:false});
    child.once('close',(value,signal)=>{childClosed=true;closeCode=value;exitSignal=signal||null;});
    view.spawned(child.pid);
    if(windowTicket&&child.pid)updateWindowTicket(windowTicket,configFile,member,'OPEN',{openedAt:new Date().toISOString(),wrapperPid:process.pid,childPid:child.pid});
    code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>{if(signal||code===null)reject(Error('NATIVE_TUI_EXIT_UNKNOWN'));else resolve(code);});});
  }catch(e){executionError=e;throw e;}
  finally{
    // Even a signal/error path can have a real close event. Record only what
    // was observed before propagating the failure; never invent a zero exit.
    if(windowTicket&&childClosed)updateWindowTicket(windowTicket,configFile,member,'CLOSED',{exitCode:closeCode,exitSignal,closedAt:new Date().toISOString(),...(executionError?{error:executionError.message}:{})});
    if(!child||childClosed||!child.pid)view.closed();
  }
  // A known nonzero exit is a failed TUI, but its process really closed. Preserve
  // that result without permanently treating the window as an active owner.
  if(code!==0)throw Error(`NATIVE_TUI_EXIT_${code}`);
  return {closed:true,teamStopped:!!launch.standalone};
}
