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

额度来自客户端 CLI 的账号接口。圆环数量由实际返回的有效额度周期决定，不依赖套餐名称：只有 5 小时或每周额度时显示一个圆环，两者都有时显示两个；缺失或无效的周期不补画圆环。返回顺序不影响显示顺序，双圆环始终先显示 5 小时额度，再显示每周额度。没有有效额度时显示不可用；连接失败时将已有圆环置灰，恢复后根据新数据重新判断数量。大于 50% 为绿、10%～50% 为黄、小于 10% 为红。

Token 读取本机会话数据库中的累计值，包含缓存输入，不代表当前上下文大小。色块的四档分界为 100 万、1000 万和 1 亿；无记录时为灰色。额度约每分钟刷新，Token 约每 5 秒刷新。

项目容量按本机项目路径计算，macOS 使用目录占用统计；默认两路并发，缓存 5 分钟，单项目计算最多 3 分钟。不可访问的目录显示 `—`，不以不完整结果冒充完整容量。

插件依赖客户端内部界面和调试接口。自动化测试使用临时目录、模拟页面与独立测试应用，不读取真实账号。macOS 自动加载已完成本机真实客户端重启验证；Windows 安装流程由 CI 验证，已登录客户端的长期兼容性仍需更多设备反馈。
