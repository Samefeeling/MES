# Epicor -> SharePoint PMD_Planning sync
# Runs on the always-on shop-floor PC every 15 min via Task Scheduler.
#
# This script never contains the Epicor URL, credentials, or any tenant
# secret. Two external inputs:
#   1. C:\PMDSync\config.json   - non-secret URLs / IDs (kept off git)
#   2. Windows Credential Manager - secrets (Epicor API key,
#                                   SharePoint client cert password)
#
# See docs/DEPLOYMENT.md (section D) for one-time setup.

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function LogMsg([string]$msg) {
  $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  Write-Host "[$ts] $msg"
}

# ---- 1. load non-secret config -----------------------------------------
$cfgPath = if ($env:PMD_SYNC_CONFIG) { $env:PMD_SYNC_CONFIG } else { 'C:\PMDSync\config.json' }
if (-not (Test-Path $cfgPath)) {
  throw "Missing config file at $cfgPath. Copy scripts/sync-epicor-to-sp.config.example.json there and fill in values."
}
$cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
foreach ($key in 'EpicorUrl','SharePointUrl','PlanningListTitle') {
  if (-not $cfg.$key) { throw "Config $cfgPath missing required key: $key" }
}
# SharePoint auth mode: 'Certificate' for production (unattended on the
# shop-floor PC), 'Interactive' for dev/temp use on a developer PC where
# the token can cache against the signed-in user.
$spAuth = if ($cfg.PSObject.Properties.Match('SPAuthMode').Count -and $cfg.SPAuthMode) {
  [string]$cfg.SPAuthMode
} elseif ($cfg.PSObject.Properties.Match('SPCertThumbprint').Count -and $cfg.SPCertThumbprint) {
  'Certificate'
} else {
  'Interactive'
}

# ---- 2. load secrets from Windows Credential Manager -------------------
# One-time setup (run as the user the scheduled task will run as):
#   cmdkey /generic:PMDSync.Epicor /user:<EpicorUser> /pass:<EpicorPasswordOrApiKey>
# If your Epicor instance uses both Basic auth AND an X-API-Key header,
# store the Basic password as the credential password and put the API key
# in config.json under "EpicorApiKey" (it's an identifier, not a secret).
Import-Module CredentialManager -ErrorAction Stop
$epi = Get-StoredCredential -Target 'PMDSync.Epicor' -ErrorAction SilentlyContinue
if (-not $epi) { throw "Missing Credential Manager entry 'PMDSync.Epicor'. See docs/DEPLOYMENT.md section D." }

# ---- 3. pull rows from Epicor ------------------------------------------
$pair = "{0}:{1}" -f $epi.UserName, $epi.GetNetworkCredential().Password
$basic = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($pair))
$headers = @{
  'Authorization' = "Basic $basic"
  'Accept'        = 'application/json'
}
if ($cfg.PSObject.Properties.Match('EpicorApiKey').Count -and $cfg.EpicorApiKey) {
  $headers['X-API-Key'] = $cfg.EpicorApiKey
}
LogMsg "GET $($cfg.EpicorUrl)"
$resp = Invoke-RestMethod -Uri $cfg.EpicorUrl -Headers $headers -Method GET -UseBasicParsing
$rows = if ($null -ne $resp.value) { $resp.value } else { $resp }
LogMsg "  Epicor returned $($rows.Count) rows"

