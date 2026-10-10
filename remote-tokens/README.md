# Windows SSH 远程 Token（可选）

在 Windows Codex 侧边栏查看 Linux SSH 服务器上每个会话的累计 Token。默认关闭；原版额度圆环、本地统计和项目颜色继续运行。此扩展只连接用户配置的一台服务器，不扫描网络。

需要包含 Token UI 版本 8 的原版插件（本功能随附）、Windows OpenSSH 和原插件使用的 Node.js 24+。服务器需要 Python 3.10+；不需要在服务器安装完整桌面插件。尚未支持 WSL、服务器之间合并统计或自动登录启动。

## 首次配置

开发测试时先运行 `python3 scripts/build_release.py --platform Windows`，安装同一份源码构建的主插件；再运行 `python3 scripts/build_remote_tokens.py` 构建独立 ZIP。连接器需要主插件的 Token UI 版本 8，不能单独配合已发布的 UI 版本 7 主插件使用。完整解压远程安装包到新文件夹，保留全部文件。已有旧版独立扩展时先用其 `Stop.cmd` 停止。

1. 沿用已能连接服务器的 SSH 别名。以下 `my-server` 均替换为这个别名；示例不会更改 SSH 密钥或连接配置。
2. 手动部署包中的只读服务脚本，在包目录的 PowerShell 中运行：

```powershell
ssh my-server "mkdir -p ~/.local/share/codex-usage-badge"
scp .\remote_reader.py my-server:~/.local/share/codex-usage-badge/remote_reader.py
```

3. 将 `config.example.json` 复制为 `config.json`，修改 `sshHost`。`sshUser`、`sshPort` 留为 `null` 时通过 `ssh -G` 沿用现有配置。`expectedHostName` 可填实际目标主机名/IP，以防误选别名；留空时只使用明确指定的 `sshHost`。
4. 保持 Codex、原版插件和服务器会话可见，双击 `Hosts.cmd` 查看侧边栏的服务器标识，将目标服务器对应标识填入 `hostIds`。一个配置中的所有 `hostIds` 必须属于同一台服务器。该命令仅读取主机标识，不读取标题或聊天正文。
5. 默认 `readerPath` 指向上述部署位置。`codexHome: null` 使用服务器的 `CODEX_HOME` 或默认 `.codex` 目录；需要其他目录时可填写绝对路径或以 `~/` 开头的路径。

不同服务器使用独立解压目录和不同 `localPort`。默认本地转发端口 39223、远程服务端口 43003，两端均只监听回环地址。端口被占用时报告失败，不关闭已有进程。

## 启动和停止

- 双击 `Start.vbs` 隐藏启动，或双击 `Start.cmd`（启动时可能短暂显示窗口）。无需退出或重启 Codex。
- 启动器先检查现有密钥能否无交互登录。成功后在后台运行；无法无交互登录时打开 `StartConsole.cmd`，由 OpenSSH 自己处理密码、私钥密码、主机确认或连接错误。此回退模式需要保留命令窗口。
- 悬停远程会话的 Token 色块查看累计值，每 5 秒刷新。累计值包含缓存输入，不代表当前上下文大小或费用。
- `Status.cmd` 查看状态，`Stop.cmd` 停止并恢复原版本地统计。SSH 结束时服务器脚本退出；扩展被强制结束时 UI 约 20 秒内恢复。
- 不创建开机自启、不替换原插件文件、不修改聊天数据库或 SSH 配置。无需管理员权限。密码和私钥始终由现有 SSH 客户端处理，不保存到扩展配置。

若主机标识不匹配或数据不可读取，显示未知/过期状态，避免用零值冒充成功。后台连接结束后重新运行启动器；网络故障不会自动修改登录设置。

## 验证范围

独立 Windows 原型已在真实 SSH 连接和后台启动场景中获得用户反馈。本仓库集成采用同一个 Token UI 函数，测试覆盖本地/远程同 ID 隔离、浅色/深色布局、原版反复注入、停止和过期恢复、数据库只读、请求鉴权、输入管道存续及 SSH 断开退出。真实 Windows 客户端的后续版本兼容性仍需更多设备反馈。
