# install.ps1 — one-command installer for the Resources Node (Windows).
#
# A newsroom runs ONE line in the built-in PowerShell — nothing to install by hand:
#
#     irm https://grounded.developai.co.za/nodes/resources/windows | iex
#
# What it does — no admin rights, no installers to click through, no git, no VS Code:
#   1. Uses the Node already on the PC if it's new enough; otherwise downloads a
#      private, app-only copy of Node (nothing system-wide changes).
#   2. Downloads the latest app code from GitHub over plain HTTPS (no git).
#   3. Installs the app's parts, starts it, and opens the dashboard in the browser.
#
# Re-running the same line later just relaunches on the latest version. The
# newsroom's API key (.env) and uploaded data (data\) are ALWAYS preserved.
#
# Everything below is for Develop AI, not the newsroom — they only ever see the
# friendly messages this prints.

$ErrorActionPreference = 'Stop'

# ── Settings (defaults are the real values; env vars override them for testing) ──
$Repo    = if ($env:GROUNDED_REPO)         { $env:GROUNDED_REPO }         else { 'pauldevelopai/node-resources' }
$Ref     = if ($env:GROUNDED_REF)          { $env:GROUNDED_REF }          else { 'main' }
$NodeVer = if ($env:GROUNDED_NODE_VERSION) { $env:GROUNDED_NODE_VERSION } else { '20.18.1' }
$Root    = if ($env:GROUNDED_HOME)         { $env:GROUNDED_HOME }         else { Join-Path $env:USERPROFILE 'GROUNDED' }
$AppDir  = Join-Path $Root 'node-resources'
$Name    = 'Resources'
$Port    = if ($env:PORT) { $env:PORT } else { '3000' }

function Say($m) { Write-Host "  $m" }
function OK($m)  { Write-Host "  + $m" -ForegroundColor Green }
function Die($m) {
  Write-Host "`n  x $m`n`n  Email Paul a screenshot of this window - he'll get you unstuck.`n" -ForegroundColor Red
  exit 1
}

Write-Host "`n  +- $Name - Setup -+`n"

# ── 1. Make sure we have Node >= 20 ──────────────────────────────────────────
$needNode = $true
if (Get-Command node -ErrorAction SilentlyContinue) {
  try { $major = [int](& node -p "process.versions.node.split('.')[0]") } catch { $major = 0 }
  if ($major -ge 20) {
    $needNode = $false
    OK "Using the Node already on this PC ($(& node -v))."
  }
}

if ($needNode) {
  $build    = "node-v$NodeVer-win-x64"
  $nodeHome = Join-Path $AppDir '.node'
  $nodeDir  = Join-Path $nodeHome $build
  if (-not (Test-Path (Join-Path $nodeDir 'node.exe'))) {
    Say "Setting up a private copy of Node just for this app (one-time, ~30 MB)..."
    New-Item -ItemType Directory -Force -Path $nodeHome | Out-Null
    $zip = Join-Path $env:TEMP "$build.zip"
    try {
      Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v$NodeVer/$build.zip" -OutFile $zip
      Expand-Archive -Path $zip -DestinationPath $nodeHome -Force
      Remove-Item $zip -Force -ErrorAction SilentlyContinue
    } catch { Die "Couldn't download Node. Check your internet connection and run the command again." }
  }
  $env:Path = "$nodeDir;$env:Path"
  OK "Node ready ($(& node -v))."
}

# ── 2. Download the latest app code (plain HTTPS, no git) ────────────────────
$fresh = -not (Test-Path (Join-Path $AppDir 'package.json'))
$tmp   = Join-Path $env:TEMP ('grounded-' + [System.Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

$gotCode = $false
$src     = $null
try {
  Say "Downloading the latest $Name..."
  $zip = Join-Path $tmp 'app.zip'
  Invoke-WebRequest -UseBasicParsing -Uri "https://codeload.github.com/$Repo/zip/refs/heads/$Ref" -OutFile $zip
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  Remove-Item $zip -Force
  # The zip unpacks to a single <repo>-<ref> directory.
  $src = (Get-ChildItem -Path $tmp -Directory | Select-Object -First 1).FullName
  $gotCode = $true
} catch {
  if ($fresh) { Die "Couldn't download the app. Check your internet connection and run the command again." }
  Say "(Couldn't reach GitHub - launching the version already installed.)"
}

New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
# Remember the dependency fingerprint before we sync, so we only reinstall if it changed.
$preSig = ''
if (Test-Path (Join-Path $AppDir 'package.json')) {
  $preSig = (Get-FileHash (Join-Path $AppDir 'package.json') -Algorithm SHA1).Hash
}

if ($gotCode) {
  # Copy code in, but NEVER touch the newsroom's key (.env) or data (data\).
  # robocopy exit codes 0-7 are success; 8+ is a real failure.
  robocopy $src $AppDir /E /XD node_modules .node .git data /XF .env .env.local *.log /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { Die "Couldn't copy the app files." }
  $global:LASTEXITCODE = 0
  OK "App code is up to date."
}
New-Item -ItemType Directory -Force -Path (Join-Path $AppDir 'data\processed') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $AppDir 'data\raw') | Out-Null
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue

Set-Location $AppDir

# ── 3. Install the app's parts (only when something changed) ─────────────────
$postSig = (Get-FileHash (Join-Path $AppDir 'package.json') -Algorithm SHA1).Hash
if ((-not (Test-Path 'node_modules')) -or ($preSig -ne $postSig)) {
  Say "Installing the app's parts (the first time takes a minute)..."
  & npm install --no-audit --no-fund --loglevel=error
  if ($LASTEXITCODE -ne 0) { Die "Couldn't install the app's parts. Run the command again; if it keeps failing, email Paul." }
  OK "Parts installed."
}

# ── 4. Launch ────────────────────────────────────────────────────────────────
OK "Starting $Name..."
Write-Host "`n  Your dashboard will open at  http://localhost:$Port"
Write-Host "  Leave this window open while you use the app."
Write-Host "  To stop the app: press Ctrl+C here, or just close this window."
Write-Host "  To use it again another day: paste the same command.`n"
Start-Job -ScriptBlock { Start-Sleep 3; Start-Process "http://localhost:$using:Port" } | Out-Null
& npm start
