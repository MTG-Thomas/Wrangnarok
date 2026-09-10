<#
.SYNOPSIS
  LaneOps: drive opencode lane sessions over HTTP (loopback lane server).
  No separate runtime needed. Password lives in a local config file outside
  the repo and must NEVER be posted to GitHub; distribute via lane mailbox.
.NOTES
  PowerShell 5.1 compatible. Use curl.exe, never bare curl.
#>

$script:LaneConfigPath = Join-Path $HOME '.local/share/opencode/lane-ops.json'

function Get-LaneConfig {
  if (-not (Test-Path -LiteralPath $script:LaneConfigPath)) {
    throw "Lane config missing at $($script:LaneConfigPath). Run Start-LaneServer first."
  }
  return (Get-Content -LiteralPath $script:LaneConfigPath -Raw | ConvertFrom-Json)
}

function Get-LaneAuthHeader {
  param([Parameter(Mandatory = $true)]$Config)
  $pair = "$($Config.user):$($Config.password)"
  $b64 = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes($pair))
  return @{ Authorization = "Basic $b64" }
}

function Start-LaneServer {
  <#
  .SYNOPSIS Starts a loopback-only authenticated lane server; records PID + password locally.
  #>
  param([int]$Port = 4097, [string]$RepoDir)
  if (-not $RepoDir) { $RepoDir = (Get-Location).Path }
  $busy = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue |
    Where-Object { $_.State -eq 'Listen' }
  if ($busy) { throw "Port $Port already listening. Reuse it or pick another." }
  $exe = (Get-Command opencode -ErrorAction Stop).Source
  $pw = ([System.Guid]::NewGuid().ToString('N') +
    [System.Guid]::NewGuid().ToString('N').Substring(0, 8))
  $env:OPENCODE_SERVER_PASSWORD = $pw
  $proc = Start-Process -FilePath $exe `
    -ArgumentList "serve --port $Port --hostname 127.0.0.1" `
    -WorkingDirectory $RepoDir -WindowStyle Hidden -PassThru
  Start-Sleep -Seconds 8
  $cfg = @{
    host = '127.0.0.1'; port = $Port; user = 'opencode'
    password = $pw; pid = $proc.Id; repoDir = $RepoDir
  }
  $dir = Split-Path -Parent $script:LaneConfigPath
  if (-not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }
  $cfg | ConvertTo-Json | Set-Content -LiteralPath $script:LaneConfigPath
  $hdr = Get-LaneAuthHeader -Config $cfg
  $h = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/global/health" `
    -Headers $hdr -TimeoutSec 10
  if (-not $h.healthy) { throw "Server up but unhealthy." }
  Write-Output "lane server healthy on 127.0.0.1:$Port (pid $($proc.Id), v$($h.version))"
}

