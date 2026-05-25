$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$Port = if ($env:PORT) { $env:PORT } else { "3000" }

function Test-Command($Name) {
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Ensure-Node {
  if (Test-Command node) { return }

  Write-Host "Node.js 未安装，正在尝试通过 winget 安装 Node.js LTS..."
  if (-not (Test-Command winget)) {
    throw "未找到 winget。请先安装 Node.js 20+，然后重新运行本脚本。"
  }

  winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
  $env:Path = "$env:ProgramFiles\nodejs;$env:LocalAppData\Programs\nodejs;$env:Path"

  if (-not (Test-Command node)) {
    throw "Node.js 安装完成但当前终端未识别。请重新打开 PowerShell 后再运行本脚本。"
  }
}

Ensure-Node
Set-Location $Root

Write-Host "正在安装依赖..."
& npm.cmd install

Start-Job -ScriptBlock {
  param($Port)
  for ($i = 0; $i -lt 90; $i++) {
    try {
      Invoke-WebRequest "http://localhost:$Port/health" -UseBasicParsing -TimeoutSec 2 | Out-Null
      Start-Process "http://localhost:$Port"
      break
    } catch {
      Start-Sleep -Seconds 1
    }
  }
} -ArgumentList $Port | Out-Null

Write-Host "启动服务：http://localhost:$Port"
& npm.cmd start

