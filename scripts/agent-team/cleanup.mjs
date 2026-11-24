import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { hash, readJson, writeJson, safeDirectory, memberDisplayName, validateConfig } from './core.mjs';
import { assertNoOpenViews } from './views.mjs';
import { HANDOFF_FILE, standaloneLaunch } from './handoff.mjs';
import { NativeMaintenanceClient } from './native-communication.mjs';
import { assertMembershipStable } from './membership-state.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TERMINAL=new Set(['COMPLETED','FAILED','INTERRUPTED','REJECTED','OPERATOR_REPLIED']);
const KINDS=['cli','vscode','exec','appServer','subAgent','subAgentReview','subAgentCompact','subAgentThreadSpawn','subAgentOther','unknown'];
const MARKER='cleanup-state.json';
export const isArchiveComplete=r=>['WHOLE_TRIAL_TEAM_ARCHIVED','WHOLE_NATIVE_TEAM_ARCHIVED'].includes(r?.status)&&r.inspectorProcess==='CLOSED';
const samePath=(a,b)=>path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
const pause=ms=>new Promise(r=>setTimeout(r,ms));
function bytes(file){safeDirectory(file);const stat=fs.statSync(file);if(!stat.isFile()||stat.size>32*1024*1024)throw Error('INVALID_OR_OVERSIZED_FILE');return fs.readFileSync(file);}
function executableHash(file){
  safeDirectory(file);const stat=fs.statSync(file);if(!stat.isFile()||stat.size>512*1024*1024)throw Error('INVALID_EXECUTABLE_SIZE');
  const h=crypto.createHash('sha256'),buffer=Buffer.alloc(1024*1024),fd=fs.openSync(file,'r');
  try{let n;while((n=fs.readSync(fd,buffer,0,buffer.length,null))>0)h.update(buffer.subarray(0,n));}finally{fs.closeSync(fd);}
  return h.digest('hex');
}
function absent(pid){if(!Number.isInteger(pid)||pid<1)throw Error('PROCESS_ID_UNKNOWN');try{process.kill(pid,0);return false;}catch(e){if(e.code==='ESRCH')return true;throw Error('PROCESS_STATUS_UNKNOWN');}}
function load(configFile,{includeNativeHistory=false}={}){
  if(!path.isAbsolute(configFile))throw Error('ABSOLUTE_ACTUAL_TEAM_CONFIG_REQUIRED');
  assertMembershipStable(configFile);
  configFile=safeDirectory(configFile);const directory=path.dirname(configFile),configBytes=bytes(configFile),config=JSON.parse(configBytes);
  const stateFile=path.join(directory,'state.json'),stateBytes=bytes(stateFile),state=JSON.parse(stateBytes);
  const direct=config.initializationMode==='codex-native';let provisionSha256;
  if(direct){
    validateConfig(config);
    const root=path.join(config.repoRoot,'.local','agent-teams',config.machine);
    const expected=config.generation?path.join(root,'generations',config.generation,'team.json'):path.join(root,'team.json');
    if(!samePath(configFile,expected))throw Error('NATIVE_ARCHIVE_MANAGED_LOCATION_REQUIRED');
    for(const n of ['native-provision.lock','native-communication.lock','transport-migration.json','broker.lock','endpoint.json','native-endpoint.json'])if(fs.existsSync(path.join(directory,n)))throw Error('NATIVE_ARCHIVE_OWNER_OR_OPERATION_PENDING');
    const raw=bytes(path.join(directory,'native-provision.json')),r=JSON.parse(raw);provisionSha256=hash(raw);
    if(r.status!=='READY_FOR_NATIVE_TUI'||r.maintenanceClose!=='CLOSED'||r.configHash!==hash(JSON.stringify(config))||JSON.stringify(Object.keys(r.members||{}).sort())!==JSON.stringify(config.members.map(m=>m.name).sort()))throw Error('NATIVE_ARCHIVE_PROVISION_NOT_READY');
    for(const m of config.members)if(r.members[m.name].status!=='APPLIED'||r.members[m.name].threadId!==state.members?.[m.name]?.threadId)throw Error('NATIVE_ARCHIVE_PROVISION_IDENTITY_MISMATCH');
    if(!fs.existsSync(path.join(directory,HANDOFF_FILE)))throw Error('NATIVE_ARCHIVE_HANDOFF_REQUIRED');
  }else throw Error('PORTABLE_NATIVE_TEAM_REQUIRED');
  if(config.generation!==undefined&&!UUID.test(config.generation))throw Error('INVALID_TEAM_GENERATION');
  safeDirectory(config.repoRoot);safeDirectory(config.codexExecutable);
  if(!fs.statSync(config.codexExecutable).isFile()||/\.(ps1|cmd|bat)$/i.test(config.codexExecutable))throw Error('NATIVE_CODEX_REQUIRED');
  if(!Array.isArray(config.members)||config.members.length<1||config.members.length>(direct?64:12)||state.schemaVersion!==1||state.configHash!==hash(JSON.stringify(config))||!Array.isArray(state.messages)||!state.members)throw Error('TEAM_STATE_MISMATCH');
  const names=config.members.map(m=>m.name);
  if((!direct&&names.includes(`${config.machine.slice(-1)}-Ops`))||names.includes(config.externalOperator))throw Error('EXTERNAL_OPS_NOT_A_TRIAL_TEAM_TARGET');
  if(new Set(names).size!==names.length||(!direct&&names.some(n=>!new RegExp(`^${config.machine.slice(-1)}-[A-Za-z0-9._-]+$`).test(n)))||JSON.stringify(Object.keys(state.members).sort())!==JSON.stringify(names.slice().sort()))throw Error('ROSTER_MISMATCH');
  const targets=[],blocked=[];
  for(const name of names){
    const m=state.members[name];
    if(m.name!==name||!UUID.test(m.threadId||'')||m.sessionId!==m.threadId){blocked.push(`${name}:IDENTITY_UNKNOWN`);continue;}
    if(m.binding)blocked.push(`${name}:FORMAL_CONTRACT_BOUND`);
    if(m.status!=='IDLE'||m.currentMessage)blocked.push(`${name}:ACTIVE_OR_UNKNOWN_STATE`);
    const messages=state.messages.filter(x=>x.to===name||x.from===name);
    if(messages.some(x=>!TERMINAL.has(x.status)))blocked.push(`${name}:PENDING_OR_UNKNOWN_MESSAGE`);
    if(messages.some(x=>!['preparation','report',...(direct||includeNativeHistory?['native-interaction']:[])].includes(x.kind)))blocked.push(`${name}:NON_TRIAL_TASK_HISTORY`);
    if(!direct&&!UUID.test(m.turnId||''))blocked.push(`${name}:LAST_TURN_UNKNOWN`);
    targets.push({member:name,threadId:m.threadId,lastTurnId:m.turnId??null,expectedName:memberDisplayName(config,name)});
  }
  if(new Set(targets.map(t=>t.threadId)).size!==targets.length)blocked.push('DUPLICATE_THREAD_ID');
  return {configFile,directory,config,state,configBytes,stateBytes,targets,blocked,direct,provisionSha256};
}

