<#
.SYNOPSIS
  Forward a Windows host port to the WSL2 VM and open the Windows firewall.

.DESCRIPTION
  WSL2 runs in a lightweight VM with its own (changing) IP. Devices on the
  same LAN can only reach the Windows host, so we need:
    1. netsh portproxy on Windows: 0.0.0.0:<port> -> <wsl-ip>:<port>
    2. Windows Firewall rule allowing inbound on <port> (Private profile)

  Re-run this script every time WSL is restarted, since WSL's IP can change.
  An alternative is WSL mirrored networking (Win11 22H2+); see README.

.PARAMETER Port
  TCP port to forward. Default 8787.

.PARAMETER RuleName
  Display name of the firewall rule. Default "WSL Forward <port>".

.EXAMPLE
  .\expose-wsl-port.ps1
  .\expose-wsl-port.ps1 -Port 9000
#>

[CmdletBinding()]
param(
  [int]$Port = 8787,
  [string]$RuleName = ""
)

if (-not $RuleName) { $RuleName = "WSL Forward $Port" }

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  $launchArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Port $Port -RuleName `"$RuleName`""
  Start-Process powershell -Verb RunAs -ArgumentList $launchArgs
  exit
}

$ErrorActionPreference = "Stop"

Write-Host "=== Expose WSL2 port $Port to LAN ===" -ForegroundColor Cyan

$wslOutput = (wsl hostname -I) 2>$null
if (-not $wslOutput) {
  Write-Error "Failed to query WSL IP. Is WSL running? Try: wsl -d <distro> echo ok"
  Read-Host "Press Enter to close"
  exit 1
}

$wslIp = ($wslOutput.Trim() -split '\s+')[0]
if (-not $wslIp -or $wslIp -notmatch '^\d+\.\d+\.\d+\.\d+$') {
  Write-Error "Could not parse WSL IPv4 address. Got: $wslOutput"
  Read-Host "Press Enter to close"
  exit 1
}

Write-Host "WSL IP detected: $wslIp"

netsh interface portproxy delete v4tov4 listenport=$Port listenaddress=0.0.0.0 2>$null | Out-Null

netsh interface portproxy add v4tov4 listenport=$Port listenaddress=0.0.0.0 connectport=$Port connectaddress=$wslIp | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Error "netsh portproxy add failed (exit $LASTEXITCODE)"
  Read-Host "Press Enter to close"
  exit 1
}

Write-Host ""
Write-Host "Active portproxy rules:" -ForegroundColor Cyan
netsh interface portproxy show v4tov4

Remove-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName $RuleName `
  -Direction Inbound -Action Allow `
  -Protocol TCP -LocalPort $Port `
  -Profile Private | Out-Null

Write-Host ""
Write-Host "Firewall rule '$RuleName' added (Private profile)." -ForegroundColor Green

$lanIPs = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object {
    $_.IPAddress -notlike '127.*' -and
    $_.IPAddress -notlike '169.254.*' -and
    $_.IPAddress -notlike '172.*' -and
    $_.PrefixOrigin -in 'Dhcp','Manual'
  } |
  Select-Object -ExpandProperty IPAddress

Write-Host ""
Write-Host "=== Done ===" -ForegroundColor Green
Write-Host ""
Write-Host "Reach the service from any device on the same WiFi at:"
if ($lanIPs.Count -eq 0) {
  Write-Host "  (no LAN IPv4 detected — check 'ipconfig')" -ForegroundColor Yellow
} else {
  foreach ($ip in $lanIPs) {
    Write-Host "  http://${ip}:${Port}" -ForegroundColor Yellow
  }
}
Write-Host ""
Write-Host "Reminder:" -ForegroundColor DarkGray
Write-Host "  - Re-run this script after every WSL restart (WSL IP can change)." -ForegroundColor DarkGray
Write-Host "  - Make sure your WSL .env has HOST=0.0.0.0 (not 127.0.0.1)." -ForegroundColor DarkGray
Write-Host "  - To remove the rules later, run: teardown-wsl-port.ps1 -Port $Port" -ForegroundColor DarkGray
Write-Host ""
Read-Host "Press Enter to close"
