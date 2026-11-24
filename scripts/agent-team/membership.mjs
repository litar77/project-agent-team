import fs from 'node:fs';
import {permissionParameters,verifyPermissions,effectivePermissions} from './permissions.mjs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {hash,readJson,writeJson,safeDirectory,validateConfig,memberReferences,memberDisplayName} from './core.mjs';
import {NativeMaintenanceClient} from './native-communication.mjs';
import {PROVISION_FILE,inspectNativeTeam,nativeRolePrompt,nativeRosterPrompt} from './native-team.mjs';
import {HANDOFF_FILE,standaloneLaunch,assertHandoffIdle} from './handoff.mjs';
import {assertNoOpenViews} from './views.mjs';
import {membershipOperation,MEMBERSHIP_FILE,MEMBERSHIP_LOCK} from './membership-state.mjs';

const files=['team.json',PROVISION_FILE,'state.json',HANDOFF_FILE];
const stamp=()=>new Date().toISOString();
const configHash=c=>hash(JSON.stringify(c));
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const samePath=(a,b)=>typeof a==='string'&&typeof b==='string'&&path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
function bytes(file){safeDirectory(file);return fs.existsSync(file)?fs.readFileSync(file):null;}
function byteHash(file){const b=bytes(file);return b===null?null:hash(b);}
function decode(snapshot){return snapshot?.bytes===null?null:JSON.parse(Buffer.from(snapshot.bytes,'base64').toString('utf8'));}
function command(exe,args){const r=spawnSync(exe,args,{encoding:'utf8',windowsHide:true,shell:false,timeout:15000,maxBuffer:32768});if(r.error||r.status!==0)throw Error(`MEMBERSHIP_COMMAND_FAILED ${args.slice(0,3).join(' ')}: ${r.error?.code||r.status}`);return r.stdout;}
function unchanged(dir,r){for(const name of files)if(byteHash(path.join(dir,name))!==r.before[name].sha256)throw Error(`MEMBERSHIP_INPUT_CHANGED ${name}`);}
function noOtherOwner(dir){for(const name of ['native-provision.lock','native-communication.lock','broker.lock','endpoint.json','native-endpoint.json','cleanup-state.json','transport-migration.json'])if(fs.existsSync(path.join(dir,name)))throw Error(`MEMBERSHIP_OWNER_OR_RETIRED ${name}`);}

