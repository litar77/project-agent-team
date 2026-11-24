import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readJson, writeJson, safeDirectory, validateConfig } from './core.mjs';
import { preview, applyPlan, isArchiveComplete } from './cleanup.mjs';
import { archiveTeam, archiveState, listManagedTeams } from './archive.mjs';
import { openNative, askYesNo, askChoice } from './native.mjs';
import { openWindows, windowTickets, windowTicketText } from './windows.mjs';
import { assertNoOpenViews } from './views.mjs';
import {validMachine,selectComposition,saveComposition,parseSelection,askText,selectAddition} from './composition.mjs';
import {provisionNativeTeam,queueRoleLearning,nativeTeamSummary,inspectNativeTeam,TEAM_TOOL_VERSION} from './native-team.mjs';
import {addMembers,inspectExpandableTeam} from './membership.mjs';
import {membershipOperation,printMembership} from './membership-state.mjs';
import {inspectTeamPermissions,applyTeamPermissions} from './permission-review.mjs';
import {selectPermissions,permissionModes} from './permissions.mjs';

const samePath=(a,b)=>path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
function actual(file,options){
  if(!path.isAbsolute(file))throw Error('ABSOLUTE_ACTUAL_TEAM_CONFIG_REQUIRED');
  const c=validateConfig(readJson(safeDirectory(file)));
  if(c.machine!==options.machine||!samePath(c.repoRoot,options.repoRoot))throw Error('SELECTED_TEAM_MACHINE_OR_REPOSITORY_MISMATCH');
  return c;
}
export function locate(options){
  if(!path.isAbsolute(options.repoRoot)||!validMachine(options.machine))throw Error('ACTUAL_REPOSITORY_AND_MACHINE_REQUIRED');
  const root=safeDirectory(path.join(options.repoRoot,'.local','agent-teams',options.machine));
  const pointer=path.join(root,'current-team.json');
  if(options.configFile){
    actual(options.configFile,options);
    const retired=path.join(path.dirname(options.configFile),'cleanup-state.json');
    if(fs.existsSync(retired)&&fs.existsSync(pointer)){
      const old=readJson(retired),p=readJson(pointer);
      if(old.status==='WHOLE_TRIAL_TEAM_ARCHIVED'&&old.inspectorProcess==='CLOSED'&&!samePath(p.config,options.configFile)){
        if(p.schemaVersion!==1||p.machine!==options.machine)throw Error('CURRENT_TEAM_POINTER_UNKNOWN');
        actual(p.config,options);return {root,pointer,file:p.config,redirectedFrom:options.configFile};
      }
    }
    if(isArchiveComplete(archiveState(options.configFile)))return {root,pointer,file:null,archivedConfig:options.configFile};
    return {root,pointer,file:options.configFile};
  }
  if(fs.existsSync(pointer)){
    const p=readJson(safeDirectory(pointer));if(p.schemaVersion!==1||p.machine!==options.machine)throw Error('CURRENT_TEAM_POINTER_UNKNOWN');
    actual(p.config,options);
    if(isArchiveComplete(archiveState(p.config)))return {root,pointer,file:null,archivedConfig:p.config};
    return {root,pointer,file:p.config};
  }
  const file=path.join(root,'team.json');if(fs.existsSync(file))actual(file,options);
  if(fs.existsSync(file)&&isArchiveComplete(archiveState(file)))return {root,pointer,file:null,archivedConfig:file};
  return {root,pointer,file:fs.existsSync(file)?file:null};
}

export function saveStage(file,phase,details={}){
  const f=path.join(path.dirname(file),'wizard-state.json'),old=fs.existsSync(f)?readJson(f):{};
  writeJson(f,{...old,schemaVersion:1,config:path.resolve(file),phase,updatedAt:new Date().toISOString(),...details});
}
export function showResult(file,{log=console.log,status='STATUS',error}={}){
  if(readJson(file).initializationMode==='codex-native'){nativeTeamSummary(file,log);if(error)log(`状态：${status}；原因：${error}`);return;}
}

