param(
  [string]$ProjectRoot = (Get-Location).Path,
  [ValidateSet('Wizard','Roles','Plan','Create','Status','Continue')][string]$Action = 'Wizard',
  [string]$Roles, [string]$Lead, [string]$Prefix = 'Agent', [string]$Objective,
  [string]$NodeExecutable, [string]$CodexExecutable
)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$OutputEncoding=[Console]::OutputEncoding
$package=Join-Path $PSScriptRoot 'scripts'
if(!(Test-Path -LiteralPath (Join-Path $package 'project-agent-team/team.mjs'))){$package=Split-Path -Parent $PSScriptRoot}
$entry=Join-Path $package 'project-agent-team/team.mjs'
. (Join-Path $package 'agent-team/Team-Runtime.ps1')
$project=(Resolve-Path -LiteralPath $ProjectRoot).Path
$machine='PT-'+$env:COMPUTERNAME
$runtime=Resolve-TeamRuntime -Portable -NonInteractive -Repository $project -Machine $machine -NodeExecutable $NodeExecutable -CodexExecutable $CodexExecutable
$cliArgs=@($entry,$Action,$project,$machine,$runtime.codex,(Get-Process -Id $PID).Path,$Prefix)
foreach($item in @(@('roles',$Roles),@('lead',$Lead),@('objective',$Objective))){
  if($item[1]){$cliArgs+=@($item[0],$item[1])}
}
& $runtime.node @cliArgs
exit $LASTEXITCODE
