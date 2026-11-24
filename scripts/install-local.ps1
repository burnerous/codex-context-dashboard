$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$buildRoot = Join-Path $projectRoot 'dist/marketplace'
$catalog = Join-Path $buildRoot '.claude-plugin/marketplace.json'
if (-not (Test-Path -LiteralPath $catalog -PathType Leaf)) {
    throw '请先运行 npm run build。'
}

$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$marketplace = Join-Path $codexHome 'local-marketplaces/codex-context-dashboard'
$codexExe = (Get-Command codex.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source

New-Item -Path $marketplace -ItemType Directory -Force | Out-Null
Get-ChildItem -LiteralPath $buildRoot -Force | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $marketplace -Recurse -Force
}

& $codexExe plugin marketplace add $marketplace
if ($LASTEXITCODE -ne 0) {
    throw 'Codex 无法注册专用本地插件源。'
}
& $codexExe plugin add 'codex-context-dashboard@codex-dashboard-local'
if ($LASTEXITCODE -ne 0) {
    throw 'Codex 无法安装用量看板。'
}
