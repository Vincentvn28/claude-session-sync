# build.ps1 — 1-click build & package for Claude Session Sync extension
#
# Usage (PowerShell, đứng trong folder tools\claude-session-sync\):
#   .\build.ps1                    # cài deps (lần đầu) + build + package thành .vsix
#   .\build.ps1 -Install           # build xong cài luôn vào Antigravity
#   .\build.ps1 -SkipInstall       # chỉ build, không install
#
# Yêu cầu: Node.js >= 18 (https://nodejs.org/en/download)

[CmdletBinding()]
param(
  [switch]$Install,
  [switch]$SkipInstall,
  [string]$AntigravityCli = "$env:LOCALAPPDATA\Programs\Antigravity\bin\antigravity.cmd"
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Has-Cmd([string]$name) {
  return (Get-Command $name -ErrorAction SilentlyContinue) -ne $null
}

# 1. Pre-flight: Node.js
if (-not (Has-Cmd "node")) {
  Write-Host "[X] Khong tim thay Node.js trong PATH." -ForegroundColor Red
  Write-Host ""
  Write-Host "Cai Node.js (mat ~3 phut):"
  Write-Host "  1. Mo trinh duyet: https://nodejs.org/en/download"
  Write-Host "  2. Tai 'Windows Installer (.msi) - LTS'"
  Write-Host "  3. Chay file .msi, click Next het, Install"
  Write-Host "  4. DONG cua so PowerShell nay, mo cai moi"
  Write-Host "  5. Chay lai: .\build.ps1"
  exit 1
}

$nodeVer = (node --version) -replace '^v',''
$majorVer = [int]($nodeVer -split '\.')[0]
if ($majorVer -lt 18) {
  Write-Host "[X] Node.js phien ban $nodeVer qua cu (can >= 18)." -ForegroundColor Red
  Write-Host "    Tai ban moi: https://nodejs.org/en/download"
  exit 1
}
Write-Host "[OK] Node.js v$nodeVer" -ForegroundColor Green

# 2. Install npm deps if needed
if (-not (Test-Path "node_modules")) {
  Write-Host "[*] Cai dependencies (lan dau, mat 1-2 phut)..." -ForegroundColor Cyan
  npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { Write-Host "[X] npm install that bai" -ForegroundColor Red; exit 1 }
} else {
  Write-Host "[OK] node_modules da co" -ForegroundColor Green
}

# 3. Build
Write-Host "[*] Build extension..." -ForegroundColor Cyan
npm run build
if ($LASTEXITCODE -ne 0) { Write-Host "[X] Build that bai" -ForegroundColor Red; exit 1 }
Write-Host "[OK] Build done -> out/extension.js" -ForegroundColor Green

# 4. Package thanh .vsix
Write-Host "[*] Dong goi .vsix..." -ForegroundColor Cyan
# Xoa .vsix cu de tranh confusion
Get-ChildItem -Filter "*.vsix" -ErrorAction SilentlyContinue | Remove-Item -Force
npx --no -- vsce package --no-dependencies --out claude-session-sync.vsix
if ($LASTEXITCODE -ne 0) { Write-Host "[X] vsce package that bai" -ForegroundColor Red; exit 1 }

$vsix = (Get-ChildItem -Filter "*.vsix" | Select-Object -First 1).FullName
if (-not $vsix) { Write-Host "[X] Khong tim thay .vsix sau khi build" -ForegroundColor Red; exit 1 }
Write-Host "[OK] Packaged: $vsix" -ForegroundColor Green

# 5. Install vao Antigravity (optional)
if ($SkipInstall) {
  Write-Host ""
  Write-Host "[i] Bo qua install. Cai thu cong:" -ForegroundColor Yellow
  Write-Host "    1. Mo Antigravity"
  Write-Host "    2. Ctrl+Shift+P -> 'Extensions: Install from VSIX'"
  Write-Host "    3. Chon $vsix"
  exit 0
}

if ($Install -or $true) {
  if (Test-Path $AntigravityCli) {
    Write-Host "[*] Cai vao Antigravity..." -ForegroundColor Cyan
    & $AntigravityCli --install-extension $vsix --force
    if ($LASTEXITCODE -eq 0) {
      Write-Host "[OK] Da cai vao Antigravity. Reload window de kich hoat." -ForegroundColor Green
    } else {
      Write-Host "[!] CLI install loi. Cai thu cong qua Ctrl+Shift+P -> 'Extensions: Install from VSIX'" -ForegroundColor Yellow
    }
  } else {
    Write-Host "[!] Khong tim thay Antigravity CLI: $AntigravityCli" -ForegroundColor Yellow
    Write-Host "    Cai thu cong: mo Antigravity -> Ctrl+Shift+P -> 'Extensions: Install from VSIX' -> chon $vsix"
  }
}

Write-Host ""
Write-Host "[DONE] Tat ca xong!" -ForegroundColor Green
Write-Host "VSIX: $vsix"
