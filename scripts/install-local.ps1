$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$buildRoot = Join-Path $projectRoot 'dist/marketplace'
$catalog = Join-Path $buildRoot '.claude-plugin/marketplace.json'
if (-not (Test-Path -LiteralPath $catalog -PathType Leaf)) {
    throw '请先运行 npm run build。'
}

$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$marketplace = Join-Path $codexHome 'local-marketplaces/codex-context-dashboard'
$portableNode = Join-Path $projectRoot 'runtime/node.exe'
$usesPortableNode = Test-Path -LiteralPath $portableNode -PathType Leaf
$codexCommand = Get-Command codex.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($codexCommand) {
    $codexExe = $codexCommand.Source
} else {
    $desktopPackage = Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue | Select-Object -First 1
    $codexExe = if ($desktopPackage) { Join-Path $desktopPackage.InstallLocation 'app/resources/codex.exe' } else { $null }
    if (-not $codexExe -or -not (Test-Path -LiteralPath $codexExe -PathType Leaf)) {
        throw '找不到 Codex 桌面端。请安装 Codex，或确保 codex.exe 位于 PATH 中。'
    }
}

function Get-Sha256([string]$filePath) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $stream = [System.IO.File]::OpenRead($filePath)
        try {
            [System.BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
        } finally {
            $stream.Dispose()
        }
    } finally {
        $sha.Dispose()
    }
}

if ($usesPortableNode) {
    $portableVersion = (& $portableNode --version).Trim()
    if ($LASTEXITCODE -ne 0 -or $portableVersion -notmatch '^v(\d+\.\d+\.\d+)$') {
        throw '离线 Node.js 运行时无法启动。'
    }
    $portableMajor = [int]$portableVersion.Substring(1).Split('.')[0]
    if ($portableMajor -lt 24) {
        throw "离线 Node.js 版本 $portableVersion 低于所需的 v24。"
    }
}

New-Item -Path $marketplace -ItemType Directory -Force | Out-Null
Get-ChildItem -LiteralPath $buildRoot -Force | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $marketplace -Recurse -Force
}

if ($usesPortableNode) {
    $runtimeHash = (Get-Sha256 $portableNode)
    $runtimeDirectoryName = $portableVersion.Substring(1) + '-' + $runtimeHash.Substring(0, 12)
    $installedRuntimeDirectory = Join-Path $marketplace ('runtime/' + $runtimeDirectoryName)
    $installedNode = Join-Path $installedRuntimeDirectory 'node.exe'
    New-Item -ItemType Directory -Path $installedRuntimeDirectory -Force | Out-Null
    $installedNodeHash = if (Test-Path -LiteralPath $installedNode -PathType Leaf) {
        (Get-Sha256 $installedNode)
    } else { '' }
    if ($installedNodeHash -ne $runtimeHash) {
        Copy-Item -LiteralPath $portableNode -Destination $installedNode -Force
    }
    $portableLicense = Join-Path $projectRoot 'runtime/LICENSE'
    if (Test-Path -LiteralPath $portableLicense -PathType Leaf) {
        $installedLicense = Join-Path $installedRuntimeDirectory 'LICENSE'
        $portableLicenseHash = (Get-Sha256 $portableLicense)
        $installedLicenseHash = if (Test-Path -LiteralPath $installedLicense -PathType Leaf) {
            (Get-Sha256 $installedLicense)
        } else { '' }
        if ($installedLicenseHash -ne $portableLicenseHash) {
            Copy-Item -LiteralPath $portableLicense -Destination $installedLicense -Force
        }
    }

    $pluginSource = Join-Path $marketplace 'plugins/codex-context-dashboard'
    $manifestPath = Join-Path $pluginSource '.mcp.json'
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $server = $manifest.mcpServers.codex_usage_dashboard
    $server.command = $installedNode
    $server.args = @('server.cjs')
    $server.cwd = '.'
    $server.env.CODEX_DASHBOARD_CODEX_EXE = $codexExe
    $manifestJson = ConvertTo-Json -InputObject $manifest -Depth 20
    [System.IO.File]::WriteAllText($manifestPath, $manifestJson + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))

    $nodeLiteral = "'" + $installedNode.Replace("'", "''") + "'"
    $codexLiteral = "'" + $codexExe.Replace("'", "''") + "'"
    $wrapperPath = Join-Path $pluginSource 'collect.ps1'
    $wrapper = [System.IO.File]::ReadAllText($wrapperPath)
    $relativeNodeLine = @'
$nodeExePath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..\..\runtime\node.exe'))
'@.TrimEnd("`r", "`n")
    $installedNodeLine = '$nodeExePath = ' + $nodeLiteral
    if (-not $wrapper.Contains($relativeNodeLine)) { throw '离线 Hook 启动器格式不正确。' }
    $wrapper = $wrapper.Replace($relativeNodeLine, $installedNodeLine)
    $encodingLine = '$OutputEncoding = [Console]::OutputEncoding'
    $codexEnvironmentLine = '$env:CODEX_DASHBOARD_CODEX_EXE = ' + $codexLiteral
    if (-not $wrapper.Contains($encodingLine)) { throw '离线 Hook 启动器缺少环境配置。' }
    $wrapper = $wrapper.Replace($encodingLine, $encodingLine + "`r`n" + $codexEnvironmentLine)
    [System.IO.File]::WriteAllText($wrapperPath, $wrapper, [System.Text.UTF8Encoding]::new($true))
}

& $codexExe plugin marketplace add $marketplace
if ($LASTEXITCODE -ne 0) {
    throw 'Codex 无法注册专用本地插件源。'
}
& $codexExe plugin add 'codex-context-dashboard@codex-dashboard-local'
if ($LASTEXITCODE -ne 0) {
    throw 'Codex 无法安装用量看板。'
}
