param(
  [Parameter(Mandatory = $true)]
  [string]$JobFile
)

$ErrorActionPreference = 'Stop'
$node = (Get-Command node.exe -ErrorAction Stop).Source
$runner = Join-Path $PSScriptRoot 'deferred-migration-export.cjs'

if (-not [IO.Path]::IsPathRooted($JobFile)) {
  throw 'The deferred migration job path must be absolute.'
}

& $node $runner ([IO.Path]::GetFullPath($JobFile))
exit $LASTEXITCODE
