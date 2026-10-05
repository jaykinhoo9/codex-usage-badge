# Codex Usage Badge · Codex 用量条

为 Codex 桌面端增加额度显示、项目配色、文件夹容量、会话 Token 和运行指标统计，适配浅色与深色主题。

![Codex Usage Badge：原生风格额度圆环、项目配色与 Token 色块](assets/cover.png)

## 功能

- **额度圆环**：查看订阅剩余额度，绿、黄、红对应充足、偏低和即将耗尽。Plus 支持 5 小时与每周额度双圆环。
- **文件夹配色**：在项目菜单中选择颜色，方便区分不同项目。
- **文件夹容量（macOS）**：在本地项目名称旁显示目录占用，支持 KB、MB、GB 等单位，自动缓存并刷新。
- **会话 Token**：用蓝色色块表示用量，悬停查看累计 Token，按万、千万、亿显示。
- **输入框下方的会话指标（未发布）**：查看当前本地会话的轮数、模型步骤、工具耗时、首 token 平均等待、缓存命中和输入/输出 Token，以及有可靠观测时的 `≈LLM` / `≈tok/s`。
- **逐会话保存**：空闲、切换和暂时读取失败时保留最后已知数值，本地 SQLite 保存每个已收集会话的指标及采样时间。
- **归档清理**：归档后删除对应的插件指标缓存，插件未运行时发生的归档会在下次检查时补清理；取消归档重新采集，原始聊天保持不变。
- **自动更新（macOS）**：每 6 小时检查 GitHub Releases，校验安装包后在后台升级，失败时恢复原版。

## 会话指标

未能可靠读取的值留空。历史尚未回填完整或仅有本次监测计数时，轮数、步数以 `≥` 标明已确认的下限；完整历史计数不会与监测计数相加。悬停指标可查看读取或观测时间，保留的旧值会注明历史来源。

`≈tok/s` 使用客户端报告的实际输出 Token，按最近 5 次有效完整响应的观测耗时加权计算，包含推理输出、工具参数和通知延迟，扣除可确认的工具执行区间。它是客户端响应阶段均速，不能当作严格的服务端生成速度。`≈LLM` 为当前有效监测时段完整响应阶段的累计耗时。

指标只在本机处理。保存的数值按桌面账号、本地存储和会话隔离，没有会话数量淘汰限制；归档清理仅影响插件缓存，不删除或修改客户端会话数据库及 rollout 文件。数据来源、精度与缓存说明见 [开发说明](docs/development.md) 和 [隐私与安全](SECURITY.md)。

## 下载

输入框指标目前提供源码构建，步骤见 [本地开发](docs/development.md#本地开发)。下方链接为 macOS v0.9.4 / Windows v0.10.1 的既有发布包。

[**macOS v0.9.4 预发布版**](https://github.com/jaykinhoo9/codex-usage-badge/releases/tag/v0.9.4-macos) · [Windows v0.10.1](https://github.com/jaykinhoo9/codex-usage-badge/releases/tag/v0.10.1-windows)

| 系统 | 安装包 | 使用说明 |
| --- | --- | --- |
| macOS · Apple Silicon / Intel | [下载 ZIP](https://github.com/jaykinhoo9/codex-usage-badge/releases/download/v0.9.4-macos/CodexUsageBadge-macOS-0.9.4.zip) | [macOS 安装](docs/macos.md) |
| Windows 10 / 11 | [下载 ZIP](https://github.com/jaykinhoo9/codex-usage-badge/releases/download/v0.10.1-windows/CodexUsageBadge-Windows-0.10.1.zip) | [Windows 安装](docs/windows.md) |

macOS 和 Windows 安装后均可沿用原应用图标，启动时自动加载。Windows 后台在新窗口尚未开始操作时请求正常重开；点击、输入或后台启动时会跳过。需要已登录的 Codex 客户端和 Node.js 24+，安装器会优先查找客户端自带的运行环境。

[更新记录](CHANGELOG.md) · [问题反馈](https://github.com/jaykinhoo9/codex-usage-badge/issues) · [开发说明](docs/development.md) · [隐私与安全](SECURITY.md)

Windows v0.10.1 起默认从 GitHub Release 自动更新，可通过 `Update.cmd` 立即检查。旧版本需先手动升级一次；之后发布更高版本的 Windows 安装包和校验清单即可自动分发。[更新设置与发布方式](docs/windows.md)

非官方项目，与 OpenAI 无关联。采用 [MIT 许可](LICENSE)。
