# PowerShell equivalent of the Makefile (make is not installed on this machine).
# Usage: ./make.ps1 build|install|uninstall|reinstall|dev|logs|test [-Suite <part of a test file name>]
param(
    [Parameter(Position = 0)][ValidateSet("build", "install", "uninstall", "reinstall", "dev", "logs", "test")]
    [string]$Target = "build",
    [string]$Image = "pierside/extension",
    [string]$Tag = "dev",
    [string]$Suite = ""
)
# Not "Stop": PowerShell 5.1 turns native stderr (docker build progress) into errors. Exit codes are checked instead.
$ErrorActionPreference = "Continue"
$Ref = "${Image}:${Tag}"
Set-Location $PSScriptRoot

function Invoke-Checked([string]$Exe, [string[]]$Arguments) {
    & $Exe @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Exe $($Arguments -join ' ') failed with exit code $LASTEXITCODE" }
}

function Build { Invoke-Checked docker @("build", "-t", $Ref, ".") }
function Uninstall { & rdctl extension uninstall $Ref; $global:LASTEXITCODE = 0 }
function Install { Invoke-Checked rdctl @("extension", "install", $Ref) }

# Every suite in dev/tests. The Python ones import the backend and use the engine through the socket,
# so they run in the built image (build it first) with the working copy's backend mounted over the
# image's; test_logsafe.mjs runs here with Node. live_*.py need the SSH test host and aren't run.
function Test-All {
    $testRef = "${Image}:test"
    # The image plus what the suites need and Pierside doesn't ship (starlette's TestClient needs httpx).
    "FROM $Ref`nRUN pip install -q httpx==0.28.1" | docker build -q -t $testRef - | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "building $testRef failed (build $Ref first: ./make.ps1 build)" }
    $root = (Get-Location).Path
    $suites = @(Get-ChildItem dev/tests -Filter "test_*" | Where-Object { $_.Extension -in ".py", ".mjs" } | Sort-Object Name | ForEach-Object Name)
    if ($Suite) { $suites = @($suites | Where-Object { $_ -like "*$Suite*" }) }
    if (-not $suites) { throw "no test suite matches '$Suite'" }
    $failed = @()
    foreach ($s in $suites) {
        Write-Host "==== $s" -ForegroundColor Cyan
        if ($s.EndsWith(".mjs")) {
            & node "dev/tests/$s"
        } else {
            # /src/app = the backend (imported as `app`); /src/backend/app the same, for suites that load a
            # module by its repo path (test_alerts); /data a fresh tmpfs, so nothing of the installed
            # extension is read or changed.
            & docker run --rm --entrypoint python -v "${root}\backend\app:/src/app:ro" -v "${root}\backend\app:/src/backend/app:ro" `
                -v "${root}\dev\tests:/t:ro" -v /var/run/docker.sock:/var/run/docker.sock --tmpfs /data -w /src $testRef "/t/$s"
        }
        if ($LASTEXITCODE -ne 0) { $failed += $s }
    }
    Write-Host ""
    foreach ($s in $suites) {
        if ($failed -contains $s) { Write-Host "FAIL $s" -ForegroundColor Red } else { Write-Host "PASS $s" -ForegroundColor Green }
    }
    if ($failed) { throw "$($failed.Count) of $($suites.Count) suites failed: $($failed -join ', ')" }
}

switch ($Target) {
    "build" { Build }
    "install" { Build; Install }
    "uninstall" { Uninstall }
    "reinstall" { Build; Uninstall; Install }
    "dev" {
        # The backend's TCP port is picked by Docker; hand it to the dev UI.
        $id = docker ps -q --filter "label=com.pierside.backend=true" | Select-Object -First 1
        if ($id) {
            $hostPort = (docker port $id 8080/tcp | Select-Object -First 1) -replace '.*:', ''
            $env:VITE_PIERSIDE_BACKEND = "http://localhost:$hostPort"
            # Every request needs the session token, the dev UI's too.
            $env:VITE_PIERSIDE_TOKEN = (docker exec $id cat /run/pierside-token)
            Write-Host "Backend: $env:VITE_PIERSIDE_BACKEND"
        } else { Write-Warning "Pierside backend isn't running; install the extension first" }
        Set-Location ui
        try { npm run dev }
        finally {
            # Don't leave the token in this session: a later build here would otherwise see it.
            Remove-Item Env:VITE_PIERSIDE_TOKEN -ErrorAction SilentlyContinue
            Set-Location ..
        }
    }
    "test" { Test-All }
    "logs" {
        $id = docker ps -q --filter "label=com.docker.compose.service=pierside" | Select-Object -First 1
        if (-not $id) { throw "backend container not running" }
        docker logs -f --tail 200 $id
    }
}
