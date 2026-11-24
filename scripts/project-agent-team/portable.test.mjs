import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {execute} from './team.mjs';
import {composeAddition,composeConfig} from '../agent-team/composition.mjs';
import {memberReferences,readJson} from '../agent-team/core.mjs';
import {provisionNativeTeam} from '../agent-team/native-team.mjs';
import {standaloneLaunch} from '../agent-team/handoff.mjs';
import {locate} from '../agent-team/lifecycle.mjs';

test('standalone project: preview, real provisioning code with isolated RPC, stable team and resume',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'project-team-case-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const options={repoRoot:root,machine:'PT-test',codexExecutable:process.execPath,roles:'module-manager=1,developer=1,designer=1',lead:'Demo-Lead1',prefix:'Demo',objective:'案例交付'};
  assert.equal((await execute('plan',options)).members.length,3);
  assert.equal(fs.existsSync(path.join(root,'.local')),false);
  assert.equal((await execute('status',options)).status,'NO_CURRENT_TEAM');
  const threads=new Map(),injected=new Map();
  const rpc={initialize:async()=>{},close:async()=>{},async request(method,p){
    switch(method){
      case 'thread/start':{
        assert.equal(p.cwd,root);
        assert.match(p.developerInstructions,/案例交付/);
        assert.doesNotMatch(p.developerInstructions,/项目协作与Agent执行规范|frontend-skill/);
        const id=randomUUID(),thread={id,sessionId:id,cwd:root,status:{type:'idle'},canAcceptDirectInput:true};
        threads.set(id,thread);return {thread};
      }
      case 'thread/name/set': threads.get(p.threadId).name=p.name;return {};
      case 'thread/read':case 'thread/resume': return {thread:threads.get(p.threadId)};
      case 'thread/queue/list':return {data:[],nextCursor:null};
      case 'thread/inject_items': injected.set(p.threadId,p.items[0].content[0].text);return {};
      default:throw Error(method);
    }
  }};
  const deps={provision:(file,args)=>provisionNativeTeam(file,{...args,connect:async()=>rpc,run:()=> 'codex-cli fixture',log:()=>{}})};
  assert.equal((await execute('create',options,deps)).status,'READY_FOR_NATIVE_TUI');
  for(const id of threads.keys())for(const text of injected.values())assert.ok(text.includes(id));
  assert.equal((await execute('create',options,deps)).status,'READY_FOR_NATIVE_TUI');
  assert.equal((await execute('continue',options,deps)).members.length,3);
  await assert.rejects(execute('create',{...options,objective:'changed'},deps),/已有不同名册/);
  const file=locate(options).file,team=readJson(file);
  assert.equal(threads.size,3);
  for(const m of team.members)assert.ok(standaloneLaunch(file,m.name).args.includes([...threads.values()].find(x=>x.name.includes('/'+m.name+' ')).id));
  assert.equal(memberReferences(team,team.members[0]).length,1);
  fs.writeFileSync(path.join(root,'AGENTS.md'),'project specific');
  assert.equal(memberReferences(team,team.members[0]).length,2);
  const added=composeAddition(team,{prefix:'Demo',counts:{developer:1}});
  assert.equal(added.members.at(-1).name,'Demo-Dev2');
  assert.equal(added.profile,'portable-project-v1');
  assert.throws(()=>composeConfig({...options,counts:{developer:1},lead:null,portable:false}), /INVALID_TEAM_PROFILE/);
});