// Preview admission has no native calls. Existing duties, Lead, history and
// authority are retained; the old technical role 'lead' is normalized only.
export function inspectExpandableTeam(file){
  if(!path.isAbsolute(file)||path.basename(file)!=='team.json')throw Error('MEMBERSHIP_ACTUAL_TEAM_CONFIG_REQUIRED');
  file=safeDirectory(file);const c=validateConfig(readJson(file)),dir=path.dirname(file);
  noOtherOwner(dir);assertNoOpenViews(file);
  if(membershipOperation(file)?.status&&membershipOperation(file).status!=='COMPLETED')throw Error('MEMBERSHIP_PENDING_CONTINUE_EXISTING_SELECTION');
  if(c.initializationMode==='codex-native')inspectNativeTeam(file);
  else{
    if(!fs.existsSync(path.join(dir,HANDOFF_FILE)))throw Error('旧托管团队尚未交还原生Codex，请先选择“释放空闲旧团队”，保留会话后再添加成员。');
    for(const m of c.members)standaloneLaunch(file,m.name);
    assertHandoffIdle(readJson(path.join(dir,'state.json')));
    const migration=path.join(dir,'native-communication.json');
    if(fs.existsSync(migration)){
      const r=readJson(migration);
      if(r.maintenanceClose!=='CLOSED'||r.status!=='INSTRUCTIONS_APPLIED_AWAITING_COMMUNICATION_TEST')throw Error('MEMBERSHIP_LEGACY_COMMUNICATION_UNKNOWN');
    }
  }
  return c;
}
function checkTarget(c,t){
  validateConfig(t);
  const expected={...c,initializationMode:'codex-native',transport:'native',membershipRevision:(c.membershipRevision||0)+1,
    frontendSkill:c.frontendSkill||t.frontendSkill,members:c.members.map(m=>m.jobRole==='lead'?{...m,jobRole:'module-manager',legacyJobRole:'lead'}:m)};
  if(JSON.stringify({...t,members:t.members.slice(0,c.members.length)})!==JSON.stringify(expected))throw Error('MEMBERSHIP_EXISTING_TEAM_MUST_NOT_CHANGE');
  if(t.members.length<=c.members.length)throw Error('MEMBERSHIP_NEW_MEMBERS_REQUIRED');
  if(new Set(t.members.map(m=>m.name.toLowerCase())).size!==t.members.length)throw Error('MEMBERSHIP_DUPLICATE_NAMES');
  for(const m of t.members)memberReferences(t,m);
}
function prepare(file,target,c){
  const dir=path.dirname(file);if(configHash(readJson(file))!==configHash(c))throw Error('MEMBERSHIP_INPUT_CHANGED team.json');checkTarget(c,target);
  const before=Object.fromEntries(files.map(name=>{const b=bytes(path.join(dir,name));return [name,{sha256:b===null?null:hash(b),bytes:b===null?null:b.toString('base64')}];}));
  const state=decode(before['state.json']),id=crypto.randomUUID();
  const r={schemaVersion:1,id,configFile:file,revision:target.membershipRevision,status:'PREPARED',createdAt:stamp(),target,
    added:target.members.slice(c.members.length).map(m=>m.name),before,members:{},receipts:{},attempts:[]};
  for(const m of c.members)r.members[m.name]={threadId:state.members[m.name].threadId,status:'EXISTING'};
  const recordFile=safeDirectory(path.join(dir,'membership',id,'operation.json'));fs.mkdirSync(path.dirname(recordFile),{recursive:true,mode:0o700});
  writeJson(recordFile,r);writeJson(path.join(dir,MEMBERSHIP_FILE),{schemaVersion:1,id});return {...r,recordFile};
}
async function idle(rpc,c,m,id,state){
  const t=(await rpc.request('thread/read',{threadId:id,includeTurns:false})).thread;
  if(t?.id!==id||t.sessionId!==id||!samePath(t.cwd,state?.binding?.workspace||c.repoRoot)||t.name!==memberDisplayName(c,m.name))throw Error(`MEMBERSHIP_IDENTITY_MISMATCH ${m.name}`);
  if(!['idle','notLoaded'].includes(t.status?.type))throw Error(`MEMBERSHIP_MEMBER_BUSY ${m.name}`);
  const q=await rpc.request('thread/queue/list',{threadId:id,limit:1});
  if(!Array.isArray(q.data)||q.data.length||q.nextCursor)throw Error(`MEMBERSHIP_QUEUE_NOT_EMPTY ${m.name}`);
  const goal=await rpc.request('thread/goal/get',{threadId:id});
  if(!Object.hasOwn(goal,'goal')||(goal.goal!==null&&!['complete','paused','blocked','budgetLimited','usageLimited'].includes(goal.goal.status)))throw Error(`MEMBERSHIP_GOAL_ACTIVE_OR_UNKNOWN ${m.name}`);
}
function publication(r){
  const c=r.target,h=configHash(c),state=decode(r.before['state.json']),old=decode(r.before[PROVISION_FILE]);
  const record=old||{schemaVersion:1,members:{},learning:{},attempts:[],createdAt:r.createdAt,origin:'released-legacy-team'};
  state.configHash=h;state.snapshotOnly=true;
  for(const m of c.members){
    if(r.added.includes(m.name))state.members[m.name]={name:m.name,jobRole:m.jobRole,threadId:r.members[m.name].threadId,sessionId:r.members[m.name].threadId,status:'IDLE',ready:false};
    record.members[m.name]={...record.members[m.name],...(r.added.includes(m.name)?{permissionActual:r.members[m.name].permissionActual,permissionVerification:r.members[m.name].permissionVerification}:{}),threadId:r.members[m.name].threadId,sessionId:r.members[m.name].threadId,status:'APPLIED',rosterRevision:r.revision,rosterInstructionHash:r.receipts[m.name].instructionHash};
  }
  Object.assign(record,{configHash:h,status:'READY_FOR_NATIVE_TUI',maintenanceClose:'CLOSED',createdCount:c.members.length,membershipRevision:r.revision,lastError:null});
  const previous=decode(r.before[HANDOFF_FILE]);
  const handoff={...previous,id:r.id,configHash:h,roster:c.members.map(m=>({name:m.name,threadId:r.members[m.name].threadId})).sort((a,b)=>a.name.localeCompare(b.name)),
    owner:null,status:'RELEASED_TO_NATIVE',previousHandoffId:previous.id,previousReportFile:previous.reportFile,reportFile:path.join(path.dirname(r.recordFile),'handoff-result.json'),membershipRevision:r.revision,finishedAt:stamp(),historyDeleted:false,threadsArchived:false};
  return {'team.json':c,[PROVISION_FILE]:record,'state.json':state,[HANDOFF_FILE]:handoff};
}
function commitPublication(dir,r,save,afterWrite){
  // The journal is a read barrier for every tool consumer. Each file accepts
  // only its original or target bytes; a crash can resume, foreign edits cannot.
  const targetBytes=Object.fromEntries(files.map(n=>[n,Buffer.from(JSON.stringify(r.publish[n],null,2)+'\n')]));
  for(const n of files){const actual=byteHash(path.join(dir,n));if(actual!==r.before[n].sha256&&actual!==hash(targetBytes[n]))throw Error(`MEMBERSHIP_PUBLICATION_CONFLICT ${n}`);}
  for(const n of files){
    if(byteHash(path.join(dir,n))!==hash(targetBytes[n])){writeJson(path.join(dir,n),r.publish[n]);afterWrite?.(n);}
  }
  for(const n of files)if(byteHash(path.join(dir,n))!==hash(targetBytes[n]))throw Error(`MEMBERSHIP_PUBLICATION_NOT_VERIFIED ${n}`);
  writeJson(r.publish[HANDOFF_FILE].reportFile,r.publish[HANDOFF_FILE]);
  r.status='COMPLETED';r.completedAt=stamp();r.lastError=null;save();
}

