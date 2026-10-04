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
git add -A
git commit -m "2.3.x: <一句话说明>"
git push origin main
npm publish            # 注意坑 6：本账号的发布会走 registry 侧 staged publish，"输出成功"≠"已公开"
# 2b. 发布后确认（必做，不要只看 npm view version —— packument 有缓存、会滞后几分钟）：
#     版本级 URL 返回 200 才算真的公开 →  curl https://registry.npmjs.org/<scope>%2F<pkg>/<版本>
#     再核对 dist-tags：npm view <pkg> dist-tags        （latest 应指向新版本）
#     最后回下载对比：npm pack <pkg>@<版本> 的 sha1 应等于 npm publish 输出里的 npm notice shasum
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
6. **registry 侧 staged publish（2026-09-29 发布 2.4.18 时踩到，会误判"发布失败"）**：
   本账号（2FA 开启、token 为 `npm_…` 细粒度令牌）的 `npm publish` 由 registry **暂存**受理，
   npm 照常打印 `npm notice version: x.y.z` 与 `+ @scope/pkg@x.y.z` 并以 0 退出，但版本**不会立刻公开**：
   - 立刻查会看到旧版本（`npm view version` 仍是上一个版本，packument 缓存 + 暂存未推广），
     于是很容易以为发布失败；
   - 重发同一个版本会得到 `npm error code E409 409 Conflict - PUT … Cannot publish over
     previously staged version "x.y.z"`（**不是**权限问题，也不是版本号被占用）；
   - `GET https://registry.npmjs.org/-/stage` 与 `npm stage list` 在本机可能显示为空（本地 npm 11.10.0
     **没有** `stage` 子命令；`npm stage list/view/approve/reject/download` 属于 **npm 12+**，
     可用 `npx -y npm@12 stage …`，注意会打 `EBADENGINE` 警告：npm 12 要求 node ^24.15.0，本机 24.13.0）。
   实测（2.4.18）：第一次 `npm publish` 报成功但 registry 无此版本；重发报 E409；**约 8 分钟后
   `https://registry.npmjs.org/@scope%2Fpkg/2.4.18` 返回 200、`dist-tags.latest` 跟上** —— 即暂存件被
   推广为正式版本，**无需重新发布**。结论：**发布后先用"版本级 URL"确认，别急着重发**；
   重发只会得到 409。真正需要人工介入（OTP/网页批准）时，npm 会明确要求 one-time password。

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

- **🚦 DSH 0.2.0-rc.1 起的「插件兼容性门」（2026-09-28，最重要）**：harness 用插件自己声明的
  **DSH peer 版本范围**判定能否安装/激活；范围覆盖不到运行时版本时 `dsh plugin add` 直接拒绝
  （`Plugin <name>@<v> is incompatible with dsh <runtime>: peerDependencies …`），已装的 bundle 也
  **不会激活**（宿主里查不到该插件的 entry/tool），只能 `dsh plugin allow-version <pkg@ver> --dsh-version
  <runtime> --accept-risk` 逐版本豁免（官方警告可能崩溃/丢数据）。判定是**严格 npm semver**：预发布
  版本只被"元组相同且自身带预发布"的比较器接受 → **每条已验证版本线都要显式列出**，例如
  `"^0.1.0-rc.6 || ^0.1.5-rc.1 || ^0.1.7-rc.2 || ^0.2.0-rc.1"`（`dsh-cron` 用同样的写法）。
  `tests/manifest-compat.test.mjs` 用内置严格比较器守住这一点（`DSH_RUNTIME_VERSION` 可覆盖目标版本）。
  另外：运行时不再提供的客户端包要从 `dsh.client.inject` 移除（0.2.0-rc.1 起没有
  `@deepseek-ai/dsh-client-runtime`），否则客户端半边会去解析不存在的包。
