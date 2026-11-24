import fs from 'node:fs';
import {permissionMode,permissionModes,permissionParameters,verifyPermissions,effectivePermissions} from './permissions.mjs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {NativeMaintenanceClient} from './native-communication.mjs';
import {hash,readJson,writeJson,safeDirectory,validateConfig,memberReferences,memberDisplayName} from './core.mjs';
import {releaseToNative,HANDOFF_FILE,standaloneLaunch} from './handoff.mjs';
import {windowTickets,windowTicketText} from './windows.mjs';
import {assertMembershipStable,printMembership} from './membership-state.mjs';

export const PROVISION_FILE='native-provision.json';
export const TEAM_TOOL_VERSION='0.12.3';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function input(file,{allowPending=false}={}){
  if(!path.isAbsolute(file))throw Error('ABSOLUTE_TEAM_CONFIG_REQUIRED');
  if(!allowPending)assertMembershipStable(file);
  file=safeDirectory(file);const config=validateConfig(readJson(file)),dir=path.dirname(file);
  if(config.initializationMode!=='codex-native')throw Error('EXISTING_TEAM_USE_COMMUNICATION_MIGRATION');
  for(const n of ['broker.lock','endpoint.json','native-endpoint.json','cleanup-state.json','transport-migration.json'])if(fs.existsSync(path.join(dir,n)))throw Error('NATIVE_TEAM_HAS_LEGACY_OWNER_OR_RETIRED');
  for(const m of config.members)memberReferences(config,m);
  return {file,config,dir,configHash:hash(JSON.stringify(config)),recordFile:safeDirectory(path.join(dir,PROVISION_FILE))};
}
function assertReadyRecord(x,r){
  const names=x.config.members.map(m=>m.name).sort();
  if(JSON.stringify(Object.keys(r.members||{}).sort())!==JSON.stringify(names))throw Error('NATIVE_READY_ROSTER_MISMATCH');
  const state=readJson(path.join(x.dir,'state.json'));
  for(const name of names){const m=r.members[name];if(m.status!=='APPLIED'||!uuid.test(m.threadId)||m.threadId!==state.members?.[name]?.threadId)throw Error('NATIVE_READY_MEMBER_MISMATCH');standaloneLaunch(x.file,name);}
}
// Read-only readiness check: release/repair/status must never create members.
export function inspectNativeTeam(file){
  const x=input(file);
  if(fs.existsSync(path.join(x.dir,'native-provision.lock')))throw Error('NATIVE_PROVISION_IN_PROGRESS_OR_UNKNOWN');
  if(!fs.existsSync(x.recordFile))throw Error('NATIVE_TEAM_INCOMPLETE_USE_CONTINUE');
  const r=readJson(x.recordFile);
  if(r.status!=='READY_FOR_NATIVE_TUI'||r.configHash!==x.configHash||r.maintenanceClose!=='CLOSED')throw Error('NATIVE_TEAM_INCOMPLETE_OR_UNKNOWN_USE_STATUS');
  assertReadyRecord(x,r);return r;
}
export function nativeRolePrompt(c,m){
  if(c.profile==='portable-project-v1'){
    return [`你是 ${m.name}，岗位 ${m.jobRole}，工作目录 ${c.repoRoot}，汇报给 ${m.reportsTo}。`,
      `职责：${m.responsibilities}`,`目标：${m.objective}`,`工作边界：${m.scope}`,`交付：${m.outputs}`,
      '按用户授权和当前项目适用的 AGENTS.md 执行。首次接单先读取下列规范；按本岗职责向协调者报告结果、证据和缺项。团队创建本身仅配置岗位，等待用户分派工作。',
      JSON.stringify(memberReferences(c,m),null,2)].join('\n\n');
  }
  throw Error("INVALID_TEAM_PROFILE");
}
export function nativeRosterPrompt(c,record){
  return ['本团队原生通信映射（仅本机使用，禁止提交公开仓库）：',JSON.stringify(c.members.map(m=>({name:m.name,role:m.jobRole,threadId:record.members[m.name].threadId,reportsTo:m.reportsTo}))),
    `协调者：${c.lead||'无，由人类直接管理'}。有协调者时，其在既有授权内分派，成员向其回报；没有协调者时，成员直接向人类回报，不自动增设Lead。`,
    `优先使用当前客户端实际提供的原生send_message_to_thread等工具；没有该工具时，使用本机官方可执行文件 ${JSON.stringify(c.codexExecutable)} queue --thread <上表准确UUID> --message <文本>。以参数数组调用，不增加--remote、不改变CODEX_HOME或权限。`,
    '每项消息用唯一编号；queued只表示排队，需区分成员实际执行/回报/协调者确认。结果UNKNOWN不得盲目重发；遵守本项目的通信权限。',
    '本机配置和创建记录只证明岗位及会话映射，不是实时任务看板。此说明不发送任务、不代替正式任务授权，不证明关闭TUI后的接收能力已经验收。',
  ].join('\n\n');
}
function command(exe,args){
  const r=spawnSync(exe,args,{windowsHide:true,shell:false,encoding:'utf8',timeout:15000,maxBuffer:32768});
  if(r.error||r.status!==0)throw Error(`NATIVE_COMMAND_FAILED ${args.slice(0,3).join(' ')}: ${r.error?.code||r.status}`);
  return r.stdout;
}
async function assertIdentity(rpc,c,m,id){
  const t=(await rpc.request('thread/read',{threadId:id,includeTurns:false})).thread;
  if(t?.id!==id||t.sessionId!==id||!t.cwd||path.resolve(t.cwd).toLowerCase()!==path.resolve(c.repoRoot).toLowerCase()||t.name!==memberDisplayName(c,m.name))throw Error(`NATIVE_MEMBER_IDENTITY_MISMATCH ${m.name}`);
  if(!['idle','notLoaded'].includes(t.status?.type))throw Error(`NATIVE_MEMBER_NOT_IDLE ${m.name}`);
  const q=await rpc.request('thread/queue/list',{threadId:id,limit:1});if(!Array.isArray(q.data)||q.data.length||q.nextCursor)throw Error(`NATIVE_MEMBER_QUEUE_NOT_EMPTY ${m.name}`);
}
export async function provisionNativeTeam(file,{confirmed=false,connect,run=command,log=console.log}={}){
  const x=input(file),c=x.config;
  if(!confirmed)throw Error('NATIVE_TEAM_CREATION_CONFIRMATION_REQUIRED');
  const record=fs.existsSync(x.recordFile)?readJson(x.recordFile):{schemaVersion:1,configHash:x.configHash,status:'PREPARED',members:{},attempts:[],createdAt:new Date().toISOString(),learning:{}};
  if(record.configHash!==x.configHash)throw Error('NATIVE_TEAM_INPUT_CHANGED');
  if(record.maintenanceClose==='UNKNOWN')throw Error('NATIVE_TEAM_CLOSE_UNKNOWN');
  for(const m of Object.values(record.members))if(['CREATING','CREATE_UNKNOWN','INJECTING','INJECTION_UNKNOWN'].includes(m.status))throw Error('NATIVE_TEAM_UNKNOWN_NO_RECREATE_OR_REPLAY');
  if(Object.values(record.members).some(m=>m.status==='PERMISSION_MISMATCH'))throw Error('NATIVE_PERMISSION_NOT_CONFIRMED_USE_SAVED_DIAGNOSTIC_NO_RECREATE');
  if(record.status==='READY_FOR_NATIVE_TUI'){
    if(record.maintenanceClose!=='CLOSED'||fs.existsSync(path.join(x.dir,'native-provision.lock')))throw Error('NATIVE_PROVISION_IN_PROGRESS_OR_UNKNOWN');
    if(!fs.existsSync(path.join(x.dir,HANDOFF_FILE)))throw Error('NATIVE_READY_RECORD_INCOMPLETE');
    assertReadyRecord(x,record);
    log('复用原有岗位和会话；未再次创建或初始化。');return record;
  }
  const lock=path.join(x.dir,'native-provision.lock'),lockBytes=Buffer.from(JSON.stringify({pid:process.pid,id:crypto.randomUUID()}));
  fs.writeFileSync(lock,lockBytes,{flag:'wx',mode:0o600});let rpc,closed=true;
  const attempt={startedAt:new Date().toISOString()};record.attempts.push(attempt);
  const save=()=>writeJson(x.recordFile,record);
  try{
    record.cliVersion=run(c.codexExecutable,['--version']).trim();run(c.codexExecutable,['queue','--help']);
    if(!connect)run(c.codexExecutable,['app-server','daemon','start']);
    rpc=connect?await connect():new NativeMaintenanceClient(c.codexExecutable);await rpc.initialize();
    for(const member of c.members){
      if(input(file).configHash!==x.configHash)throw Error('NATIVE_TEAM_INPUT_CHANGED');
      let m=record.members[member.name];
      if(!m?.threadId){
        m=record.members[member.name]={status:'CREATING',at:new Date().toISOString()};save();
        try{
          const r=await rpc.request('thread/start',{cwd:c.repoRoot,developerInstructions:nativeRolePrompt(c,member),ephemeral:false,...(member.model?{model:member.model}:{}),...permissionParameters(member)});
          if(!uuid.test(r.thread?.id||'')||r.thread.sessionId!==r.thread.id)throw Error('NATIVE_CREATED_ID_UNKNOWN');
          m.threadId=r.thread.id;m.sessionId=r.thread.id;m.status='CREATED';m.permissionActual=effectivePermissions(r);save();
          m.permissionVerification=verifyPermissions(member,r);save();
        }catch(e){m.status=e.permissionMismatch?'PERMISSION_MISMATCH':e.rejected?'CREATE_REJECTED':'CREATE_UNKNOWN';m.error=e.message;save();throw e;}
      }
      if(m.status==='CREATED'){
        await rpc.request('thread/name/set',{threadId:m.threadId,name:memberDisplayName(c,member.name)});m.status='NAMED';save();
      }
      log(`${member.name}：会话已记录，${m.status==='APPLIED'?'原生通信已配置':'等待完整名册'}。`);
    }
    const roster=nativeRosterPrompt(c,record);
    for(const member of c.members){
      const m=record.members[member.name];
      if(m.status==='APPLIED')continue;
      await assertIdentity(rpc,c,member,m.threadId);
      const resumed=await rpc.request('thread/resume',{threadId:m.threadId,excludeTurns:true});
      m.permissionActual=effectivePermissions(resumed);save();
      try{m.permissionVerification=verifyPermissions(member,resumed);save();}
      catch(e){m.status='PERMISSION_MISMATCH';m.error=e.message;save();throw e;}
      if(resumed.thread?.canAcceptDirectInput!==true)throw Error(`NATIVE_MEMBER_READONLY ${member.name}`);
      await assertIdentity(rpc,c,member,m.threadId);
      const instructions=nativeRolePrompt(c,member)+'\n\n'+roster;
      m.status='INJECTING';m.instructionHash=hash(instructions);save();
      try{await rpc.request('thread/inject_items',{threadId:m.threadId,items:[{type:'message',role:'developer',content:[{type:'input_text',text:instructions}]}]});m.status='APPLIED';save();}
      catch(e){m.status=e.rejected?'INJECTION_REJECTED':'INJECTION_UNKNOWN';m.error=e.message;save();throw e;}
    }
    const stateFile=path.join(x.dir,'state.json');
    if(!fs.existsSync(stateFile))writeJson(stateFile,{schemaVersion:1,configHash:x.configHash,members:Object.fromEntries(c.members.map(m=>[m.name,{name:m.name,jobRole:m.jobRole,threadId:record.members[m.name].threadId,sessionId:record.members[m.name].threadId,status:'IDLE',ready:false}])),messages:[],events:[],sequence:0,snapshotOnly:true});
    // Reuse the existing native-launch ownership marker. There never was a
    // private owner here: releaseToNative records owner:null and stops no daemon.
    await releaseToNative(file);
    assertReadyRecord(x,record);
    record.status='READY_FOR_NATIVE_TUI';record.createdCount=c.members.length;record.lastError=null;attempt.status='COMPLETED';save();return record;
  }catch(e){attempt.status='FAILED_OR_UNKNOWN';attempt.error=e.message;record.lastError=e.message;save();throw e;}
  finally{
    attempt.finishedAt=new Date().toISOString();
    try{if(rpc)await rpc.close();record.maintenanceClose='CLOSED';save();}
    catch(e){closed=false;record.maintenanceClose='UNKNOWN';record.closeError=e.message;save();throw e;}
    finally{if(closed&&fs.existsSync(lock)&&fs.readFileSync(lock).equals(lockBytes))fs.unlinkSync(lock);}
  }
}
export function queueRoleLearning(file,{confirmed=false,members,run=command,log=console.log}={}){
  const x=input(file),r=readJson(x.recordFile);
  if(!confirmed||r.status!=='READY_FOR_NATIVE_TUI'||r.configHash!==x.configHash||r.maintenanceClose!=='CLOSED')throw Error('NATIVE_LEARNING_NOT_READY_OR_NOT_CONFIRMED');
  if(fs.existsSync(path.join(x.dir,'native-provision.lock')))throw Error('NATIVE_PROVISION_IN_PROGRESS_OR_UNKNOWN');
  assertReadyRecord(x,r);
  const selected=members||x.config.members.map(m=>m.name);
  if(!Array.isArray(selected)||!selected.length||new Set(selected).size!==selected.length||selected.some(n=>!x.config.members.some(m=>m.name===n)))throw Error('INVALID_LEARNING_SELECTION');
  for(const name of selected){
    if(r.learning[name]){log(`${name}：已存在学习投递记录 ${r.learning[name].status}；不重复发送。`);continue;}
    const entry=r.learning[name]={id:crypto.randomUUID(),status:'SENDING',at:new Date().toISOString()};writeJson(x.recordFile,r);
    const message=`岗位初始化 ${entry.id}：仅按已保存的岗位说明读取本岗必读资料，文字报告职责、边界、已读路径和缺项。此轮不向其他成员发消息，不改文件，不执行开发、安装或服务器操作，不设置goal。学习结束后等待人类正式任务。`;
    try{run(x.config.codexExecutable,['queue','--thread',r.members[name].threadId,'--message',message]);entry.status='QUEUED';writeJson(x.recordFile,r);log(`${name}：岗位学习已排队；完成与缺项请在原生TUI核对。`);}
    catch(e){entry.status='UNKNOWN';entry.error=e.message;writeJson(x.recordFile,r);throw e;}
  }
  return r;
}
export function nativeTeamSummary(file,log=console.log){
  const x=input(file,{allowPending:true}),r=fs.existsSync(x.recordFile)?readJson(x.recordFile):null;
  const sha=spawnSync('git',['-C',x.config.repoRoot,'rev-parse','HEAD'],{encoding:'utf8',windowsHide:true,timeout:5000});
  const top=spawnSync('git',['-C',x.config.repoRoot,'rev-parse','--show-toplevel'],{encoding:'utf8',windowsHide:true,timeout:5000});
  const exactRoot=top.status===0&&path.resolve(top.stdout.trim()).toLowerCase()===path.resolve(x.config.repoRoot).toLowerCase();
  const stageFile=path.join(x.dir,'wizard-state.json'),stage=fs.existsSync(stageFile)?readJson(stageFile):{};
  log(`===== Project Agent Team 诊断摘要开始 =====\n工具：v${TEAM_TOOL_VERSION}；Node：${process.version}；Codex：${r?.cliVersion||'未核得'}\nGit HEAD：${exactRoot&&sha.status===0?sha.stdout.trim():'未核得（不是仓库根或无提交）'}\n本机标识：${x.config.machine}；团队代次：${(x.config.generation?.slice(0,8)||'原有代次')}\n配置：${file}\n上次阶段：${stage.phase||'未记录'}；上一套团队（非当前代次）：${stage.previousArchive||'本轮未归档'}\n成员数：${x.config.members.length}；协调者：${x.config.lead||'人类'}\n通信：Codex原生；未创建Project Agent Team专属后台\n创建：${r?.status||'仅有配置'}；维护进程：${r?.maintenanceClose||'未核得'}`);
  for(const m of x.config.members)log(`${m.name} / ${m.jobRole}：${r?.members[m.name]?.status||'未创建'}；学习投递 ${r?.learning?.[m.name]?.status||'未发送'}；岗位就绪未核收`);
  const latest=new Map();for(const w of windowTickets(file).sort((a,b)=>(a.createdAt||'').localeCompare(b.createdAt||'')))latest.set(w.member,w);
  for(const w of latest.values())log(`窗口 ${windowTicketText(w)}；进程状态不等于真实对话通过`);
  log('创建时权限选择：\n'+x.config.members.map(m=>`  ${m.name}：${permissionModes[permissionMode(m)]}；创建/初始化回读 ${r?.members?.[m.name]?.permissionVerification?.status||'未记录'}`).join('\n'));
  log('此处为创建时记录，非当前实时权限；后续人工调整以原生 /permissions 为准。普通Resume不强行重设权限，原生收发和窗口接续按现场证据核收。');
  printMembership(file,log);
  if(r?.lastError)log(`最近失败：${r.lastError.replace(/[a-f0-9]{8}-[a-f0-9-]{27}/gi,'[本地ID]')}`);
  const launcher='Start-AgentTeam.ps1';
  log(`下一步：再次运行 ${launcher}，选择继续或查看状态；已有成功成员不重复创建。UNKNOWN先诊断，不重发。\n可复制本摘要回传；不要发送完整配置或会话ID。\n===== Project Agent Team 诊断摘要结束 =====`);
}
