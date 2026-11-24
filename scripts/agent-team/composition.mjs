import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createInterface} from 'node:readline/promises';
import {readJson,writeJson,safeDirectory,validateConfig,memberReferences} from './core.mjs';
import {selectPermissions} from './permissions.mjs';
export const roles=readJson(new URL('./roles.json',import.meta.url));
export const validMachine=x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(x)&&!/[.]$/.test(x)&&! /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(x);
export function parseSelection(raw,choices){
  raw=String(raw).trim();
  if(['all','*','全选'].includes(raw.toLowerCase()))return choices.map(x=>x.id);
  const tokens=raw.split(/[,，\s]+/).filter(Boolean);
  if(!tokens.length)throw Error('请选择至少一个岗位/成员');
  const ids=tokens.map(t=>/^\d+$/.test(t)?choices[Number(t)-1]?.id:choices.find(x=>x.id===t)?.id);
  if(ids.some(x=>!x)||new Set(ids).size!==ids.length)throw Error('编号无效或重复，请重新选择');
  return ids;
}
export async function askText(question,{defaultValue='',validate=()=>true}={}){
  if(!process.stdin.isTTY||!process.stdout.isTTY)throw Error('INTERACTIVE_TERMINAL_REQUIRED');
  const rl=createInterface({input:process.stdin,output:process.stdout});
  try{for(;;){const value=(await rl.question(`${question}${defaultValue?` [${defaultValue}]`:''}：`)).trim()||defaultValue;
    try{if(validate(value))return value;}catch(e){process.stdout.write(e.message+'\n');continue;}process.stdout.write('输入不符合要求，请重试。\n');}}
  finally{rl.close();}
}
export function composeConfig({repoRoot,machine,codexExecutable,frontendSkill,counts,lead=null,frontendDevelopment=false,objective='完成本岗资料学习，等待人类分配正式任务',prefix='Agent',generation=crypto.randomUUID(),model,portable=true}){
  if(!validMachine(machine))throw Error('INVALID_MACHINE_ID');
  if(!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(prefix))throw Error('INVALID_AGENT_PREFIX');
  if(!counts||Object.keys(counts).some(id=>!roles.some(r=>r.id===id)))throw Error('UNKNOWN_ROLE');
  let total=0;for(const n of Object.values(counts)){if(!Number.isInteger(n)||n<1||n>8)throw Error('ROLE_COUNT_MUST_BE_1_TO_8');total+=n;}
  if(total<1||total>64)throw Error('TEAM_TOTAL_MUST_BE_1_TO_64');
  const members=roles.flatMap(r=>Array.from({length:counts[r.id]||0},(_,i)=>({name:`${prefix}-${r.prefix}${i+1}`,jobRole:r.id,
    roleDocument:'team-rules.md',
    responsibilities:portable&&r.id==='designer'?'负责交互、视觉、原型及界面验收，遵守本项目设计要求。':r.duty,objective,
    scope:'仅本次明确分配的任务与资源。创建岗位不授予源码/main/服务器操作权限；不得代签、覆盖他人成果或重放UNKNOWN。',
    outputs:'本人职责和学习缺项回报；正式任务的固定版本、实际结果及失败/未验说明。',
    ...(!portable&&(r.frontend||(r.id==='developer'&&frontendDevelopment))?{requiresFrontend:true}:{}),...(model?{model}:{})})));
  if(lead!==null&&!members.some(m=>m.name===lead))throw Error('COORDINATOR_MUST_BE_SELECTED_MEMBER');
  for(const m of members)m.reportsTo=m.name===lead?'human':lead||'human';
  const c={schemaVersion:1,initializationMode:'codex-native',teamId:`Project-${machine}`,machine,generation,createdAt:new Date().toISOString(),repoRoot:path.resolve(repoRoot),codexExecutable:path.resolve(codexExecutable),frontendSkill:frontendSkill?path.resolve(frontendSkill):null,maxActive:1,transport:'native',lead,externalOperator:'human',members};
  if(portable){
    c.profile='portable-project-v1';
    c.teamId='Project-'+crypto.createHash('sha256').update(c.repoRoot).digest('hex').slice(0,10)+'-'+machine;
  }
  validateConfig(c);for(const m of members)memberReferences(c,m);return c;
}
export async function selectComposition(options,{read=askText,choose,ask,log=console.log}={}){
  const preset=await choose('选择岗位组合',[['custom','自定义：单选、多选或全选岗位'],['general','运行开发模板：Lead×1、开发×2、测试×1'],['interface','界面开发模板：Lead×1、设计×1、开发×2、测试×1']]);
  let counts;
  if(preset==='custom'){
    log(roles.map((r,i)=>`${i+1}. ${r.label}`).join('\n'));
    const picked=await read('输入岗位编号（逗号分隔）；all为全选',{defaultValue:'5',validate:s=>!!parseSelection(s,roles)});
    counts={};for(const id of parseSelection(picked,roles)){const r=roles.find(x=>x.id===id);counts[id]=Number(await read(`${r.label}数量（1—8）`,{defaultValue:'1',validate:s=>/^[1-8]$/.test(s)}));}
  }else counts=preset==='general'?{'module-manager':1,developer:2,tester:1}:{'module-manager':1,designer:1,developer:2,tester:1};
  const prefix=await read('成员名称前缀（字母/数字/下划线/连字符）',{defaultValue:'Agent',validate:s=>/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(s)});
  const objective=await read('本阶段目标（只描述范围，不自动设置goal）',{defaultValue:'完成本岗资料学习，等待人类分配正式任务',validate:s=>s.length>0&&s.length<=2000});
  const frontendDevelopment=!options.portable&&(preset==='interface'||(counts.developer?await ask('开发成员是否承担前端设计/开发？是则须读取frontend-skill。'):false));
  const c=composeConfig({...options,counts,prefix,objective,frontendDevelopment});
  const coordinator=await choose('选择协调者（岗位不自动增加权限）',[['human','人类直接管理／无需Lead'],...c.members.map(m=>[m.name,`${m.name}：${roles.find(r=>r.id===m.jobRole).label}`])]);
  c.lead=coordinator==='human'?null:coordinator;for(const m of c.members)m.reportsTo=m.name===c.lead?'human':c.lead||'human';
  await selectPermissions(c.members,{read,ask,log});
  validateConfig(c);log(`拟创建 ${c.members.length} 名：\n${c.members.map(m=>`  ${m.name}：${roles.find(r=>r.id===m.jobRole).label}`).join('\n')}\n协调者：${c.lead||'人类'}；普通Codex原生通信；账号和默认模型保持原设置，权限按上述选择交由Codex核验。`);
  return c;
}
export function saveComposition(c){
  validateConfig(c);const dir=safeDirectory(path.join(c.repoRoot,'.local','agent-teams',c.machine,'generations',c.generation));
  if(fs.existsSync(dir))throw Error('GENERATION_ALREADY_EXISTS_NO_OVERWRITE');
  fs.mkdirSync(dir,{recursive:true,mode:0o700});const file=path.join(dir,'team.json');writeJson(file,c);return file;
}