- **🧪 升级前沙箱（2026-09-29 起已自动化，替代手工配方）**：内核升版前先在工作区跑
  `dsh-preupdate-sandbox\preupdate-sandbox.ps1`（默认取 `npm dist-tags.next`，并与桌面端
  nightly feed 的版本号对照）。它在**独立 `DSH_HOME`**
  （`C:\Users\Administrator\dsh-sandbox\<版本>\home`）里装候选内核 + 当前插件栈，逐个插件过
  兼容门禁、再真实启动一次自检，产出 `reports\<版本>\report.md`（PASS/BLOCKED + 逐插件结论 +
  准确的修复命令）。**豁免只写沙箱 profile，绝不写主 profile。**
  `-Upgrade <pkg@ver>` 用来验证「升级插件」这条治本路径；`-AllowRisk` 用来验证「豁免之后能不能
  起来」。**升级前还要跑 `-Stage grant`**：把目标内核需要的豁免写进主 profile 的
  `compatibility.json`（= 应用里点「接受风险」，但不需要应用能启动，带备份且幂等）——
  必须在升级**前**做，否则应用因门禁起不来时那个按钮也点不到（死锁）。该 JSON **必须 UTF-8
  无 BOM**（应用是裸 `JSON.parse`），所以用 `lib\grant-exemption.mjs` 写而不要手写/`Out-File`。
  实测结论（0.2.0-rc.2）：本插件 2.4.17 直接 OK（peer 已含 `^0.2.0-rc.1`）；
  被挡的是 better-sidebar 0.22.1（升到 0.24.1 即可，其 peer 已是 `^0.2.0-rc.1`）、
  agent-teams 0.1.21、skill-mcp-panel 2.1.2（peer 明确 `<0.2.0-0`）、dsh-cron 0.14.3。
- **🚫 cordis 的 `inject` 没有 optional：第三方 bundle 提供的服务绝不要写进 `exports.inject`（2026-09-29，issue #18）**：
  `Inject<M>` 只有两种形态 —— 字符串数组，或 `{ [K]: config|null }`（对象形态的 `null` 表示**拦截配置**，
  **不是**"可选"，`Inject.resolve()` 只产出 `{serviceName: config|null}`）。`Fiber._refresh()`（cordis 4.0.4
  `lib/index.js` L1317-1329）里 `for (const name of Object.keys(this.inject)) { if (!this._store[name]) { epoch = INACTIVE; break } }`
  —— **任何一个 inject 键对应的服务没注册，整个 fiber 就永久 pending**。前端 boot 会把 pending 的条目列出来并抛错：
  `web boot: N entr… did not activate` + `<插件>: pending (waiting for service: <服务>)`，桌面端还会弹「插件恢复」。
  实例：客户端半边曾写 `exports.inject = ["betterSidebar", "slots", "locale"]`，而 `betterSidebar` 只由
  `dsh-better-sidebar` 这个**可选** bundle 提供 → 没装它的用户整块前端起不来（宿主照旧只是打一条
  `patch: entry "better-sidebar" not found` 的 warn，很容易看漏）。**正确写法是子 fiber 软注入**：
  `ctx.inject(["betterSidebar"], (bsCtx) => { … bsCtx.effect(() => bs.registerTab(…)) })`（前端自身用
  `e.inject(["uiRenderer"], o => {…})`，本插件宿主半边软注入 `webRuntime` 同理）；`exports.inject` 只留内核**一定**
  提供的服务（`slots`/`locale`）。软注入回调在服务注册时执行，装与不装都安全。
- **🔬 复现「插件让前端起不来」这类问题的验证配方（2026-09-29 建，A/B/C 三例已跑通）**：
  ① 沙箱 profile 里按需增删依赖：`dsh plugin --profile sandbox remove <pkg>` / `add <pkg>@<ver>`（`dsh plugin`
  就是 pnpm 直通，`remove` 可用）；② 启动 `node <core>\lib\bin.js --profile sandbox --port <端口> --no-open`，
  从 stdout 抓 `dsh web: http://127.0.0.1:<端口>/?token=…`；③ **用无头 Chrome + CDP 读前端真实状态**，
  不要用 `--dump-dom --virtual-time-budget`（页面有长连接/定时器时**会挂死**，脚本卡到超时）：
  `chrome --headless=new --remote-debugging-port=9223 --user-data-dir=<空目录> about:blank`，再
  `http://127.0.0.1:9223/json/version` 取 `webSocketDebuggerUrl`，Playwright MCP `browser_connect_roxy` 连上去后
  `page.context().newCDPSession(page)` + `Network.setCacheDisabled` 再 `goto`（否则可能吃到旧 bundle），
  然后 `page.evaluate` 读 `document.body.innerText`（失败时整屏就是 `Failed to load plugins` + 原因）与插件自己设的全局。
  **判据别用 `window.__DSH_BOOT_READY__`：失败的场景里它同样是 `true`**（实测）；可靠判据是 ① DOM 里有没有
  `did not activate` 错误屏 ② 插件自己在 `apply` 里设的全局（如 `__dshRemoteSshGlobeStats`）在不在
  ③ 设置页里本插件的小节（如「远程连接」）出没出现。三例结论：已发布 2.4.17 + 无 better-sidebar = 整屏报错；
  修复版 + 无 better-sidebar = 干净引导 + 设置页有「远程连接」；修复版 + better-sidebar 0.24.1 = 行为不变。
