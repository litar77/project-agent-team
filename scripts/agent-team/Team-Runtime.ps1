# Deterministic local discovery; never installs tools or changes PATH/permissions.
function Read-TeamJson([string]$File) {
  $null=Assert-TeamLocation $File
  if(Test-Path -LiteralPath $File -PathType Leaf){return ([IO.File]::ReadAllText($File,[Text.Encoding]::UTF8)|ConvertFrom-Json)}
  return $null
}
function Assert-TeamLocation([string]$Path) {
  $current=[IO.Path]::GetFullPath($Path)
  while($current){
    if(Test-Path -LiteralPath $current){
      if((Get-Item -Force -LiteralPath $current).Attributes -band [IO.FileAttributes]::ReparsePoint){throw "Reparse path requires operator review: $Path"}
    }
    $parent=Split-Path -Parent $current
    if($parent -eq $current){break}
    $current=$parent
  }
}
function Assert-TeamPath([string]$File) {
  if(!$File -or !(Test-Path -LiteralPath $File -PathType Leaf)){throw "Missing file: $File"}
  $item=Get-Item -Force -LiteralPath $File
  while($item){
    if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw "Reparse path requires operator review: $File"}
    if($item -is [IO.FileInfo]){$item=$item.Directory}else{$item=$item.Parent}
  }
  return (Resolve-Path -LiteralPath $File).Path
}
function Resolve-TeamRuntime {
  param([string]$Repository,[string]$Machine,[string]$NodeExecutable,[string]$CodexExecutable,[string]$FrontendSkill,[string]$Config,[switch]$NonInteractive,[switch]$Portable)
  if(!$Repository){$Repository=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))}
  $Repository=(Resolve-Path -LiteralPath $Repository).Path
  if(!$Portable -or (Test-Path -LiteralPath (Join-Path $Repository 'AGENTS.md'))){$null=Assert-TeamPath (Join-Path $Repository 'AGENTS.md')}
  $root=Join-Path $Repository '.local/agent-teams'
  if(!$Machine -and $Config){$Machine=(Read-TeamJson $Config).machine}
  if(!$Machine){
    $known=@()
    if(Test-Path -LiteralPath $root){
      $null=Assert-TeamLocation $root
      $known=@(Get-ChildItem -LiteralPath $root -Directory | Where-Object {$_.Name -match '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' -and ((Test-Path -LiteralPath (Join-Path $_.FullName 'current-team.json')) -or (Test-Path -LiteralPath (Join-Path $_.FullName 'team.json')) -or (Test-Path -LiteralPath (Join-Path $_.FullName 'runtime.json')))} | ForEach-Object {$_.Name})
    }
    if($known.Count -eq 1){$Machine=$known[0]}
    elseif($known.Count -gt 1){
      if($NonInteractive){throw 'Several saved teams found. Specify the existing -Machine or -Config.'}
      Write-Host ('Saved team locations: '+($known -join ', '))
      $Machine=(Read-Host 'Select existing machine ID, or enter a new local ID').Trim()
    }else{
      $Machine=$env:COMPUTERNAME
      if(!$Machine -or $Machine -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'){
        if($NonInteractive){throw 'Specify a local -Machine identifier (letters, numbers, dot, underscore or hyphen).'}
        $Machine=(Read-Host 'Local machine identifier').Trim()
      }
    }
  }
  if($Machine -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' -or $Machine.EndsWith('.') -or $Machine -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$'){throw 'Invalid local machine identifier.'}
  $machineRoot=Join-Path $root $Machine
  $savedFile=Join-Path $machineRoot 'runtime.json'
  $saved=Read-TeamJson $savedFile
  if($saved -and ($saved.schemaVersion -ne 1 -or $saved.machine -ne $Machine -or $saved.repository -ne $Repository)){throw 'Saved runtime scope mismatch.'}
  $pointer=Read-TeamJson (Join-Path $machineRoot 'current-team.json')
  $cfg=$null
  if($Config){$cfg=Read-TeamJson (Assert-TeamPath $Config)}
  elseif($pointer){
    if($pointer.schemaVersion -ne 1 -or $pointer.machine -ne $Machine){throw 'Current team pointer mismatch.'}
    $cfg=Read-TeamJson (Assert-TeamPath $pointer.config)
  }else{$cfg=Read-TeamJson (Join-Path $machineRoot 'team.json')}
  if($cfg -and ($cfg.machine -ne $Machine -or [IO.Path]::GetFullPath($cfg.repoRoot) -ne $Repository)){throw 'Team scope mismatch.'}
  if($Config -and $pointer -and $pointer.config -ne $Config){
    $retired=Read-TeamJson (Join-Path (Split-Path -Parent $Config) 'cleanup-state.json')
    if($retired.status -eq 'WHOLE_TRIAL_TEAM_ARCHIVED' -and $retired.inspectorProcess -eq 'CLOSED'){
      if($pointer.schemaVersion -ne 1 -or $pointer.machine -ne $Machine){throw 'Current team pointer mismatch.'}
      $cfg=Read-TeamJson (Assert-TeamPath $pointer.config)
      if($cfg.machine -ne $Machine -or [IO.Path]::GetFullPath($cfg.repoRoot) -ne $Repository){throw 'Current team scope mismatch.'}
    }
  }
  if(!$NodeExecutable){
    if($saved){$NodeExecutable=$saved.node}
    else{
      $candidates=@()
      foreach($base in @((Join-Path $Repository '.local/tools'))){
        if(Test-Path -LiteralPath $base){$candidates+=@(Get-ChildItem -LiteralPath $base -Directory -Filter 'node-v24*' | Sort-Object Name -Descending | ForEach-Object {Join-Path $_.FullName 'node.exe'})}
      }
      $onPath=Get-Command node.exe -ErrorAction SilentlyContinue
      if($onPath){$candidates+=@($onPath.Source)}
      foreach($candidate in @($candidates|Select-Object -Unique)){
        if(Test-Path -LiteralPath $candidate -PathType Leaf){
          $candidate=Assert-TeamPath $candidate
          $version=& $candidate --version
          if($LASTEXITCODE -eq 0 -and "$version" -match '^v24\.\d+\.\d+$'){$NodeExecutable=$candidate;break}
        }
      }
    }
  }
  if(!$NodeExecutable){throw 'Node 24 was not found. Ops: supply the verified -NodeExecutable once. No installation was attempted.'}
  $NodeExecutable=Assert-TeamPath $NodeExecutable
  $nodeVersion=& $NodeExecutable --version
  if($LASTEXITCODE -ne 0 -or "$nodeVersion" -notmatch '^v24\.\d+\.\d+$'){throw 'Node 24 is required; PATH Node 22 is not accepted.'}
  if(!$CodexExecutable){
    if($cfg){$CodexExecutable=$cfg.codexExecutable}elseif($saved){$CodexExecutable=$saved.codex}
    else{
      $exe=Get-Command codex.exe -ErrorAction SilentlyContinue
      if($exe){$CodexExecutable=$exe.Source}
      elseif(Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA 'Programs/Codex/bin/codex.exe')){$CodexExecutable=Join-Path $env:LOCALAPPDATA 'Programs/Codex/bin/codex.exe'}
      else{
        $shim=Get-Command codex.cmd -ErrorAction SilentlyContinue
        if($shim){
          $npmRoot=Join-Path (Split-Path -Parent $shim.Source) 'node_modules/@openai/codex'
          foreach($rel in @('node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe','vendor/x86_64-pc-windows-msvc/bin/codex.exe')){
            $candidate=Join-Path $npmRoot $rel
            if(Test-Path -LiteralPath $candidate -PathType Leaf){$CodexExecutable=$candidate;break}
          }
        }
      }
    }
  }
  if(!$CodexExecutable){throw 'Native Codex executable was not found. Ops: supply verified -CodexExecutable once.'}
  $CodexExecutable=Assert-TeamPath $CodexExecutable
  if($cfg -and $CodexExecutable -ne (Assert-TeamPath $cfg.codexExecutable)){throw 'Explicit Codex differs from the current team. Use its existing executable; runtime selection does not migrate team configuration.'}
  if([IO.Path]::GetExtension($CodexExecutable) -ne '.exe'){throw 'Use native codex.exe, not a script/shim.'}
  $codexVersion=& $CodexExecutable --version
  if($LASTEXITCODE -ne 0 -or "$codexVersion" -notmatch '^codex-cli '){throw 'Codex version check failed.'}
  if(!$Portable -and !$FrontendSkill){
    if($cfg -and $cfg.frontendSkill){$FrontendSkill=$cfg.frontendSkill}
    elseif($saved -and $saved.frontendSkill){$FrontendSkill=$saved.frontendSkill}
    else{$candidate=Join-Path $env:USERPROFILE '.codex/skills/frontend-skill/SKILL.md';if(Test-Path -LiteralPath $candidate -PathType Leaf){$FrontendSkill=$candidate}}
  }
  if($FrontendSkill){$FrontendSkill=Assert-TeamPath $FrontendSkill}
  # Use the verified Node runtime: Get-FileHash is not available in every approved PowerShell host.
  $fingerprintRaw=& $NodeExecutable (Join-Path $PSScriptRoot 'cli.mjs') runtime-fingerprint --codex $CodexExecutable
  if($LASTEXITCODE -ne 0){throw 'Runtime fingerprint failed; no defaults were saved.'}
  $fingerprint=$fingerprintRaw|ConvertFrom-Json
  $record=[ordered]@{schemaVersion=1;machine=$Machine;repository=$Repository;node=$NodeExecutable;nodeVersion="$nodeVersion";nodeSha256=$fingerprint.nodeSha256;codex=$CodexExecutable;codexVersion="$codexVersion";codexSha256=$fingerprint.codexSha256;frontendSkill=$FrontendSkill}
  $same=$saved -and $saved.node -eq $record.node -and $saved.nodeSha256 -eq $record.nodeSha256 -and $saved.codex -eq $record.codex -and $saved.codexSha256 -eq $record.codexSha256 -and $saved.frontendSkill -eq $record.frontendSkill
  if(!$NonInteractive){
    Write-Host "Project Agent Team $Machine | $nodeVersion | $codexVersion"
    if(!$same){
      Write-Host "Repository: $Repository`nNode: $NodeExecutable`nCodex: $CodexExecutable"
    }
  }
  $record['needsConfirmation']=!$same
  $record['recordFile']=$savedFile
  return [pscustomobject]$record
}
function Save-TeamRuntime($Runtime) {
  $null=Assert-TeamLocation $Runtime.recordFile
  $null=New-Item -ItemType Directory -Path (Split-Path -Parent $Runtime.recordFile) -Force
  $value=$Runtime|Select-Object schemaVersion,machine,repository,node,nodeVersion,nodeSha256,codex,codexVersion,codexSha256,frontendSkill
  [IO.File]::WriteAllText($Runtime.recordFile,($value|ConvertTo-Json -Depth 5),(New-Object Text.UTF8Encoding $false))
}
