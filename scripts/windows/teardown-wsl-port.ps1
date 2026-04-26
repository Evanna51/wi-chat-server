<#
.SYNOPSIS
  Remove the portproxy rule and firewall rule created by expose-wsl-port.ps1.

.PARAMETER Port
  TCP port that was forwarded. Default 8787.

.PARAMETER RuleName
  Display name of the firewall rule. Default "WSL Forward <port>".

.EXAMPLE
  .\teardown-wsl-port.ps1
  .\teardown-wsl-port.ps1 -Port 9000
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

netsh interface portproxy delete v4tov4 listenport=$Port listenaddress=0.0.0.0 2>$null | Out-Null
Remove-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue

Write-Host "Removed portproxy + firewall rule for port $Port." -ForegroundColor Green
Write-Host ""
Write-Host "Active portproxy rules:" -ForegroundColor Cyan
netsh interface portproxy show v4tov4
Write-Host ""
Read-Host "Press Enter to close"