- **🧷 better-sidebar 的 `fs.*` 契约是「逐端点」的：上游新增/改名端点必须同步注册 exact 路由（2026-09-29 实例，issue 现象＝「远程项目的侧边栏文件打开是本地目录」）**：
  本插件靠注册 `/sidebar/api/fs.*` 的 **exact 路由**抢在 better-sidebar 的 `/sidebar/api` prefix 之前拦截，
  **没注册的端点不会报错，而是静默回落到它自己的宿主实现（读本地 fs）** —— 表现就是"远程项目里看到本地目录"。
  实例：`dsh-better-sidebar` **0.23+ 把文件树从「逐层 `fs.tree`」改成「一次 `fs.trees` 批量列举可见集」**
  （工作区根 + 所有已展开目录，≤64 条；客户端按返回的 `level.path` 落缓存），0.24 又新增 `fs.mkdir`（新建目录）。
  2.4.17 只注册了 `fs.tree` → 0.24 的整棵树绕过拦截、读本地镜像；新建目录也只建在本地镜像里。2.4.18 已适配 9 端点。
  **同一个坑在「打开方式」上重演**：`open.external`（0.24 新增）宿主侧用本机打开器执行
  （`explorer.exe /select,<路径>` / `rundll32 url.dll,FileProtocolHandler <url>`），客户端传的仍是**镜像路径** →
  「在文件管理器中显示」打开本地镜像、「用 VS Code 打开」打开 `vscode://file/C:\…镜像…`。2.4.18 起拦截该端点，
  远程工作区改开 `vscode://vscode-remote/ssh-remote+<别名><远端路径>`（`reveal` = 打开所在远端目录）。
  别名必须**端口一致**才可用（非 22 端口 / 跳板机只能靠别名复用 ssh config 的 Port/User/IdentityFile/ProxyJump），
  匹配逻辑是纯函数 `remoteEditorAuthority()`；拿不到别名就回退本机行为 + warn。**注意 `openWith.sshHost` 是反例**：
  用户填了它，客户端会自行打开（宿主看不到），路径却仍是镜像路径 —— 文档里明确让人留空。
  **每次升级 better-sidebar 后必做对拍（1 分钟）**：把它的宿主 handler 键集合与我们的注册数组逐项比对 ——
  `node -e "const s=require('fs').readFileSync(process.argv[1],'utf8');console.log([...new Set([...s.matchAll(/\"(fs\.[a-zA-Z]+)\"/g)].map(m=>m[1]))].join(' '))" "<profile>\node_modules\dsh-better-sidebar\lib\index.js"`
  （客户端真实调用侧看同一包的 `lib/client.js` 里的 `call(\"fs.*\")`；`fs.tree` 仍要保留 —— 旧版客户端与编辑器侧栏都在用）。
  两条分支**都必须实现**：exact 路由会连本地会话一起抢占，只在远程分支处理会让本地工作区的该端点 404、反而弄坏原本正常的功能。
  `fs.trees` 的响应形状必须对齐上游：`{ levels: [{ path(回显客户端传入的路径，客户端拿它当缓存键), entries, truncated, error? }] }`，
  单层失败**不**让整批失败；远端批量列举用 `remoteListDirsBatch()`（`__DSH_LVL__` 标记分段，**一次 SSH 往返**列举 N 个目录，
  别退化成 N 次 SSH），命中 `treeCache` 的层 0 RTT。
  `open.external` 的宿主命令形状（三平台）与上游 `revealCommand`/`urlCommand` 逐字一致（纯函数 `openerCommand()`，
  argv 数组、不经 shell、`detached`+`unref`）；自动化验证用 **`DSH_REMOTE_SSH_NO_LAUNCH=1`** 干跑，避免测试真的弹出
  VS Code / 资源管理器窗口。远程打开要过三关：工作区归属（`matchRemoteWorkspace`，该端点**没有** sessionId/cwd）→
  ssh 别名（端口一致才可用）→ `~` 展开（URL 不过 shell；`printf %s "$HOME"` + 10 分钟缓存），任何一关不过都**回退本机 + warn**。
