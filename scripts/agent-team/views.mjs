import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readJson, writeJson, safeDirectory } from './core.mjs';
import { assertNoPendingWindows } from './windows.mjs';

function absent(pid){
  if(!Number.isInteger(pid)||pid<1)throw Error('TUI_PROCESS_UNKNOWN');
  try{process.kill(pid,0);return false;}catch(e){if(e.code==='ESRCH')return true;throw Error('TUI_PROCESS_UNKNOWN');}
}
// These records cover windows opened through this launcher. They are not an OS
// lock on manually started Codex clients; older/manual windows must be closed too.
export function assertNoOpenViews(configFile,{isAbsent=absent}={}){
  assertNoPendingWindows(configFile,{isAbsent});
  const dir=safeDirectory(path.join(path.dirname(configFile),'native-views'));
  if(!fs.existsSync(dir))return;
  for(const name of fs.readdirSync(dir)){
    if(!/^[a-f0-9-]{36}\.json$/.test(name))throw Error('TUI_VIEW_RECORD_UNKNOWN');
    const r=readJson(safeDirectory(path.join(dir,name)));
    if(r.schemaVersion!==1||r.config!==path.resolve(configFile)||!Number.isInteger(r.wrapperPid))throw Error('TUI_VIEW_RECORD_UNKNOWN');
    if(!isAbsent(r.wrapperPid))throw Error(`OTHER_TUI_WINDOW_OPEN: ${r.member}`);
    if(!Number.isInteger(r.childPid)||!isAbsent(r.childPid))throw Error(`TUI_WINDOW_NOT_CLOSED_OR_UNKNOWN: ${r.member}`);
    // Both recorded processes are gone. Keep the crash record; never kill a PID.
  }
}
export function beginView(configFile,member){
  const dir=safeDirectory(path.join(path.dirname(configFile),'native-views'));fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const id=crypto.randomUUID(),file=path.join(dir,id+'.json');
  const r={schemaVersion:1,id,config:path.resolve(configFile),member,wrapperPid:process.pid,childPid:null};
  fs.writeFileSync(file,JSON.stringify(r)+'\n',{flag:'wx',mode:0o600});
  return {spawned(pid){if(Number.isInteger(pid)){r.childPid=pid;writeJson(file,r);}},closed(){if(readJson(file).id!==id)throw Error('TUI_VIEW_CHANGED');fs.unlinkSync(file);}};
}
