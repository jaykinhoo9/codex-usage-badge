# Isolated launcher regression tests; no installed client, account or GUI activation.
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$version=(Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).windowsVersion
# The built Windows package supplies the UTF-8 BOM required by PowerShell 5.1.
. (Join-Path $root ('dist/CodexUsageBadge-Windows-'+$version+'/manage-windows.ps1')) -Action Functions
function Assert($Condition,[string]$Message) { if(!$Condition){throw $Message} }
function Throws([scriptblock]$Body,[string]$Pattern) {
    $failure=$null
    try {& $Body} catch {$failure=$_.Exception.Message}
    Assert ($failure -and $failure -match $Pattern) ('Expected '+$Pattern+', got '+$failure)
}
$script:packages=@([pscustomobject]@{Name='OpenAI.Codex';InstallLocation='C:\Fixture Store\Codex';PackageFullName='OpenAI.Codex_fixture';PackageFamilyName='OpenAI.Codex_fixturefamily'})
$script:manifest=[xml]'<Package><Applications><Application Id="Helper" Executable="app\helper.exe"/><Application Id="Desktop" Executable="app\ChatGPT.exe"/></Applications></Package>'
$script:launches=@()
function Get-AppxPackage { $script:packages }
function Get-AppxPackageManifest([string]$Package) {
    Assert ($Package -eq 'OpenAI.Codex_fixture') 'Manifest lookup must use the matching package'
    $script:manifest
}
function Invoke-StoreApplication([string]$Identity,[string]$Arguments) {
    $script:launches+=@{Kind='Store';Identity=$Identity;Arguments=$Arguments}
    if($script:activationFails){throw 'Synthetic Store activation failure'}
}
function Start-Process([string]$FilePath,[string]$ArgumentList,[string]$WindowStyle) {
    $script:launches+=@{Kind='Desktop';Path=$FilePath;Arguments=$ArgumentList;WindowStyle=$WindowStyle}
}
Start-DesktopApplication 'C:\Fixture Store\Codex\app\ChatGPT.exe'
Assert ($script:launches.Count -eq 1 -and $script:launches[0].Kind -eq 'Store') 'Store launch must not execute the binary directly'
Assert ($script:launches[0].Identity -eq 'OpenAI.Codex_fixturefamily!Desktop') 'Store identity must come from the exact executable in its manifest'
Assert ($script:launches[0].Arguments -eq '--remote-debugging-address=127.0.0.1 --remote-debugging-port=39222') 'Loopback-only debugging flags must be preserved'
$script:launches=@()
Start-DesktopApplication 'C:\Fixture Store\Codex-other\ChatGPT.exe'
Assert ($script:launches.Count -eq 1 -and $script:launches[0].Kind -eq 'Desktop' -and $script:launches[0].WindowStyle -eq 'Hidden') 'A sibling path must not be mistaken for the Store package'
Assert ($script:launches[0].Arguments -eq '--remote-debugging-address=127.0.0.1 --remote-debugging-port=39222') 'Desktop launch must preserve debugging flags'
$script:launches=@()
Throws {Start-DesktopApplication 'C:\Fixture Store\Codex\app\Codex.exe'} 'Cannot resolve Store application identity'
Assert ($script:launches.Count -eq 0) 'Unknown Store executable must not fall back to direct execution'
$script:activationFails=$true
Throws {Start-DesktopApplication 'C:\Fixture Store\Codex\app\ChatGPT.exe'} 'Synthetic Store activation failure'
Assert ($script:launches.Count -eq 1 -and $script:launches[0].Kind -eq 'Store') 'Failed Store activation must not fall back to direct execution'
$script:launches=@();$script:packages=@()
Throws {Start-DesktopApplication 'C:\Program Files\WindowsApps\Missing\app\ChatGPT.exe'} 'Cannot resolve Store package'
Assert ($script:launches.Count -eq 0) 'Unresolved WindowsApps identity must fail closed'
Write-Host 'PASS Store manifest identity, desktop fallback, hidden launch, loopback flags and no direct execution after Store resolution/activation failure'
