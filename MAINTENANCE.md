# dsh-remote-ssh 维护与发布手册（Maintainer Playbook）

> 本手册由维护会话于 2026-09-10 从 DSH 归档历史会话中提炼（session d5dc5130 主会话、
> 996c0822 工程师子会话等），并逐项在当前机器上验证通过。不含任何密钥。

## 0. 当前状态（已验证）

| 项目 | 状态 |
| --- | --- |
| 本地版本 / npm latest / GitHub main | 2.3.9，三者一致 |
| 仓库 | https://github.com/ZhangFengshun/dsh-remote-ssh（HTTPS，分支 main） |
| npm 账号 | `npm whoami` → `zhangfengshun` ✅ |
| gh CLI | v2.97.0，已登录 `ZhangFengshun`（keyring），scopes: admin:public_key, gist, read:org, repo |
| 发布可见性 | package.json `publishConfig.access = "public"` |

## 1. GitHub 连接机制（如何工作的）

**认证链路**：`git push origin main` → git 调 credential helper → gh CLI 提供 token。

- `~/.gitconfig` 中由 `gh auth setup-git` 写入：
  ```
  [credential "https://github.com"]
    helper = !'C:\Program Files\GitHub CLI\gh.exe' auth git-credential
  ```
  （gist.github.com 同理）
- 系统级兜底：`E:/Program Files/Git/etc/gitconfig` 的 `credential.helper=manager`
  （Git Credential Manager）。
- 令牌本体存于 Windows 凭据管理器（keyring），**永远不要**打印/复制到明文文件。
- 验证命令：`gh auth status`（应显示 ✓ Logged in，Active account: true，
  Git operations protocol: https）。

**git 身份**：
- 全局：`user.name=zhangfengshun`、`user.email=zhangfsh2020@163.com`
- 本仓库覆盖：`user.name=ZhangFengshun`、`user.email=zhangfengshun21@mails.ucas.ac.cn`
  （提交前用 `git config user.name / user.email` 确认走的是仓库级配置）

**gh 附加能力（历史会话已实际用过）**：
- `gh repo fork --clone=false` + `gh pr create`：向 awesome-dsh-plugin 投稿
  （PR #4268，条目 `data/plugins/zhangfengshun__dsh-remote-ssh.yml`，category: remote）
- `gh repo edit --add-topic dsh-plugin`：仓库已加 `dsh-plugin` topic
- `gh api` 可用（token 含 admin:public_key，可临时注册测试 SSH 公钥，用完即删）

**故障排查**：若 push 突然要求输密码 → `gh auth status` 看登录是否失效；
重登录用 `gh auth login`（浏览器 OAuth 或粘贴 gho_ token），然后 `gh auth setup-git`。

## 2. npm 发布机制

- 认证：`%USERPROFILE%\.npmrc` 中的
  `//registry.npmjs.org/:_authToken=npm_***`（值不外泄）。
- 校验：`npm whoami` → `zhangfengshun`；失效表现为发布时 **401**。
- **token 更新流程（历史做法）**：用户在聊天里给出新 token →
  用 PowerShell 正则替换 `.npmrc` 中该行 → `npm whoami` 验证。
  ```powershell
  $npmrc = "$env:USERPROFILE\.npmrc"
  $lines = Get-Content $npmrc
  $lines = $lines -replace '^//registry\.npmjs\.org/:_authToken=.*$', '//registry.npmjs.org/:_authToken=<新token>'
  Set-Content -Path $npmrc -Value $lines -Encoding ascii
  npm whoami
  ```

## 3. 标准发布流程（历史会话沉淀，每条线都验证过）