function Get-LaneHealth {
  $cfg = Get-LaneConfig
  $hdr = Get-LaneAuthHeader -Config $cfg
  return Invoke-RestMethod -Uri "http://127.0.0.1:$($cfg.port)/global/health" `
    -Headers $hdr -TimeoutSec 10
}

function New-LaneSession {
  param([Parameter(Mandatory = $true)][string]$Title)
  $cfg = Get-LaneConfig
  $hdr = Get-LaneAuthHeader -Config $cfg
  $body = @{ title = $Title } | ConvertTo-Json
  $s = Invoke-RestMethod -Uri "http://127.0.0.1:$($cfg.port)/session" `
    -Method Post -Headers $hdr -ContentType 'application/json' -Body $body `
    -TimeoutSec 15
  return $s.id
}

function Send-LaneMessage {
  <#
  .SYNOPSIS Post one message. -Model 'provider/model-id' sticks session-wide; pass on FIRST message.
  .EXAMPLE Send-LaneMessage -SessionId $id -Text '...' -Model 'opencode-go/muse-spark-1.3-contributor'
  #>
  param(
    [Parameter(Mandatory = $true)][string]$SessionId,
    [Parameter(Mandatory = $true)][string]$Text,
    [string]$Model,
    [switch]$Wait,
    [switch]$NoReply,
    [int]$TimeoutSec = 110
  )
  $cfg = Get-LaneConfig
  $hdr = Get-LaneAuthHeader -Config $cfg
  $payload = @{ parts = @(@{ type = 'text'; text = $Text }) }
  if ($Model) {
    $mp = $Model -split '/', 2
    $payload['model'] = @{ providerID = $mp[0]; modelID = $mp[1] }
  }
  if ($NoReply) { $payload['noReply'] = $true }
  $body = $payload | ConvertTo-Json -Depth 6
  if ($Wait) {
    $r = Invoke-RestMethod `
      -Uri "http://127.0.0.1:$($cfg.port)/session/$SessionId/message" `
      -Method Post -Headers $hdr -ContentType 'application/json' `
      -Body $body -TimeoutSec $TimeoutSec
    $texts = @()
    foreach ($p in $r.parts) { if ($p.type -eq 'text') { $texts += $p.text } }
    return ($texts -join "`n")
  }
  Invoke-RestMethod `
    -Uri "http://127.0.0.1:$($cfg.port)/session/$SessionId/prompt_async" `
    -Method Post -Headers $hdr -ContentType 'application/json' `
    -Body $body -TimeoutSec 25 | Out-Null
  Write-Output "queued to $SessionId"
}

function Get-LaneMessages {
  param(
    [Parameter(Mandatory = $true)][string]$SessionId,
    [int]$Limit = 5,
    [int]$MaxChars = 200
  )
  $cfg = Get-LaneConfig
  $hdr = Get-LaneAuthHeader -Config $cfg
  $m = Invoke-RestMethod `
    -Uri "http://127.0.0.1:$($cfg.port)/session/$SessionId/message?limit=$Limit" `
    -Headers $hdr -TimeoutSec 15
  foreach ($x in $m) {
    $t = @()
    foreach ($p in $x.parts) {
      if ($p.type -eq 'text' -and $p.text.Trim().Length -gt 0) { $t += $p.text }
    }
    $j = ($t -join ' ')
    if ($j.Length -eq 0) { $j = '(non-text parts only)' }
    Write-Output "$($x.info.role): $($j.Substring(0, [Math]::Min($MaxChars, $j.Length)))"
  }
}

function Get-LaneStatus {
  $cfg = Get-LaneConfig
  $hdr = Get-LaneAuthHeader -Config $cfg
  $st = Invoke-RestMethod -Uri "http://127.0.0.1:$($cfg.port)/session/status" `
    -Headers $hdr -TimeoutSec 15
  return $st
}

function Stop-LaneRun {
  <#.SYNOPSIS Abort the active run (recovery for silent-busy); redrive after with report-first.#>
  param([Parameter(Mandatory = $true)][string]$SessionId)
  $cfg = Get-LaneConfig
  $hdr = Get-LaneAuthHeader -Config $cfg
  return Invoke-RestMethod `
    -Uri "http://127.0.0.1:$($cfg.port)/session/$SessionId/abort" `
    -Method Post -Headers $hdr -TimeoutSec 20
}

function Watch-LaneQueue {
  <#.SYNOPSIS Read the Mergify Merge Queue check for a PR; names the exact blocking item.
  Returns queued/merged state. Use instead of guessing why a green PR sits. #>
  param([Parameter(Mandatory = $true)][int]$PrNumber)
  $sha = gh pr view $PrNumber --json headRefOid --jq .headRefOid
  $runs = gh api "repos/MTG-Thomas/Wrangnarok/commits/$sha/check-runs" |
    ConvertFrom-Json
  foreach ($r in $runs.check_runs) {
    if ($r.name -like '*Merge Queue*') {
      Write-Output ($r.name + ' => ' + $r.conclusion)
      $s = $r.output.summary
      $unmet = @()
      foreach ($line in ($s -split "`n")) {
        if ($line -match '^- \[ \] (.+)$') { $unmet += $Matches[1] }
      }
      if ($unmet.Count -eq 0) { Write-Output 'no blocking items (queued or merged)' }
      else { Write-Output 'BLOCKED BY:'; $unmet }
    }
  }
}