- **🧪 沙箱里装本地 tgz 做验证时：同版本 + 同路径不会重装（2026-09-29 踩到）**：`dsh plugin --profile sandbox add file:…tgz`
  对**已装的同一版本号**直接跳过（pnpm 认为已满足），于是"验证通过"其实是旧包在跑 —— 必须先断言包内确实有新代码，
  例如 `Select-String <profile>\node_modules\<pkg>\lib\index.js -Pattern '<新增函数名>'` 或把 tgz **换个文件名**（新的
  `file:` spec）再装。煞尾：改动后重打包 → 换名 → 装 → 断言符号存在 → 再启动实例验证。
- **🖥 desktop profile 只能由应用内插件管理器改（2026-09-28 起）**：`dsh plugin --profile desktop …`
  会被无条件拒绝（`profile "desktop" is managed exclusively by the Electron application`，
  `rejectElectronProfile` 无开关）。想手工升级只会遇到两个护栏：① profile 的 node_modules 由**特定
  版本**的 pnpm 建（`.modules.yaml` 里记 `packageManager`/`storeDir` 是 `store\v11`），换版本就
  `ERR_PNPM_UNEXPECTED_STORE`；② harness 给 pnpm 传了 `minimumReleaseAge` 供应链策略，**刚发布的版本
  在时限内会被拒**（`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`）。所以：让用户去应用的插件管理器更新，
  不要手工 pnpm / 直接改 package.json。用户自己装的版本若被兼容性门挡住，可让他点"接受风险"豁免（前提是
  该版本代码本身已适配，例如 2.4.15 与 2.4.16 的代码相同、只差 peer 声明）。
- **🔎 用运行中的宿主做接口对拍**：`cordis_inspect_list` → host `Service.listService`（不带参数出目录，
  带 `{service}` 出该服务契约）、`Config.listConfigs`（`{name: <包名>}` 查自己的 entry；`{entry}` 取投影
  schema）、`Tool.listTools`（插件是否真的注册了工具）、client `Slots.listSubTree`（客户端槽位是否存在）。
  0.2.0-rc.1 里 Config 目录用 `include:<patchId>` 命名，但 **patch 仍按 `patchId` 命中**（我们的
  `terminal-controller` patch 因此照旧生效）；`settings.describe()` 的 `ns` 也仍是 `remote-ssh` 这类 patchId。
  `webRuntime`（信任围栏的信任源）在 0.2.0-rc.1 已被移除 → 软注入下自动退回 loopback-only（桌面端本身
  `networkExposure: loopback`，功能无损失）。
- **🧩 DSH 0.1.7-rc.2 起的 settings 模型（2026-09-28 适配，issue #16）**：`settings` 服务
  **没有** `register(ns, schema)`，改为 `configure / describe / update / replace / mutate`；
  用户偏好存放在**本插件 loader 行的 Config**（命名空间 = **entry id / patchId**，我们 bundle 里是
  `remote-ssh`；而旧 settings 的 section 键是**包名** `dsh-remote-ssh` —— 这导致旧数据不会自动迁移）。
  三条硬约束：
  1. Config 字段必须 `.volatile()`，且**必须用 `@deepseek-ai/schemastery`**（公共 `schemastery`
     没有该实现 → Loader 的 volatile-commit 路径不提交 → 写入"报成功但值不变"）；
  2. 读：`describe({ redactSecrets: true }).find(d => d.ns === entryId).value`（实测 value 里是
     **已解析的普通数组**）；`apply(ctx, config)` 里同名字段是**带 `.get()` 的引用对象**，两者都要兼容；
  3. 写：`settings.update(entryId, patch, revision)`（revision 取自同一次 describe）。
  旧数据迁移：读 `$DSH_HOME/settings.yaml.imported`（退 `settings.yaml`）里旧 section，
  **仅当该 entry 用户层为空**时 `update` 导入；并把导入值放内存兜底，让升级后**第一次启动**就能看到。
