// Native Codex settings, never a prompt-based approval proxy or a global config edit.
export const permissionModes=Object.freeze({
  inherit:'沿用 Codex 当前默认设置',
  'auto-review':'代我审批（Codex 原生自动审查）',
  'full-access':'完全访问（无 Codex 沙箱、无需执行审批）',
});
export function permissionMode(member){
  const mode=member.permissionMode??'inherit';
  if(!Object.hasOwn(permissionModes,mode))throw Error('INVALID_MEMBER_PERMISSION_MODE');
  return mode;
}
export function permissionParameters(member){
  const mode=permissionMode(member);
  if(mode==='inherit')return {};
  return mode==='auto-review'
    ?{sandbox:'workspace-write',approvalPolicy:'on-request',approvalsReviewer:'auto_review'}
    :{sandbox:'danger-full-access',approvalPolicy:'never',approvalsReviewer:'user'};
}
export function effectivePermissions(response){
  return {approvalPolicy:response.approvalPolicy??null,approvalsReviewer:response.approvalsReviewer??null,sandbox:response.sandbox??null};
}
// thread/resume parameters are not a settings-update API for an already loaded
// thread. Use the dedicated native endpoint; it changes no model or messages.
export function permissionSettings(member,current={}){
  const params=permissionParameters(member);if(!params.sandbox)return {};
  const {sandbox,...rest}=params;
  return {...rest,sandboxPolicy:sandbox==='danger-full-access'?{type:'dangerFullAccess'}:{
    type:'workspaceWrite',writableRoots:[],excludeTmpdirEnvVar:false,excludeSlashTmp:false,
    ...(current.sandbox?.type==='workspaceWrite'?current.sandbox:{}),networkAccess:false,
  }};
}
export function verifyPermissions(member,response){
  const mode=permissionMode(member),actual=effectivePermissions(response);
  if(mode==='inherit')return {status:'INHERITED',actual};
  const matched=mode==='auto-review'
    ?actual.approvalPolicy==='on-request'&&['auto_review','guardian_subagent'].includes(actual.approvalsReviewer)&&actual.sandbox?.type==='workspaceWrite'&&actual.sandbox.networkAccess===false
    :actual.approvalPolicy==='never'&&actual.approvalsReviewer==='user'&&actual.sandbox?.type==='dangerFullAccess';
  if(!matched){const error=Error(`NATIVE_PERMISSION_NOT_CONFIRMED ${member.name}: ${mode}; 以 Codex 返回的有效设置为准，保留会话，不自动换模式或重建。`);error.permissionMismatch=true;error.actualPermissions=actual;throw error;}
  return {status:'VERIFIED',actual};
}
export async function selectPermissions(members,{read,ask,log=console.log,existing=false}){
  log((existing?'为选定的现有成员选择权限；不修改未选成员、全局配置或 Windows 管理员权限。\n1. 保留当前实际权限，不调整（默认）':'为本次新成员选择权限；不修改原成员、全局配置或 Windows 管理员权限。\n1. 沿用 Codex 当前默认设置（默认）')+'\n2. 代我审批：保留工作区边界，由 Codex 独立审查器处理适用的审批\n3. 完全访问：可访问当前系统账号可访问的文件、执行命令和联网，不再逐项审批\n4. 按成员分别选择');
  const pick=(await read(existing?'所选成员权限模式':'新成员权限模式',{defaultValue:'1',validate:s=>/^[1-4]$/.test(s)}))||'1';
  if(!/^[1-4]$/.test(pick))throw Error('INVALID_PERMISSION_SELECTION');
  const modes=['inherit','auto-review','full-access'];
  const selected=[];
  for(const member of members){
    const answer=pick==='4'?await read(`${member.name} 权限：1沿用／2代我审批／3完全访问`,{defaultValue:'1',validate:s=>/^[1-3]$/.test(s)}):pick;
    if(!/^[1-3]$/.test(answer))throw Error('INVALID_PERMISSION_SELECTION');
    selected.push({member,mode:modes[Number(answer)-1]});
  }
  const full=selected.filter(x=>x.mode==='full-access').map(x=>x.member.name);
  if(full.length&&!await ask(`确认仅为 ${full.join('、')} 启用完全访问？这些成员可在当前操作系统账号权限内访问工作区外文件、执行命令和联网，Codex 不再逐项询问。项目授权与组织限制仍有效。`))throw Error('FULL_ACCESS_NOT_CONFIRMED_NO_TEAM_CHANGED');
  for(const {member,mode} of selected){if(mode==='inherit')delete member.permissionMode;else member.permissionMode=mode;}
  log('本次权限选择：\n'+members.map(m=>`  ${m.name}：${existing&&permissionMode(m)==='inherit'?'保持当前实际权限':permissionModes[permissionMode(m)]}`).join('\n'));
  return members;
}
