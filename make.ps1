# PowerShell equivalent of the Makefile (make is not installed on this machine).
# Usage: ./make.ps1 build|install|uninstall|reinstall|dev|logs
param(
    [Parameter(Position = 0)][ValidateSet("build", "install", "uninstall", "reinstall", "dev", "logs")]
    [string]$Target = "build",
    [string]$Image = "pierside/extension",
    [string]$Tag = "dev"
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
            Write-Host "Backend: $env:VITE_PIERSIDE_BACKEND"
        } else { Write-Warning "Pierside backend isn't running; install the extension first" }
        Set-Location ui; npm run dev
    }
    "logs" {
        $id = docker ps -q --filter "label=com.docker.compose.service=pierside" | Select-Object -First 1
        if (-not $id) { throw "backend container not running" }
        docker logs -f --tail 200 $id
    }
}
