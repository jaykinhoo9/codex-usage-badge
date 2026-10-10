param([ValidateSet('Start','StartBackground','Stop','Status','Hosts')][string]$Action = 'Start')
$ErrorActionPreference = 'Stop'
try {
    $baseConfig = Join-Path $env:LOCALAPPDATA 'CodexUsageBadge\config.json'
    if (!(Test-Path -LiteralPath $baseConfig)) { throw '请先安装原版 Codex Usage Badge。' }
    $settings = Get-Content -LiteralPath $baseConfig -Raw -Encoding UTF8 | ConvertFrom-Json
    $node = $settings.NodeExe
    if (!$node -or !(Test-Path -LiteralPath $node)) {
        $command = Get-Command node.exe -ErrorAction SilentlyContinue
        if (!$command) { throw '找不到 Node.js。请先运行原版插件 Install.cmd 修复运行环境。' }
        $node = $command.Source
    }
    $addon = Join-Path $PSScriptRoot 'remote-addon.cjs'
    $arguments = @($addon)
    if ($Action -eq 'Hosts') {
        $hosts = @(& $node $addon --hosts | ConvertFrom-Json)
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        if (!$hosts.Count) { Write-Host '请先在 Codex 侧边栏显示远程会话。' }
        else { $hosts | ForEach-Object { Write-Host $_ } }
        exit 0
    }
    if ($Action -eq 'Start' -or $Action -eq 'StartBackground') {
        $remoteConfig = Join-Path $PSScriptRoot 'config.json'
        if (!(Test-Path -LiteralPath $remoteConfig)) {
            throw '请先将 config.example.json 复制为 config.json，并按说明填写 SSH 主机和 hostIds。'
        }
    }
    if ($Action -eq 'StartBackground') {
        $current = (& $node $addon --status | ConvertFrom-Json)
        if ($current.running) { exit 0 }
        & $node $addon --check-ssh
        if ($LASTEXITCODE -ne 0) {
            # Passwords and first-time host confirmation remain in OpenSSH's own console.
            $shell = New-Object -ComObject WScript.Shell
            $console = Join-Path $PSScriptRoot 'StartConsole.cmd'
            $shell.Run(('"{0}"' -f $console), 1, $false) | Out-Null
            exit 0
        }
        $arguments += '--background'
    }
    if ($Action -eq 'Status') {
        $current = (& $node $addon --status | ConvertFrom-Json)
        if (!$current.running) { Write-Host '远程 Token 扩展已停止。'; exit 0 }
        $labels = @{
            starting = '正在启动'; connected = '已连接，每 5 秒刷新';
            waiting_cdp = '等待 Codex 连接'; waiting_plugin = '等待原版插件加载';
            waiting_threads = '等待远程会话显示'; host_mismatch = '远程主机配置不匹配';
            waiting_ssh = '等待 SSH 连接'; database_unavailable = '远程统计暂不可用';
            stopping = '正在停止'
        }
        $label = $labels[$current.state]
        if (!$label) { $label = '正在运行' }
        Write-Host ('远程 Token 扩展：{0}。' -f $label)
        exit 0
    }
    if ($Action -eq 'Stop') { $arguments += '--stop' }
    & $node @arguments
    if ($Action -eq 'StartBackground' -and $LASTEXITCODE -ne 0) {
        throw '远程 Token 后台连接已结束。请运行 StartConsole.cmd 查看连接提示。'
    }
    exit $LASTEXITCODE
} catch {
    if ($Action -eq 'StartBackground') {
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Codex 远程 Token') | Out-Null
    } else { Write-Host $_.Exception.Message -ForegroundColor Red }
    exit 1
}