function Restart-LaneServer {
  <#.SYNOPSIS Safe restart of a lane server: abort runs, verify idle, verify
  process ownership, stop, start, health-check, confirm sessions survive.
  Never point at an interactive instance (:4096) without the human asking. #>
  param(
    [int]$Port = 4097,
    [string]$Password,
    [string]$RepoDir
  )
  if (-not $Password) {
    $cfg = Get-LaneConfig
    if ($cfg.port -ne $Port) {
      throw "No password given and lane config targets port $($cfg.port), not $Port. Pass -Password explicitly."
    }
    $Password = $cfg.password
    if (-not $RepoDir) { $RepoDir = $cfg.repoDir }
  }
  if (-not $RepoDir) { $RepoDir = (Get-Location).Path }
  $pair = "opencode:$Password"
  $b64 = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes($pair))
  $hdr = @{ Authorization = "Basic $b64" }
  $base = "http://127.0.0.1:$Port"
  # 1. Abort active runs so nothing is mid-write.
  $st = Invoke-RestMethod -Uri "$base/session/status" -Headers $hdr -TimeoutSec 15
  foreach ($prop in $st.PSObject.Properties) {
    Invoke-RestMethod -Uri "$base/session/$($prop.Name)/abort" -Method Post `
      -Headers $hdr -TimeoutSec 20 | Out-Null
  }
  Start-Sleep -Seconds 5
  $st2 = Invoke-RestMethod -Uri "$base/session/status" -Headers $hdr -TimeoutSec 15
  $left = @($st2.PSObject.Properties).Count
  if ($left -gt 0) { throw "$left runs still active after abort; refusing restart." }
  $before = @(Invoke-RestMethod -Uri "$base/session" -Headers $hdr -TimeoutSec 20).Count
  # 2. Verify the listener really is our opencode before killing.
  $conn = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue |
    Where-Object { $_.State -eq 'Listen' } | Select-Object -First 1
  if (-not $conn) { throw "Nothing listening on $Port." }
  $proc = Get-Process -Id $conn.OwningProcess -ErrorAction Stop
  if ($proc.ProcessName -notlike '*opencode*') {
    throw "PID $($proc.Id) is '$($proc.ProcessName)', not opencode. Refusing."
  }
  Stop-Process -Id $proc.Id -Force
  $deadline = (Get-Date).AddSeconds(20)
  while ((Get-Date) -lt $deadline) {
    $l = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue |
      Where-Object { $_.State -eq 'Listen' }
    if (-not $l) { break }
    Start-Sleep -Seconds 1
  }
  # 3. Start fresh with the same password and cwd.
  $env:OPENCODE_SERVER_PASSWORD = $Password
  $exe = (Get-Command opencode -ErrorAction Stop).Source
  $new = Start-Process -FilePath $exe `
    -ArgumentList "serve --port $Port --hostname 127.0.0.1" `
    -WorkingDirectory $RepoDir -WindowStyle Hidden -PassThru
  $deadline = (Get-Date).AddSeconds(60)
  while ((Get-Date) -lt $deadline) {
    try {
      $h = Invoke-RestMethod -Uri "$base/global/health" -Headers $hdr -TimeoutSec 5
      if ($h.healthy) { break }
    } catch { Start-Sleep -Seconds 2 }
  }
  $after = @(Invoke-RestMethod -Uri "$base/session" -Headers $hdr -TimeoutSec 20).Count
  Write-Output "restarted :$Port pid $($proc.Id)->$($new.Id) sessions $before->$after"
}

function Get-LaneDigest {
  <#.SYNOPSIS One-call watch round: server, lanes, PRs, issues, inbox.
  Replaces timer polling; run on wake only. Lanes steer on DONE/BLOCKED. #>
  param([string]$IdsPath)
  $cfg = Get-LaneConfig
  $hdr = Get-LaneAuthHeader -Config $cfg
  $base = "http://127.0.0.1:$($cfg.port)"
  try {
    $h = Invoke-RestMethod -Uri "$base/global/health" -Headers $hdr -TimeoutSec 10
    Write-Output ("server: ok v" + $h.version)
  } catch { Write-Output 'server: DOWN'; return }
  if (-not $IdsPath) {
    $IdsPath = Join-Path ([System.IO.Path]::GetTempPath()) 'opencode\lane_ids.json'
  }
  if (Test-Path -LiteralPath $IdsPath) {
    $ids = Get-Content -LiteralPath $IdsPath -Raw | ConvertFrom-Json
    $st = Invoke-RestMethod -Uri "$base/session/status" -Headers $hdr -TimeoutSec 15
    foreach ($lane in @('A','B','C','D')) {
      $id = $ids.$lane
      if (-not $id) { continue }
      $v = $st.$id
      if ($null -eq $v) { Write-Output "$lane idle" } else { Write-Output "$lane busy" }
    }
  }
  Write-Output 'prs:'; gh pr list --limit 8 --json number,title,state `
    --template "{{range .}}#{{.number}} {{.state}} {{.title}}`n{{end}}"
  Write-Output 'issues(75-78 comments):'
  foreach ($n in @(75,76,77,78)) {
    $c = gh issue view $n --json comments --jq '.comments | length'
    Write-Output ("  #" + $n + ":" + $c)
  }
}