export function preview(configFile,{includeNativeHistory=false}={}){
  const x=load(configFile,{includeNativeHistory});if(fs.existsSync(path.join(x.directory,MARKER)))throw Error('CLEANUP_ALREADY_RECORDED_INSPECT_EXISTING_REPORT');
  const id=crypto.randomUUID(),out=safeDirectory(path.join(x.directory,'cleanup',id));fs.mkdirSync(out,{recursive:true,mode:0o700});
  const plan={schemaVersion:1,kind:'ARCHIVE_WHOLE_OLD_TRIAL_TEAM',planId:id,createdAt:new Date().toISOString(),configFile:x.configFile,teamId:x.config.teamId,machine:x.config.machine,configSha256:hash(x.configBytes),stateSha256:hash(x.stateBytes),codexSha256:executableHash(x.config.codexExecutable),targets:x.targets,blocked:x.blocked,status:x.blocked.length?'BLOCKED':'READY_FOR_RUNTIME_CHECKS',behavior:'May stop only this whole trial team broker after live checks. Archive, never delete; no model turns or thread resume. Existing history and state are retained.'};
  if(includeNativeHistory)plan.includeNativeHistory=true;
  if(x.direct){plan.kind='ARCHIVE_WHOLE_NATIVE_TEAM';plan.provisionSha256=x.provisionSha256;plan.behavior='Archive only exact managed team sessions after live idle/queue/goal/descendant checks. Preserve history and configuration. Never stop the shared daemon or create/resume a session.';}
  const planFile=path.join(out,'plan.json');writeJson(planFile,plan);
  return {planFile,status:plan.status,memberCount:x.targets.length,blocked:plan.blocked};
}

