# 开发与验证

## 发布 macOS 自动更新

更新 `package.json`、`package-lock.json`、`src/agent-main.js` 和 `manage.cjs` 中的 macOS 版本号后，运行 `python3 scripts/build_release.py --platform macOS`。构建器生成包含 `update.json` 和校验清单的安装包。

通过测试与隐私检查后，以 `v版本号-macos` 标签发布 GitHub Release，上传 `CodexUsageBadge-macOS-版本号.zip` 和外部 `SHA256SUMS.txt`。只有已发布、安装包上传完整且具有 GitHub SHA-256 digest 的 Release 会被发现。草稿、仅推送源码、Windows 包及不高于本机版本的包不会触发升级。当前 macOS 渠道默认包含预发布版本。

`updater/core.cjs` 负责筛选版本、下载校验、ZIP 校验和缓存锁；`updater/worker.cjs` 调用现有安装器。安装器在独立操作锁内迁移程序，保持正在运行的更新器存活，并在后台启动失败时恢复原文件与服务。更新包在临时缓存目录验证，安装结束后清理。

## 本地开发

开发环境：Node.js 24+、Python 3.10+。macOS 原生助手由 Xcode Command Line Tools 编译为 arm64 / x86_64 通用程序；普通用户使用安装包中的成品，无需编译。

```bash
npm ci
npx playwright install chromium --only-shell
python3 scripts/build_release.py
npm test
npm run test:privacy
```

macOS 额外运行原生测试：

```bash
node tests/startup-native.cjs .devtools/macos-startup-bridge
```

PowerShell 测试：`pwsh -File tests/windows.ps1`。Windows CI 还会运行 `tests/windows-native.ps1`，验证安装、快捷方式、后台停止和卸载。

Windows 启动适配器测试：`powershell -NoProfile -ExecutionPolicy Bypass -File tests/windows-startup-native.ps1`。它仅操作临时隐藏应用，检查进程身份、Raw Input 活动分类、正常退出/拒绝及重开。`startup/` 为 Windows 适配器；macOS 保持原有 `macos/startup/` 实现。

只构建 Windows：`python scripts/build_release.py --platform Windows`。其版本取自 `package.json` 的 `windowsVersion`，不修改 macOS 的 `version` 或已有发布附件。Windows 发布使用 `v<版本>-windows` 标签，只上传 Windows ZIP 和该 ZIP 的校验文件。

`build_release.py` 在 macOS 生成两个平台的 ZIP，在 Windows 生成 Windows ZIP。文件输出到 `dist/`，附带 SHA256 校验清单。发布前将本次源码加入 Git 暂存区，再执行隐私检查；检查覆盖所有受跟踪源码和安装包。

## 数据与兼容性

额度来自客户端 CLI 的账号接口。Plus 显示短周期与每周额度，Pro 显示周额度；大于 50% 为绿、10%～50% 为黄、小于 10% 为红。

Token 读取本机会话数据库中的累计值，包含缓存输入，不代表当前上下文大小。色块的四档分界为 100 万、1000 万和 1 亿；无记录时为灰色。额度约每分钟刷新，Token 约每 5 秒刷新。

上下文环独立于累计 Token 和网络额度调度，约每 5 秒读取一次。`context-window-reader.js` 只读参数化查询最新 state 数据库的目标 `rollout_path`；初读最多 4 MiB，后续增量读取，跨窗口共用文件游标。不会退回旧数据库。日志读取会接触可能包含正文的字节，但只保留统计、模型及请求身份元数据，不输出原始行或私人路径。

当前来源适配要求日志具有递增 ordinal、`turn_context` 和带 thread/turn/response ID 的 `token_usage_record`，并将其用量逐字段与 `token_count.info` 匹配。重复来源、用量指纹冲突、模型切换前的请求、非法最新统计均降级为未知；没有这些身份字段的旧客户端也显示未知。占用以 `last_token_usage.total_tokens / model_context_window` 计算，不额外相加缓存输入，不硬编码容量；空闲保留快照，采集心跳断开后显示未知并自动恢复。

`context-window-ui.js` 从可见 composer 的 portal ID、祖先 React props 中一致的 conversationId/hostId、模型按钮的机器 model prop 确认身份。该兼容层依赖客户端私有 React 结构，结构不匹配时拒绝绑定；不使用显示文字、生成类名、侧栏最近会话或数据库命中来猜身份。原生可见的上下文用量图像在同一 composer 中抑制插件环。未修改客户端设置或 React 管理的节点。

上下文圆环的来源要求、测试范围与实机验证限制见 [上下文圆环说明](context-window.md)。

项目容量按本机项目路径计算，macOS 使用目录占用统计；默认两路并发，缓存 5 分钟，单项目计算最多 3 分钟。不可访问的目录显示 `—`，不以不完整结果冒充完整容量。

插件依赖客户端内部界面和调试接口。自动化测试使用临时目录、模拟页面与独立测试应用，不读取真实账号。macOS 自动加载已完成本机真实客户端重启验证；Windows 安装流程由 CI 验证，已登录客户端的长期兼容性仍需更多设备反馈。