# ---- 4. filter to active PMD orders ------------------------------------
# JobReleased = true AND PersonID = PMD AND not closed and not complete.
# Booleans from Epicor REST come back as PowerShell [bool] already.
$keep = $rows | Where-Object {
  $_.JobHead_JobReleased -eq $true `
    -and $_.JobHead_PersonID -eq 'PMD' `
    -and (-not $_.JobHead_JobClosed) `
    -and (-not $_.JobHead_JobComplete)
}
LogMsg "  Kept $($keep.Count) after PMD/Released filter"

# ---- 5. connect SharePoint --------------------------------------------
Import-Module PnP.PowerShell -ErrorAction Stop
if ($spAuth -eq 'Certificate') {
  foreach ($k in 'SPClientId','SPTenantId','SPCertThumbprint') {
    if (-not $cfg.$k) { throw "SPAuthMode=Certificate requires $k in config.json" }
  }
  Connect-PnPOnline `
    -Url $cfg.SharePointUrl `
    -ClientId $cfg.SPClientId `
    -Tenant $cfg.SPTenantId `
    -Thumbprint $cfg.SPCertThumbprint `
    -WarningAction SilentlyContinue
} else {
  # Interactive: pops a browser the first time, caches the token under
  # the current user; subsequent scheduled runs reuse the cache until the
  # refresh token expires (~90 days). Use this only on a dev PC.
  #
  # PnP.PowerShell v2 removed the bundled multi-tenant app, so -Interactive
  # now REQUIRES a -ClientId. Register one once with:
  #   Register-PnPEntraIDAppForInteractiveLogin -ApplicationName "PMD-Planning-Sync-Dev" -Tenant <tenant>.onmicrosoft.com -Interactive
  # then put the printed ClientId in config.json -> SPClientId.
  $clientId = if ($cfg.PSObject.Properties.Match('SPClientId').Count -and $cfg.SPClientId) { $cfg.SPClientId } else { $null }
  if (-not $clientId) {
    throw "SPAuthMode=Interactive requires SPClientId in config.json. See docs/DEPLOYMENT.md section D.2 — register an Entra app once with Register-PnPEntraIDAppForInteractiveLogin, then paste the printed ClientId into config.json."
  }
  Connect-PnPOnline -Url $cfg.SharePointUrl -Interactive -ClientId $clientId -WarningAction SilentlyContinue
}
try {
  # ---- 6. diff against existing list -----------------------------------
  $existing = Get-PnPListItem -List $cfg.PlanningListTitle -PageSize 1000 -Fields @('ID','JobHead_JobNum')
  $existingById = @{}
  foreach ($it in $existing) {
    $j = $it.FieldValues.JobHead_JobNum
    if ($j) { $existingById[[string]$j] = [int]$it.Id }
  }
  $incomingSet = @{}
  foreach ($r in $keep) { $incomingSet[[string]$r.JobHead_JobNum] = $true }

  # ---- 7. upsert -------------------------------------------------------
  $added = 0; $updated = 0; $deleted = 0; $errors = 0
  foreach ($r in $keep) {
    try {
      $values = @{
        'Title'                       = [string]$r.JobHead_JobNum   # natural key
        'JobHead_JobNum'              = [string]$r.JobHead_JobNum
        'JobHead_PartNum'             = [string]$r.JobHead_PartNum
        'JobHead_PartDescription'     = [string]$r.JobHead_PartDescription
        'Calculated_RemainingQty'     = [double]$r.Calculated_RemainingQty
        'StartDateTime'               = $r.JobHead_StartDate
        'Due_Date'                    = $r.JobHead_ReqDueDate
        'Duration'                    = [double]$r.Calculated_RemaingLaborHrs
        'QTYperHour'                  = [double]$r.JobOper_ProdStandard
      }
      $jobKey = [string]$r.JobHead_JobNum
      if ($existingById.ContainsKey($jobKey)) {
        Set-PnPListItem -List $cfg.PlanningListTitle -Identity $existingById[$jobKey] -Values $values | Out-Null
        $updated++
      } else {
        Add-PnPListItem -List $cfg.PlanningListTitle -Values $values | Out-Null
        $added++
      }
    } catch {
      $errors++
      LogMsg "  ! upsert failed for Job $($r.JobHead_JobNum): $($_.Exception.Message)"
    }
  }

  # ---- 8. delete orphans (no longer in Epicor result set) --------------
  foreach ($jobNum in $existingById.Keys) {
    if (-not $incomingSet.ContainsKey($jobNum)) {
      try {
        Remove-PnPListItem -List $cfg.PlanningListTitle -Identity $existingById[$jobNum] -Force | Out-Null
        $deleted++
      } catch {
        $errors++
        LogMsg "  ! delete failed for Job ${jobNum}: $($_.Exception.Message)"
      }
    }
  }
  LogMsg "Done: +$added (added)  ~$updated (updated)  -$deleted (removed)  $errors errors"
} finally {
  Disconnect-PnPOnline
}
