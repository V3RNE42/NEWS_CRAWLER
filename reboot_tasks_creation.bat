@echo off
setlocal EnableDelayedExpansion

:: Set the path to your PowerShell script
set "PS_SCRIPT=C:\Users\usuario\Desktop\NEWS_CRAWLER\check_and_reboot.ps1"

:: Check if the PowerShell script exists
if not exist "%PS_SCRIPT%" (
    echo Error: PowerShell script not found at %PS_SCRIPT%
    exit /b 1
)

:: Array of scheduled times
set "times=09:00 12:00 15:00 18:00 21:00 00:00 03:00 06:00"

:: Create a scheduled task for each time
for %%t in (%times%) do (
    echo Creating scheduled task for %%t
    schtasks /create /tn "Reboot Check %%t" /tr "powershell.exe -ExecutionPolicy Bypass -File \"%PS_SCRIPT%\"" /sc daily /st %%t /ru SYSTEM /rl HIGHEST /f
    if !errorlevel! neq 0 (
        echo Failed to create scheduled task for %%t
    ) else (
        echo Successfully created scheduled task for %%t
    )
)

echo All scheduled tasks have been created.
pause