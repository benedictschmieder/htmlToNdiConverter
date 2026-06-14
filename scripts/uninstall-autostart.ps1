# uninstall-autostart.ps1
#
# Removes the scheduled task created by install-autostart.ps1.
#
# Run from an elevated PowerShell prompt:
#   powershell -ExecutionPolicy Bypass -File .\uninstall-autostart.ps1

param(
    [string]$TaskName = "HtmlToNdiConverter"
)

$ErrorActionPreference = "Stop"

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Scheduled task '$TaskName' removed." -ForegroundColor Green
}
else {
    Write-Host "No scheduled task named '$TaskName' was found."
}