function requireTrialUnchanged(x,plan){
  if(x.blocked.length||x.config.teamId!==plan.teamId||JSON.stringify(x.targets)!==JSON.stringify(plan.targets)||hash(x.configBytes)!==plan.configSha256||hash(x.stateBytes)!==plan.stateSha256||executableHash(x.config.codexExecutable)!==plan.codexSha256||(x.direct&&x.provisionSha256!==plan.provisionSha256))throw Error('PLAN_STALE_OR_NOT_A_SAFE_TRIAL_TEAM');
}
function stopOriginal(x){
  assertNoOpenViews(x.configFile);
  for(const name of ['broker.lock','endpoint.json','native-endpoint.json']){
    if(fs.existsSync(path.join(x.directory,name)))throw Error('TEAM_OWNER_PRESENT');
  }
  return {status:'NO_REGISTERED_BROKER'};
}
async function inspectThread(rpc,x,target,{captureCurrentTurn=false,native=false}={}){
  const {thread}=await rpc.request('thread/read',{threadId:target.threadId,includeTurns:false});
  // Originator is persisted by Codex and may inherit "Codex Desktop"; it is
  // not initialize.clientInfo.name. Exact recorded IDs/name/cwd/turn bind scope.
  if(thread?.id!==target.threadId||thread.sessionId!==target.threadId||thread.name!==target.expectedName||!samePath(thread.cwd,x.config.repoRoot)||thread.ephemeral||thread.parentThreadId||thread.forkedFromId)throw Error('THREAD_IDENTITY_OR_ORIGIN_MISMATCH');
  if(!['notLoaded','idle'].includes(thread.status?.type)||thread.canAcceptDirectInput===false)throw Error('THREAD_ACTIVE_LOCKED_OR_UNKNOWN');
  const page=await rpc.request('thread/turns/list',{threadId:target.threadId,limit:1,sortDirection:'desc',itemsView:'notLoaded'});
  const turn=page.data?.[0];
  const noTurns=x.direct&&Array.isArray(page.data)&&page.data.length===0&&page.nextCursor===null;
  if(!noTurns&&(!turn||!UUID.test(turn.id||'')||!['completed','failed','interrupted'].includes(turn.status)))throw Error('LATEST_TURN_ACTIVE_OR_UNKNOWN');
  const lastTurnId=noTurns?null:turn.id;
  if(!captureCurrentTurn&&lastTurnId!==target.lastTurnId)throw Error('LATEST_TURN_CHANGED_ACTIVE_OR_UNKNOWN');
  if(native){
    const queue=await rpc.request('thread/queue/list',{threadId:target.threadId,limit:1});
    if(!Array.isArray(queue.data)||queue.data.length||queue.nextCursor)throw Error('NATIVE_QUEUE_NOT_EMPTY_OR_UNKNOWN');
  }
  const goal=await rpc.request('thread/goal/get',{threadId:target.threadId});
  if(!goal||!Object.hasOwn(goal,'goal')||goal.goal===undefined)throw Error('GOAL_STATE_UNKNOWN');
  if(goal.goal&&goal.goal.status!=='complete')throw Error('EXISTING_GOAL_REQUIRES_SEPARATE_HANDLING');
  for(const archived of [false,true]){
    const descendants=await rpc.request('thread/list',{ancestorThreadId:target.threadId,archived,sourceKinds:KINDS,limit:1,useStateDbOnly:true});
    if(!Array.isArray(descendants.data)||descendants.data.length||descendants.nextCursor)throw Error('DESCENDANTS_PRESENT_OR_UNKNOWN_NO_RECURSIVE_ARCHIVE');
  }
  return {originator:thread.originator??null,name:thread.name,cwd:thread.cwd,lastTurnId,turnStatus:noTurns?'NO_TURNS':turn.status};
}
async function archiveReadback(rpc,x,target){
  let cursor=null;
  for(let n=0;n<4;n++){
    const page=await rpc.request('thread/list',{archived:true,searchTerm:target.expectedName,cwd:x.config.repoRoot,sourceKinds:KINDS,useStateDbOnly:true,limit:100,cursor});
    if(!Array.isArray(page.data))throw Error('ARCHIVE_READBACK_UNKNOWN');
    if(page.data.some(t=>t.id===target.threadId&&t.name===target.expectedName&&samePath(t.cwd,x.config.repoRoot)))return;
    if(!page.nextCursor)break;cursor=page.nextCursor;
  }
  throw Error('ARCHIVE_READBACK_UNKNOWN');
}

