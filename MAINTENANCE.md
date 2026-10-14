# dsh-remote-ssh 维护与发布手册（Maintainer Playbook）

> 本手册由维护会话于 2026-09-10 从 DSH 归档历史会话中提炼（session d5dc5130 主会话、
> 996c0822 工程师子会话等），并逐项在当前机器上验证通过。不含任何密钥。

## 0. 当前状态（已验证）

| 项目 | 状态 |
| --- | --- |
| 本地版本 / npm latest / GitHub main | **2.4.28**（2026-10-14 发布）：npm `dist-tags.latest`、tag `v2.4.28`、GitHub Release 三者一致，commit `d0ce933`；已装进桌面 profile（`lib/index.js` 328,826 字节 / SHA256 `62B7288892347A10270AE5926765237E692ADFFF5FE2FA1A13C119036787A32C`，与 npm 产物同哈希）。**需重启 DSH 才生效** |
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

1. **`minimumReleaseAge` 供应链策略（2026-10-04 实测：窗口 = 24 小时，不是几分钟）**：
   刚发布的新版本走**应用内插件管理器**安装会被 pnpm 拦下：
   `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION  <pkg>@<ver> was published at <ISO>, within the
   minimumReleaseAge cutoff (<ISO>)`。两处证据与结论：
   - 策略窗口从日志里的 cutoff 反推 = **发布时刻 − cutoff = 24h**（导出 2.4.19 时读
     `<profile>/.plugin-manager/logs/<operation>/pnpm.log` 看到 cutoff 恰为检查时刻前 24 小时；
     历史上 2.4.16 也在同一窗口内被拦）；
   - 它验证的是 **lockfile 里所有 entries**（"Verifying lockfile against supply-chain policies
     (N entries)"），所以不是"只挡新包"，而是"锁文件里出现未满 24h 的版本就整体拒绝"；
   - **桌面 profile 是 pnpm 工程**（`<profile>/package.json` + `pnpm-lock.yaml` + `pnpm-workspace.yaml`，
     `nodeLinker: hoisted`，`autoInstallPeers: false`），应用内插件管理器其实就是在这个目录跑
     `pnpm add <pkg>@<ver>`（日志可见）；它用的是 **pnpm 11.8.0 + store
     `%LOCALAPPDATA%\pnpm\store\v11`**，与本机 CLI 的 pnpm（10.x / store v10）**store 不同** ——
     拿 CLI pnpm 直接 install 会要求"清空并重建 node_modules"
     （`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`，非 TTY 下被拒），**不要照做**（会牵连 profile 里
     其它插件）。
   - 想立刻用上新版本：**就地更新**（把 registry 上该版本 tgz 解出的 `package/*` 覆盖到
     `<profile>/node_modules/<pkg>/`，并同步 `<profile>/package.json` 的依赖号）。这条路径不经过 pnpm，
     因此不受 24h 窗口限制；代价是 `pnpm-lock.yaml` 会暂时落后一版 —— 等窗口过去后由管理器安装自动收敛。
     备份放 `%USERPROFILE%\.dsh\packages\_hotfix-backup\profile-desktop-<时间戳>\`。

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

7. **改文档/版本号一律用编辑器工具，不要用 PowerShell 做文本往返（2026-10-11 踩到，一次废掉两个 README）**：
   本机 DSH 的 `pwsh` 工具实际是 **Windows PowerShell 5.1**（`5.1.26100.9568`），它的
   `Get-Content -Raw` **对没有 BOM 的文件按 ANSI 代码页（中文机器 = GBK）解码** —— 仓库里所有
   `.md`/`.json` 都是 **UTF-8 无 BOM**，于是 `Get-Content -Raw` → `-replace` → `Set-Content -Encoding utf8`
   这条"顺手改个版本号"的链路会把整篇中文读成乱码再写回：README.md / README_EN.md 全篇变
   `锛?鈥?馃`，还额外带上 BOM（BOM 对 npm 无害，但**对裸 `JSON.parse` 的宿主是致命的**）。
   纪律：
   - 改文件用编辑器工具（`edit`/`write`，它们按 UTF-8 处理且有版本守卫）；**需要脚本批量替换时，
     显式指定编码**（`Get-Content -Encoding UTF8` / `Set-Content -Encoding UTF8NoBOM`，PS 5.1 写
     无 BOM 得用 `[System.IO.File]::WriteAllText($p,$t,(New-Object System.Text.UTF8Encoding($false)))`）。
   - **改完必须核验**：① `git diff --stat` 看改动行数是否离谱（整篇重写 = 编码事故的信号）；
     ② 文件头 3 字节不是 `EF BB BF`；③ 抽查是否出现 `锛|鈥|馃` 这类乱码样本。
   - 出事后**不要手工修补**：`git checkout -- <文件>` 回到 HEAD，再用编辑器重做那几行改动
     （本次 README 的两行改动就是这么重做的，实测 30 秒恢复干净）。

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

- **📦 「在开发机上能解析」≠「官方打包形态能解析」（2026-10-12，issue #23 第二轮，最值得记的一条）**：
  2.4.24 用 `process.execPath` / 同目录 node 等五条候选修 wrapper 的 node 解析，本机实测通过、测试也过，
  但**官方打包版上五条全落空** —— 举报人对着产物逐条核对：主进程 `execPath` 是 `DeepSeek Harness.exe`、
  `DSH_DESKTOP_NODE_EXECUTABLE` 不在子进程环境里、同目录无 node。教训有两条：
  （a）**验收要造出目标形态的进程画像**，而不是只跑本机的真实值 —— `tests/wrapper-terminal.test.mjs`
  场景 11 现在就是这样：伪造 packaged Desktop 的 `execPath` + 清掉环境变量 + 无同目录 node，
  再断言兜底候选能解析到**真实存在**的文件，并留一条负向控制（全都不可用 → 空串 + 回退 PATH）。
  （b）**结论的措辞要跟代码能交付的范围对齐**：2.4.24 的 CHANGELOG/README 写了"不再依赖 PATH"，
  这对打包版是过强的 —— 2.4.25 把话收回来，并明确"在官方给出稳定 runtime 入口之前，插件侧到此为止"。
  CHANGELOG 里已经写下的过强结论，**要在下一版显式更正**，不能悄悄改文档了事。
  （c）2.4.25 加的两条兜底（⑥ `%DSH_HOME%\dsh-runtimes\*`、⑦ `<安装目录>\resources\runtime\*`）在
  **两台机器上都命中⑦、不是⑥** —— 插件所在进程的环境里**没有** `DSH_HOME`，所以⑥落空（DSH_HOME 是给
  子进程/终端设的，不是宿主主进程的）。⑦ 依赖"进程可执行文件旁边就是运行时"这个**安装期事实**，比环境变量稳，
  排序不该反过来。举报人还实测了：`…\resources\runtime\` 下有 `bin`/`cli`/`office-skills`/`pnpm`/`primary-runtime`
  **五个目录，只有 `primary-runtime` 含 node** —— 所以"探测该层 + 逐候选 `existsSync` 验证 + 实例名不写死"
  是必需的，硬编码任何实例名都会在下一次改名时脆掉。
- **⚖️ 覆盖类护栏的默认值：按代价不对称来定，并且必须留"作废"通道（2026-10-12，issue #24 护栏 B）**：
  写回前检查远端是否被改过（记录 `size:mtime`，不一致就不推、只报告）。定这条护栏时的几个判断可复用：
  ① **默认开** —— 漏报一次 = 远端内容被静默覆盖（不可逆），误报一次 = 模型多走一步 `remote_ssh_push`（可恢复）；
  ② **只在远端自己的时间轴上自比**，绝不与本地 mtime 比（跨机时钟偏移、tar/base64 重写让两边不可比）；
  ③ **"读不到"必须放行**（`stat` 失败/ssh 抖动归为"状态未知"，只留日志）—— 否则 flaky 连接就变成了拦截器；
  ④ **记录要能被显式操作作废**（`remote_ssh_push` / `remote_ssh_sync` 成功、以及显式写远端之后清记录），
  否则护栏会从"保护"变成"永久封锁"；⑤ 判据抽成纯函数（`freshnessVerdict`）单独测三态，而不是埋在 `apply()` 里。
- **🔌 新设置字段的"可达性"清单（2026-10-12，issue #24 第二轮举报人指出）**：加了设置字段但没进设置面板，
  对普通用户等于不存在（#23 的场景恰恰是"终端打不开、最需要自救"的那批人）。加字段时逐项过：
  `PrefsSchema`/`WorkspaceSchema` → **三个 settings face 的 `read()` 都要回它** → 写入口（`updatePrefs` 在三个
  face 都实现）→ 宿主端点（白名单字段）→ 客户端控件（`lib/client.js`）→ zh/en 双语键 → 测试
  （`tests/settings-ui-reachability.test.mjs` 就是这条清单的沉淀）。
  这里踩到的隐性 bug 值得单独记：`settingsFace.read()` 此前只回 `profiles`/`workspaces`，
  于是 `read().writeBackFailure` 永远是 `undefined` —— **用户把设置写成 `"log"` 也不生效，只有环境变量管用，
  而且不报任何错**。标量偏好要用 `prefsScalar`（注意 `false` 是合法取值，不能用 `||` 回退）。
- **🧾 包装脚本的每条分支都要有"实测"证据，而不是只有源码形状断言（2026-10-12，关 #23 前补测）**：
  举报人复测通过但如实标注"本轮**没有**重跑负向控制"，我这边补了三条分支的实测（PATH 里只留
  `System32` + `WindowsPowerShell\v1.0`，先确认 `where node` 退出码 1）：

  | 场景 | 期望 | 实测 |
  | --- | --- | --- |
  | 写死路径有效、PATH 无 node（正例） | 越过往后正常起步 | 退出码 **0**，真的开出了 `Windows PowerShell` |
  | 写死路径失效、PATH 无 node（负向控制） | 127 + 可操作提示 | 退出码 **127** + 那三行 `node not found` 提示 |
  | 写死路径失效、PATH 有 node（回退） | 回退成立 | 退出码 **0** |

  **踩到的坑（很容易被误读成产品 bug）**：造"写死路径失效"的副本时，我用
  `-replace 'set "DSH_NODE=.*?"'` 一次替换了**三处** —— 连 `set "DSH_NODE="`（清空那行）和
  `for /f … set "DSH_NODE=%%N"`（PATH 回退那行）也被换成了坏路径，于是脚本直接 `goto :run`
  去执行不存在的文件，得到 cmd 的 `The system cannot find the path specified` + 退出码 **3**。
  正确的做法是**只改那一行非空赋值**（按原编码读入 → `[string]::Replace` 精确替换那一行 → 按原编码写回；
  该文件是 **UTF-8 无 BOM + CRLF**）。教训：**对照实验的"注入"本身要先验证注入成功**（打印改后的文件），
  否则会把测量装置的故障当成被测对象的行为。
- **📋 尚未被"行为"覆盖的清单（据实登记，别当成已验证）**：① ~~写回桥 `writeBackFailure: "log"` 的写路径端到端~~
  —— **2026-10-12 已补（2.4.26）**：把护栏 B 的判定与处置抽成三个可注入的纯函数
  （`freshnessGuardPlan` / `applyFreshnessPlan` / `freshnessGuardCheck`），于是"log 模式被拦 → 不推送、不抛
  （工具返回成功）"从**源码形状**变成了 `applyFreshnessPlan` 的**返回值**，测试里直接断言（`fs-write-bridge`
  的 E5 段，98 → 121 条）。教训值得复用：**凡是"分支存在性"只能靠正则断言的地方，多半是这段逻辑埋在闭包里
  了 —— 把它抽成纯函数（依赖从参数进、结果从返回值出），行为断言自然就有了**；抽完接线只剩三行。
  抽的时候顺带发现一处实质缺陷：log 模式此前只记一行短提示，那份带补救步骤的长报告**只存在于被抛出的
  错误里** —— 也就是说"只报告、不推送"在该模式下退化成"连报告都没有"（改成长报告也写进日志）。
  ② 暂无。

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
  **接管的不只是端点，还有路径语义**（2026-10-13 issue #25，实测复现）—— 被接管的原实现按**会话 cwd / worktree 根**
  解析相对路径（`ensureWorkspacePath(activeWorktreeRootOf(ctx, sessionId, sessionCwd), raw)`），本插件早期版本把
  `payload.path` 原样交给 `fs`，Node 于是按**插件宿主进程的 `process.cwd()`**（pnpm profile 目录）解析。在运行中的
  宿主上实测（2.4.26，只发只读请求）：
  ① `GET /sidebar/file?sessionId=<假>&path=tools/check_file_size.py` → `400 cannot read: ENOENT … stat '<profile>\tools\check_file_size.py'`（与举报人给的一字不差）；
  ② `POST /sidebar/api/fs.read {path:"package.json"}` → **200，返回的是 profile 自己的 `package.json`**（比 ENOENT 更坏：静默读到错文件，用户毫无察觉）；
  ③ `fs.tree {path:"."}` → 列出 profile 目录（`.plugin-manager`、`node_modules`…）；④ 同一文件换**绝对路径** → 200（所以"只有相对路径坏"，极难自查）。
  写操作同理：`fs.write` / `fs.remove` 拿到相对路径会在**插件宿主目录**里写/删（能覆盖 profile 里的同名文件）。
  **修法（2.4.27）**：模块级纯函数 `resolveSessionPath(raw, base)` + `unresolvedPathMessage()`，**每一处落点都过它**
  （`/sidebar/file`、`fs.read/tree/trees/write/rename/remove/mkdir/search` 的本地与远程分支、`git.*` 本地分支、`open.external`）；
  取不到会话 cwd 时**一律报错，绝不回退 `process.cwd()`** —— 那个兜底正是 bug 本身。`fs.trees` 逐条报错（一条坏路径不拖垮整棵树）。
  **测法（可直接复用）**：切片真实 handler + 假 `ctx/req/res`，把 `process.chdir()` 到一个"插件宿主目录"并放 **canary 文件**，
  断言相对路径落在会话 cwd 下、canary **既读不到也删不掉**、拿不到会话 cwd 时必须报错。
  并做**变异负向控制**（把修复点改回旧行为，确认测试真的会红）：本处两处变异分别让 12 条 / 2 条断言变红 ✓。
  **2026-10-14 实例：0.25.0 升级后对拍查出 6 个端点未接管（不是用户报的 issue）** —— 桌面 profile 被应用升到
  `dsh-better-sidebar@0.25.0`（0.24.1 → 0.25.0），照上面的规则比对「宿主 handler 键集合 vs 本插件注册集合」：
  fs 由 8 变 9（新增 `fs.createFile`），git 由 14 变 21（新增 `git.blame` / `commit-model` / `diff-head` / `models` /
  `pull` / `push` / `suggest-message`），而本插件只注册了 fs 8 / git 13。**判据是「这个端点碰不碰路径或仓库」**：
  必须接管的 6 个 —— `fs.createFile`（`cwdOf` + `createWorkspaceFile({cwd,path,name})`；不接管就只在镜像里建空文件，
  远端永远没有）、`git.blame` / `git.diff-head`（`ensureWorkspacePath` + `runGit(repoRoot(cwd))`）、
  `git.worktrees`（0.24.1 就有、此前也漏了）、`git.pull` / `git.push`（`runGit(repoRoot, ["pull","--ff-only"] /
  ["push"])`，会在镜像那个跟远端无关的仓库上动）；**不必接管**的 3 个 —— `git.models` 走 `ctx.get("llm")` 列
  provider、`git.commit-model` 只出现在客户端、`git.suggest-message` 虽然读 `status(cwd)` 但只用于生成提交信息
  （已知小瑕疵：它取的是镜像状态）。
  2.4.28 已接管这 6 个，并把对拍**自动化**：`tests/sidebar-0250-endpoints.test.mjs` 的 C8/C9 会读本机
  `~/.dsh/profiles/*/node_modules/dsh-better-sidebar/lib/index.js`（没装则 SKIP、不算失败），把宿主键集合与本插件
  注册集合逐项比对 —— **升级 better-sidebar 之后跑一次全量测试即可**，不必再手抄键名。同一个文件的 D 段还做
  **语义差分对拍**：把上游的 `assertCreatableFileName` / `isoWithOffset` / `parseBlamePorcelain` / `parseWorktreeList`
  用 `grabFn` 式切片抽出来，与本插件实现喂同一批输入、逐条比较（含拒绝文案）—— 注册齐了但语义走样同样会红。
  该测试还钉住三条容易重犯的事：
  ① 模型类端点**不许**进 `GIT_METHODS`（它们不碰路径，注册反而剥夺上游能力）；② `git.worktrees` 这类"每个条目各有
  自己的根"的端点必须用**条目自己的目录**跑命令（复用会话 cwd 的 `run` 会把 status 跑错目录）—— 断言 `runGitRemote`
  收到的是 `/remote/wt2` 而不是会话/镜像目录；③ "已存在"=409、"形状不对"=400+`bad-request`（本地分支曾一律给
  400 + `fs-error`，连自己的远程分支都不一致）。
  **远端建空文件用 `(set -C; : > <path>)`（noclobber）**：探测与创建之间若有人抢先建了同名文件，这里只会失败，
  不会清空别人的文件（对齐上游 `writeFile(…, {flag:"wx"})` 的语义）；本地分支用 `writeFile(dest, "", {flag:"wx"})`。
  `git.pull` 成功后要做两件事：整棵远端列举缓存失效（工作树可能变了）+ 清掉写回桥的**远端指纹**记录
  （`freshnessForgetProfile`）—— 那些记录描述的是 pull 之前的远端内容，留着会让下一次写回被误判成"远端已改动"而拒写。
  **🧭 真机验证 2.4.28 的实据（2026-10-14，宿主重启后进程全为 10:18:45 启动）**：直接对
  `POST http://127.0.0.1:<port>/sidebar/api/<method>` 发请求（body `{sessionId, cwd|path}`，与本插件注册的 exact 路由同形）：
  ① `git.worktrees`（真实 sessionId）→ `/data/run01/<user>/zfs/codex/DFS-Dev`、`current: true`、`changes: 27` ——
  **远端绝对路径**只可能来自远端分支（镜像里没有 `.git`，上游实现只会给 `[]`），这是"新端点已接管且跑在远端"的硬证据；
  ② `git.blame Project.toml 1-5` → 真实作者/时间（`+08:00` 偏移）/中文 summary，且同一 commit 的后 4 行复用首块信息
  （porcelain 语义在真实数据上成立）；③ `git.diff-head` 返回 `{diff:"\n"}` —— 与**既有** `git.diff` 对同一干净文件的返回
  完全一致，说明多出的那个换行是远端运行器的既有归一，不是 0.25.0 新端点引入的；④ `fs.createFile` 非法名 → 400 +
  `bad-request`（上游文案）；正常创建 → 200，文件**真的在远端**（SSH `stat` 0 字节）且**本地镜像里没有**（只写远端）；
  同名再建 → 409；⑤ `changes` 27→28→27 与**我用自己 SSH 数出来的 27/28/27 完全一致**（`countStatusEntries` 口径正确）；
  ⑥ `fs.remove` 往返后远端文件消失、镜像干净、git HEAD/分支/worktree 列表未动。
  **验证纪律**：插件报告 ≠ 事实 —— 写完必须用**自己的 SSH**独立核对，核对完清理到原状（远端 status 计数与
  `git rev-parse HEAD` 都要回到初始值）。
  **找"活的" sessionId 的办法**：`<DSH_HOME>\sessions\--<workspace-slug>--\` 下的目录名即历史 sessionId，
  但只有**宿主注册表里仍在的**才可用 —— 探测方式是发一次只读的 `git.worktrees`：能解析的返回远端路径，不能解析的
  **如实报错**（"无法确定会话工作目录…"），这本身也是 2.4.27"绝不猜 `process.cwd()`"的行为。
  **⚠️ 远端判定只认"正好放着 `.remote-ssh.json` 的那一级目录"（实测，未来加固的候选）**：
  `readRemoteInfoSync(p)` 的实现就是 `JSON.parse(readFileSync(join(p, ".remote-ssh.json")))` —— **不向上遍历**。
  真实客户端总带有效 `sessionId`，而会话 cwd 就是**镜像根**，所以永远命中；但**回退路径**（取不到会话 cwd 时改用
  `payload.path` 判定）只有当客户端给的正好是**工作区根**（或某个自带 `.remote-ssh.json` 的目录）时才命中。
  实测：假 sessionId + 绝对**文件**路径 → `fs.remove` 落进**本地分支**，报 `400 ENOENT … lstat '<镜像路径>'`
  （远端什么都没动 —— 是"删不掉"，不是"删错地方"）；换成真实 sessionId 后同一请求 → 200 且远端文件消失。
  风险点：若客户端带着**过期/未知** sessionId 发来镜像根**之下**的绝对路径，`fs.write` / `fs.remove` 会**静默作用于镜像**
  而不是报错 —— 与 2.4.27 修的那类"落到错误位置"同源。加固方向二选一：向上遍历找到工作区根，或在"绝对路径 + 无法确定
  会话 cwd + 该路径可能属于某个镜像"时**明确报错**；两者都要新的小版本 + 一轮真机回归。
  **✅ 2.4.29 已按"两个都做"加固（2026-10-14）**：新增 `remoteWorkspaceForPath(absPath)` —— 复用本来就有、
  只是没被 fs 判定用上的 `matchRemoteWorkspace`（它是**前缀**匹配）把任意绝对路径匹配到已注册工作区，再取该根下的
  `.remote-ssh.json`；fs 判定的两条路（会话 cwd / `payload.path`）与 `@` 引用补全都改走它。加上 `isUnderMirrorBase()`
  的明确报错分支（镜像根之下却不属于任何已注册工作区 → 读写都 400，绝不在镜像上动手）。**顺带修掉一个此前没被注意的
  映射 bug**：命中时必须以**工作区根**当 `remoteBase`，拿传进来那条更深的路径当基准会让 `localToRemote()` 少一段
  路径段（子目录会话 + 相对路径必然踩到）。教训有两条值得记住：①**同一件事有两套判定方式时，弱的那个迟早会被走到**
  （`gitContextOf` 一直用前缀匹配，fs 判定却用精确匹配，于是只有 fs 出问题）；②**"能命中"和"命中后基准对不对"是两件事**
  ——后者不会报错，只会静默把文件放到错位置，只能靠断言"远端命令里的完整远端路径"抓。测试见
  `tests/remote-workspace-root.test.mjs`（39 条断言 + 7 个变异全部被抓），判定相关的函数一律用**真实源码**、不 stub。
  **重构会让老的形状断言失效**：`fs-trees-contract` / `open-external-contract` 里 5 条断言指向被改掉的代码文本 ——
  这时要先判断"它保护的**契约**变了没有"（本次都没变，只是变量名/新增了归一这一步），再改断言指向新代码，
  **不要直接删**，也不要为了让测试变绿而放宽契约。
  **上游的路径阶梯要照抄语义**（2026-10-13 从装好的 `dsh-better-sidebar/lib/index.js` 里读出来的事实，
  举报人在 #25 的评论里也提供了同一事实）：
  `buildApi` 的 `cwdOf(payload)` 用 `requireString(payload, "sessionId")` —— **sessionId 是必填**，且把 `payload.cwd`
  当 `clientCwd` 传给 `sessionCwdOf(ctx, sessionId, clientCwd)`；阶梯是
  **会话注册表 `ctx.sessions.get(sessionId)?.header.cwd` → 客户端 cwd（`requireAbsolute()`，非绝对即 400）→
  `sessionPersistence` 持久化元数据 → `process.cwd()`**。`gitCwdOf = cwdOf + resolveWorktree(worktree)`（`worktree` 同样"从不直接采信"）；
  `ensureWorkspacePath(cwd, target)` 就是 `resolveTarget(cwd, target)`；**git 的 pathspec（`add/reset/checkout -- <path>`、
  `show <rev>:<path>`）是仓库相对路径，不按会话 cwd 归一**，别顺手"修"它们。
  两条可操作的结论：① 真实面板流量**一定带 sessionId**，所以"取不到会话 cwd 就报错"这条兜底不会影响正常客户端
  （它替换掉的 `process.cwd()` 尾级实际是死代码）；② **客户端给的 cwd / worktree 必须自己校验绝对性** ——
  `join(相对 base, 相对 path)` 拼出来仍是相对路径，fs 又会按 `process.cwd()` 解析，等于把 #25 放回来。
  本插件没有引入 `sessionPersistence` 那一级（需要上游内部 API），如实记为已知差异。
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
- **🗑️ 「先删后取」+「静默失败 × 唯一通道」= 数据丢失（issue #20，2026-10-11；纪律级）**：
  `remoteSyncDown` 曾把顺序写成 `rm -rf 镜像 → tar 拉取`，于是**删除发生在任何成功证据之前**。
  单独看这只是"失败后镜像空了、重跑一次就好"；真正致命的是它旁边的**静默失败**：agent 的 `write`
  超过 `MAX_BYTES`（4 MiB）时**本地镜像写入已成功**、`remoteWriteFile` 拒绝推送，宿主侧只打一行
  `warn`（模型与用户都看不到）—— 于是镜像里躺着一份**只存在于本地**的成果，下一次 sync（哪怕随后
  失败）就把它永久删掉，而且全程没有任何提示。issue #20 的作者用一个 46 G 的"代码 + 数据集"混合根
  把这条路径讲透了（他还特意区分"真实函数 + 真实进程的实测"与"46 G 规模的推断"）。固化成六条纪律
  （实现：`probeRemoteBytes` / `swapMirrorDir` / `scanMirrorOnly` / `sweepStaleSyncDirs` / `runTarPipe`）：
  1. **破坏性操作排在最后**：删除/替换之前必须已经拿到了成功证据。这里的顺序是
     *体积哨兵 → 解包到临时目录 → 比对 → 原子替换*；任何一步失败都保留旧状态，错误信息里明说
     "本地镜像未改动"。**测试断言的是「rm 调用序列为空」**，不是"报错文案里有某句话"。
  2. **静默失败要有出口**：只在日志里 `warn` 的失败，必须在**模型可见**的地方留下痕迹（工具描述、
     下一次同工具调用的返回值、或写进镜像的说明文件）。"副作用已落地但调用方不知道"是最危险的状态。
  3. **唯一通道要当心**：镜像自 2.0.0 起是**单向出站缓冲区**（没有其它 remote→local 通道），
     于是 `sync` 成了唯一回拉手段，也成了唯一的删除入口 —— 唯一入口上的破坏性语义必须自带护栏。
  4. **量了再删**：`du -sb -c -- <本次范围>`（带预算）→ 超限/超时/不可解析一律拒绝 + `force` 逃生门。
     保守方向永远是"多要一个参数"，而不是"替用户决定删掉什么"。⚠️ 探测范围要**跟着 paths 走**，
     否则"我只想同步 src"会被整根的 46 G 误伤。
  5. **"本地独有"要能被识别**：整树替换前比对镜像与拉取结果，命中就拒绝并回传清单（`onlyMirror`），
     同时排除插件自有文件（`.remote-ssh.json` + 按**首行指纹**识别的占位 README）—— 否则每次同步都
     误报，护栏很快会被用户当成噪音而绕过。
  6. **回滚路径也要写清楚**：`swapMirrorDir` 失败会先删掉半成品再把旧目录 rename 回来，若连回滚都
     失败，错误信息必须给出旧目录的**绝对路径**（数据还在，只是挪了地方），不能只说"替换失败"。
  7. 附带一条实现经验的坑：**超时定时器不要 `unref()`** —— 这个 bug 是新测试抓到的：`unref` 过的
     定时器在事件循环空转时会被跳过，而"两端进程都卡住、没有其它句柄"恰恰是最需要它触发的场景
     （旧实现连墙钟预算都没有，46 G 拉取只能杀进程）。
  8. 举报人自己做了一版本地补丁（四个入口统一 deny-by-default + 环境变量放行）。回复时明确说明
     正式修复**不需要**那套环境变量（默认就有哨兵），并把他的思路（临时目录 + 原子替换、体积哨兵、
     范围下推、push 白名单）落进实现 —— 举报人给出可用方案时，优先评估并入而不是另起一套。
- **🧩 argv 是有语法的：`-o` 与它的取值之间不能插任何东西（issue #21，2026-10-11；纪律级）**：
  终端 wrapper 曾用**位置插入**给 ssh 加 ProxyJump ——
  `args.splice(2, 0, '-J', j.proxyJump)`，而索引 2 正好是 `-o`（索引 1）的下一个位置，于是命令行成了
  `ssh -tt -o -J jump-host StrictHostKeyChecking=no …`：ssh 把 `-J` 当成 `-o` 的关键字（关键字比较前
  小写化 → 报文里显示 `-j`）→ `command-line line 0: no argument after keyword "-j"` → **退出 255**，
  只要连接填了 ProxyJump，内置终端就永远打不开（2.4.18 起就坏了，一路发到 2.4.20）。四条纪律：
  1. **顺序构造，不要位置插入**：`push` 出一段一段的"选项 + 取值"（或 `[opt, val]` 数组再摊平），
     永远不要用 `splice(固定索引, …)` 往别人的对子里塞东西 —— 索引会随上下文漂移，而报错发生在
     ssh 那边、离现场很远（用户只看到 255 与一句让人摸不着头脑的 `no argument after keyword "-j"`）。
  2. **每个选项都要有配对断言**：`for (i) if (args[i] === '-o') assert(args[i+1] 含 '=' 且不以 '-' 开头)`。
     这类不变式写一次就能守住后续所有新增选项（本次同时覆盖了 `-J` / `-p` / `-i`）。
  3. **让真实工具当判据，而不是自己解释规则**：`ssh -G <argv>` 只解析命令行与 config、**不建立连接**，
     于是"这串 argv 合不合法、ProxyJump 有没有真的生效"可以在离线、无凭据、无网络的情况下由 ssh 自己回答
     —— 断言 `ssh -G` 的 exit 0 与转储里的 `proxyjump jump-host`；再配一条负向控制（把 `-J` 插回坏位置，
     同一判据必须失败并复现原报文），证明判据本身有牙齿。本机 `OpenSSH_for_Windows_9.5p2` 与举报人同版本，
     复现出的报文**逐字节相同**。
  4. **测试断言了文件 ≠ 覆盖了分支**：`tests/wrapper-terminal.test.mjs` 早就把 wrapper 的 argv 断言得
     很细（`-tt`、端口、密钥、`user@host`、远程命令），但**没有任何场景设置 `proxyJump`** —— 分支没被
     走过，坏形状就一路绿灯。凡"由输入组合决定的 argv"，每种组合都要有场景；缺哪种组合，就在测试里
     显式列出来（本次补了 3 个 proxyJump 场景 + 1 条结构不变式 + 1 条 ssh 离线判据）。
  5. 找同类问题的手法：`Select-String -Pattern "splice\(|'-o'|StrictHostKeyChecking"` 把全仓 argv
     拼接点列出来逐个核对 —— 本次确认插件自己的 `sshArgv()`（`opts.push("-o","ProxyJump="+…)`）写法正确，
     只有 wrapper 这一处坏了，这也正好解释了举报人"模型工具正常、只有终端不行"的观察。
- **🧷 同一个 helper 不能跨 shell 边界（issue #22，2026-10-11；纪律级，issue #21 的第二天又犯一次同类错）**：
  `syncTarExcludes()` 用 `shellQuote()` 把排除模式包成 POSIX 单引号。**sync 方向**这是对的（结果被拼进
  **远端命令字符串**，要由远端 shell 解释）；**push 方向**同样的字符串作为 **argv 元素**交给本地 tar，
  argv 不经 shell —— 引号成了模式的**字面字符**，于是 `--exclude='./x'` 匹配不到 `./x`，
  **所有排除静默失效**：`.remote-ssh.json`（含 host/user/keyPath/remotePath）与占位 `README.md`
  真被解到了用户远端根，2.4.20 CHANGELOG 里"连接信息绝不推到远端"的承诺当时是假的。
  举报人（SundaeYAGO）用真实 bsdtar + 插件生成的精确 argv 复现，还给了 A/B 对照与修法。六条纪律：
  1. **按语境分叉，不要"顺手复用"**：同一个逻辑产出物要喂给「shell 命令字符串」和「argv 数组」时，
     必须显式区分（`forShell` 开关之类），并在注释里写清哪边是哪边 —— 这是 issue #21（argv 位置）
     与 #22（argv 引号）连着两天踩到的同一类边界。
  2. **静默失效比报错危险得多**：`GNU tar` / `bsdtar` 对"不匹配任何成员"的 `--exclude` 都 **exit 0**、
     无任何提示；`ssh` 那边则是 255 + 一句看不懂的报文。凡"外部程序按自己的语法解释我们的字符串"的地方，
     都要有**真实工具端到端**的断言，而不是只断言我们拼出来的字符串。
  3. **冒烟测试必须消费"生成出来的 argv"**：2.4.20 我自己做过 tar 冒烟，但 argv 是**手打**的（正好写成
     正确形态），于是假阴性放行 —— 正确做法是捕获真实 spawn 的 argv 再喂给真实 tar（本次 H-A 段）。
  4. **断言产物 ≠ 断言行为（两天内第二次）**：#21 是"测试覆盖了文件却没覆盖分支"，#22 是"测试把 bug
     的形状一起断言了"（D/F 段原本断言 `--exclude='./x'` 带引号）。新写的断言要问一句：**如果这段代码
     坏了，这条断言会不会照样通过？** 会的话它就不是回归测试。
  5. **泄漏类缺陷必须配负向控制**：不仅要断言"现在不漏"，还要证明"判据能抓到漏"——把模式重新加引号，
     同一判据必须判失败并复现旧行为（本次实测 bsdtar 3.8.8 确实漏）。
  6. **善后要写进 release 与回复**：已经泄漏到用户远端根的文件不会自己消失，发布说明里要给"自查自清"
     步骤（对比 size、删掉多出来的两个文件），别只写"已修复"。
- **🔤 「同一份字节流，两端对名字该怎么解码」的默认假设不同（issue #22，2026-10-11；与上面那条互为姊妹篇）**：
  Windows 上的 `remote_ssh_sync` 把 `报告_2026Q1.csv` 拉成 `鎶ュ憡_2026Q1.csv` —— **内容完好、exit 0、
  stderr 为空**，七天后才被用户发现。三方各自都没写错代码：远端 GNU tar 对较短的非 ASCII 名写的是
  **纯 ustar 头**（`typeflag='0'`、GNU magic `"ustar  \0"`、名字字段直接放裸 UTF-8 字节，无 PAX、
  无字符集声明），Windows 自带的 bsdtar 3.8.8 按**本地 ANSI 代码页**（CP936）解码该字段，而那个构建
  **不支持 `--hdrcharset`**。修法是让远端改输出 PAX（`path=` 记录携带 UTF-8 名，bsdtar 会优先采用），
  并用**能力探针**（`tar <我们的参数> -cf /dev/null /dev/null`，exit 0 = 支持，不遍历任何目录、按 profile 缓存）
  而不是猜版本号。五条纪律：
  1. **"静默的字节级差异"只能靠真实工具链路复现**：这类 bug 不会报错、不会改变文件内容、本地
     tar↔tar 往返也测不出来（两边都用同一个"错"的假设就自洽了）。必须让**真实的两个版本的工具**
     各站一端（本次：WSL 里的 GNU tar 1.35 当远端、Windows 的 bsdtar 3.8.8 当本地），中间跑**真实实现**。
  2. **合成 fixture 可能是错的，真工具才是 oracle**：我先手搓过一个 PAX 头，记录长度算错（写成
     `recBytes + digits + 2`，正确是 `digits + 1 + recBytes`）导致 bsdtar 报错；改用**真 GNU tar 产出的
     归档**当素材后才得到可信结论。凡"我想验证某个格式"的场合，先问一句"能不能让真工具生成它"。
  3. **能力探测优于版本判断**：`--format=pax` 与 `--pax-option=...` 是两个独立能力（macOS 的 bsdtar
     有前者没有后者），所以探针是两级阶梯，逐级降级并缓存；探测失败时**明确告知后果**
     （Windows 上会乱码、请升级远端 GNU tar），而不是静默退回旧行为。
  4. **优化项要量，不要猜**：`--format=pax` 默认给每个文件都写 `mtime`/`atime` 记录（301 个 200 B 文件的
     树 +97%），但加上 `delete=atime,delete=ctime,delete=mtime` 后 GNU tar 只为**真正需要**的条目写扩展头
     —— 实测体积与 ustar 逐字节相同。没有这组测量，就会在"修乱码"与"膨胀一倍"之间做无谓取舍。
     同理，"只在 Windows 启用"这个门控也是**量出来的**而不是猜的：WSL 里 `LC_ALL=C tar xf` 解同一个
     GNU-magic 归档，名字字节仍是 `e6 8a a5 …`（原样透传），说明 Linux 的 GNU tar 不看 locale 转换字节 ——
     乱码需要一个**主动往遗留代码页转换的读者**（Windows 的 bsdtar），所以门控是 `process.platform === "win32"`
     而不是"非 UTF-8 locale 就启用"。想当然地按 locale 判断会白白给所有 Linux 用户改成 PAX。
  5. **旧数据要给出路，但不能借"修复"之名删东西**：乱码名是**已经存在**的镜像内容，识别它需要把
     "正确名 → GBK 改写"反过来配对（Node 没有 GBK 编码器，所以是**正向**算 `mojibake(新树名)` 再去镜像里找），
     且只在**本来就要拒绝**的那条路径上扫描（日常同步零成本）。删改必须显式（`repairNames: true`），
     且**只有全部**镜像独有文件都被证明是乱码名时才放行 —— 混着真·本地独有文件时依旧拒绝。
     另外：乱码名里可能出现**私用区字符**（本次实测 `\uE0BC`），别指望用户能手打或复制粘贴去改名，
     插件必须给出自动通道。
  6. **改了长期存在的命令形状要顺手纠正不规范处**：`tar cf -` 的"无横线旧式选项"只在**首参**生效，
     前面一旦有长选项（`--format=pax`），`cf` 会被当成文件名并报
     `You must specify one of the '-Acdtrux'…`（实测 1.35）。带横线的 `-cf` 才同时满足"可组合"与 POSIX 风格。
- **🪟 「宿主是进程内服务，不代表它的契约对我们透明」（issue #23 / #24，2026-10-11；同一个举报人连报两条）**：
  #23 是 wrapper 裸调 `node`（桌面端按设计不给子进程 PATH 装 node，于是集成终端 100% 打不开）；
  #24 是写回桥推送失败只有一行宿主日志（模型以为远端已有文件）。两条都不是"我们代码写错了"，
  而是**对宿主契约的假设没被验证**。五条纪律：
  1. **"裸名"就是隐含的 PATH 依赖，能换成绝对路径就换**：同一份 wrapper 里 `ssh` 早就用
     `sysSsh` 绝对路径 + 回退（理由是"避免解析到 MSYS2 的 ssh"），`node` 却一直裸名 —— 同类问题
     在同一文件里共存了十几个版本。`process.execPath`（**正在运行本插件的那个解释器**）是最可靠的
     来源，不需要任何宿主耦合；只在文件名形如 `node`/`node.exe` 时采用（Electron 主进程的 execPath
     指向 app 本体，拿它拉起只会再开一个 DSH 实例）。
  2. **不要猜宿主的私有目录**：举报人明确不建议"直接探测 DSH 自带 runtime 的绝对路径"（那要官方点头），
     正确形状是"用户显式给的路径 > 我们自己的解释器 > PATH"，再加一条**可操作的错误**（说明是本插件的
     终端、为什么桌面端没有 node、怎么配）与 127 退出码，而不是把 cmd 的原文糊给用户。
  3. **模型可见性是宿主契约问题，先查打包产物再设计修法**：举报人建议"在 `ctx.fs.writeText` 的返回值上
     附加字段"，听起来最干净 —— 但 `write` 工具的 output schema 是 `additionalProperties: false` 且只声明
     `path`/`operation`/`before`/`after`，`execute` 自己重建返回对象，成功渲染还是固定信封
     （`<path>/<type>/<content>`）。**结论：成功结果里塞不进任何警告**，本版唯一可用的通道就是工具报错。
     查法（不需要源码仓库）：`app.asar` 是文件不是目录，按 asar 格式读头部 JSON + 按 offset 切片即可
     （本次脚本在 `%TEMP%\asar-tool.mjs`）；`remediateFsError` / `sandbox.mapError` 对非 `FsError`
     **原样透传**，所以自定义 `Error` 的消息能一字不差地到模型。
  4. **确定性失败优先"消灭"，而不是"上报"**：`MAX_BYTES`（4 MiB）让写回桥在大文件上必然失败 ——
     与其把失败报给模型，不如按 3 MiB 分块（3 的倍数 → 非末块 base64 无 padding，可直接拼接；
     **先编码成 Buffer 再切字节**，按 JS 码元切会劈开代理对）追加 + `wc -c` 校验完事。
     上报留给真正不可预测的失败（断连、权限、配额）。
  5. **验收判据用"失败点后移"这类可判定的现象**：本次两条都好用 —— 终端那条是"给一个干净 PATH 直接跑
     **真实生成的产物**，失败点必须从『找不到 node』后移到 ssh（退出码 255）"，且配一条**负向控制**
     （把旧形状放回同一环境，必须复现 `'node' is not recognized`）；写回那条是"旧路径对 7 MiB 必须是
     确定性失败、新路径必须成功且拼接字节逐字节相同"。**别用"我构造的错误文本里有没有某个词"当断言** ——
     那只能证明测试写得对，证明不了实现（本次先犯了一次，改成断言源码里的真实文案）。
  6. **测试环境的两个坑，顺手记下**：`PATH=/nonexistent` 时 `#!/usr/bin/env bash` 自己就起不来
     （`env` 要靠 PATH 找 bash），所以验证"薄壳不依赖 PATH"要显式 `PATH=/nonexistent /bin/bash 脚本`；
     Windows 的 `ssh.exe` 在 stderr 是管道时会把报文写到**控制台**，`spawnSync` 捕获不到（真实终端是 pty，
     用户照常可见）—— 这类"测量方式造成的假象"要写在注释里，免得以后有人"顺手修好"。
- **📦 装给自己用也要走一遍沙箱（2026-10-11，2.4.24 发布后当场更新本机 desktop profile）**：
  发布 ≠ 能装。DSH Desktop 的插件管理器用自带 pnpm（本机 11.7.0）跑 profile 内的安装，且带
  **24 小时** `minimumReleaseAge` 供应链策略 —— 刚发布的版本必然被拒。四条纪律：
  1. **先沙箱，再动真 profile**：在 `~/.dsh/profiles/<临时名>` 里放一个只有该依赖的 `package.json`
     ＋ `pnpm-workspace.yaml`，用自带 node 跑 `runtime\pnpm\bin\pnpm.cjs install`（本机 787 ms 装完），
     确认版本、文件清单、以及**与仓库 HEAD 逐文件 SHA256 一致**，再动真 profile；事后删掉沙箱目录。
  2. **A/B 两组都要跑**："不加放行 → 必须被拒（`ERR_PNPM_NO_MATURE_MATCHING_VERSION`）"＋"加放行 → 必须装成"，
     否则无法区分"策略真的生效"与"策略根本没被应用"。本次 A 组的拒绝报文里的发布时间戳
     （`2026-10-11T15:05:29.155Z`）还顺手校对了 npm 的发布时刻。
  3. **`minimumReleaseAgeExclude` 的两种写法语义不同（pnpm 11.7 实测）**：`名@版本` 只被 **lockfile 校验**
     匹配（所以 profile 里那条 `…@2.4.19` 能通过启动校验），而**解析新版本**这条路径只认**纯包名**
     —— 钉住版本时，卸载旧版装新版会直接失败，日志看起来像"放行没写"。要么用纯包名（本次采用，
     代价是该包不再受 24 小时窗口保护），要么安装时用 `--config.minimumReleaseAge=0` 临时关掉策略。
  4. **收尾要按宿主的真实口径复验**：更新完再跑一次
     `pnpm install --frozen-lockfile --config.minimumReleaseAge=1440`（等价于 DSH 每次启动的校验），
     必须 `Already up to date` ＋ 退出码 0，否则下次启动会被策略拦下、插件直接不加载。
     另外：`resources\runtime\bin\node.cmd` 的内容就是 `"%DSH_DESKTOP_NODE_EXECUTABLE%"` ——
     那个环境变量在子进程里缺席时它展开成一对空引号（`'""' is not recognized`），
     这是 issue #23 的现场实证，也说明"用自己的 `process.execPath`"是唯一不依赖宿主私有约定的来源。
