import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {permissionMode} from './permissions.mjs';

export const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const nativeRoles=JSON.parse(fs.readFileSync(new URL('./roles.json',import.meta.url),'utf8')).map(r=>r.id);
const text = (v, name, limit = 16000) => {
  if (typeof v !== 'string' || !v.trim() || v.length > limit) throw new Error(`INVALID_${name}`);
  return v;
};
export function safeDirectory(directory) {
  const absolute = path.resolve(directory);
  let current = absolute;
  while (true) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('REPARSE_PATH_DENIED');
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
  return absolute;
}
export function writeJson(file, value) {
  safeDirectory(file);
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, file);
}
export function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
export function validateConfig(c) {
  const direct=c.initializationMode==='codex-native';
  if((c.profile!=='portable-project-v1'||!direct))throw Error('INVALID_TEAM_PROFILE');
  if(c.initializationMode!==undefined&&!direct)throw Error('INVALID_INITIALIZATION_MODE');
  if (c.schemaVersion !== 1 || !idPattern.test(c.teamId || '') || !idPattern.test(c.machine || '')) throw new Error('INVALID_TEAM');
  if(c.transport!==undefined&&!['stdio','native'].includes(c.transport))throw new Error('INVALID_TEAM_TRANSPORT');
  if(c.generation!==undefined&&!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(c.generation))throw Error('INVALID_TEAM_GENERATION');
  if (!path.isAbsolute(c.repoRoot) || !fs.statSync(safeDirectory(c.repoRoot)).isDirectory()) throw new Error('REPO_REQUIRED');
  if (!path.isAbsolute(c.codexExecutable) || !fs.statSync(safeDirectory(c.codexExecutable)).isFile() || /\.(cmd|bat|ps1)$/i.test(c.codexExecutable)) throw new Error('NATIVE_CODEX_EXECUTABLE_REQUIRED');
  if (!Array.isArray(c.members) || c.members.length < 1 || c.members.length > (direct?64:12) || new Set(c.members.map(m => m.name)).size !== c.members.length) throw new Error('INVALID_MEMBERS');
  if (!Number.isInteger(c.maxActive) || c.maxActive < 1 || c.maxActive > c.members.length) throw new Error('INVALID_CONCURRENCY');
  if (!direct&&c.members.filter(m => m.jobRole === 'lead').length !== 1) throw new Error('ONE_LEAD_REQUIRED');
  if(direct&&c.lead!==null&&!c.members.some(m=>m.name===c.lead))throw Error('COORDINATOR_MUST_BE_SELECTED_MEMBER');
  for (const m of c.members) {
    if(permissionMode(m)!=='inherit'&&!direct)throw Error('EXPLICIT_PERMISSIONS_REQUIRE_NATIVE_TEAM');
    if (!idPattern.test(m.name || '') || !(direct?nativeRoles:['lead','developer','tester','designer','operations']).includes(m.jobRole)) throw new Error('INVALID_MEMBER');
    for (const key of ['responsibilities','objective','scope','outputs']) text(m[key], key);
    if (m.model !== undefined && m.model !== null) text(m.model, 'MODEL', 200);
    if (m.name !== c.lead && m.reportsTo !== (direct?(c.lead||'human'):c.lead)) throw new Error('REPORTING_LINE_REQUIRED');
    if(c.profile==='portable-project-v1'){
      if(m.roleDocument!=='team-rules.md')throw Error('INVALID_PORTABLE_ROLE_DOCUMENT');
      continue;
    }
    const doc = path.resolve(c.repoRoot, m.roleDocument);
    const relative=path.relative(c.repoRoot,doc);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.statSync(safeDirectory(doc)).isFile()) throw new Error('ROLE_DOCUMENT_REQUIRED');
  }
  if (!direct&&!c.members.some(m => m.name === c.lead && m.jobRole === 'lead')) throw new Error('LEAD_MISMATCH');
  return c;
}
export function memberDisplayName(c,name){return `${c.teamId}/${name}${c.generation?` [${c.generation.slice(0,8)}]`:''}`;}
export function memberReferences(c, m) {
  if(c.profile==='portable-project-v1'){
    const policy=fileURLToPath(new URL('./team-rules.md',import.meta.url));
    const project=safeDirectory(path.join(c.repoRoot,'AGENTS.md'));
    return [policy,...(fs.existsSync(project)?[project]:[])].map(file=>({path:file,sha256:hash(fs.readFileSync(safeDirectory(file)))}));
  }
  throw Error("INVALID_TEAM_PROFILE");
}
