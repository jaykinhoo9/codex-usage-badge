# Windows 使用说明

新增会话指标条（未发布）读取当前能确认身份的本地 Codex 会话。`≈LLM` / `≈tok/s` 来自完整观测到的实时响应阶段，响应完成后更新；缺少数据的值留空。自动更新仅信任 `jaykinhoo9/codex-usage-badge` 的发布包。

## 原图标自动加载（Windows 0.10.1 预发布）

完整解压 Windows ZIP 后，运行 `Install.cmd`。首次安装前先打开并登录客户端，使内置运行组件准备好；安装后从托盘或菜单完全退出，再使用原来的 Codex 图标打开。安装时已经打开的窗口会保留。

后台观察到刚刚启动、位于前台且尚未操作的客户端时，会请求一次正常退出，再带用量条连接参数重开。窗口可能短暂消失后重新出现。若已经操作、存在多个实例、启动参数包含链接/文件、端口被占用或客户端拒绝退出，本次自动加载会跳过。关闭窗口但仍驻留托盘的客户端不属于新启动。

Microsoft Store 版从原进程读取应用标识，通过 Windows 应用激活接口携带连接参数重开，避免直接执行 `WindowsApps` 内文件时出现“拒绝访问”。商店激活可能直接显示窗口；普通桌面安装仍使用隐藏进程启动，再按焦点检查显示窗口。

Windows 通过 Raw Input 观察实际操作：点击、滚轮或按键会取消本次接管，单纯移动鼠标和松开启动按键不会。后台只检查事件类别和时间，不读取或保存按键内容、文字或鼠标坐标。

这是 Windows 预发布版本。已在 Windows 10 的已登录 Microsoft Store 客户端上验证原生激活、自动重开及额度条/项目颜色/Token 三个组件的加载；独立测试应用也已验证系统退出与拒绝行为。其他设备、任务栏入口和客户端更新后的兼容性仍需验证。旧版 v0.9.x 仍需使用独立桌面入口。

安装到 `%LOCALAPPDATA%\CodexUsageBadge`，创建当前用户的后台启动项，不需要管理员权限。登录 Windows 时只启动隐藏后台，等待用户打开客户端。升级会移除本项目创建的旧桌面入口，保留无关快捷方式；`Launch.cmd` 保留为手动加载入口。安装、更新、卸载具有归属检查与备份。

## 运行环境

- Windows 10/11，Windows PowerShell 5.1 或更高版本。
- 已登录且包含 Codex CLI 的 Windows 桌面客户端。
- Node.js 24+，需要 `node:sqlite`。自动查找客户端 Node，或使用已安装的系统 Node。
- 原生 Windows 会话数据库。WSL 与远程环境暂不跨系统读取。

`Install.cmd` / `Launch.cmd` / `Status.cmd` / `Uninstall.cmd` 仅为本次 PowerShell 进程设置执行策略，不更改注册表或企业策略。脚本没有代码签名；设备策略禁止时请联系管理员。

## 自动更新（Windows 0.10.1 起）

安装后默认开启。后台首次启动约 30 秒后检查 GitHub，之后每 6 小时检查一次；Windows 登录后台需要保持启用。只下载本仓库已发布且版本更高的 Windows Release，不使用 macOS 发布包或仅推送的源码提交。

下载会核对发布页的 SHA-256 清单和 GitHub 资产摘要（如有），再验证 ZIP 内的每个文件及路径。安装沿用目录替换和失败回滚，保留自定义路径、更新开关和加载记录。更新过程只替换插件后台，Codex 窗口保持打开；下载失败会在下一个检查周期重试。`Status.cmd` 可查看更新结果；双击 `Update.cmd` 可立即手动检查，即使自动更新已关闭。

v0.10.0 及更早版本没有更新器，需要先手动安装一次 v0.10.1 或更新版本，之后才能自动升级。

```powershell
# 关闭 / 开启自动更新
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\CodexUsageBadge\manage-windows.ps1" -Action UpdatesOff
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\CodexUsageBadge\manage-windows.ps1" -Action UpdatesOn
```

也可首次安装时使用 `-Action Install -DisableAutoUpdate`。更新偏好记录在安装目录的 `update-preferences.json`，检查结果记录在 `update-state.json`。

发布新 Windows 版本时，同步修改 `package.json` 的 `windowsVersion` 和 `windows/manage-windows.ps1` 的版本号，然后运行 `python scripts/build_release.py --platform Windows`。在 GitHub 创建标签为 `v版本号-windows` 的 Release，上传生成的 `CodexUsageBadge-Windows-版本号.zip` 和同一批生成的 `SHA256SUMS.txt`，最后发布。更新器也接受该命名规则下的预发布 Release；草稿不会触发更新。

## 自定义路径

只填写需要覆盖的参数，其余自动发现。以下示例路径需要换成实际位置：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\manage-windows.ps1 -Action Install -AppExe 'D:\Apps\Codex\Codex.exe' -NodeExe 'D:\Tools\nodejs\node.exe' -CodexBin 'D:\Apps\Codex\resources\codex.exe' -CodexHome 'D:\CodexData'
```

显式参数会保留，迁移后请重新指定。`CodexHome` 必须与客户端当前数据目录一致，否则可能读不到额度或 Token。

## 故障处理

- **未找到 Node / CLI**：先运行客户端一次；安装 Node.js 24 LTS；必要时显式指定路径。
- **已运行但不能连接**：先查看 `Status.cmd` 中的自动加载状态。`skipped-active-or-background` 表示启动后已有操作或窗口在后台；`quit-refused` 表示系统退出请求被拒绝；`skipped-cooldown` 表示两分钟内已经尝试过一次。完全退出后可用 `Launch.cmd` 手动加载。
- **原图标没有自动加载**：确认后台运行且 Windows 没有禁用它的启动项。等待两分钟后完全退出，再从原图标打开；开始操作前让窗口完成重开。
- **客户端更新后失效**：v0.10.1 后台每 5 秒核对客户端和运行时路径，重新发现 Microsoft Store 更新后的位置并刷新观察器。之后完全退出客户端，再从原图标打开即可重新加载；已打开的窗口不会被强制重启。也可完全退出后运行 `Launch.cmd`。
- **自动更新失败**：查看 `Status.cmd` 的更新状态，确认能够连接 GitHub API 和 Release 下载服务，或使用 `Update.cmd` 立即重试。校验或安装失败时继续使用原版本。
- **只有额度不可用**：确认使用支持额度查询的账号，且 CLI 和客户端的登录/数据目录一致。
- **Token 灰色**：可能没有本地记录，或当前是 WSL、远程、云端会话。

卸载时若客户端可连接，立即移除界面组件并清理颜色设置；否则组件会在下次完全重启后消失，颜色配置可能保留在客户端存储中。备份目录名以 `CodexUsageBadge.backup-` 或 `.uninstalled-` 开头，由用户自行决定何时删除。

CI 使用临时应用验证 Windows 进程、快捷方式迁移、后台停止、安装回滚、正常系统退出和拒绝退出。启动助手使用 Restart Manager 的非强制退出请求；应用可通过 Windows 的退出询问拒绝，不发送全局快捷键。Windows 可能拒绝后台进程恢复焦点，此时不会强行抢占焦点。长期焦点行为仍需更多设备验证。