export function composeAddition(current,options){
  validateConfig(current);
  const part=composeConfig({...options,portable:current.profile==='portable-project-v1',repoRoot:current.repoRoot,machine:current.machine,codexExecutable:current.codexExecutable,frontendSkill:current.frontendSkill||options.frontendSkill,lead:null});
  const used=new Set(current.members.map(m=>m.name.toLowerCase()));
  for(const m of part.members){
    const role=roles.find(r=>r.id===m.jobRole),stem=`${options.prefix||'Agent'}-${role.prefix}`;
    // Continue after the highest existing suffix, including old Dev1/Dev2 names.
    let next=1;
    for(const name of used){if(name.startsWith(stem.toLowerCase())){const suffix=name.slice(stem.length);if(/^\d+$/.test(suffix))next=Math.max(next,Number(suffix)+1);else if(!suffix)next=Math.max(next,2);}}
    while(used.has(`${stem}${next}`.toLowerCase()))next++;
    m.name=`${stem}${next}`;used.add(m.name.toLowerCase());m.reportsTo=current.lead||'human';
  }
  const target={...current,initializationMode:'codex-native',transport:'native',membershipRevision:(current.membershipRevision||0)+1,
    frontendSkill:current.frontendSkill||part.frontendSkill,
    members:[...current.members.map(m=>m.jobRole==='lead'?{...m,jobRole:'module-manager',legacyJobRole:'lead'}:m),...part.members]};
  validateConfig(target);for(const m of target.members)memberReferences(target,m);return target;
}
export async function selectAddition(current,options,{read=askText,ask,log=console.log}={}){
  log(`当前团队：${current.teamId}；协调者：${current.lead||'人类'}\n已有 ${current.members.length} 人：${current.members.map(m=>m.name).join('、')}\n本次仅新增，保留以上成员、会话和历史。\n${roles.map((r,i)=>`${i+1}. ${r.label}`).join('\n')}`);
  const picked=await read('新增岗位编号（逗号分隔）；all全选',{defaultValue:'5',validate:s=>!!parseSelection(s,roles)}),counts={};
  for(const id of parseSelection(picked,roles)){const r=roles.find(x=>x.id===id);counts[id]=Number(await read(`新增${r.label}数量（1—8）`,{defaultValue:'1',validate:s=>/^[1-8]$/.test(s)}));}
  if(current.members.length+Object.values(counts).reduce((a,b)=>a+b,0)>64)throw Error('TEAM_TOTAL_MUST_BE_1_TO_64');
  const prefixDefault=current.members[0].name.replace(/-[^-]+$/,'');
  const prefix=await read('新成员名称前缀（自动续号，不覆盖同名成员）',{defaultValue:/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(prefixDefault)?prefixDefault:'Agent',validate:s=>/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(s)});
  const objective=await read('新成员本阶段目标',{defaultValue:'完成本岗资料学习，等待人类分配正式任务',validate:s=>s.length>0&&s.length<=2000});
  const frontendDevelopment=current.profile!=='portable-project-v1'&&counts.developer?await ask('新增开发成员是否承担前端设计/开发？是则须读取frontend-skill。'):false;
  const target=composeAddition(current,{...options,counts,prefix,objective,frontendDevelopment});
  await selectPermissions(target.members.slice(current.members.length),{read,ask,log});
  log(`拟新增：${target.members.slice(current.members.length).map(m=>`${m.name}（${roles.find(r=>r.id===m.jobRole).label}）`).join('、')}\n原协调者保持 ${current.lead||'人类'}；新增管理岗位不会自动替换Lead。`);return target;
}
