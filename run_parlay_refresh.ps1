# Runs the same three steps as .github/workflows/refresh_parlay_data.yml's
# scheduled job, but locally. Why it exists: ESPN was blocking its
# scoreboard/search API outright from GitHub Actions' (and Cloudflare's)
# shared IP ranges -- confirmed directly (HTTP 403 on every attempt, even
# with browser-real headers, an authenticated ESPN session cookie, and a
# 37s retry/backoff schedule). Fixed since by switching to
# site.web.api.espn.com (see espn_gametime_lookup.py), so cloud grading
# works again and this is NOT currently scheduled -- the Windows Scheduled
# Task ("RetirementLeague Parlay Refresh") that ran this every 30 minutes
# has been removed. Kept as a manual fallback: re-register that task the
# same way if site.web.api.espn.com ever gets blocked too. Needs
# google_secret.json in this same folder and an active `wrangler login`
# session (both already set up on this machine) -- no env vars to
# configure.

$ErrorActionPreference = "Continue"
$env:PATH = "C:\Program Files\nodejs;C:\Program Files\GitHub CLI;" + $env:PATH
Set-Location $PSScriptRoot

$logDir = Join-Path $PSScriptRoot "logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$logFile = Join-Path $logDir "parlay_refresh.log"

function Run-Step {
    param([string]$Name, [string]$Script)
    "=== $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $Name ===" | Add-Content $logFile
    python $Script 2>&1 | Add-Content $logFile
}

Run-Step -Name "Grade Finished Games" -Script "auto_grade_results.py"
Run-Step -Name "Publish Parlay Stats to Cloudflare KV" -Script "publish_parlay_stats.py"
Run-Step -Name "Sync Picks to D1" -Script "sync_parlay_to_d1.py"

"" | Add-Content $logFile
