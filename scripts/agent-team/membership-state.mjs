import fs from 'node:fs';
import path from 'node:path';
import {readJson,safeDirectory} from './core.mjs';

export const MEMBERSHIP_FILE='membership.json';
export const MEMBERSHIP_LOCK='membership.lock';
export function membershipOperation(file){
  const dir=path.dirname(path.resolve(file)),pointer=safeDirectory(path.join(dir,MEMBERSHIP_FILE));
  if(!fs.existsSync(pointer))return null;
  const p=readJson(pointer);
  if(p.schemaVersion!==1||!/^[a-f0-9-]{36}$/i.test(p.id))throw Error('MEMBERSHIP_POINTER_INVALID');
  const recordFile=safeDirectory(path.join(dir,'membership',p.id,'operation.json')),r=readJson(recordFile);
  if(r.id!==p.id||r.schemaVersion!==1||path.resolve(r.configFile)!==path.resolve(file))throw Error('MEMBERSHIP_RECORD_MISMATCH');
  return {...r,recordFile};
}
export function assertMembershipStable(file){
  const r=membershipOperation(file);
  if(fs.existsSync(path.join(path.dirname(file),MEMBERSHIP_LOCK))||(r&&r.status!=='COMPLETED'))throw Error('MEMBERSHIP_PENDING_USE_ADD_MEMBERS_TO_CONTINUE');
}
export function printMembership(file,log=console.log){
  const r=membershipOperation(file);if(!r)return;
  log(`扩容：${r.status}；名册版本 ${r.revision}；新增 ${r.added.join('、')}`);
  for(const n of r.added)log(`  新成员 ${n}：${r.members[n]?.status||'待创建'}；名册 ${r.receipts[n]?.status||'待同步'}`);
  const done=Object.values(r.receipts||{}).filter(x=>x.status==='APPLIED').length;
  log(`全员名册同步 ${done}/${r.target.members.length}；维护连接 ${r.maintenanceClose||'尚未连接'}；本地记录 ${r.status==='COMPLETED'?'已一致提交':'未完成，勿向新成员派正式任务'}`);
  if(r.lastError)log(`扩容原因：${r.lastError.replace(/[a-f0-9]{8}-[a-f0-9-]{27}/gi,'[本地ID]')}`);
  if(/MEMBER_BUSY|QUEUE_NOT_EMPTY|GOAL_ACTIVE|MEMBER_READONLY/.test(r.lastError||''))log('成员仍在运行、排队、有活动目标或被其他界面占用。先正常结束相关工作和窗口，再沿原扩容续办；本工具不代停任务。');
  if(/INPUT_CHANGED|PUBLICATION_CONFLICT/.test(r.lastError||''))log('本地记录出现本次目标之外的修改。已停止覆盖，请Ops核对该文件与扩容前记录。');
  log(`扩容记录：${r.recordFile}；中断后选“为当前团队添加成员”续办。UNKNOWN须诊断，不能重发或删锁。`);
}
