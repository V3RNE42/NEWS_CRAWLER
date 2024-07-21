$safePath = "C:\Users\usuario\Desktop\NEWS_CRAWLER\safe_to_reboot.flag"

$maxRetries = 5  # Maximum number of retries
$retryInterval = 60  # Interval between retries in seconds (1 minute)

function AttemptReboot {
    if (Test-Path $safePath) {
        Write-Host "Initiating system reboot..."
        Remove-Item $safePath -Force
        shutdown /r /f /t 5
        return $true
    } else {
        Write-Host "Not safe to reboot at this moment."
        return $false
    }
}

$retryCount = 0
$rebootSuccessful = $false

while (-not $rebootSuccessful -and $retryCount -lt $maxRetries) {
    $rebootSuccessful = AttemptReboot

    if (-not $rebootSuccessful) {
        $retryCount++
        if ($retryCount -lt $maxRetries) {
            Write-Host "Retry $retryCount of $maxRetries. Waiting $retryInterval seconds before next attempt..."
            Start-Sleep -Seconds $retryInterval
        }
    }
}

if (-not $rebootSuccessful) {
    Write-Host "Failed to reboot after $maxRetries attempts. Skipping reboot for now."
}