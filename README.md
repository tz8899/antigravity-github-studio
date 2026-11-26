# Antigravity GitHub Studio

从 `dsh-github-studio`（[zhaohaix/DeepSeek-GitHub](https://github.com/zhaohaix/DeepSeek-GitHub)，MIT 协议）完整移植并深度增强适配至 **Google Antigravity** 的原生可视化工作台插件（MCP App + 13 个 MCP 工具 + 配套 Skill）。

## 核心特性

- **双通道本机加密登录**：支持 GitHub 官方 **OAuth Device Flow（设备码登录，免填 Client Secret）** 与 **Personal Access Token 快速连接**；凭据按系统原生加密存储（Windows **DPAPI**、macOS **Keychain**、Linux / SSH Remote **`0600` AES-256-GCM** 本地保险箱）。
- **先预览、后确认安全写入**：新建仓库、提交代码文件、创建 Release、上传发布附件均先生成 `pending` 待确认预览卡片，由用户核对可见范围与变更内容后点击确认才真正执行；全程不申请 `delete_repo` 删库权限，删除入口仅打开 GitHub 官方设置页。
- **最大 2 GiB 安装包流式直传**：内置跨平台系统原生文件选择框 + 本地路径暂存，由后台 Node 服务通过流式 HTTP 直传 `uploads.github.com`，绕开前端沙箱 iframe 内存限制。
- **仓库浏览、全站检索与辅助文案**：支持浏览个人公开/私有仓库目录与代码、构造全站高级搜索、从本地源码或 `.zip` 包提取结构证据并联动当前对话模型生成项目简介与 Release 更新说明。
- **双草稿箱防抖自动保存**：新建仓库简介草稿与按仓库隔离的 Release 标题/正文草稿自动落盘恢复。

## 相比上游原版的修复与增强

1. **补齐 Release 编辑器草稿自动保存**：修复上游前端 `ReleaseEditor` 漏接草稿保存/恢复逻辑的问题，按 `owner/repo` 独立防抖保存。
2. **修复带斜杠分支（如 `feat/xxx`）404 报错**：新增 `encodeRefSegments` 按路径段编码引用并拦截非法 `..` / `.lock` 引用名，避免 `/` 被编码为 `%2F` 导致 GitHub REST API 404。
3. **修复标准 GitHub OAuth App 设备流 Scope 报错**：移除非标准 OIDC `offline_access` scope，统一使用标准 `repo` 权限，并新增 PAT 加密直连备选通道。
4. **增强密钥防泄漏拦截**：在源码 ZIP 解析与 `commitFiles` 提交预检中同步拦截 `ghp_`、`github_pat_`、私钥块与 AWS AKIA 凭据。
5. **补齐 Linux / 远程环境凭据加密存储**：新增 `0600` 权限 AES-256-GCM 加密凭据仓，覆盖 Windows / macOS / Linux 全平台。
6. **原生适配 Antigravity MCP App**：基于 `@modelcontextprotocol/ext-apps` 构建单文件沙箱视图（`dist/studio.html`），自动跟随 Antigravity 昼夜主题与字体变量。

## 安装方式

将本仓库克隆或复制到 Antigravity 插件目录，安装依赖并构建前端视图：

```bash
# macOS / Linux
git clone https://github.com/tz8899/antigravity-github-studio.git ~/.gemini/config/plugins/github-studio
cd ~/.gemini/config/plugins/github-studio
npm install
npm run build:ui
```

```powershell
# Windows PowerShell
git clone https://github.com/tz8899/antigravity-github-studio.git "$HOME\.gemini\config\plugins\github-studio"
Set-Location "$HOME\.gemini\config\plugins\github-studio"
npm install
npm run build:ui
```

随后在 Antigravity 插件管理中启用 **GitHub Studio**（或在对话中直接输入「打开 GitHub Studio」），即可从侧边栏或对话面板打开工作台。

## 开发与测试

```bash
npm test          # 运行单元测试（分支编码、三端加密存储、OAuth/PAT、ZIP 防穿越与密钥脱敏、预览确认流）
npm run build:ui  # 重新打包单文件 MCP App 前端产物 dist/studio.html
```
