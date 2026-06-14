# install-autostart.ps1
#
# Registers the HTML to NDI Converter to start automatically when the media
# production PC user logs on, using a Windows Scheduled Task. The task is set to
# restart automatically if it ever stops.
#
# Run from an elevated PowerShell prompt:
#   powershell -ExecutionPolicy Bypass -File .\install-autostart.ps1
#
# Optional parameters:
#   -ExePath  Full path to the program to launch. Defaults to the packaged
#             HTMLtoNDI.exe if found, otherwise falls back to "npm start" in
#             the project folder (development mode).
#   -TaskName Name of the scheduled task (default: HtmlToNdiConverter).

param(
    [string]$ExePath = "",
    [string]$TaskName = "HtmlToNdiConverter"
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot

function Resolve-Launch {
    param([string]$ExePath)

    if ($ExePath -and (Test-Path $ExePath)) {
        return @{ Program = $ExePath; Arguments = ""; WorkingDir = (Split-Path -Parent $ExePath) }
    }

    # Look for a packaged build produced by electron-builder.
    $candidates = @(
        (Join-Path $projectRoot "dist\win-unpacked\HTMLtoNDI.exe"),
        (Join-Path $env:LOCALAPPDATA "Programs\HTMLtoNDI\HTMLtoNDI.exe")
    )
    foreach ($c in $candidates) {
        if (Test-Path $c) {
            return @{ Program = $c; Arguments = ""; WorkingDir = (Split-Path -Parent $c) }
        }
    }

    # Fall back to development mode: npm start.
    $npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue)
    if ($null -eq $npm) { $npm = (Get-Command npm -ErrorAction SilentlyContinue) }
    if ($null -eq $npm) {
        throw "Could not find a packaged HTMLtoNDI.exe and npm is not on PATH. Build the app first (npm run dist) or pass -ExePath."
    }
    return @{ Program = $npm.Source; Arguments = "start"; WorkingDir = $projectRoot }
}

$launch = Resolve-Launch -ExePath $ExePath
Write-Host "Launch program : $($launch.Program)"
Write-Host "Arguments      : $($launch.Arguments)"
Write-Host "Working dir    : $($launch.WorkingDir)"
Write-Host "Task name      : $TaskName"

# Build the scheduled task.
if ($launch.Arguments) {
    $action = New-ScheduledTaskAction -Execute $launch.Program -Argument $launch.Arguments -WorkingDirectory $launch.WorkingDir
}
else {
    $action = New-ScheduledTaskAction -Execute $launch.Program -WorkingDirectory $launch.WorkingDir
}

$trigger = New-ScheduledTaskTrigger -AtLogOn

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0)

# Run as the currently logged-on interactive user (needed for GPU/desktop).
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Highest

# Remove any previous version first.
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal | Out-Null

Write-Host ""
Write-Host "Scheduled task '$TaskName' installed. It will start at logon." -ForegroundColor Green
Write-Host "Start it now with: Start-ScheduledTask -TaskName '$TaskName'"
