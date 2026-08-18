param(
  [switch]$NoBrowser,
  [switch]$Hidden,
  [switch]$Silent,
  [string]$Proxy
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$credentialPath = "C:\Program Files\safe\miulx-daily-hub.json"
$serverUrl = "http://localhost:4173"
$healthUrl = "$serverUrl/api/bootstrap"
$logPath = Join-Path $projectRoot "data\launcher.log"

if ($Proxy) {
  $env:HTTPS_PROXY = $Proxy
  $env:HTTP_PROXY = $Proxy
} elseif ($Hidden -and -not $env:HTTPS_PROXY -and -not $env:HTTP_PROXY) {
  # Explorer-launched VBS files do not inherit a temporary PowerShell
  # environment. Pick a local proxy only when its port is actually listening;
  # otherwise let Node use the direct connection instead of a dead endpoint.
  $proxyPorts = @(7890, 7891, 10809, 1080, 7897)
  $listeningPorts = @([System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() |
    Select-Object -ExpandProperty Port -Unique)
  # Keep a deterministic preference: prefer the common HTTPS-capable mixed
  # port 7890, and fall back only when it is not listening.
  $listeningProxy = @($proxyPorts | Where-Object { $_ -in $listeningPorts } | Select-Object -First 1)
  if ($listeningProxy) {
    $env:HTTPS_PROXY = "http://127.0.0.1:$($listeningProxy[0])"
    $env:HTTP_PROXY = $env:HTTPS_PROXY
  }
}

function Write-LauncherLog([string]$message) {
  try {
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -LiteralPath $logPath -Value "[$timestamp] $message"
  } catch {
    # Logging must never prevent the application from starting.
  }
}

function Stop-WithMessage([string]$message) {
  Write-LauncherLog "ERROR: $message"
  if (-not $Silent) {
    Write-Host ""
    Write-Host $message -ForegroundColor Red
    Write-Host ""
    Write-Host "Press any key to close this window..." -ForegroundColor Yellow
    [void][Console]::ReadKey($true)
  }
  exit 1
}

function Stop-ExistingDailyService {
  $listeners = @(Get-NetTCPConnection -LocalPort 4173 -State Listen -ErrorAction SilentlyContinue)
  $ownerPids = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
  if (-not $ownerPids) {
    throw "The existing Daily Data Hub responded on port 4173, but its owning process could not be found. Close the old node.exe manually and try again."
  }

  foreach ($ownerPid in $ownerPids) {
    $process = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
    if (-not $process) {
      throw "The process owning port 4173 could not be inspected. Close the old node.exe manually and try again."
    }
    if ($process.ProcessName -notin @("node", "nodejs")) {
      throw "Port 4173 is used by $($process.ProcessName), not node.exe. The launcher did not stop it."
    }
    Stop-Process -Id $ownerPid -Force
    Write-LauncherLog "Stopped old Daily Data Hub node.exe (PID $ownerPid)."
  }
  Start-Sleep -Milliseconds 250
}

try {
  if (-not (Test-Path -LiteralPath $credentialPath -PathType Leaf)) {
    Stop-WithMessage "Google service account file was not found: $credentialPath"
  }

  $credential = Get-Content -Raw -LiteralPath $credentialPath | ConvertFrom-Json
  if (-not $credential.client_email -or -not $credential.private_key) {
    Stop-WithMessage "The Google service account JSON must contain client_email and private_key."
  }

  $node = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $node) {
    Stop-WithMessage "node.exe was not found. Install Node.js 20 or later first."
  }

  $running = $false
  $configured = $false
  try {
    $health = Invoke-RestMethod -Uri $healthUrl -Method Get -TimeoutSec 2
    $running = $true
    $configured = [bool]$health.connection.configured
  } catch {
    $running = $false
  }

  $startedNow = $false
  if ($running) {
    Stop-ExistingDailyService
    $running = $false
  }

  if (-not $running) {
    $env:GOOGLE_SERVICE_ACCOUNT_FILE = $credentialPath
    $nodeArguments = @()
    if ($env:HTTPS_PROXY -or $env:HTTP_PROXY) {
      $nodeArguments += "--use-env-proxy"
    }
    $nodeArguments += "server.mjs"
    $windowStyle = if ($Hidden) { "Hidden" } else { "Normal" }
    Start-Process -FilePath $node.Source -ArgumentList $nodeArguments -WorkingDirectory $projectRoot -WindowStyle $windowStyle
    Start-Sleep -Seconds 2
    $startedNow = $true
  }

  if (-not $NoBrowser) {
    Start-Process $serverUrl
  }

  $proxyValue = $env:HTTPS_PROXY
  if (-not $proxyValue) { $proxyValue = $env:HTTP_PROXY }
  if (-not $proxyValue) {
    Write-LauncherLog "No local proxy detected; Google requests will use the direct connection."
  }
  if ($startedNow) {
    Write-LauncherLog "Started: $serverUrl; account: $($credential.client_email); proxy: $proxyValue"
  } else {
    Write-LauncherLog "Already running: $serverUrl; existing service was not restarted; account: $($credential.client_email); proxy: $proxyValue"
  }
  if (-not $Silent) {
    $statusText = if ($startedNow) { "started" } else { "already running (not restarted)" }
    Write-Host "MIULX Daily Data Hub ${statusText}: $serverUrl" -ForegroundColor Green
    Write-Host "Google service account: $($credential.client_email)" -ForegroundColor DarkGray
  }
} catch {
  Stop-WithMessage $_.Exception.Message
}