export async function applyPlan(planFile,{rpcFactory,stopOptions}={}){
  planFile=safeDirectory(path.resolve(planFile));const plan=JSON.parse(bytes(planFile));
  if(plan.schemaVersion!==1||!['ARCHIVE_WHOLE_OLD_TRIAL_TEAM','ARCHIVE_WHOLE_NATIVE_TEAM'].includes(plan.kind)||plan.status!=='READY_FOR_RUNTIME_CHECKS'||plan.blocked?.length||!UUID.test(plan.planId||''))throw Error('INVALID_OR_BLOCKED_PLAN');
  const x=load(plan.configFile,{includeNativeHistory:plan.includeNativeHistory===true});requireTrialUnchanged(x,plan);
  if(x.direct!==(plan.kind==='ARCHIVE_WHOLE_NATIVE_TEAM'))throw Error('ARCHIVE_PLAN_MODE_MISMATCH');
  const out=path.join(x.directory,'cleanup',plan.planId);if(!samePath(planFile,path.join(out,'plan.json')))throw Error('PLAN_LOCATION_MISMATCH');
  const marker=path.join(x.directory,MARKER),reportFile=path.join(out,'result.json');
  if(fs.existsSync(reportFile)||fs.existsSync(marker))throw Error('PREVIOUS_ATTEMPT_REQUIRES_REVIEW_NO_REPLAY');
  // A released team's native turns do not update the old broker snapshot.
  // Verify the exact handoff before creating our cleanup marker; never resume
  // or stop the shared daemon to inspect these sessions.
  const handoffFile=path.join(x.directory,HANDOFF_FILE),native=fs.existsSync(handoffFile);
  let handoffHash;
  if(native){standaloneLaunch(x.configFile,x.targets[0].member);handoffHash=hash(bytes(handoffFile));}
  const report={schemaVersion:1,planId:plan.planId,teamId:plan.teamId,startedAt:new Date().toISOString(),status:'PRECHECK',members:[],historyDeleted:false,serverTurnsStarted:false};
  fs.writeFileSync(path.join(out,'team.before.json'),x.configBytes,{flag:'wx',mode:0o600});
  fs.writeFileSync(path.join(out,'state.before.json'),x.stateBytes,{flag:'wx',mode:0o600});
  const markerBody={schemaVersion:1,planId:plan.planId,teamId:plan.teamId,status:'CLEANUP_IN_PROGRESS',reportFile};
  fs.writeFileSync(marker,JSON.stringify(markerBody,null,2)+'\n',{flag:'wx',mode:0o600});
  writeJson(reportFile,report);let rpc,archiveAttempted=false;
  try{
    report.owner=await stopOriginal(x,stopOptions);writeJson(reportFile,report);
    const stopped=load(x.configFile,{includeNativeHistory:plan.includeNativeHistory===true});
    if(stopped.blocked.length||hash(stopped.configBytes)!==plan.configSha256||JSON.stringify(stopped.targets)!==JSON.stringify(plan.targets))throw Error('TEAM_CHANGED_AFTER_STOP');
    rpc=rpcFactory?rpcFactory(x.config.codexExecutable,{native}):new NativeMaintenanceClient(x.config.codexExecutable);
    rpc.on('request',r=>rpc.reject(r.id,'CLEANUP_IS_METADATA_ONLY_NO_APPROVAL'));
    await rpc.initialize();
    // Validate every target first; official archive can cascade to descendants, so require leaves.
    report.actualMetadata={};const currentTargets=[];
    for(const target of x.targets){
      report.checkingMember=target.member;
      const metadata=await inspectThread(rpc,x,target,{native,captureCurrentTurn:native&&(x.direct||plan.includeNativeHistory===true)});
      report.actualMetadata[target.member]=metadata;
      currentTargets.push({...target,lastTurnId:metadata.lastTurnId});
    }
    // Separate evidence, not a rewrite of state.json or the original plan.
    // All members must pass before the first archive. Pin the live turns, then
    // require those same turns at each mutation boundary (no moving baseline).
    const currentFile=path.join(out,'current-targets.json');
    const currentBytes=Buffer.from(JSON.stringify({schemaVersion:1,planId:plan.planId,capturedAt:new Date().toISOString(),native,targets:currentTargets},null,2)+'\n');
    fs.writeFileSync(currentFile,currentBytes,{flag:'wx',mode:0o600});
    report.currentTargetsFile=currentFile;report.currentTargetsSha256=hash(currentBytes);
    report.reconciledMembers=currentTargets.filter((t,i)=>t.lastTurnId!==x.targets[i].lastTurnId).map(t=>t.member);
    writeJson(reportFile,report);
    for(const target of currentTargets){
      // Recheck target activity at the mutation boundary; do not use only a historical snapshot.
      report.checkingMember=target.member;
      requireTrialUnchanged(load(x.configFile,{includeNativeHistory:plan.includeNativeHistory===true}),plan);
      assertNoOpenViews(x.configFile);
      if(native&&(hash(bytes(handoffFile))!==handoffHash||['broker.lock','endpoint.json','native-endpoint.json'].some(n=>fs.existsSync(path.join(x.directory,n)))))throw Error('NATIVE_HANDOFF_CHANGED');
      await inspectThread(rpc,x,target,{native});
      const item={member:target.member,threadId:target.threadId,status:'ARCHIVE_REQUESTING'};
      report.members.push(item);archiveAttempted=true;writeJson(reportFile,report);
      try{await rpc.request('thread/archive',{threadId:target.threadId});await archiveReadback(rpc,x,target);item.status='ARCHIVED_VERIFIED';}
      catch(e){item.status=e.rejected?'ARCHIVE_REJECTED':'UNKNOWN';item.error=e.message;writeJson(reportFile,report);throw e;}
      writeJson(reportFile,report);
    }
    delete report.checkingMember;report.status=x.direct?'WHOLE_NATIVE_TEAM_ARCHIVED':'WHOLE_TRIAL_TEAM_ARCHIVED';
  }catch(e){report.status=archiveAttempted?'INCOMPLETE_REVIEW_REQUIRED':'BLOCKED_NO_ARCHIVE';report.error=e.message;}
  finally{
    if(rpc){try{await rpc.close();report.inspectorProcess='CLOSED';}catch(e){report.inspectorProcess='UNKNOWN';report.closeError=e.message;}}
    report.finishedAt=new Date().toISOString();writeJson(reportFile,report);
    if(archiveAttempted||report.inspectorProcess==='UNKNOWN'){writeJson(marker,{...markerBody,status:report.status,inspectorProcess:report.inspectorProcess});}
    else if(fs.existsSync(marker)&&readJson(marker).planId===plan.planId){fs.unlinkSync(marker);}
  }
  return {reportFile,status:report.status,archived:report.members.filter(x=>x.status==='ARCHIVED_VERIFIED').length,total:x.targets.length,inspectorProcess:report.inspectorProcess||'NOT_STARTED',error:report.error,blockedMember:report.checkingMember};
}

async function main(args){
  const command=args.shift(),get=k=>{const i=args.indexOf('--'+k);return i<0?undefined:args[i+1];};
  let result;if(command==='preview')result=preview(get('config')||'');else if(command==='apply')result=await applyPlan(get('plan')||'');else throw Error('USE_PREVIEW_OR_APPLY');
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
  if(['BLOCKED','BLOCKED_NO_ARCHIVE','INCOMPLETE_REVIEW_REQUIRED'].includes(result.status)||result.inspectorProcess==='UNKNOWN')process.exitCode=2;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main(process.argv.slice(2)).catch(e=>{process.stderr.write(e.message+'\n');process.exitCode=1;});
