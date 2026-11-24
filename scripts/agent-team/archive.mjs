import fs from 'node:fs';
import path from 'node:path';
import {readJson,safeDirectory,validateConfig} from './core.mjs';
import {preview,applyPlan,isArchiveComplete} from './cleanup.mjs';
import {validMachine} from './composition.mjs';

const same=(a,b)=>path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function archiveState(file){
  const marker=safeDirectory(path.join(path.dirname(file),'cleanup-state.json'));
  return fs.existsSync(marker)?readJson(marker):null;
}
// Enumerate only this machine's managed configurations, never all Codex chats.
export function listManagedTeams(options){
  if(!path.isAbsolute(options.repoRoot)||!validMachine(options.machine))throw Error('ACTUAL_REPOSITORY_AND_MACHINE_REQUIRED');
  const root=safeDirectory(path.join(options.repoRoot,'.local','agent-teams',options.machine));
  const pointer=safeDirectory(path.join(root,'current-team.json'));
  const current=fs.existsSync(pointer)?readJson(pointer).config:null,files=[],skipped=[],teams=[];
  const legacy=path.join(root,'team.json');if(fs.existsSync(legacy))files.push(legacy);
  const generations=safeDirectory(path.join(root,'generations'));
  if(fs.existsSync(generations))for(const d of fs.readdirSync(generations,{withFileTypes:true})){
    if(uuid.test(d.name)){
      const file=path.join(generations,d.name,'team.json');
      try{safeDirectory(file);if(fs.existsSync(file))files.push(file);}catch(e){skipped.push({file,error:e.message});}
    }
  }
  for(const file of files){
    try{
      const c=validateConfig(readJson(safeDirectory(file)));
      const expected=c.generation?path.join(root,'generations',c.generation,'team.json'):legacy;
      if(c.machine!==options.machine||!same(c.repoRoot,options.repoRoot)||!same(file,expected))throw Error('MANAGED_TEAM_LOCATION_MISMATCH');
      const marker=archiveState(file);
      teams.push({file,config:c,current:!!current&&same(file,current),marker,archived:isArchiveComplete(marker)});
    }catch(e){skipped.push({file,error:e.message});}
  }
  teams.sort((a,b)=>Number(b.current)-Number(a.current)||(b.config.createdAt||'').localeCompare(a.config.createdAt||'')||a.file.localeCompare(b.file));
  return {teams,skipped};
}
function label(t){return t.config.teamId+' ['+(t.config.generation?.slice(0,8)||'原有代次')+'] · '+t.config.members.length+'人 · '+(t.current?'当前指针':'历史团队')+(t.archived?' · 已归档':t.marker?' · 待核对归档结果':'');}
function recordedResult(t){
  const m=t.marker,expected=uuid.test(m.planId||'')?path.join(path.dirname(t.file),'cleanup',m.planId,'result.json'):null;
  if(!expected||typeof m.reportFile!=='string'||!same(m.reportFile,expected))throw Error('ARCHIVE_REPORT_LOCATION_UNKNOWN');
  const r=readJson(safeDirectory(expected));
  if(r.planId!==m.planId||r.teamId!==t.config.teamId||r.status!==m.status||r.inspectorProcess!==m.inspectorProcess||!Array.isArray(r.members))throw Error('ARCHIVE_REPORT_MISMATCH');
  return {...r,reportFile:expected,archived:r.members.filter(x=>x.status==='ARCHIVED_VERIFIED').length,total:t.config.members.length,blockedMember:r.checkingMember};
}
export function printArchiveResult(t,r,log=console.log){
  log('\n===== Project Agent Team 团队归档摘要开始 =====');
  log('团队：'+label(t)+'\n配置：'+t.file+'\n成员：'+t.config.members.map(m=>m.name).join('、'));
  log('状态：'+r.status+'；已归档 '+(r.archived??'未核得')+'/'+(r.total??t.config.members.length)+'；检查连接 '+(r.inspectorProcess||'未启动'));
  if(r.error)log('原因：'+r.error+(r.blockedMember?'；成员 '+r.blockedMember:''));
  if(r.reportFile||r.planFile)log('记录：'+(r.reportFile||r.planFile));
  log('聊天历史、团队配置和原始记录保留；未删除数据，未停止Codex共享后台。');
  log(isArchiveComplete(r)?'所选团队已退役，不会再由向导打开。可继续新建，或退出向导。':'未确认完整归档，不会新建替代团队。处理明确阻断后再操作；部分归档/UNKNOWN先核对本地报告，不重放。');
  log('===== Project Agent Team 团队归档摘要结束 =====');
}
export async function archiveTeam(options,{choose,ask,log=console.log,preview:prepare=preview,apply=applyPlan}={}){
  const found=listManagedTeams(options);
  for(const s of found.skipped)log('跳过不可核验的配置：'+s.file+'；'+s.error);
  if(!found.teams.length){log('本机尚无可选的已登记团队；未归档任何会话。');return {status:'NO_MANAGED_TEAMS'};}
  const selection=await choose('选择要归档的整套团队（保留历史）',[['cancel','取消，保留所有团队'],...found.teams.map((t,i)=>[String(i),label(t)])]);
  if(selection==='cancel')return {status:'CANCELLED'};
  const t=found.teams.find((_,i)=>String(i)===selection);if(!t)throw Error('INVALID_ARCHIVE_SELECTION');
  if(t.marker){
    let r;try{r=recordedResult(t);}catch(e){r={...t.marker,status:'ARCHIVE_REVIEW_REQUIRED',error:e.message};}
    printArchiveResult(t,r,log);
    const complete=isArchiveComplete(r)&&r.archived===t.config.members.length;
    return {status:complete?'ALREADY_ARCHIVED':'ARCHIVE_REVIEW_REQUIRED',archivedConfig:t.file,complete,result:r};
  }
  log('所选：'+label(t)+'\n成员：'+t.config.members.map(m=>m.name).join('、')+'\n请先暂停派发，等待回合结束，并正常/exit退出这些成员的TUI。其他团队不受影响。');
  if(!await ask('确认只归档以上 '+t.config.members.length+' 名成员？历史和配置保留，归档后本向导不再打开这套团队。'))return {status:'CANCELLED'};
  let r;
  try{
    const p=await prepare(t.file,{includeNativeHistory:true});
    r=p.status==='READY_FOR_RUNTIME_CHECKS'?await apply(p.planFile):{...p,error:(p.blocked||[]).join('；'),archived:0,total:t.config.members.length};
  }catch(e){r={status:'ARCHIVE_REVIEW_REQUIRED',error:e.message,total:t.config.members.length};}
  printArchiveResult(t,r,log);
  const complete=isArchiveComplete(r)&&r.archived===t.config.members.length&&r.total===t.config.members.length;
  return {status:complete?'TEAM_ARCHIVED':'ARCHIVE_REVIEW_REQUIRED',archivedConfig:t.file,complete,result:r};
}