export async function addMembers(file,{target,confirmed=false,connect,run=command,log=console.log,afterWrite}={}){
  if(!confirmed)throw Error('MEMBERSHIP_CONFIRMATION_REQUIRED');
  file=safeDirectory(file);const dir=path.dirname(file),lock=path.join(dir,MEMBERSHIP_LOCK);
  if(fs.existsSync(lock))throw Error('MEMBERSHIP_WRITER_OR_UNKNOWN_NO_REPLAY');
  let r=membershipOperation(file);
  if(r?.status==='COMPLETED'&&!target)return r;
  const fresh=!r||r.status==='COMPLETED',admitted=fresh?inspectExpandableTeam(file):null,previousId=r?.id;
  if(!fresh&&target&&configHash(target)!==configHash(r.target))throw Error('MEMBERSHIP_PENDING_DIFFERENT_SELECTION');
  const lockBytes=Buffer.from(JSON.stringify({pid:process.pid,id:crypto.randomUUID()}));fs.writeFileSync(lock,lockBytes,{flag:'wx',mode:0o600});
  let rpc,closed=true,attempt;
  const save=()=>{if(r)writeJson(r.recordFile,r);};
  try{
    if(membershipOperation(file)?.id!==previousId)throw Error('MEMBERSHIP_SELECTION_CHANGED');
    if(fresh)r=prepare(file,target,admitted);
    attempt={startedAt:stamp()};r.attempts.push(attempt);save();
    noOtherOwner(dir);assertNoOpenViews(file);
    if(r.maintenanceClose==='UNKNOWN')throw Error('MEMBERSHIP_CLOSE_UNKNOWN');
    if(r.status==='COMMITTING'){commitPublication(dir,r,save,afterWrite);attempt.status='COMPLETED';save();return r;}
    unchanged(dir,r);
    if(Object.values(r.members).some(m=>['CREATING','CREATE_UNKNOWN','NAMING','NAME_UNKNOWN'].includes(m.status))||Object.values(r.receipts).some(m=>['INJECTING','UNKNOWN'].includes(m.status)))throw Error('MEMBERSHIP_UNKNOWN_NO_RECREATE_OR_REPLAY');
    if(Object.values(r.members).some(m=>m.status==='PERMISSION_MISMATCH'))throw Error('NATIVE_PERMISSION_NOT_CONFIRMED_USE_SAVED_DIAGNOSTIC_NO_RECREATE');
    const c=r.target,state=decode(r.before['state.json']);
    r.cliVersion=run(c.codexExecutable,['--version']).trim();run(c.codexExecutable,['queue','--help']);
    if(!connect)run(c.codexExecutable,['app-server','daemon','start']);
    rpc=connect?await connect():new NativeMaintenanceClient(c.codexExecutable);await rpc.initialize();
    r.maintenanceClose='OPEN';save();
    // Before any new session, make sure the existing members can receive their
    // updated roster. A busy Lead does not cause an ever-growing partial team.
    for(const m of c.members.filter(m=>!r.added.includes(m.name)))await idle(rpc,c,m,r.members[m.name].threadId,state.members[m.name]);
    for(const m of c.members.filter(m=>r.added.includes(m.name))){
      unchanged(dir,r);let saved=r.members[m.name];
      if(!saved?.threadId){
        saved=r.members[m.name]={status:'CREATING'};save();
        try{
          const created=await rpc.request('thread/start',{cwd:c.repoRoot,developerInstructions:nativeRolePrompt(c,m),ephemeral:false,...(m.model?{model:m.model}:{}),...permissionParameters(m)});
          const t=created.thread;
          if(!uuid.test(t?.id||'')||t.sessionId!==t.id)throw Error('MEMBERSHIP_CREATED_ID_UNKNOWN');
          Object.assign(saved,{threadId:t.id,status:'CREATED',permissionActual:effectivePermissions(created)});save();
          saved.permissionVerification=verifyPermissions(m,created);save();
        }catch(e){saved.status=e.permissionMismatch?'PERMISSION_MISMATCH':e.rejected?'CREATE_REJECTED':'CREATE_UNKNOWN';saved.error=e.message;save();throw e;}
      }
      if(['CREATED','NAME_REJECTED'].includes(saved.status)){
        saved.status='NAMING';save();
        try{await rpc.request('thread/name/set',{threadId:saved.threadId,name:memberDisplayName(c,m.name)});saved.status='NAMED';save();}
        catch(e){saved.status=e.rejected?'NAME_REJECTED':'NAME_UNKNOWN';saved.error=e.message;save();throw e;}
      }
      log(`新增 ${m.name}：会话已保存；复用成功记录，不重复创建。`);
    }
    const roster=`团队名册更新 v${r.revision}。以下完整映射替代此前名册；原成员职责、任务、权限、HOLD、失败和UNKNOWN保持。扩容完成由人类确认后再派新任务。\n${nativeRosterPrompt(c,r)}`;
    for(const m of c.members){
      if(r.receipts[m.name]?.status==='APPLIED')continue;
      unchanged(dir,r);await idle(rpc,c,m,r.members[m.name].threadId,state.members[m.name]);
      const resumed=await rpc.request('thread/resume',{threadId:r.members[m.name].threadId,excludeTurns:true});
      if(r.added.includes(m.name)){
        const saved=r.members[m.name];saved.permissionActual=effectivePermissions(resumed);save();
        try{saved.permissionVerification=verifyPermissions(m,resumed);save();}
        catch(e){saved.status='PERMISSION_MISMATCH';saved.error=e.message;save();throw e;}
      }
      if(resumed.thread?.canAcceptDirectInput!==true)throw Error(`MEMBERSHIP_MEMBER_READONLY ${m.name}`);
      await idle(rpc,c,m,r.members[m.name].threadId,state.members[m.name]);
      const text=(r.added.includes(m.name)?nativeRolePrompt(c,m)+'\n\n':'')+roster;
      const receipt=r.receipts[m.name]={status:'INJECTING',instructionHash:hash(text)};save();
      try{await rpc.request('thread/inject_items',{threadId:r.members[m.name].threadId,items:[{type:'message',role:'developer',content:[{type:'input_text',text}]}]});receipt.status='APPLIED';receipt.at=stamp();save();}
      catch(e){receipt.status=e.rejected?'REJECTED':'UNKNOWN';receipt.error=e.message;save();throw e;}
      log(`${m.name}：名册 v${r.revision} 已写入；未发送任务或重复学习。`);
    }
    try{await rpc.close();rpc=null;r.maintenanceClose='CLOSED';save();}
    catch(e){closed=false;r.maintenanceClose='UNKNOWN';r.closeError=e.message;save();throw e;}
    unchanged(dir,r);r.publish=publication(r);r.status='COMMITTING';save();
    commitPublication(dir,r,save,afterWrite);attempt.status='COMPLETED';save();return r;
  }catch(e){if(attempt){attempt.status='FAILED_OR_UNKNOWN';attempt.error=e.message;r.lastError=e.message;save();}throw e;}
  finally{
    if(attempt)attempt.finishedAt=stamp();
    try{if(rpc&&closed){await rpc.close();r.maintenanceClose='CLOSED';}if(attempt)save();}
    catch(e){closed=false;r.maintenanceClose='UNKNOWN';r.closeError=e.message;save();throw e;}
    finally{if(closed&&fs.existsSync(lock)&&fs.readFileSync(lock).equals(lockBytes))fs.unlinkSync(lock);}
  }
}
