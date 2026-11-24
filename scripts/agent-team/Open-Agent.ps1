param(
  [Parameter(Mandatory=$true)][string]$NodeExecutable,
  [Parameter(Mandatory=$true)][string]$Config,
  [Parameter(Mandatory=$true)][string]$Member,
  [string]$WindowTicket,
  [switch]$NoExitPrompt
)
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
[Console]::InputEncoding=[System.Text.Encoding]::UTF8
$OutputEncoding=[System.Text.Encoding]::UTF8
$ErrorActionPreference='Stop'
foreach($sfPath in @($NodeExecutable,$Config)){if(!(Test-Path -LiteralPath $sfPath -PathType Leaf)){throw "Missing path: $sfPath"}}
$sfNativeArgs=@((Join-Path $PSScriptRoot 'cli.mjs'),'native','--config',$Config,'--member',$Member)
if(!$NoExitPrompt){$sfNativeArgs+='--ask-release'}
if($WindowTicket){$sfNativeArgs+=@('--window-ticket',$WindowTicket)}
& $NodeExecutable @sfNativeArgs
if($LASTEXITCODE -ne 0){
  Write-Host "Native Codex entry failed (exit $LASTEXITCODE). Preserve this window and inspect the report; do not recreate the Agent."
  if($WindowTicket){$null=Read-Host 'Press Enter after recording this error'}
  throw 'Native Codex entry failed'
}
