# Isolated WSH/PowerShell smoke test: no SSH, real profile, or desktop client.
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { exit 0 }
$temp = Join-Path ([IO.Path]::GetTempPath()) ('badge-remote-' + [guid]::NewGuid())
$folder = Join-Path $temp '含中文 空格'
$savedAppData = $env:LOCALAPPDATA
$workerPid = $null
$parentPid = $null
try {
    New-Item -ItemType Directory -Path $folder -Force | Out-Null
    $source = Join-Path (Split-Path $PSScriptRoot -Parent) 'remote-tokens'
    foreach ($name in @('Start.vbs','launcher.ps1')) {
        $text = [IO.File]::ReadAllText((Join-Path $source $name))
        $encoding = if ($name.EndsWith('.ps1')) { New-Object Text.UTF8Encoding $true } else { [Text.Encoding]::ASCII }
        [IO.File]::WriteAllText((Join-Path $folder $name), $text, $encoding)
    }
    [IO.File]::WriteAllText((Join-Path $folder 'config.json'), '{}')
    $fake = @'
const fs=require('node:fs'),path=require('node:path');
const file=name=>path.join(__dirname,name),args=process.argv.slice(2);
if(args.includes('--status'))console.log(JSON.stringify({running:fs.existsSync(file('ready')),state:'connected'}));
else if(args.includes('--check-ssh'))process.exit(0);
else if(args.includes('--stop'))fs.writeFileSync(file('stop'),'stop');
else {
  if(!args.includes('--background'))throw Error('not background');
  fs.writeFileSync(file('ready'),JSON.stringify({pid:process.pid}));
  const timer=setInterval(()=>{if(fs.existsSync(file('stop'))){fs.unlinkSync(file('ready'));clearInterval(timer)}},30);
}
'@
    [IO.File]::WriteAllText((Join-Path $folder 'remote-addon.cjs'), $fake)
    $env:LOCALAPPDATA = Join-Path $folder 'profile'
    $base = Join-Path $env:LOCALAPPDATA 'CodexUsageBadge'
    New-Item -ItemType Directory -Path $base -Force | Out-Null
    $settings = @{NodeExe = (Get-Command node.exe).Source} | ConvertTo-Json
    [IO.File]::WriteAllText((Join-Path $base 'config.json'), $settings)
    $entry = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\wscript.exe') -ArgumentList ('"{0}"' -f (Join-Path $folder 'Start.vbs')) -PassThru
    if (!$entry.WaitForExit(5000)) { throw 'WSH launcher did not return' }
    $ready = Join-Path $folder 'ready'
    $until = (Get-Date).AddSeconds(15)
    while (!(Test-Path -LiteralPath $ready) -and (Get-Date) -lt $until) { Start-Sleep -Milliseconds 100 }
    if (!(Test-Path -LiteralPath $ready)) { throw 'hidden worker did not start' }
    $workerPid = (Get-Content -LiteralPath $ready -Raw | ConvertFrom-Json).pid
    $parentPid = (Get-CimInstance Win32_Process -Filter "ProcessId = $workerPid").ParentProcessId
    # The WSH entry has exited, while its independent background worker survives.
    Get-Process -Id $workerPid -ErrorAction Stop | Out-Null
    $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    & $powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $folder 'launcher.ps1') -Action Status
    if ($LASTEXITCODE -ne 0) { throw 'status failed' }
    & $powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $folder 'launcher.ps1') -Action Stop
    if ($LASTEXITCODE -ne 0) { throw 'stop failed' }
    $until = (Get-Date).AddSeconds(10)
    while ((Test-Path -LiteralPath $ready) -and (Get-Date) -lt $until) { Start-Sleep -Milliseconds 100 }
    if (Test-Path -LiteralPath $ready) { throw 'background worker did not stop' }
    Write-Host 'PASS isolated Windows WSH background launch, Unicode paths, status and stop.'
} finally {
    $env:LOCALAPPDATA = $savedAppData
    foreach ($testPid in @($workerPid,$parentPid)) {
        if ($testPid) {
            $process = Get-CimInstance Win32_Process -Filter "ProcessId = $testPid" -ErrorAction SilentlyContinue
            if ($process -and $process.CommandLine -and $process.CommandLine.Contains($folder)) {
                Stop-Process -Id $testPid -ErrorAction SilentlyContinue
            }
        }
    }
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
