# ============================================================================
# Install the official Beike CLI (Windows / PowerShell)
# ============================================================================
#
# Purpose:
#   EstatePilot AI fetches real property data through Beike's AI open platform.
#   That platform is exposed as an MCP (Model Context Protocol) service and the
#   supported way to call it is the official `beike` CLI. This project invokes
#   the CLI as a subprocess and converts its output into NormalizedProperty.
#
# Security:
#   - The binary is downloaded from the official GitHub Releases page and its
#     SHA256 is verified against the official release manifest.
#   - Installation aborts if the checksum does not match.
#   - No credentials are stored by this script. The API key is supplied through
#     the BEIKE_MCP_API_KEY environment variable at runtime.
#
# NOTE: This file is intentionally ASCII-only. Windows PowerShell 5.1 reads
#       .ps1 files using the system ANSI codepage, so non-ASCII characters in a
#       UTF-8 file get mangled and produce parser errors.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File infrastructure/beike/install-cli.ps1
#   powershell -ExecutionPolicy Bypass -File infrastructure/beike/install-cli.ps1 -Version 0.2.26 -Force

param(
    [string]$Version = '',
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$manifestUrl = 'https://raw.githubusercontent.com/LianjiaTech/beike-ai-platform/master/cli/releases/manifest.json'
$installDir = Join-Path $PSScriptRoot 'bin'
$exePath = Join-Path $installDir 'beike.exe'

Write-Host '==> Fetching official release manifest...'
$manifest = Invoke-RestMethod -Uri $manifestUrl
$targetVersion = if ($Version) { $Version } else { $manifest.latest }

Write-Host "==> Target version: $targetVersion"

$release = $manifest.releases | Where-Object { $_.version -eq $targetVersion } | Select-Object -First 1
if (-not $release) {
    throw "Version $targetVersion not found in manifest"
}

$binary = $release.binaries |
    Where-Object { $_.os -eq 'windows' -and $_.arch -eq 'amd64' } |
    Select-Object -First 1

if (-not $binary) {
    throw "Version $targetVersion has no Windows x64 binary"
}

# Skip if already installed at the requested version
if ((Test-Path $exePath) -and -not $Force) {
    $existing = & $exePath --version 2>$null | Select-Object -First 1
    if ($existing -match [regex]::Escape($targetVersion)) {
        Write-Host "[OK] beike CLI already installed at requested version ($existing)"
        Write-Host "     Path: $exePath"
        exit 0
    }
    Write-Host "==> Found $existing, upgrading to $targetVersion"
}

$tmpDir = Join-Path $env:TEMP ('beike-cli-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmpDir | Out-Null

try {
    $archive = Join-Path $tmpDir 'beike.tar.gz'

    Write-Host '==> Downloading...'
    Invoke-WebRequest -Uri $binary.url -OutFile $archive -UseBasicParsing

    if ((Get-Item $archive).Length -lt 1024) {
        throw 'Downloaded file is too small, likely corrupted'
    }
    Write-Host "    Downloaded $([math]::Round((Get-Item $archive).Length / 1MB, 2)) MB"

    # Integrity check: mandatory when installing a third-party binary
    Write-Host '==> Verifying SHA256...'
    $actual = (Get-FileHash -Algorithm SHA256 -Path $archive).Hash.ToLower()
    $expected = $binary.sha256.ToLower()
    if ($actual -ne $expected) {
        throw "SHA256 mismatch, refusing to install`n  expected: $expected`n  actual:   $actual"
    }
    Write-Host '    [OK] Checksum matches the official manifest'

    Write-Host '==> Extracting...'
    $extractDir = Join-Path $tmpDir 'extract'
    New-Item -ItemType Directory -Path $extractDir | Out-Null
    tar -xzf $archive -C $extractDir
    if ($LASTEXITCODE -ne 0) { throw 'Extraction failed (requires the built-in tar from Windows 10 1803+)' }

    $exe = Get-ChildItem -Path $extractDir -Filter 'beike.exe' -Recurse | Select-Object -First 1
    if (-not $exe) { throw 'beike.exe not found inside the archive' }

    Write-Host '==> Installing...'
    New-Item -ItemType Directory -Path $installDir -Force | Out-Null
    Copy-Item $exe.FullName $exePath -Force

    $installed = & $exePath --version 2>$null | Select-Object -First 1
    Write-Host ''
    Write-Host "[OK] beike CLI $installed installed"
    Write-Host "     Path: $exePath"
    Write-Host ''
    Write-Host 'Next step: set BEIKE_MCP_API_KEY in .env, or run:'
    Write-Host '  infrastructure\beike\bin\beike.exe login'
    Write-Host ''
}
finally {
    Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue
}
