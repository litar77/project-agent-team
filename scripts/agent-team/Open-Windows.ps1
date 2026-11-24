param([Parameter(Mandatory=$true)][string]$Batch)
$ErrorActionPreference='Stop'
$b=[IO.File]::ReadAllText($Batch,[Text.Encoding]::UTF8)|ConvertFrom-Json
if($b.schemaVersion -ne 1){throw 'Invalid window batch'}
$shell=(Get-Process -Id $PID).Path
$entry=Join-Path $PSScriptRoot 'Open-Agent.ps1'
function Quote-Argument([string]$Value){
  if($Value -match '["\r\n]'){throw 'Invalid window argument'}
  return '"'+$Value+'"'
}
foreach($ticket in $b.tickets){
  $r=[IO.File]::ReadAllText($ticket,[Text.Encoding]::UTF8)|ConvertFrom-Json
  if($r.config -ne $b.config -or $r.status -ne 'PENDING' -or $r.member -notmatch '^[A-Za-z0-9._-]+$'){throw 'Window ticket mismatch'}
  # Visible windows are the operator's explicit All selection.
  $null=Start-Process -FilePath $shell -ArgumentList @('-NoProfile','-File',(Quote-Argument $entry),'-NodeExecutable',(Quote-Argument $b.node),'-Config',(Quote-Argument $b.config),'-Member',$r.member,'-WindowTicket',(Quote-Argument $ticket)) -PassThru
}