function Wait-LaneCondition {
  <#.SYNOPSIS Block until lane/PR/issue conditions hold or timeout.
  Conditions are ANDed; each optional. Returns the trigger reason.
  .EXAMPLE Wait-LaneCondition -PrMerged 84 -LaneIdle @('A') -TimeoutSec 600 -IntervalSec 45 #>
  param(
    [int[]]$PrMerged = @(),
    [string[]]$LaneIdle = @(),
    [int[]]$IssueActivity = @(),
    [int]$TimeoutSec = 600,
    [int]$IntervalSec = 45,
    [string]$IdsPath
  )
  $cfg = Get-LaneConfig
  $hdr = Get-LaneAuthHeader -Config $cfg
  $base = "http://127.0.0.1:$($cfg.port)"
  if (-not $IdsPath) {
    $IdsPath = Join-Path ([System.IO.Path]::GetTempPath()) 'opencode\lane_ids.json'
  }
  $ids = $null
  if (Test-Path -LiteralPath $IdsPath) {
    $ids = Get-Content -LiteralPath $IdsPath -Raw | ConvertFrom-Json
  }
  $baseCounts = @{}
  foreach ($n in $IssueActivity) {
    $baseCounts["$n"] = gh issue view $n --json comments --jq '.comments | length'
  }
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    $unmet = @()
    foreach ($p in $PrMerged) {
      $st = gh pr view $p --json state --jq .state
      if ($st -ne 'MERGED') { $unmet += "PR$p=$st" }
    }
    if ($LaneIdle.Count -gt 0 -and $null -ne $ids) {
      $map = Invoke-RestMethod -Uri "$base/session/status" -Headers $hdr -TimeoutSec 15
      foreach ($lane in $LaneIdle) {
        if ($null -ne $map.($ids.$lane)) { $unmet += "lane-$lane=busy" }
      }
    }
    foreach ($n in $IssueActivity) {
      $c = gh issue view $n --json comments --jq '.comments | length'
      if ([int]$c -le [int]$baseCounts["$n"]) { $unmet += "issue#$n quiet" }
    }
    if ($unmet.Count -eq 0) { return 'MET' }
    Start-Sleep -Seconds $IntervalSec
  }
  return ('TIMEOUT unmet: ' + ($unmet -join ', '))
}

function Remove-LaneSession {
  param([Parameter(Mandatory = $true)][string]$SessionId)
  $cfg = Get-LaneConfig
  $hdr = Get-LaneAuthHeader -Config $cfg
  return Invoke-RestMethod `
    -Uri "http://127.0.0.1:$($cfg.port)/session/$SessionId" `
    -Method Delete -Headers $hdr -TimeoutSec 15
}
