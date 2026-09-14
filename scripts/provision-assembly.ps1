param(
  [Parameter(Mandatory = $true)][string]$SiteUrl,
  [switch]$Apply
)
$ErrorActionPreference = 'Stop'
$schemaPath = Join-Path $PSScriptRoot '../config/assembly-lists.json'
$schema = Get-Content -LiteralPath $schemaPath -Raw | ConvertFrom-Json
$site = $SiteUrl.TrimEnd('/')
if (([uri]$site).Scheme -ne 'https') { throw 'Use the HTTPS SharePoint site URL.' }
$resource = ([uri]$site).GetLeftPart([System.UriPartial]::Authority)

function Invoke-Request([string]$Url, [string]$Method = 'get', $Body = $null, [switch]$Merge) {
  $arguments = @('request', '--url', $Url, '--method', $Method, '--resource', $resource,
    '--accept', 'application/json;odata=nometadata', '--output', 'json')
  $bodyFile = $null
  try {
    if ($null -ne $Body) {
      $bodyFile = [System.IO.Path]::GetTempFileName()
      [System.IO.File]::WriteAllText($bodyFile, ($Body | ConvertTo-Json -Depth 12), [System.Text.UTF8Encoding]::new($false))
      $arguments += @('--body', "@$bodyFile", '--content-type', 'application/json;odata=nometadata')
    }
    if ($Merge) { $arguments += @('--x-http-method', 'MERGE', '--if-match', '*') }
    $output = & m365 @arguments
    if ($LASTEXITCODE -ne 0) { throw "Microsoft 365 request failed: $Method $Url" }
    if ($output) { return ($output -join "`n" | ConvertFrom-Json) }
  } finally {
    if ($bodyFile) { Remove-Item -LiteralPath $bodyFile }
  }
}

if (-not (Get-Command m365 -ErrorAction SilentlyContinue)) { throw 'Install CLI for Microsoft 365 and sign in with m365 login first.' }
# Read-only inventory first. Permission errors never mean that a list is absent.
$catalog = Invoke-Request "$site/_api/web/lists?`$select=Title,Id"
foreach ($list in $schema.lists) {
  $existing = @($catalog.value | Where-Object Title -eq $list.name)
  if (-not $existing.Count) {
    Write-Host "Create list: $($list.name)"
    if (-not $Apply) { $list.fields | Format-Table name,type,required,indexed,unique; continue }
    Invoke-Request "$site/_api/web/lists" 'post' @{
      Title = $list.name; Description = $list.description; BaseTemplate = 100; EnableVersioning = $true
    } | Out-Null
  }
  $listUrl = "$site/_api/web/lists/getbytitle('$($list.name)')"
  $fields = Invoke-Request "$listUrl/fields?`$select=InternalName,TypeAsString,Indexed,EnforceUniqueValues,Required,Id"
  foreach ($field in $list.fields) {
    $have = $fields.value | Where-Object InternalName -eq $field.name
    if ($have) {
      # Skills can be existing multi-choice data; the adapter handles both shapes.
      $compatible = $have.TypeAsString -eq $field.type -or ($field.name -eq 'Skills' -and $have.TypeAsString -in @('MultiChoice','Choice','Note'))
      if (-not $compatible) { throw "$($list.name).$($field.name) is $($have.TypeAsString), expected $($field.type). Existing data was not converted." }
      $changes = @{}
      if ($field.indexed -and -not $have.Indexed) { $changes.Indexed = $true }
      if ($field.unique -and -not $have.EnforceUniqueValues) { $changes.EnforceUniqueValues = $true }
      if ($field.required -and -not $have.Required) { $changes.Required = $true }
      if ($changes.Count) {
        Write-Host "Set constraints: $($list.name).$($field.name)"
        if ($Apply) { Invoke-Request "$listUrl/fields(guid'$($have.Id)')" 'post' $changes -Merge | Out-Null }
      }
      continue
    }
    Write-Host "Add field: $($list.name).$($field.name) [$($field.type)]"
    if (-not $Apply) { continue }
    $required = if ($field.required) { 'TRUE' } else { 'FALSE' }
    $indexed = if ($field.indexed) { 'TRUE' } else { 'FALSE' }
    $unique = if ($field.unique) { 'TRUE' } else { 'FALSE' }
    $extras = ''
    if ($field.type -eq 'DateTime') { $extras = ' Format="' + $(if ($field.format) { $field.format } else { 'DateTime' }) + '"' }
    if ($field.type -eq 'Note') { $extras = ' RichText="FALSE" AppendOnly="FALSE" NumLines="6"' }
    if ($field.type -eq 'Number') { $extras = ' Min="0" Decimals="2"' }
    $default = if ($null -ne $field.default) { "<Default>$($field.default)</Default>" } else { '' }
    $xml = "<Field Type=`"$($field.type)`" Name=`"$($field.name)`" StaticName=`"$($field.name)`" DisplayName=`"$($field.name)`" Required=`"$required`" Indexed=`"$indexed`" EnforceUniqueValues=`"$unique`"$extras>$default</Field>"
    Invoke-Request "$listUrl/fields/createfieldasxml" 'post' @{ parameters = @{ SchemaXml = $xml; Options = 0 } } | Out-Null
  }
  if ($Apply) { Invoke-Request $listUrl 'post' @{ EnableVersioning = $true } -Merge | Out-Null }
}
Write-Host $(if ($Apply) { 'Assembly schema applied. Existing items were preserved.' } else { 'Read-only schema review complete. Add -Apply to create missing schema.' })
