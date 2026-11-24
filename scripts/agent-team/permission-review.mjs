import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {readJson,writeJson,hash,memberDisplayName,safeDirectory} from './core.mjs';
import {inspectNativeTeam} from './native-team.mjs';
import {NativeMaintenanceClient} from './native-communication.mjs';
import {assertNoOpenViews} from './views.mjs';
import {permissionMode,permissionModes,permissionSettings,effectivePermissions,verifyPermissions} from './permissions.mjs';

function input(file){
  const provision=inspectNativeTeam(file),config=readJson(file);
  assertNoOpenViews(file);
  return {file,config,provision,dir:path.dirname(file),configHash:hash(JSON.stringify(config))};
}
async function connection(x,connect,body,onClosed=()=>{}){
  const rpc=connect?await connect():new NativeMaintenanceClient(x.config.codexExecutable);
  try{const server=await rpc.initialize();return await body(rpc,server);}
  finally{await rpc.close();onClosed();}
}
async function current(rpc,x,name){
  const id=x.provision.members[name]?.threadId;
  if(!id)throw Error('UNKNOWN_PERMISSION_MEMBER');
  const t=(await rpc.request('thread/read',{threadId:id,includeTurns:false})).thread;
  if(t?.id!==id||t.sessionId!==id||t.name!==memberDisplayName(x.config,name)||!t.cwd||path.resolve(t.cwd).toLowerCase()!==path.resolve(x.config.repoRoot).toLowerCase())throw Error(`PERMISSION_MEMBER_IDENTITY_MISMATCH ${name}`);
  if(!['idle','notLoaded'].includes(t.status?.type))throw Error(`PERMISSION_MEMBER_NOT_IDLE ${name}`);
  const q=await rpc.request('thread/queue/list',{threadId:id,limit:1});
  if(!Array.isArray(q.data)||q.data.length||q.nextCursor)throw Error(`PERMISSION_MEMBER_QUEUE_NOT_EMPTY ${name}`);
  const response=await rpc.request('thread/resume',{threadId:id,excludeTurns:true});
  if(response.thread?.id!==id||response.thread.canAcceptDirectInput!==true)throw Error(`PERMISSION_MEMBER_OPEN_ELSEWHERE ${name}`);
  return {...effectivePermissions(response),activePermissionProfile:response.activePermissionProfile??null};
}
export function currentPermissionLabel(actual){
  for(const mode of ['auto-review','full-access']){
    try{verifyPermissions({name:'current',permissionMode:mode},actual);return permissionModes[mode];}catch{}
  }
  if(actual.approvalPolicy==='on-request'&&actual.approvalsReviewer==='user'&&actual.sandbox?.type==='workspaceWrite')return '请求审批（Ask for approval）';
  return '其他／未完整确认；查看原生 /permissions';
}
// No policy overrides, no model turn and no persistent configuration changes.
export async function inspectTeamPermissions(file,{connect,log=console.log}={}){
  const x=input(file),report={at:new Date().toISOString(),configHash:x.configHash,creationCliVersion:x.provision.cliVersion,members:{}};
  await connection(x,connect,async(rpc,server)=>{
    report.server=server?.userAgent??null;
    for(const m of x.config.members){
      const row=report.members[m.name]={selectedAtCreation:permissionMode(m)};
      try{row.actual=await current(rpc,x,m.name);row.status='READ';try{verifyPermissions(m,row.actual);row.matchesCreation=true;}catch{row.matchesCreation=false;}}
      catch(e){row.status='UNAVAILABLE';row.error=e.message;}
    }
  });
  report.maintenanceClose='CLOSED';
  log('\n===== Project Agent Team 当前权限核对 =====');
  log(`创建CLI：${report.creationCliVersion||'未记录'}；当前服务：${report.server||'未取得'}；检查连接：CLOSED`);
  for(const [name,row] of Object.entries(report.members)){
    log(`${name}：创建选择=${permissionModes[row.selectedAtCreation]}；当前=${row.actual?currentPermissionLabel(row.actual):row.error}`);
    if(row.actual)log(`  policy=${JSON.stringify(row.actual.approvalPolicy)}；reviewer=${row.actual.approvalsReviewer}；sandbox=${row.actual.sandbox?.type||'UNKNOWN'}；profile=${row.actual.activePermissionProfile?.id||'未记录'}；${row.selectedAtCreation==='inherit'?'创建时未指定权限':row.matchesCreation?'与创建选择一致':'与创建选择不同（也可能是之后人工调整）'}`);
  }
  log('仅核对，不修改。TUI显示与此不同或再次Resume变化时，保留两者证据；不重建团队。\n===== Project Agent Team 当前权限核对结束 =====');
  return report;
}

