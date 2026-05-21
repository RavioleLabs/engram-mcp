#Requires -Version 5.1
<#
.SYNOPSIS
    EngramMCP installer for Windows.

.DESCRIPTION
    Downloads the latest (or specified) EngramMCP binary from GitHub Releases,
    installs it to %LOCALAPPDATA%\EngramMCP\bin, installs Ollama if missing,
    runs the install wizard, registers an NSSM Windows service, and
    auto-updates %USERPROFILE%\.claude\mcp.json / %USERPROFILE%\.cursor\mcp.json.

.PARAMETER Version
    Override the version to install (e.g. v1.2.3). Defaults to "latest".

.PARAMETER InstallDir
    Override the install directory. Defaults to %LOCALAPPDATA%\EngramMCP\bin.

.PARAMETER NoService
    Skip Windows service installation.

.PARAMETER NoMcpJson
    Skip mcp.json auto-configuration.

.PARAMETER WhatIf
    Dry-run: print what would be done without making changes.

.EXAMPLE
    iex (iwr https://engram-mcp.com/install.ps1).Content
    # or with version pin:
    $env:ENGRAM_VERSION="v1.2.3"; iex (iwr https://engram-mcp.com/install.ps1).Content
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$Version    = $env:ENGRAM_VERSION,
    [string]$InstallDir = $env:ENGRAM_DIR,
    [switch]$NoService,
    [switch]$NoMcpJson
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ── Constants ─────────────────────────────────────────────────────────────────

$REPO        = "RavioleLabs/engram-mcp"
$BINARY_NAME = "engram-mcp.exe"
$NSSM_URL    = "https://nssm.cc/release/nssm-2.24.zip"
$NSSM_SHA256 = "3e3e780e9f4a3a4c21bae19253e3b3c3b3cba42d5b25025f9685e24e8b5e4a5"  # advisory — update on each nssm release

if (-not $InstallDir) {
    $InstallDir = Join-Path $env:LOCALAPPDATA "EngramMCP\bin"
}

# ── Helpers ───────────────────────────────────────────────────────────────────

function Write-Step([string]$msg) {
    Write-Host ""
    Write-Host "  $msg" -ForegroundColor Cyan
}

function Test-Command([string]$cmd) {
    return $null -ne (Get-Command $cmd -ErrorAction SilentlyContinue)
}

# ── Resolve version ────────────────────────────────────────────────────────────

if (-not $Version -or $Version -eq "latest") {
    Write-Step "Resolving latest version..."
    try {
        $rel     = Invoke-RestMethod "https://api.github.com/repos/$REPO/releases/latest"
        $Version = $rel.tag_name
    } catch {
        Write-Error "Could not determine latest version. Set `$env:ENGRAM_VERSION=v1.2.3 to override."
        exit 1
    }
}

$BINARY      = "engram-mcp-win-x64.exe"
$DOWNLOAD_URL = "https://github.com/$REPO/releases/download/$Version/$BINARY"
$CHECKSUM_URL = "$DOWNLOAD_URL.sha256"

Write-Host ""
Write-Host "  EngramMCP $Version - local-first memory for AI agents" -ForegroundColor Green
Write-Host "  Platform: windows-x64"
Write-Host ""

# ── Install dir ───────────────────────────────────────────────────────────────

if ($PSCmdlet.ShouldProcess($InstallDir, "Create install directory")) {
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
}

# ── Download binary ────────────────────────────────────────────────────────────

$BinaryPath = Join-Path $InstallDir $BINARY_NAME
Write-Step "Downloading $BINARY..."
if ($PSCmdlet.ShouldProcess($BinaryPath, "Download binary")) {
    if ($env:INSTALL_FROM_FILE) {
        Copy-Item -Path $env:INSTALL_FROM_FILE -Destination $BinaryPath -Force
    } else {
        Invoke-WebRequest -Uri $DOWNLOAD_URL -OutFile $BinaryPath -UseBasicParsing
    }
}

# ── Verify checksum ────────────────────────────────────────────────────────────

Write-Step "Verifying checksum..."
if ($PSCmdlet.ShouldProcess($BinaryPath, "Verify SHA256")) {
    try {
        $expectedRaw = (Invoke-WebRequest -Uri $CHECKSUM_URL -UseBasicParsing).Content
        $expected    = ($expectedRaw -split '\s+')[0].Trim().ToLower()
        $actual      = (Get-FileHash -Path $BinaryPath -Algorithm SHA256).Hash.ToLower()
        if ($actual -ne $expected) {
            Write-Error "Checksum mismatch! Expected $expected, got $actual"
            Remove-Item $BinaryPath -Force
            exit 1
        }
        Write-Host "  Checksum OK"
    } catch {
        Write-Warning "Could not fetch checksum — skipping verification."
    }
}

# ── PATH setup ────────────────────────────────────────────────────────────────

Write-Step "Updating PATH..."
if ($PSCmdlet.ShouldProcess("User PATH", "Add $InstallDir")) {
    $userPath = [System.Environment]::GetEnvironmentVariable("PATH", "User")
    if ($userPath -notlike "*$InstallDir*") {
        [System.Environment]::SetEnvironmentVariable(
            "PATH",
            "$InstallDir;$userPath",
            "User"
        )
        Write-Host "  Added $InstallDir to user PATH."
    } else {
        Write-Host "  $InstallDir already in PATH."
    }
    $env:PATH = "$InstallDir;$env:PATH"
}

# ── Ollama ────────────────────────────────────────────────────────────────────

function Install-Ollama {
    if (Test-Command "ollama") {
        $v = & ollama --version 2>&1 | Select-Object -First 1
        Write-Host "  Ollama already installed: $v"
        return $true
    }

    Write-Host ""
    Write-Host "  Ollama is required for local embeddings (free, private)."

    $reply = Read-Host "  Install Ollama now? [Y/n]"
    if ($reply -and $reply -notmatch '^[Yy]') {
        Write-Host "  Skipping Ollama. Run 'engram-mcp install:wizard' later."
        return $false
    }

    Write-Step "Downloading Ollama installer..."
    $ollamaInstaller = Join-Path $env:TEMP "OllamaSetup.exe"
    Invoke-WebRequest "https://ollama.com/download/OllamaSetup.exe" -OutFile $ollamaInstaller -UseBasicParsing
    Start-Process $ollamaInstaller -ArgumentList "/S" -Wait
    return $true
}

$ollamaOk = $true
if (-not $PSCmdlet.ShouldProcess("Ollama", "Check/install")) {
    # WhatIf mode
} else {
    $ollamaOk = Install-Ollama
}

# ── Install wizard ─────────────────────────────────────────────────────────────

Write-Step "Running install wizard..."
if ($PSCmdlet.ShouldProcess("install:wizard", "Run")) {
    try {
        & $BinaryPath install:wizard
    } catch {
        Write-Warning "Install wizard failed — run 'engram-mcp install:wizard' manually."
    }
}

# ── NSSM Windows Service ──────────────────────────────────────────────────────

function Install-EngramService {
    if ($NoService) {
        Write-Host "  Skipping service install (-NoService)."
        return
    }

    Write-Step "Installing Windows service via NSSM..."

    # Download NSSM
    $nssmZip = Join-Path $env:TEMP "nssm.zip"
    $nssmDir = Join-Path $env:TEMP "nssm-extract"
    Invoke-WebRequest -Uri $NSSM_URL -OutFile $nssmZip -UseBasicParsing
    Expand-Archive -Path $nssmZip -DestinationPath $nssmDir -Force

    $nssmExe = Get-ChildItem $nssmDir -Recurse -Filter "nssm.exe" |
               Where-Object { $_.FullName -match "win64" } |
               Select-Object -First 1 -ExpandProperty FullName

    if (-not $nssmExe) {
        $nssmExe = Get-ChildItem $nssmDir -Recurse -Filter "nssm.exe" |
                   Select-Object -First 1 -ExpandProperty FullName
    }

    if (-not $nssmExe) {
        Write-Warning "NSSM not found in zip — skipping service install."
        return
    }

    $logDir = Join-Path $env:USERPROFILE ".engram\logs"
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null

    # Remove existing service if present
    & $nssmExe stop "EngramMCP" 2>$null
    & $nssmExe remove "EngramMCP" confirm 2>$null

    & $nssmExe install "EngramMCP" $BinaryPath
    & $nssmExe set "EngramMCP" AppDirectory $InstallDir
    & $nssmExe set "EngramMCP" AppStdout (Join-Path $logDir "engram.log")
    & $nssmExe set "EngramMCP" AppStderr (Join-Path $logDir "engram.err")
    & $nssmExe set "EngramMCP" AppRotateFiles 1
    & $nssmExe set "EngramMCP" AppRotateBytes 10485760
    & $nssmExe set "EngramMCP" Start SERVICE_AUTO_START
    & $nssmExe start "EngramMCP"

    Write-Host "  Windows service 'EngramMCP' installed and started."

    # Clean up
    Remove-Item $nssmZip -Force -ErrorAction SilentlyContinue
    Remove-Item $nssmDir -Recurse -Force -ErrorAction SilentlyContinue
}

if ($PSCmdlet.ShouldProcess("EngramMCP service", "Install")) {
    Install-EngramService
}

# ── mcp.json auto-config ───────────────────────────────────────────────────────

function Update-McpJson([string]$mcpFile) {
    $dir = Split-Path $mcpFile
    if (-not (Test-Path $dir)) { return }

    $reply = Read-Host "  Add engram-mcp to $mcpFile? [Y/n]"
    if ($reply -and $reply -notmatch '^[Yy]') { return }

    $entry = [ordered]@{ command = $BinaryPath; args = @() }

    $cfg = [ordered]@{ mcpServers = [ordered]@{} }
    if (Test-Path $mcpFile) {
        try {
            $raw = Get-Content $mcpFile -Raw
            $cfg = $raw | ConvertFrom-Json -AsHashtable
            if (-not $cfg.ContainsKey("mcpServers")) { $cfg["mcpServers"] = @{} }
        } catch {
            Write-Warning "  Could not parse $mcpFile — creating fresh."
        }
    }

    $cfg["mcpServers"]["engram"] = $entry
    $cfg | ConvertTo-Json -Depth 10 | Set-Content $mcpFile -Encoding UTF8
    Write-Host "  Updated $mcpFile"
}

if (-not $NoMcpJson -and -not $WhatIfPreference) {
    Update-McpJson (Join-Path $env:USERPROFILE ".claude\mcp.json")
    Update-McpJson (Join-Path $env:USERPROFILE ".cursor\mcp.json")
}

# ── Install engram-skill plugin for Claude Code ────────────────────────────────

function Install-EngramSkill {
    $pluginsFile = Join-Path $env:USERPROFILE ".claude\plugins\installed_plugins.json"
    if (-not (Test-Path $pluginsFile)) {
        Write-Host "  Claude Code not detected — skipping engram-skill install (not needed for Cursor / Continue / other MCP clients; they get instructions via MCP spec)."
        return
    }

    Write-Step "Installing engram-skill plugin for Claude Code..."

    $skillVersion = "0.2.0"
    $skillDir = Join-Path $env:USERPROFILE ".claude\plugins\cache\local\engram-skill\$skillVersion"
    New-Item -ItemType Directory -Force -Path $skillDir | Out-Null

    $cloned = $false
    if (Test-Command "git") {
        try {
            Remove-Item $skillDir -Recurse -Force -ErrorAction SilentlyContinue
            & git clone --quiet --depth 1 --branch "v$skillVersion" https://github.com/RavioleLabs/engram-skill $skillDir 2>$null
            $cloned = $true
        } catch {
            try {
                & git clone --quiet --depth 1 https://github.com/RavioleLabs/engram-skill $skillDir
                $cloned = $true
            } catch {
                Write-Warning "  Could not clone engram-skill from GitHub."
            }
        }
    }

    $pluginJsonPath = Join-Path $skillDir ".claude-plugin\plugin.json"
    if (Test-Path $pluginJsonPath) {
        $now = (Get-Date -Format "yyyy-MM-ddTHH:mm:ss.000Z")
        $entry = @{
            scope = "user"
            installPath = $skillDir
            version = $skillVersion
            installedAt = $now
            lastUpdated = $now
        }
        $data = Get-Content $pluginsFile -Raw | ConvertFrom-Json -AsHashtable
        if (-not $data.ContainsKey("plugins")) { $data["plugins"] = @{} }
        $data["plugins"]["engram-skill@local"] = @($entry)
        $data | ConvertTo-Json -Depth 10 | Set-Content $pluginsFile -Encoding UTF8
        Write-Host "  engram-skill plugin installed at $skillDir"
    } else {
        Write-Warning "  Could not install engram-skill plugin (network or git issue). engram-mcp still works; the agent will be slightly less optimal at picking it over filesystem grep."
    }
}

if (-not $WhatIfPreference) {
    Install-EngramSkill
}

# ── Pair with cloud account ───────────────────────────────────────────────────

function Invoke-PairAccount {
    if ($env:ENGRAM_NO_PAIR -eq "1") { return }

    $inviteToken = $env:INVITE_TOKEN
    if ($inviteToken) {
        Write-Step "Redeeming invite token..."
        try {
            $body = "{`"invite_token`":`"$inviteToken`"}"
            $resp = Invoke-RestMethod -Uri "https://api.engram-mcp.com/api/pair/redeem-invite" `
                -Method POST `
                -ContentType "application/json" `
                -Body $body `
                -ErrorAction Stop

            $configDir = Join-Path $env:USERPROFILE ".engram"
            New-Item -ItemType Directory -Force -Path $configDir | Out-Null
            $configPath = Join-Path $configDir "config.json"

            $existing = @{}
            if (Test-Path $configPath) {
                try { $existing = Get-Content $configPath -Raw | ConvertFrom-Json -AsHashtable } catch {}
            }

            $existing["engramAccount"] = @{
                jwt          = $resp.jwt
                refreshToken = $resp.refresh_token
                apiKey       = $resp.api_key
                masterKeySalt = if ($existing["engramAccount"]) { $existing["engramAccount"]["masterKeySalt"] } else { "" }
                pairedAt     = (Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")
            }

            $existing | ConvertTo-Json -Depth 10 | Set-Content $configPath -Encoding UTF8
            $email = $resp.user.email
            Write-Host "  Paired to $email" -ForegroundColor Green

            # Auto-open dashboard with session JWT for instant login
            if ($env:ENGRAM_NO_BROWSER -ne "1") {
                $configPath = Join-Path $env:USERPROFILE ".engram\config.json"
                try {
                    $cfg = Get-Content $configPath -Raw | ConvertFrom-Json
                    $jwt = $cfg.engramAccount.jwt
                    if ($jwt) {
                        $encoded = [System.Uri]::EscapeDataString($jwt)
                        $dashUrl = "https://engram-mcp.com/welcome?session=$encoded"
                        Write-Host ""
                        Write-Host "  Opening dashboard in your browser..." -ForegroundColor Cyan
                        Start-Process $dashUrl
                    }
                } catch {
                    # Silently skip if config is not readable
                }
            }

            Write-Host "  Open https://engram-mcp.com/dashboard to view your memory."
        } catch {
            Write-Warning "  Invite redemption failed (expired or already used)."
            Write-Host "  You can still use engram-mcp in local-only mode."
            Write-Host "  To pair later: run 'engram-mcp pair'"
        }
        return
    }

    # No invite token — skip
    Write-Host "  No invite token found — skipping pairing."
    Write-Host "  Run 'engram-mcp pair' later to enable cloud features."
}

if (-not $WhatIfPreference) {
    Invoke-PairAccount
}

# ── Done ──────────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "  EngramMCP $Version installed successfully!" -ForegroundColor Green
Write-Host ""
Write-Host "  Binary:   $BinaryPath"
if (-not $ollamaOk) {
    Write-Host "  WARN: Ollama not installed — run 'engram-mcp install:wizard' to finish." -ForegroundColor Yellow
}
Write-Host ""
Write-Host "  Start manually:  engram-mcp"
Write-Host "  Open dashboard:  http://localhost:7777"
Write-Host "  Docs:            https://engram-mcp.com/docs"
Write-Host ""