async function wizardSteps(options,{ask=askYesNo,choose=askChoice,read=askText,log=console.log,services={}}={}){
  // Never let piped/no-input execution imply agreement to cleanup or startup.
  if(ask===askYesNo&&(!process.stdin.isTTY||!process.stdout.isTTY))throw Error('INTERACTIVE_TERMINAL_REQUIRED_USE_NONINTERACTIVE_FOR_AUTOMATION');
  const svc={preview,apply:applyPlan,open:openNative,windows:openWindows,...services};
  const location=locate(options);let file=location.file,generation,previousArchive,addedMembers;
  if(location.redirectedFrom)log('指定的旧团队已归档；检测到已建立的当前团队，接续该代次，不重复建队。');
  let action=options.action;
  if(location.archivedConfig){
    log(`当前指针所指团队已归档，历史保留：${location.archivedConfig}`);
    if(action==='continue'||(!options.menu&&!action))return {status:'TEAM_ARCHIVED_USE_NEW_OR_ARCHIVE'};
  }
  if(!file&&['status','release','repaircommunication','addmembers','permissions'].includes(action)){
    log('===== Project Agent Team 诊断摘要开始 =====\n未找到当前团队；未创建成员或启动后台。\n如需建队，再运行同一短入口选择初始化。\n===== Project Agent Team 诊断摘要结束 =====');
    return {status:'NO_CURRENT_TEAM'};
  }
  if(options.menu&&file&&!action){
    const direct=readJson(file).initializationMode==='codex-native';
    action=await choose('本次操作',[['continue','继续当前团队（默认）'],['new','选择岗位和人数，新建独立团队（保留旧团队）'],['preview','只预览岗位组合，不创建会话'],...(!direct?[['rebuild','归档当前旧试建团队并新建原生团队']]:[]),['status','查看状态'],['release',direct?'检查原生会话是否可接续（不创建、不停止共享后台）':'释放空闲旧团队，交还普通 Codex'],...(!direct?[['repaircommunication','修复普通Resume后的原生团队通信（保留现有会话）']]:[]),['addmembers','为当前团队添加成员'],['archive','归档旧团队（保留历史，可选当前或历史团队）'],...(direct?[['permissions','检查／修正当前团队权限（保留会话）']]:[])]);
  }
  if(options.menu&&!file&&!action&&(location.archivedConfig||listManagedTeams(options).teams.length))action=await choose(location.archivedConfig?'当前团队已归档':'没有当前指针，但存在历史团队',[['status','查看状态／退出'],['new','选择岗位和人数，新建团队'],['preview','只预览岗位组合'],['archive','归档其他旧团队（保留历史）']]);
  if(!file&&action==='status')return {status:'NO_CURRENT_TEAM'};
  if(file&&action==='permissions'){
    log('请先正常退出本团队TUI并暂停派发；只核对所选团队，不停止Codex共享后台。');
    const report=await (services.inspectPermissions||inspectTeamPermissions)(file,{log});
    if(!await ask('是否为指定成员调整当前权限？选否仅完成核对。'))return {status:'PERMISSIONS_INSPECTED',config:file};
    const available=Object.entries(report.members).filter(([,v])=>v.status==='READ').map(([name])=>({id:name}));
    if(!available.length)throw Error('NO_IDLE_PERMISSION_MEMBER');
    log(available.map((m,i)=>`${i+1}. ${m.id}`).join('\n'));
    const selection=await read('调整成员编号（逗号分隔），all全选',{defaultValue:'1',validate:s=>!!parseSelection(s,available)});
    const names=parseSelection(selection,available);if(!names)throw Error('INVALID_PERMISSION_MEMBERS');
    const selected=names.map(name=>({name}));await selectPermissions(selected,{read,ask,log,existing:true});
    const changes=selected.filter(m=>m.permissionMode);
    if(!changes.length||!await ask(`确认仅调整 ${changes.map(m=>`${m.name} → ${permissionModes[m.permissionMode]}`).join('、')}？保留身份和历史。`))return {status:'PERMISSIONS_UNCHANGED',config:file};
    return await (services.applyPermissions||applyTeamPermissions)(file,report,changes,{confirmed:true,log});
  }
  if(action==='archive'){
    let r;try{r=await archiveTeam(options,{ask,choose,log,preview:svc.preview,apply:svc.apply});}catch(e){e.archiveHandled=true;throw e;}
    if(r.status==='ARCHIVE_REVIEW_REQUIRED'){const e=Error(`TEAM_ARCHIVE_NOT_CONFIRMED: ${r.result?.error||r.status}`);e.archiveHandled=true;throw e;}
    if(!r.complete||!await ask('所选团队已归档。是否现在继续新建独立团队？选否结束，其他团队保留。'))return r;
    if(file&&samePath(file,r.archivedConfig)){previousArchive='当前团队已归档；历史及配置保留';}
    action='new';
  }
  const expansion=file?membershipOperation(file):null;
  if(expansion&&expansion.status!=='COMPLETED'){
    if(!action||['continue','addmembers'].includes(action)){action='addmembers';log('发现未完成扩容，沿原选择续办；不会再次选择岗位或重复创建成功成员。');}
    else if(!['status','preview'].includes(action))throw Error('MEMBERSHIP_PENDING_USE_ADD_MEMBERS_TO_CONTINUE');
  }
  if(file&&action==='addmembers'){
    log('扩容期间请暂停派发并正常退出本团队成员TUI；保留原Lead、账号、原成员权限及历史，新成员可另选权限。已退出的历史窗口记录将核对实际进程，不要求关闭Codex共享后台。');
    const pending=expansion&&expansion.status!=='COMPLETED';
    const target=pending?undefined:await (services.selectAddition||selectAddition)((services.inspectExpandable||inspectExpandableTeam)(file),options,{read,ask,log});
    if(!await ask(pending?'是否续办这次未完成扩容？成功项复用，UNKNOWN不重放。':`确认仅新增 ${target.members.length-readJson(file).members.length} 名成员，并更新全员通信名册？`))return {status:'CANCELLED',config:file};
    const r=await (services.addMembers||addMembers)(file,{target,confirmed:true,log});addedMembers=r.added;
    saveStage(file,'MEMBERS_ADDED',{membershipRevision:r.revision,addedMembers});
    log(`扩容完成：新增 ${addedMembers.join('、')}；原成员会话保留，名册已同步。岗位学习和实际通信尚待核收。`);
    action='continue';
  }
  if(action==='new'||action==='preview'||(!file&&options.menu)){
    const c=await (services.selectComposition||selectComposition)(options,{read,choose,ask,log});
    if(action==='preview'){log('仅预览：未保存团队配置，未创建会话或发送学习消息。');return {status:'PREVIEW_ONLY'};}
    if(!await ask(`确认创建上述 ${c.members.length} 名成员？保留已有团队；此步不启动功能任务。`))return {status:'CANCELLED'};
    const previous=file||location.archivedConfig;file=(services.saveComposition||saveComposition)(c);
    fs.mkdirSync(location.root,{recursive:true,mode:0o700});writeJson(location.pointer,{schemaVersion:1,machine:options.machine,config:file,previousConfig:previous||null});
    saveStage(file,'CONFIGURED',{previousConfig:previous||null,previousArchive:previousArchive||'未归档，旧团队保留'});
    action='continue';
  }
  if(file&&action==='status'){showResult(file,{log});return {status:'STATUS',config:file};}
  if(file&&readJson(file).initializationMode==='codex-native'){
    if(['release','repaircommunication'].includes(action)){
      (services.inspectNative||inspectNativeTeam)(file);
      log('此团队直接采用Codex原生通信，无旧专属后台需要释放或迁移。');return {status:'READY_FOR_NATIVE_TUI',config:file};
    }
    if(action==='rebuild')throw Error('GENERIC_TEAM_KEEP_HISTORY_USE_NEW; archive separately only with explicit scope');
    await (services.provisionNative||provisionNativeTeam)(file,{confirmed:true,log});
    const c=actual(file,options);
    if(await ask(addedMembers?'是否仅向本次新增成员提交一次只读岗位学习？原成员不重复学习。':'是否现在向成员提交一次只读岗位学习？会调用模型；排队不等于学习完成。')){
      await (services.queueLearning||queueRoleLearning)(file,{confirmed:true,log,...(addedMembers?{members:addedMembers}:{})});
    }
    const available=addedMembers?c.members.filter(m=>addedMembers.includes(m.name)):c.members;
    const mode=options.openMode||await choose('选择打开原生TUI的方式',[['all',addedMembers?'打开全部新增成员独立窗口':'打开全部成员独立窗口'],['selected',addedMembers?'选择新增成员开窗':'选择一个或多个成员开窗'],['current','在当前终端打开一个成员'],['none','暂不开窗口，稍后普通/resume接续']]);
    if(mode==='none')return {status:'READY_FOR_NATIVE_TUI',config:file};
    if(mode==='current'){
      const member=options.member||await choose('选择本终端成员',available.map(m=>[m.name,m.name]));
      if(!available.some(m=>m.name===member))throw Error('UNKNOWN_SELECTED_MEMBER');
      await svc.open(file,member,{promptOnExit:true});return {status:'NATIVE_TUI_CLOSED',config:file};
    }
    let members=addedMembers;
    if(mode==='selected'){
      log(available.map((m,i)=>`${i+1}. ${m.name}`).join('\n'));const choices=available.map(m=>({id:m.name}));
      const selection=await read('开窗成员编号（逗号分隔），all全选',{defaultValue:'1',validate:s=>!!parseSelection(s,choices)});members=parseSelection(selection,choices);
    }else if(mode!=='all')throw Error('INVALID_OPEN_MODE');
    assertNoOpenViews(file);return {...await svc.windows(file,{powershell:options.powershell,node:process.execPath,members}),config:file};
  }
  throw Error('PORTABLE_TEAM_REQUIRED');
}
export async function runWizard(options,deps={}){
  try{
    const r=await wizardSteps(options,deps);
    if(r.config&&!['STATUS','CANCELLED'].includes(r.status))saveStage(r.config,r.status,{opened:r.opened??null,requestedWindows:r.total??null,error:null,resumeVerified:false,communicationVerified:false});
    if(options.menu&&r.config&&r.status!=='STATUS')showResult(r.config,{log:deps.log,status:r.status});
    return r;
  }catch(e){
    if(options.menu&&!e.archiveHandled){
      try{const file=locate(options).file;if(file){saveStage(file,'NEEDS_ATTENTION',{error:e.message});showResult(file,{log:deps.log,status:'NEEDS_ATTENTION',error:e.message});}}catch{}
    }
    throw e;
  }
}
