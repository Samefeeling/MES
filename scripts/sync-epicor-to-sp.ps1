# Epicor -> CSV sync, plain and simple.
#
# Runs on a Windows PC every 15 min via Task Scheduler. Pulls released PMD
# orders from Epicor and writes a CSV. If you point the output path at a
# folder that OneDrive is syncing with the PMD SharePoint site, the file
# will be uploaded automatically — no SP write credentials in this script.
#
# The MES app reads that CSV directly from SharePoint (see
# VITE_PLANNING_CSV_PATH in docs/DEPLOYMENT.md).
#
# Secrets stay in Windows Credential Manager — see docs/DEPLOYMENT.md
# section D for one-time setup.

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function LogMsg([string]$msg) {
  $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  Write-Host "[$ts] $msg"
}

# ---- 1. config ---------------------------------------------------------
$cfgPath = if ($env:PMD_SYNC_CONFIG) { $env:PMD_SYNC_CONFIG } else { 'C:\PMDSync\config.json' }
if (-not (Test-Path $cfgPath)) {
  throw "Missing config file at $cfgPath. Copy scripts/sync-epicor-to-sp.config.example.json there and fill in values."
}
$cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
foreach ($key in 'EpicorUrl','OutputCsvPath') {
  if (-not $cfg.$key) { throw "Config $cfgPath missing required key: $key" }
}

# ---- 2. secrets --------------------------------------------------------
Import-Module CredentialManager -ErrorAction Stop
$epi = Get-StoredCredential -Target 'PMDSync.Epicor' -ErrorAction SilentlyContinue
if (-not $epi) { throw "Missing Credential Manager entry 'PMDSync.Epicor'. See docs/DEPLOYMENT.md section D." }

# ---- 3. pull from Epicor -----------------------------------------------
$pair  = "{0}:{1}" -f $epi.UserName, $epi.GetNetworkCredential().Password
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

# ---- 4. filter ---------------------------------------------------------
$keep = $rows | Where-Object {
  $_.JobHead_JobReleased -eq $true `
    -and $_.JobHead_PersonID -eq 'PMD' `
    -and (-not $_.JobHead_JobClosed) `
    -and (-not $_.JobHead_JobComplete)
}
LogMsg "  Kept $($keep.Count) after PMD/Released filter"

# ---- 5. project to CSV columns the app expects -------------------------
# Column order is not significant (the app finds columns by header name),
# but the header names ARE — they have to match src/dal/sharepoint.ts
# parsePlanningCsv exactly.
$projected = $keep | ForEach-Object {
  [PSCustomObject]@{
    JobHead_JobNum             = [string]$_.JobHead_JobNum
    JobHead_PartNum            = [string]$_.JobHead_PartNum
    JobHead_PartDescription    = [string]$_.JobHead_PartDescription
    Calculated_RemainingQty    = [double]$_.Calculated_RemainingQty
    JobHead_StartDate          = if ($_.JobHead_StartDate)  { ([datetime]$_.JobHead_StartDate).ToString("yyyy-MM-ddTHH:mm:ss") }  else { "" }
    JobHead_ReqDueDate         = if ($_.JobHead_ReqDueDate) { ([datetime]$_.JobHead_ReqDueDate).ToString("yyyy-MM-ddTHH:mm:ss") } else { "" }
    Calculated_RemaingLaborHrs = [double]$_.Calculated_RemaingLaborHrs
    JobOper_ProdStandard       = [double]$_.JobOper_ProdStandard
  }
}

# ---- 6. atomic write: tmp -> rename so the app never reads a half file -
$outPath = $cfg.OutputCsvPath
$outDir  = Split-Path -Path $outPath -Parent
if ($outDir -and -not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }
$tmpPath = "$outPath.tmp"
$projected | Export-Csv -Path $tmpPath -NoTypeInformation -Encoding UTF8
Move-Item -Path $tmpPath -Destination $outPath -Force
LogMsg "Wrote $($projected.Count) rows to $outPath"
