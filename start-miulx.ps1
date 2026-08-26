param(
  [switch]$NoBrowser,
  [switch]$Hidden,
  [switch]$Silent,
  [string]$Proxy
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$credentialPath = "C:\Program Files\safe\miulx-daily-hub.json"
$serverUrl = "http://127.0.0.1:4173"
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
    return
  }

  foreach ($servicePid in $ownerPids) {
    $process = Get-Process -Id $servicePid -ErrorAction SilentlyContinue
    if (-not $process) {
      throw "The process owning port 4173 could not be inspected. Close the old node.exe manually and try again."
    }
    if ($process.ProcessName -notin @("node", "nodejs")) {
      throw "Port 4173 is used by $($process.ProcessName), not node.exe. The launcher did not stop it."
    }
  }

  $graceful = $false
  try {
    $shutdown = Invoke-RestMethod -Uri "$serverUrl/api/system/shutdown" -Method Post -ContentType "application/json" -Body "{}" -TimeoutSec 5 -Proxy $null -DisableKeepAlive
    $graceful = $shutdown.status -eq "draining"
    if ($graceful) {
      Write-LauncherLog "Graceful restart requested; waiting for the task queue to drain."
      $deadline = (Get-Date).AddMinutes(5)
      do {
        Start-Sleep -Milliseconds 500
        $remaining = @(Get-NetTCPConnection -LocalPort 4173 -State Listen -ErrorAction SilentlyContinue)
      } while ($remaining -and (Get-Date) -lt $deadline)
      if (-not $remaining) {
        Write-LauncherLog "The previous Daily Data Hub stopped gracefully."
        return
      }
      Write-LauncherLog "Graceful shutdown exceeded five minutes; falling back to a verified force stop."
    }
  } catch {
    Write-LauncherLog "Graceful shutdown was unavailable: $($_.Exception.Message)"
  }

  $remainingListeners = @(Get-NetTCPConnection -LocalPort 4173 -State Listen -ErrorAction SilentlyContinue)
  $remainingPids = @($remainingListeners | Select-Object -ExpandProperty OwningProcess -Unique)
  foreach ($servicePid in $remainingPids) {
    $process = Get-Process -Id $servicePid -ErrorAction SilentlyContinue
    if (-not $process -or $process.ProcessName -notin @("node", "nodejs")) {
      throw "Port 4173 changed ownership during restart; the launcher did not force stop it."
    }
    Stop-Process -Id $servicePid -Force
    Write-LauncherLog "Force-stopped old Daily Data Hub node.exe after graceful shutdown fallback (PID $servicePid)."
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

  Stop-ExistingDailyService

  $env:GOOGLE_SERVICE_ACCOUNT_FILE = $credentialPath
  $nodeArguments = @()
  if ($env:HTTPS_PROXY -or $env:HTTP_PROXY) {
    $nodeArguments += "--use-env-proxy"
  }
  $nodeArguments += "server.mjs"
  $windowStyle = if ($Hidden) { "Hidden" } else { "Normal" }
  Start-Process -FilePath $node.Source -ArgumentList $nodeArguments -WorkingDirectory $projectRoot -WindowStyle $windowStyle

  $serverReady = $false
  $readyDeadline = (Get-Date).AddSeconds(30)
  do {
    Start-Sleep -Milliseconds 500
    try {
      $null = Invoke-RestMethod -Uri $healthUrl -Method Get -TimeoutSec 2 -Proxy $null -DisableKeepAlive
      $serverReady = $true
      break
    } catch {
      # The new process may still be loading.
    }
  } while ((Get-Date) -lt $readyDeadline)
  if (-not $serverReady) {
    throw "The restarted Daily Data Hub did not become ready within 30 seconds. Check data\launcher.log and the Node.js process."
  }

  if (-not $NoBrowser) {
    Start-Process $serverUrl
  }

  $proxyValue = $env:HTTPS_PROXY
  if (-not $proxyValue) { $proxyValue = $env:HTTP_PROXY }
  if (-not $proxyValue) {
    Write-LauncherLog "No local proxy detected; Google requests will use the direct connection."
  }
  Write-LauncherLog "Restarted: $serverUrl; account: $($credential.client_email); proxy: $proxyValue"
  if (-not $Silent) {
    Write-Host "MIULX Daily Data Hub restarted: $serverUrl" -ForegroundColor Green
    Write-Host "Google service account: $($credential.client_email)" -ForegroundColor DarkGray
  }
} catch {
  Stop-WithMessage $_.Exception.Message
}