```powershell
cd C:\Users\Administrator\Desktop\temp\ChatGPTProProject\dsh-remote-ssh
# 1. 改代码 + 升 package.json version + 更新 CHANGELOG.md（版本段 + 修复/性能数据）
# 2. 提交 + 推送 + 发布（一条命令串行）：
git add lib\index.js lib\client.js package.json CHANGELOG.md
git commit -m "2.3.x: <一句话说明>"
git push origin main
npm publish
# 3. （可选）校验 npm 包内容：npm publish --dry-run
# 4. （可选）本地 pack 与 registry shasum 一致性核对（npm pack --dry-run --json vs
#    registry dist.shasum）
# 5. 装入 desktop profile：
dsh plugin --profile desktop add @zhangfengshun/dsh-remote-ssh@<版本>
```

### 已知坑（全部在历史会话中踩过并解决）

1. **`minimumReleaseAge` 供应链策略**：刚发布的新版本立刻 `dsh plugin add` 会被
   pnpm 拦截（"within the minimumReleaseAge cutoff"）。等几十秒到几分钟重试即可，
   不是发布失败。
2. **npm notice 打到 stderr**：PowerShell 会把它包成 NativeCommandError 红字，
   但发布实际成功——以输出里 `+ @zhangfengshun/dsh-remote-ssh@x.y.z` 和
   `npm whoami` 为准，不要被红字吓到。判断成功可
   `npm publish 2>&1 | Select-String -Pattern "version:|\+ @zhangfengshun"`。
3. **LF→CRLF 警告**：`warning: in the working copy of '...', LF will be replaced by
   CRLF` 无害，忽略。
4. **发布前必查 `files` 字段**：package.json 的 `files` 白名单决定 tarball 内容，
   历史上有一次漏了 README_EN.md（2.1.7 补上）。发布后用 dry-run 输出核对文件清单。
5. **版本号一致性纪律**：commit message 以版本号开头（如 `2.3.9: pin ssh to
   System32 OpenSSH...`），CHANGELOG 顶部同步加同版本条目；npm 与 git 必须同时
   走到同一版本，否则后续排查对不上。

## 4. 归档会话的读取方法（以后还想翻历史）

```powershell
# 会话存于 <DSH_HOME>\sessions\<工作区目录>\<session-id>\session.jsonl.zstd
# DSH_HOME = C:\Users\Administrator\.dsh
zstd -d -f <file>.zstd -o out.jsonl   # zstd 位于 E:\ProgramData\anaconda3\Library\bin
```

- 本项目相关会话在 `--C-Users-Administrator-Desktop-temp-ChatGPTProProject--` 目录：
  `session-d5dc5130`（主维护会话，2.1.7→2.3.9 全部发布史）、
  `session-996c0822`（AgentTeams 工程师子会话，含 awesome 投稿全过程）。
- 每条 JSONL 行是一个事件；`assistant/message` 里的 reasoning 字段含当时的决策过程。

## 5. 维护备忘

- **🔒 公开产物里绝不出现真实主机 / 账号 / 项目 / 路径 / 镜像 ID（2026-09-20 用户明令）**：
  issue 回复、README、CHANGELOG、代码注释、测试夹具**一律用通用占位符**。曾把真实项目名
  （OpenFOAM / kOmega / DFS-Dev / IB_Robot）、HPC 主机名、内网 IP、真实远程路径、镜像目录 ID
  写进 issue 回复与仓库文档，属于信息泄露。占位符约定：
  `proj-a` / `my-project` / `project-b`（项目）、`~/proj`、`~/work/my-project`（路径）、
  `hpc-a.example.com`（主机）、`192.0.2.10`（内网 IP，TEST-NET-1 文档网段）、
  `wmirror1`…（镜像 ID）、`solver`（查询词示例）。
  **发布前必查**（`gh-fix/scan-private.mjs` 同款逻辑，或直接 grep）：

  ```powershell
  node <scratch>\scan-private.mjs <repo>     # 枚举镜像 ID / 主机名 / 账号 / 真实路径 / 项目名 / 内网 IP
  ```

  唯一允许保留的私人字样是 README 七夕段落里的署名 `zhangyi`（刻意保留的私人寄语，见下条）。
  发布后若发现泄露：先改 issue 评论（`gh api -X PATCH .../issues/comments/<id> --input <payload.json>`）
  与仓库文件，再处理 npm 产物（`npm unpublish <pkg>@<ver>` 后重新发布同一版本，或发新补丁版）。