- **🧪 兼容性验证配方（不打扰用户正在用的会话）**：把**目标版本的官方 CLI**装到临时目录
  （`npm i --prefix <tmp> @deepseek-ai/dsh@<版本>`；注意 PATH 上的 `dsh` 可能是很久以前装的全局版本，
  别用它，否则测的不是目标版本），用 shipped 模板建一次性 profile（复制 `profiles/web` 的
  `package.json`/`cordis.yml`/`cordis.patch.yml`/`pnpm-workspace.yaml`），
  `node <tmp>/node_modules/@deepseek-ai/dsh/lib/bin.js plugin --profile <one-shot> add file:<tgz>`，
  再 `node <tmp>/…/bin.js --profile <one-shot> --port <spare> --no-open`（后台跑），最后 curl 插件 API：
  `POST http://127.0.0.1:<spare>/remote-ssh/api/listProfiles` 带 `x-requested-with: XMLHttpRequest`。
  **注意响应是 `{ok, value:{…}}` 信封**（曾因只读顶层字段而误判"全空"）。验证完删掉该 profile 与临时
  CLI 目录。`DSH_REMOTE_SSH_DEBUG_SHAPE=1` 会让插件把 settings 形状探针写到 `$DSH_HOME`。
- **🚫 禁用状态记在 `desktopDeselectedBundles`**：profile 的 `package.json` 里
  `dsh.desktopDeselectedBundles` 列出的包即使仍在 dependencies 也不会挂载；
  `dsh plugin add` **不会**替你清掉它 —— 恢复启用要把它从该数组移除、并确认包在
  `dsh.profile.bundles` 里（顺序：本插件应在 `dsh-better-sidebar` 之后）。
- **🔒 公开产物里绝不出现真实主机 / 账号 / 项目 / 路径 / 镜像 ID（2026-09-20 用户明令）**：
  issue 回复、README、CHANGELOG、代码注释、测试夹具**一律用通用占位符**。曾把真实项目名、
  HPC 主机名、内网 IP、真实远程路径、镜像目录 ID 写进 issue 回复与仓库文档，属于信息泄露
  （本文件早先的版本甚至把这些真实名字当"例子"列了出来 —— 记录规则时也不要写具体值）。
  占位符约定：`proj-a` / `my-project` / `project-b`（项目）、`~/proj`、`~/work/my-project`（路径）、
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
- **报错文案的第一性：掩埋一手证据等于把用户引向错误方向（issue #19，2026-10-04）**：
  腾讯云那台机器的失败原因其实只有一行 —— `Warning: Identity file … not accessible`（配置的私钥
  文件根本不存在），但它 ① 不是 `debug1:` 行，正好被 `testConnection` 的 `-v` 诊断过滤器漏掉；
  ② `/etc/ssh/banner.txt` 的**预认证登录横幅**（扫码二维码 ASCII 画）塞满了「原始信息」的 300 字
  截断窗口 —— 用户于是判断成"是扫码导致的连接失败"，把维护者也带偏。现在固化成五条纪律
  （实现：`stripLoginBanner` / `findMissingIdentityFile` / `offeredAuthMethods` / `sshExcerpt`）：
  1. **一手证据优先**：stderr 里能直接读出的确定事实（哪个私钥文件不存在、哪个端口被占）放在提示
     第一条，并**原样回显路径/端口**；泛泛的"公钥认证失败"必须让位。
  2. **诊断行白名单**：任何降噪都要先放行 `debug\d+:` / `Warning:` / `Permission denied` /
     `Authentications that can continue` / `Identity file` / `Connection …`，短行也保留。
  3. **截断按诊断取，不按位置取**：`slice(0, N)` 会被装饰性输出（横幅、二维码）吃光。
  4. **能力边界写进报错**：远端"允许"交互式认证 ≠ 插件"能用"—— 文件/工具能力是
     `BatchMode=yes` + `PreferredAuthentications=publickey` 的非交互通道，扫码/动态口令只能走内置
     「终端」页签（`ssh -tt`，wrapper 里不设 BatchMode）。凡"用户容易以为是 bug、其实是设计"的地方，
     都要在文案里点明并给替代路径。
  5. **回归 fixture 用举报人的真实 stderr（脱敏后）**：`tests/auth-error-diagnostics.test.mjs` 直接把
     #19 贴出的那段（二维码 + Warning + `Permission denied(…)`）喂进 `sshErrorHint`，比自造样例更能
     防住回归；并配一条"远端只提供公钥"的负向控制，防止提示越写越长。