// Explicit operator choice only. Never automatically restore creation settings.
export async function applyTeamPermissions(file,report,changes,{confirmed=false,connect,log=console.log}={}){
  const x=input(file);
  if(!confirmed)throw Error('PERMISSION_CHANGE_CONFIRMATION_REQUIRED');
  if(report.configHash!==x.configHash||report.maintenanceClose!=='CLOSED')throw Error('PERMISSION_REVIEW_STALE');
  if(!Array.isArray(changes)||!changes.length||new Set(changes.map(m=>m.name)).size!==changes.length)throw Error('INVALID_PERMISSION_CHANGES');
  for(const m of changes){if(!x.config.members.some(n=>n.name===m.name)||!['auto-review','full-access'].includes(permissionMode(m))||report.members[m.name]?.status!=='READ')throw Error('INVALID_PERMISSION_CHANGE_MEMBER_OR_MODE');}
  const recordDir=safeDirectory(path.join(x.dir,'permission-reviews'));fs.mkdirSync(recordDir,{recursive:true,mode:0o700});
  const lock=path.join(x.dir,'native-provision.lock'),lockBytes=Buffer.from(JSON.stringify({id:crypto.randomUUID(),pid:process.pid,action:'permissions'}));
  fs.writeFileSync(lock,lockBytes,{flag:'wx',mode:0o600});
  const result={schemaVersion:1,at:new Date().toISOString(),configHash:x.configHash,status:'CHECKING',members:{},maintenanceClose:'UNKNOWN'};
  const record=path.join(recordDir,`${crypto.randomUUID()}.json`);let closed=true;
  const save=()=>writeJson(record,result);
  try{
    save();
    closed=false;
    await connection(x,connect,async rpc=>{
      // Preflight every selected member before the first settings write.
      for(const m of changes){
        const actual=await current(rpc,x,m.name);
        if(JSON.stringify(actual)!==JSON.stringify(report.members[m.name].actual))throw Error(`PERMISSION_CHANGED_SINCE_REVIEW ${m.name}`);
        const g=await rpc.request('thread/goal/get',{threadId:x.provision.members[m.name].threadId});
        if(!Object.hasOwn(g,'goal')||g.goal&&g.goal.status!=='complete')throw Error(`PERMISSION_MEMBER_GOAL_PENDING ${m.name}`);
      }
      for(const m of changes){
        if(hash(JSON.stringify(readJson(file)))!==x.configHash)throw Error('PERMISSION_CONFIG_CHANGED');
        const before=await current(rpc,x,m.name);
        if(JSON.stringify(before)!==JSON.stringify(report.members[m.name].actual))throw Error(`PERMISSION_CHANGED_SINCE_REVIEW ${m.name}`);
        const row=result.members[m.name]={requested:permissionMode(m),before,status:'APPLYING'};save();
        try{
          await rpc.request('thread/settings/update',{threadId:x.provision.members[m.name].threadId,...permissionSettings(m,before)});
          const response=await rpc.request('thread/resume',{threadId:x.provision.members[m.name].threadId,excludeTurns:true});
          row.actual=effectivePermissions(response);verifyPermissions(m,response);row.status='APPLIED';save();
        }catch(e){row.status=e.permissionMismatch?'MISMATCH':e.rejected?'REJECTED':'UNKNOWN';row.error=e.message;save();throw e;}
      }
    },()=>{closed=true;result.maintenanceClose='CLOSED';});
    closed=true;result.maintenanceClose='CLOSED';save();
    // Verify through a fresh connection without overrides, like plain resume.
    closed=false;result.maintenanceClose='UNKNOWN';save();
    await connection(x,connect,async rpc=>{
      for(const m of changes){const row=result.members[m.name];row.readback=await current(rpc,x,m.name);verifyPermissions(m,row.readback);row.status='VERIFIED_AFTER_RECONNECT';save();}
    },()=>{closed=true;result.maintenanceClose='CLOSED';});
    closed=true;result.status='VERIFIED_AFTER_RECONNECT';result.maintenanceClose='CLOSED';save();
    log('权限设置及断开后的原生回读已通过；未创建会话、未发送任务、未重放学习。请在普通/resume后的/permissions现场核对。');
    for(const [name,row] of Object.entries(result.members))log(`${name}：修正后=${currentPermissionLabel(row.readback)}；policy=${JSON.stringify(row.readback.approvalPolicy)}；reviewer=${row.readback.approvalsReviewer}；${row.status}`);
    return {...result,record,config:file};
  }catch(e){
    result.status='NEEDS_ATTENTION';result.error=e.message;save();throw e;
  }finally{
    // connection() has awaited close even on a rejected settings request. A
    // close error must keep the marker, not invite another client to take over.
    // Track that fact independently of whether the operation itself succeeded.
    save();if(closed&&fs.existsSync(lock)&&fs.readFileSync(lock).equals(lockBytes))fs.unlinkSync(lock);
    log(`权限操作记录：${record}；状态：${result.status}；不盲重试UNKNOWN。`);
  }
}
