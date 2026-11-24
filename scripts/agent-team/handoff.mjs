import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { hash, readJson, writeJson, safeDirectory, validateConfig } from './core.mjs';
import { assertNoOpenViews } from './views.mjs';
import { assertMembershipStable } from './membership-state.mjs';

export const HANDOFF_FILE='native-handoff.json';
const terminal=new Set(['COMPLETED','FAILED','INTERRUPTED','REJECTED','OPERATOR_REPLIED']);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function absent(pid){if(!Number.isInteger(pid)||pid<1)throw Error('HANDOFF_OWNER_PID_UNKNOWN');try{process.kill(pid,0);return false;}catch(e){if(e.code==='ESRCH')return true;throw Error('HANDOFF_OWNER_STATE_UNKNOWN');}}
function load(file){
  if(!path.isAbsolute(file))throw Error('ABSOLUTE_ACTUAL_TEAM_CONFIG_REQUIRED');
  assertMembershipStable(file);
  file=safeDirectory(file);const dir=path.dirname(file),config=validateConfig(readJson(file));
  for(const name of ['cleanup-state.json','transport-migration.json'])if(fs.existsSync(path.join(dir,name)))throw Error('TEAM_RETIRED_OR_MIGRATING');
  const stateFile=path.join(dir,'state.json'),bytes=fs.readFileSync(stateFile),state=JSON.parse(bytes);
  if(state.configHash!==hash(JSON.stringify(config)))throw Error('HANDOFF_CONFIG_STATE_MISMATCH');
  const names=config.members.map(m=>m.name).sort();
  if(JSON.stringify(names)!==JSON.stringify(Object.keys(state.members||{}).sort()))throw Error('HANDOFF_ROSTER_MISMATCH');
  const roster=names.map(name=>{const m=state.members[name];if(m.name!==name||!uuid.test(m.threadId||'')||m.sessionId!==m.threadId)throw Error('HANDOFF_IDENTITY_UNKNOWN');return {name,threadId:m.threadId};});
  if(new Set(roster.map(m=>m.threadId)).size!==roster.length)throw Error('HANDOFF_DUPLICATE_THREAD');
  return {file,dir,config,state,stateFile,bytes,roster};
}
export function assertHandoffIdle(state){
  if(!state.members||Object.values(state.members).some(m=>m.status!=='IDLE'||m.currentMessage)||!Array.isArray(state.messages)||state.messages.some(m=>!terminal.has(m.status)))throw Error('HANDOFF_REQUIRES_IDLE_TEAM_AND_CLOSED_MESSAGES');
}
function noOwnerFiles(dir){return ['broker.lock','endpoint.json','native-endpoint.json'].every(n=>!fs.existsSync(path.join(dir,n)));}
function sameRoster(a,b){return JSON.stringify(a)===JSON.stringify(b);}

// Deliberate whole-team transition. This does not archive, delete, or resume any
// Codex thread, and it never kills a PID discovered in a file. The original
// authenticated broker shuts down its own child; both process exits are observed.
export async function releaseToNative(configFile){
  const x=load(configFile),marker=path.join(x.dir,HANDOFF_FILE);
  if(fs.existsSync(marker)){
    const previous=readJson(marker);
    if(previous.status==='RELEASED_TO_NATIVE'){standaloneLaunch(x.file,x.roster[0].name);return {status:previous.status,alreadyReleased:true,reportFile:previous.reportFile};}
    throw Error('HANDOFF_PREVIOUS_ATTEMPT_REQUIRES_REVIEW_NO_REPLAY');
  }
  assertHandoffIdle(x.state);
  assertNoOpenViews(x.file);
  if(!noOwnerFiles(x.dir))throw Error('TEAM_OWNER_PRESENT');
  const id=crypto.randomUUID(),backup=safeDirectory(path.join(x.dir,'native-handoff',id));fs.mkdirSync(backup,{recursive:true,mode:0o700});
  fs.writeFileSync(path.join(backup,'team.before.json'),fs.readFileSync(x.file),{flag:'wx',mode:0o600});
  fs.writeFileSync(path.join(backup,'state.before.json'),x.bytes,{flag:'wx',mode:0o600});
  const report={schemaVersion:1,id,team:x.config.teamId,configHash:x.state.configHash,roster:x.roster,owner:null,status:'RELEASING',createdAt:new Date().toISOString(),reportFile:path.join(backup,'result.json'),historyDeleted:false,threadsArchived:false,automaticDispatch:'PAUSED'};
  fs.writeFileSync(marker,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
  writeJson(report.reportFile,report);
  try{
    const after=load(x.file);assertHandoffIdle(after.state);
    if(!noOwnerFiles(x.dir)||after.state.configHash!==x.state.configHash||!sameRoster(after.roster,x.roster)||JSON.stringify(after.state.members)!==JSON.stringify(x.state.members)||JSON.stringify(after.state.messages)!==JSON.stringify(x.state.messages))throw Error('HANDOFF_STATE_CHANGED_DURING_STOP');
    report.status='RELEASED_TO_NATIVE';report.finishedAt=new Date().toISOString();writeJson(report.reportFile,report);writeJson(marker,report);
    return {status:report.status,reportFile:report.reportFile,members:report.roster,historyPreserved:true,automaticDispatch:'PAUSED',next:'Use ordinary codex resume <threadId>, or codex then /resume. Do not restart the team broker.'};
  }catch(e){report.status='REVIEW_REQUIRED';report.error=e.message;writeJson(report.reportFile,report);writeJson(marker,report);throw e;}
}

export function standaloneLaunch(configFile,member){
  const x=load(configFile),record=readJson(path.join(x.dir,HANDOFF_FILE));
  if(record.schemaVersion!==1||record.status!=='RELEASED_TO_NATIVE'||record.team!==x.config.teamId||record.configHash!==x.state.configHash||!sameRoster(record.roster,x.roster))throw Error('NATIVE_HANDOFF_NOT_CONFIRMED');
  if(!noOwnerFiles(x.dir))throw Error('TEAM_BACKEND_PRESENT_NO_STANDALONE_ATTACH');
  const m=x.state.members[member];if(!m)throw Error('UNKNOWN_MEMBER');
  const env={...process.env};
  // Do not override model, sandbox, account, or approvals. Codex resumes the
  // existing saved thread. Team dynamic tool callbacks are offline in this mode.
  return {executable:x.config.codexExecutable,args:['resume',m.threadId,'--no-alt-screen'],env,cwd:m.binding?.workspace||x.config.repoRoot,standalone:true};
}
