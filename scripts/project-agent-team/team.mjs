import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {composeConfig,roles,saveComposition} from '../agent-team/composition.mjs';
import {readJson,safeDirectory,writeJson} from '../agent-team/core.mjs';
import {locate,runWizard} from '../agent-team/lifecycle.mjs';
import {PROVISION_FILE,provisionNativeTeam} from '../agent-team/native-team.mjs';
import {assertMembershipStable} from '../agent-team/membership-state.mjs';

function parseCounts(value=''){
  const counts=Object.create(null);
  for(const pair of value.split(',')){
    const match=/^([a-z-]+)=([1-8])$/.exec(pair.trim());
    if(!match||!roles.some(r=>r.id===match[1])||Object.hasOwn(counts,match[1]))throw Error('岗位格式示例：module-manager=1,developer=2,tester=1。用 Roles 查看岗位。');
    counts[match[1]]=Number(match[2]);
  }
  return counts;
}

function summary(config,status){
  return {status,project:config.repoRoot,lead:config.lead||'human',objective:config.members[0].objective,
    members:config.members.map(m=>({name:m.name,role:m.jobRole,reportsTo:m.reportsTo,duty:m.responsibilities}))};
}

export async function execute(action,options,{provision=provisionNativeTeam,wizard=runWizard}={}){
  if(action==='roles')return roles.map(({id,label,prefix})=>({id,label,prefix}));
  if(!['wizard','plan','create','continue','status'].includes(action))throw Error('未知操作');
  const location=locate(options);
  const readCurrent=file=>{
    const c=readJson(safeDirectory(file));
    if(c.profile!=='portable-project-v1'||path.dirname(path.dirname(path.dirname(file)))!==location.root)
      throw Error('当前记录不属于本项目的独立团队，请核对项目和记录位置。');
    return c;
  };
  const current=location.file?readCurrent(location.file):null;
  if(action==='status'){
    if(!current)return {status:'NO_CURRENT_TEAM'};
    const record=path.join(path.dirname(location.file),PROVISION_FILE);
    return summary(current,fs.existsSync(record)?readJson(safeDirectory(record)).status:'CONFIGURED');
  }
  let proposed;
  if(action==='plan'||action==='create'){
    proposed=composeConfig({...options,portable:true,counts:parseCounts(options.roles),lead:options.lead==='human'?null:options.lead||null});
    if(action==='plan')return summary(proposed,'PREVIEW_ONLY');
  }
  fs.mkdirSync(location.root,{recursive:true,mode:0o700});
  const lock=safeDirectory(path.join(location.root,'portable-wizard.lock'));
  const fd=fs.openSync(lock,'wx',0o600);
  try{
    fs.writeFileSync(fd,JSON.stringify({pid:process.pid,action,at:new Date().toISOString()}));
    const live=locate(options);
    let file=live.file;
    const existing=file?readCurrent(file):null;
    if(existing&&path.resolve(existing.codexExecutable)!==path.resolve(options.codexExecutable))throw Error('Codex 路径与创建记录不同，请指定原可执行文件。');
    if(action==='wizard')return await wizard({...options,portable:true,menu:true});
    if(action==='continue'&&!existing)throw Error('没有可接续的团队');
    if(existing&&proposed){
      if(JSON.stringify(summary(existing,'roster'))!==JSON.stringify(summary(proposed,'roster')))throw Error('已有不同名册或目标。运行 Wizard 管理原团队或明确选择另建。');
    }
    if(!file){
      file=saveComposition(proposed);
      writeJson(live.pointer,{schemaVersion:1,machine:options.machine,config:file,previousConfig:live.archivedConfig||null});
    }
    assertMembershipStable(file);
    const result=await provision(file,{confirmed:true});
    return summary(readCurrent(file),result.status);
  }finally{
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{
    const [action,root,machine,codexExecutable,powershell,prefix,...pairs]=process.argv.slice(2);
    const options={repoRoot:path.resolve(root),machine,codexExecutable,powershell,prefix};
    for(let i=0;i<pairs.length;i+=2){
      if(!['roles','lead','objective'].includes(pairs[i])||!pairs[i+1])throw Error('参数无效');
      options[pairs[i]]=pairs[i+1];
    }
    const result=await execute(action.toLowerCase(),options);
    console.log(JSON.stringify(result,null,2));
  }catch(e){console.error(e.code==='EEXIST'?'工具已有活动记录。先核对原进程和会话，避免重复创建。':e.message);process.exitCode=1;}
}