- **🚨 改完 `lib/index.js` 必须跑模块加载冒烟（2026-09-20 血的教训）**：曾把
  `const REMOTE_SEARCH_SKIP_DIRS = new Set([...REF_EXCLUDED_DIRS, …])` 写在
  `REF_EXCLUDED_DIRS` 定义**之前** —— 模块级 `const` 的展开会在模块求值期立即读取该绑定，
  于是抛 `ReferenceError: Cannot access 'REF_EXCLUDED_DIRS' before initialization`，
  整个插件树加载失败（`dsh-plugin-desktop: plugin tree failed to load`），
  **用户连桌面都进不去，只能卸载插件**。
  当时的测试全都只从源码里「提取函数/常量文本」再单独求值，所以完全测不出来。
  现在有 `tests/module-load.test.mjs` 兜底（两层：① 真实 `import()` 模块；
  ② 带花括号深度的静态扫描，只查模块级引用顺序），并且可以指定目标文件做上机前冒烟：

  ```powershell
  node tests/module-load.test.mjs                                    # 检查仓库源码
  $env:DSH_TEST_MODULE="$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@zhangfengshun\dsh-remote-ssh\lib\index.js"
  node tests/module-load.test.mjs                                    # 检查「DSH 将要加载的那个文件」
  ```

  发布前请把上面两条都跑一遍（第二条是上机前最后一道闸）。
- **本地装包要用新文件名**：pnpm 会按 tarball 路径缓存 —— 用同一个文件名重复
  `dsh plugin --profile desktop add file:…tgz` 时可能**沿用旧内容**（现象：装完发现包内没有新代码）。
  重新打包后换个文件名（如 `-tdzfix.tgz`）或先 remove 再 add。
- **🚫 README 的「## ❤️ 七夕快乐」段落是固定内容，任何文档改版都不得删除、改写或移位**
  （`README.md` 中文版 + `README_EN.md` 的 `## ❤️ Happy Qixi` 对应段落，含
  「本项目是送给 **zhangyi** 的七夕礼物。」三行与落款日期 2026 年 8 月 18 日）。
  这是仓库作者对所有者的私人寄语，不是可裁剪的营销文案——新增章节一律插在它**上方**
  （「更新日志 / 许可证 / Star 引导」等尾部内容保持在其下方）。改动 README 后用
  `grep -n 七夕 README.md` 与 `grep -n Qixi README_EN.md` 自检，并确认 GitHub main
  与 npm 产物内均在。
- 桌面 profile 中插件顺序要求：`dsh-better-sidebar` 在
  `@zhangfengshun/dsh-remote-ssh` 之前（README 的先后要求），不要打乱。
- awesome-dsh-plugin 投稿已合并 PR #4268（2026-09-04）；列表 README 是自动生成的，
  后续若要改条目，改的是 `data/plugins/zhangfengshun__dsh-remote-ssh.yml`。
- DSH Market 评分（实用五维，权重 维护 30 / 实用 25 / 热度 20 / 便捷 15 / 信号 10）：
  - **信号质量**五项完备度 = description / license / topics / **homepage** / README
    ——GitHub 仓库 homepage 曾为空（2026-09-12 已补为 npm 页面），改仓库设置时不要清空；
  - **实用度**看 README 结构：安装 / 使用 / **代码示例** / 功能说明——新增功能时同步补示例；
  - **便捷度**要求「一条命令可装 + 无需 token/API Key」，不要引入需要额外配置的依赖；
  - **热度**由真实 star / fork 决定，无法通过文档操作提升。
- `screenshots.json`（storefront 展示图清单）与 `assets/` 截图在仓库里，发布
  README 变更时记得同步。
