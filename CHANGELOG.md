# Changelog

本文件的版本号与 `package.json` 的 `version` 保持一致。每个版本对应一个 Cordis Package 快照（`pkg-N`）。

## [2.4.35] — 2026-10-20

### 内置预览读不到"只在远端存在"的文件（issue #29，举报人 zijun-T）

远程工作区里「文件」页签能列远端、右键下载正常、编辑器打开也正常，唯独点某个文件「预览」报 **「文件不存在，可能已被移动或删除」**；同一路径右键下载拿到的内容却是对的。举报人自己把根因定位到了：那句文案来自**内核内置**的 `dsh-client-ui-sidebar-documentpreview`，它把 `workspace-file/not-found` 映射成这句话；而提供该码的 `dsh-api-workspace-files` 的全部 I/O 都走进程内的 `ctx.fs`（`resolve` / `lstat` / `stat` / `readBytes` / `readByteRange` / `streamText` / `listDir`），它的 `workspaceRoot` 取的是**本地镜像目录** —— 镜像里没有的文件，`lstat` 就返回 `undefined`，`locateFile` 随即抛 not-found。预览走 RPC 而不是 `/sidebar/*` HTTP 路由，所以 2.4.27 / 2.4.28 那套 `exact` 路由拦截**够不着它**（与 #10 的 `fileReferences` 同属"进程内服务"这一面）。一句话：**这是 #15「read 仍读镜像」在内置预览上的另一面**，不是路径解析 bug。

修法即举报人建议的方案 1：给 `ctx.fs` 的读方法加一层**影子**，原则是「**本地优先，本地缺失才回远端**」。

- 每个包装方法**先调原实现**：`stat` / `lstat` 有结果、读方法没抛错，就原样透传 —— 本地工作区、镜像里已有的文件、沙箱围栏、错误码、版本号全部保持旧行为（零回归；`tests/fs-read-bridge.test.mjs` 用假 fs 断言"本地有 → 一次远端调用都没有"）。
- 只有"本地不存在"（`stat` / `lstat` 返回 `undefined`、读方法抛 `FS_NOT_FOUND` / `ENOENT`）才回远端取：`stat` / `lstat` 用**一次往返**的条目探测（类型 + `size:mtime`，符号链接单独给 `symlink`），整文件读复用既有的合并读命令（base64 载荷 + stat 帧），区间读复用 `fs.readPage` 那条 `tail -c` 窗口命令，目录列举复用 `remoteListDir`（命中 treeCache，不多花往返）。
- 远端也没有时**原样返回原实现的结果 / 抛原实现的错**，绝不伪造"存在"；确实是远端文件时才合成 `FsTarget`（WeakSet 标记），`contains` / `processPath` / `fileUrl` 对合成 target 走 `displayPath`，不把伪造的 key 递给原生后端（`workspace-file` 的目录围栏因此不会误杀）。
- 错误码与后端同一套：二进制 → `FS_NOT_TEXT`、超 4 MiB → `FS_TOO_LARGE`、连接失败 → `FS_IO_ERROR`、已取消 → `FS_ABORTED`。
- 与 2.4.14 的写桥各包各的方法、互不覆盖；两者的恢复函数都做"当前函数是否仍是我自己的包装"的身份校验。

仍未覆盖（已写进两份 README 的「已知限制」）：① 远端被改动、而镜像里也有旧版本时读到的仍是**镜像**那份（本地优先；`remote_ssh_sync` 重拉即最新）；② `ctx.fs.watch` 对远端影子是空实现，远端变更**不会**触发实时刷新，预览不会自动跟新；③ 远端整文件读受 4 MiB 单次上限约束。

复现与验证：举报人的自查命令（远端 `ls` 有、镜像 `ls` 没有）+ 代码路径核对（documentpreview → workspace-file RPC → `ctx.fs` → 本地 fs-sandbox）。**本机拿不到 GUI 的 token URL，无法自动点预览**，所以真机验证由重启后的宿主 + 举报人复核补上（届时把实据追加到 `MAINTENANCE.md` §0，格式同 2.4.33 / 2.4.34）。

回归测试：新增 `tests/fs-read-bridge.test.mjs` **87 条**（A 条目探测命令与标记解析；B 读取器三态 / 整读 / 区间读 / 列举 / 连接异常；C 桥的本地优先、远端兜底、合成 target、错误码、安装恢复；D 接线与包装方法集合覆盖 `workspace-files` 实际调用的 12 个方法）。全量 **33 文件 / 1851 通过 / 0 失败**。

## [2.4.34] — 2026-10-20

### 同步范围终于有了 GUI 入口（issue #28，举报人 yanghuan）

`syncPaths` / `syncExclude` / `syncMaxBytes` 是 #20 就落地的**后端**能力：schema 有字段、`updateWorkspace` 能写、`syncOptsFrom` 有「逐次参数 → 工作区字段 → 全局默认」三级回退。但**客户端一个入口都没有** —— 设置面板只管 `writeBack` / `writeBackExclude`，「添加工作区」固定只传 `profileId + remotePath`，于是新工作区永远是 `syncPaths: []`。后果不是"少个功能"，而是把安全阀变成陷阱：`remotePath: ~` 的工作区空范围 = 整树 tar，2 GiB 体积哨兵当场拒绝；用户只能每次直调 `POST /remote-ssh/api/updateWorkspace`、或手改 `cordis.patch.yml`（举报人两条都试过，都是应急）。本次四项：

- **工作区卡片：同步范围 / 同步排除 / 体积上限**三个输入框（体积界面按 GiB 填，宿主存字节）。保存仍是**一次** `updateWorkspaceGuards` 原子写 —— 写回护栏与同步范围一起落库，不会只改一半。语义：`undefined` = 不动、`[]` / `0` = 显式清空（回到整树 / 内置 2 GiB）。
- **「添加工作区」弹窗：可选同步范围**。只传非空值；留空交给「全局默认」，再留空才是整树 —— 建区即定范围，不必建完再补一遍。
- **全局默认（进阶设置）**：`defaultSyncPaths` / `defaultSyncExclude` / `defaultSyncMaxBytes` 进 `PrefsSchema`，`savePrefs` 白名单扩展、`getPrefs` 回读；三个 settings face（新版 `describe` / 旧版 `register` / 只读 `config` 兜底）的 `read()` **都**回这三个默认值 —— 少一处就会在旧版 DSH 上显示成空。
- **手动「⬇ 同步 / ⬆ 推送」按钮**：复用已有 `syncDown` / `syncUp` 端点（走该工作区的持久化范围），把 client 里闲置已久的 `sync.*` 文案接上。同步/推送是显式点击，不必"叫模型跑一下"。**不新增任何路由**（接管清单仍是 31 条）。

### 归一化：一处拆分、一处解析，不让脏值进 tar 命令行

新增两个纯函数并在宿主所有入口统一使用：

- `normalizeSyncList`：数组或「逗号 / 换行 / 分号分隔」整串 → `trim` + 去空 + 去重。**空串必须丢** —— `tar --exclude=""` 会命中一切，这是 #20 踩过的坑；重复项只会让命令行无谓变长。
- `parseSyncMaxBytes`：字节数，或 `2 GiB` / `512MB` / `1.5GiB` 这类带单位写法（`GiB` 走 1024、`GB` 走 1000）；非法 → `null`，由调用方回落默认。

`updateWorkspace` 也改走同一套（原来的 `parseInt("2 GiB")` 会得到 `2` 字节）。手调 HTTP 传整串、传数组、传带单位字符串，都不会写进脏数据。

### 兼容性

老配置没有这三个字段 → schema `default([])` / `default(0)` = **旧行为不变**（整树 + 内置 2 GiB 上限）。所有新逻辑只在「传了值」时生效；`updateWorkspaceGuards` 既有调用方（只传 `writeBack` / `writeBackExclude`）行为完全不变。

### 回归测试（新增 84 条；全量 1763 通过 / 0 失败）

`tests/settings-sync-scope-ui.test.mjs`：①归一化与解析的**行为**（抽真实函数跑，不是看代码里有没有写）；②schema 与三个宿主入口（含「只有传了才写」的负向控制）；③三处 `read()` 都回默认值；④客户端控件 / 弹窗 / 手动按钮 + 中英文案各恰好一份；⑤`splitList` / `bytesToGibText` / `gibTextToBytes` / `prefsForUi` 的行为。**G 段把 `updateWorkspaceGuards` / `savePrefs` 的真实函数体抽出来、注入假 `settingsFace` 执行** —— 验到 `syncPaths` 真的落库（trim + 去重 + 拆整串）、`undefined` 不改原值、`[]`/空串清空、乱填体积归 `0`（不写 NaN）、工作区不存在报错、白名单外的键不写。`tests/settings-compat.test.mjs` 同步把两个新 helper 纳入 `eval` 沙箱 —— 漏了会整文件 CRASH（本次已修）。

### 复现证据（对运行中的 2.4.33 宿主，只读 + 一次无副作用重写）

`POST /remote-ssh/api/listWorkspaces`：3 个工作区的 `syncPaths` / `syncExclude` 全为 `[]`、`syncMaxBytes` 全为 `0`（即全部整树同步，与举报人描述一致）。对其一发 `updateWorkspaceGuards` 并显式带上 `syncPaths: [".dsh"]` / `syncExclude: ["data/"]` / `syncMaxBytes: 1048576` → 返回 `ok:true`，但回读**三个值分毫未变**：旧构建静默忽略这三个字段。⚠️ 探针注记：该接口返回 `{"ok":true,"value":{…}}` **信封**，直接读 `body.workspaces` 会误判成「0 个工作区」（第一次探测就是这么错的，与 §0 记录的同一个坑）。

## [2.4.33] — 2026-10-17

### 性能：远程打开目录/文件的耗时治理（实机测量驱动）

运行中宿主 + 远程工作区（超算登录节点，高延迟公网链路，大仓库）的实测画像：热目录列举 **30ms**、热文件读取 **~150ms** 都很快；慢感来自三处 —— **远端 `git.status` 每次 1.6~3.7s**（大仓库 `status --untracked-files=all` + 两条全仓 numstat），而 0.28.0 客户端在文件操作后会 invalidate→立即重取同一仓库，把共享 SSH 会话队列堵死；**空闲 10min 关断会话**后下一次点击要重新付 ~1.7s 握手；高延迟链路上传输无压缩。本次四项修复（`tests/perf-remote-open-2433.test.mjs`，22 条断言 + 2 条变异负向控制）：

- **`git.status` 响应缓存（5s TTL + epoch 感知，仅远端分支）**：同仓库重复请求 0 RTT；任何写/删/移/exec/git 变更都 `bumpCacheEpoch` → 立即失效，缓存只在「没有任何写动作」的窗口内生效（与 readCache/treeCache 同一纪律）。本地分支不缓存（本机 git 是进程内子进程，本来就不是瓶颈）。
- **numstat 短路（远端脚本）**：status 没有任何 tracked 变更（干净仓库 / 只有未跟踪文件）时，两条全仓 `git diff --numstat` 输出必然为空却各扫一遍整个工作树 —— 直接跳过，与本地实现 `pathspec=[]` 短路同口径。⚠️ N 计数必须在 `cat; rm` 之前 —— 这个时序 bug 是真 sh 验证逮住的（见下）。
- **`git.*` 专用池化会话**：`runPooled`/`getSession` 增加 role 参数，status/graph/通用 git runner 走 `profileKey|git` 独立会话 —— 大仓库的数秒级 git 命令不再让点击目录/文件排队等它，代价是每个 profile 多一条按需建立、同受 ServerAlive 保活的连接。
- **非 tty SSH 连接开启内建压缩（`Compression=yes`）+ 空闲窗口 10→30min**：文件树/文件读取的 base64/文本载荷在高延迟公网链路上压缩收益显著；tty 交互终端保持默认。空闲窗口拉长减少「回来点两下就重付 1.7s 握手」，死连接由 ServerAlive 90s 探活 + 255 重建兜底。

### 独立验证：真 sh + 真 git（16 条断言，含一个被逮住的真实 bug）

`scripts/verify-remote-status-script.mjs`：WSL 真 `sh` + 真 git 2.43，真实现 `gitStatusRemote` + 真解析器（只把 `runPooled` 换成 `wsl -e sh -c`）。干净仓库（段缺席 → 空 entries 且分支身份齐全）、脏仓库（真 numstat 行数经真 sh 分段逐条对上：暂存 +1/-0、未暂存 +3/-1、真改名 origin、未跟踪无行数）、只有未跟踪（tracked=0 → 段缺席）、PATH shim 让 status 全变体失败（`$T` 不存在 → `${N:-0}` 兜底不炸）、非 git 目录/不存在的目录 → `isRepo:false`。**第一版脚本把 N 计数放在 `cat; rm` 之后**，`$T` 已删导致短路退化成"总是短路"、脏仓库行数全丢 —— 单测（伪造 SSH 出口）查不出这种运行序问题，真 sh 验证立即红，修正后全绿。

## [2.4.32] — 2026-10-17

### 兼容：better-sidebar 0.28.0（新增 `git.graph` 提交图端点 + `git.status` 响应形状漂移）

上游 0.28.0 的 HTTP 派发表从 42 个方法增加到 43 个，**唯一新增的是 `git.graph`**（0.28.0 新增「Git Graph」提交图面板的取数端点）；另有一处**已接管端点**的响应形状漂移（`git.status`）。这两件事都不会报错，只会静默给出旧/空的仓库视图 —— 与 2.4.18 / 2.4.28 修的是同一类问题：**没被拦截的端点会落在本地镜像上**。

- **新增接管 `git.graph`**（`GIT_METHODS` 18 → 19 项）。
  - 入参 `{branch?, count?, cursor?}`：`branch` 必须是 `refs/heads/…` / `refs/remotes/…` 全名；`count` 安全整数且 ≥1（内部上限 200）；`cursor` 是 `base64url(JSON{version:1,fingerprint,offset})`。返回 `{isRepo, root?, entries[{hash,hashFull,parents,author,date,subject,message,refs}], branches[{ref,name,hashFull}], hasMore, nextCursor?, snapshot}`。
  - 分页游标锚在 **sha256 快照指纹**上（`for-each-ref` + `HEAD` + `symbolic-ref`，日志前后各取一次）：分页期间历史变了 → `graph-stale`（**HTTP 409**）；分支 >1000 或翻页越过 10000 → `graph-limit`（**400**）。这些 HTTP 码与上游逐条一致（此前本插件把业务错误一律映射 500）。
  - **远端分支**把 `root` 回映射成本地镜像路径：客户端把它当 `repoRoot` 用（`client.js` 里与树根标签比较），返回远端绝对路径会让它落到另一个分支上。远端仓库根在会话目录之下 → 映射成镜像内的对应子目录；在会话目录之上（工作区是仓库子目录）→ 退化成镜像根，保证跨页稳定。
  - **测试**：新增 `tests/sidebar-0280-git-graph.test.mjs`（**79 条断言**）：本地分支逐条比对实参与返回形状（含 `%x00` 日志解析、装饰、`count` 上限、游标往返、指纹过期、未知分支、>1000 分支、非仓库、空仓库、`offset+limit>10000`）；远端分支验证**只发远端、一次分页恰好 2 次 SSH 往返**、命令带只读环境、`root` 三种映射；最后用一个**真实临时 git 仓库**做端到端（真 `git log` 解析、真分页闭环、真过期检测、真空仓库、真非仓库目录）。

- **`git.status` 对齐 0.28.0 的响应形状**（本插件**已经接管**这个端点，所以此前是静默降级：既不报错也不提示）。
  - 取数从 `--porcelain=v1 -z` 换成上游同款 `status --porcelain=v2 --branch --ahead-behind -z --untracked-files=all`，并补齐 0.28.0 新增字段：`upstream` / `ahead` / `behind` / `detached` / `operation`（`merge` / `rebase`，按 `.git` 目录状态判定），以及条目级 `staged` / `unstaged` 行数（两条 `diff --numstat`；上游口径是**绝不合并**，因为合并会重复计行）、`truncated`（>2000 条截断）。
  - **有意差异（健壮性）**：`--ahead-behind` 需要 git ≥ 2.41，远程主机（尤其超算登录节点）可能更旧。本插件依次降级 **v2+ahead-behind → v2 → v1**，v1 路径明确缺新字段而不是给错值，面板不会因 git 版本整体失败。
  - **远端实现改成一次 SSH 往返**（`status` + `operation` + 两侧 `numstat` 同一条脚本，`@@DSH_GS@@` 分段；含 NUL 的 status 输出先落远端临时文件再 `cat`，**不经 shell 变量**——命令替换会吃掉 NUL）。旧实现是 3 次往返且永远拿不到新字段。远端 `numstat` 不带 pathspec（整仓），结果与本地同构、只是多算一点。
  - **远端目录不在（工作区被删/改名）→ `isRepo:false`，不再 500**：原来的 `cd <dir> || exit 3` 会让脚本以非 0 退出、被映射成 `git-error` 500（git 面板弹红字）。现在脚本自己打印 `NOTREPO` / `NOREPO`，与"目录存在但不是仓库"同一口径；真正的 SSH 失败仍照旧 500（不会被这条兜底吞掉）。
  - **测试**：新增 `tests/sidebar-0280-git-status.test.mjs`（**95 条断言**）：纯解析器（v2 records/meta、改名 origin、二进制 `-\t-`、行框改名记法折叠、pathspec 的未跟踪排除与 >8000 字节兜底、截断）；本地分支（新字段、`operation` 三态、**三条降级链**、只有未跟踪时跳过 numstat）；远端分支（一次往返、脚本不捕获 NUL、NOTREPO/v1/none/SSH 失败四种结局、cd 失败必须给 NOTREPO 而不是 `exit 3`）；真实仓库端到端（真 `ahead/behind=1/0`、真改名 `origin` 与非零行数、真二进制 `{binary:true}`、真 detached、真 merge-in-progress）。

### 独立验证：真 sh + 真 git（不是只有伪造 SSH 出口的单测）

单测把 SSH 出口整个替换掉了，**脚本本身的 POSIX 正确性**（引用、标记、NUL 传输、shell 侧 `elif` 降级链）未被覆盖。本次另外在 **WSL 的真 `sh` + 真 git 2.43** 上，用真实现 + 真解析器 + 真 handler 跑了一遍（`runPooled` 换成 `wsl -e sh -c <script>`，其余一字不改），**32 条断言 0 失败**：

- 真远端 `git.status`：3 条真实状态、`a.txt` 的 `MM` 与两侧各 +1/-0、真改名 `origin=keep.txt`（证明 NUL 经 `cat` 无损）、未跟踪无行数、临时文件用完即删；
- 真远端 `git.graph`：真提交图（hash/装饰/主题）、真游标分页闭环（第二页拿到更老的提交）、`root` 回映射成镜像路径、真 sha256 指纹；
- **shell 侧降级链用 PATH shim 真验**：让 `--ahead-behind` 报错 → 脚本落到 `v2nb`；让 `porcelain=v2` 报错 → 落到 `v1` 且分支来自独立 `BRANCH` 段；
- 真非仓库目录与**真不存在的目录** → 两者都是 `isRepo:false`（不是 500）。

### 兼容：DSH 宿主 0.2.1-rc.1（信任源迁移 + peer 范围不再依赖宿主选项）

对宿主 0.2.1-rc.1（asar 182.7 MB，`dsh/package.json` 全线 0.2.1-rc.1，cordis 4.0.5，node 24.21.0 / Electron 44.7.0）做了逐 API 审计，两处需要动代码：

- **信任源迁移**：`ctx.webRuntime.trustedHosts` 在 0.2.1-rc.1 里**已不存在**（asar 全树 5,492 个文件 0 命中；同名 `WebRuntime` 类是联网搜索服务 `ctx.web`，无关）。新家是 **`ctx.webStartup.trustedHosts`**（`dsh-web-app/lib/startup.js` 的 `ctx.provide("webStartup", …)`，宿主注释写明是 "ordinary Cordis service"，无 `isolate`，宿主自己的 `webserver` / `connection` 行也是 `inject: [webStartup]`）。
  - 2.4.32 起**两个服务都软注入**：新宿主读 `webStartup`，老宿主（0.1.x）退回 `webRuntime`，两者都没有则保持 loopback-only；`trustedHostsNow()` 仍是**按请求实时读取**，服务值可被替换，无需重启插件。软注入保证任何一个服务改名/移除都不会阻塞插件挂载。
  - 这是**非回归**的既有退化：桌面端 `networkExposure: loopback`，loopback 永远通过本插件自己的围栏，本次升级前后功能都正常；受影响的是"绑定局域网 IP 但没配 `--trusted-host`"的用法（此前插件会 403，现在 `--trusted-host` 这条官方路径真正生效）。
  - **有意保留的一处更严**：宿主 0.2.1-rc.1 的 `/api` 围栏新增了"Host 等于监听绑定 IP 字面量"例外（`webStartup.host`），本插件**不跟随** —— 本插件自注册的 `webServer` 路由在宿主浏览器令牌认证栅栏之外，跟随就等于把远端的文件读写与终端能力开放给同网段。要远程访问请显式 `--trusted-host`。
- **peer 范围不再依赖宿主的 `includePrerelease`**：宿主兼容性门（`dsh-app-boot` 的 `unmetRequirements`）调用 `semver.satisfies(v, range, { includePrerelease: true })`。实测（本机 semver 7.8.5）：`satisfies("0.2.1-rc.1", "^0.2.0-rc.1")` **不带**该选项为 `false`、带上才 `true` —— 也就是"插件在 0.2.1-rc.1 上不被拒"完全依赖宿主的实现细节。三个 DSH peer 现在都显式补上 `|| ^0.2.1-rc.1`，两种判定都通过；`0.3.0-rc.1` 仍被拒（不越界声明未验证的线）。
- **其余逐 API 判定为兼容**（静态证据 + 运行中宿主只读实测）：`ctx.webServer.register`（exact/prefix 形状与重复路由 throw）、`ctx.subprocess`（实测 `testConnection` 200）、`ctx.settings`（`describe/update/configure/volatile` 齐全；旧的 `register` 回退已是死代码）、客户端 `slots`/`locale`、`defineTool` + output schema（13 个工具全部注册通过）、cordis `inject`/fiber、`workspaceRegistry`/`fileReferences`/`profileContext` 等服务键全部未变。
- **日志侧**：本次升级期间宿主有两次启动失败 crash（15:22/15:23），等待表里 `better-sidebar` 在等已消失的 `webRuntime`（0.26.1 的硬依赖）、`remote-ssh` 在等 `tools`（上游连带）；换 better-sidebar 0.28.0 并重启（15:53）后**再无 crash**，`.plugin-manager` 日志今天 0 新增，**本插件零 warn / 零 error**。
- **测试**：`tests/trust-fence.test.mjs` 61 → **68 条**（新增 B2：新源优先、旧源兜底、双缺 → 空列表、新源形状不对 → 退回旧源不抛错）；`tests/manifest-compat.test.mjs` 43 → **49 条**（已验证线加 `0.2.1-rc.1`、`TARGET` 与 `CORDIS_VERSION` 对齐实测值，并显式锁住"严格判定下 `^0.2.0-rc.1` 覆盖不到 `0.2.1-rc.1`"这条脆弱点）。

### 套件

- 全量 **30 个测试文件 / 1657 条断言 0 失败**（新增两个文件共 175 条断言 + 信任源/清单 13 条）。
- 上游漂移巡检（`.github/workflows/upstream-drift.yml`，每周一 03:00 装 upstream latest 跑对拍）此前会红：`tests/sidebar-0250-endpoints.test.mjs` 的 C9 会报 `缺: git.graph`。本次修复后该对拍恢复为 **105 条断言 0 失败**。

### 已知项（本次未改，记录在案）

- `git.status` 仍未返回上游的 `root` / `repositories`（多仓库容器发现）：这是 0.26.1 起就存在的差距，与 0.28.0 的形状漂移无关；本插件的仓库定位始终以会话工作目录为准。
- 上游 0.28.0 把信任判定从 `webRuntime.trustedHosts` 迁到了 `connection` 服务（删除了 `trust-fence.ts`）。本插件仍走软注入的 `webRuntime`，宿主当前两者都提供；若未来 DSH 移除 `webRuntime`，会按设计静默回落到 loopback-only（不崩、不放宽）。

## [2.4.31] — 2026-10-16

### 修复：issue #27（「添加工作区 → 本地目录」弹窗打开即报「path 为必填项」，2.4.27 起的回归）

- **现象**：侧栏「+ 添加工作区」→「📁 本地目录」tab 一打开就红字 `path 为必填项`，目录树为空、「选择此目录」不可用；「🌐 远程目录」tab 正常。
- **根因**：客户端「本地目录」tab 首次打开时按设计发 `{sessionId:"", path:""}`（`lib/client.js`：「空路径时打开主目录」；`localListDir()` 自己也有 `if (!path) path = homedir()` 兜底）。2.4.27 为修 issue #25 引入的 `localPathOf()` 对空路径一律 400，把这条**只读的初始列举**一起拦了 —— #25 要防的是写操作与相对路径。
- **修复**：只放行「无会话 cwd + 空路径 + `fs.tree` 这一个只读方法」→ 交给 `localListDir("")` 走 homedir 兜底。**有 cwd 时仍按 cwd 列举**；`fs.read`/`fs.write`/`fs.rename`/`fs.remove`/`fs.mkdir`/`fs.createFile` 的必填校验与相对路径解析一行未动。
- **验证**：`tests/session-path.test.mjs` 86 → **93 条断言**，新增 B10b–B10g（2 条正向 + 1 条范围 + **3 条反向**：`fs.read`/写操作/相对路径仍 400）。**变异负向控制 3 个**（独立副本）：回退修复 → B10b+B10c 红；把放行扩大到 `fs.read` → B10e 红；无视会话 cwd → B10d 红。
- **顺带修掉测试自身的健壮性缺陷**：新断言原先直接解引用 `r.body.value`，在坏状态下会**抛错**而不是报红（掩盖后续断言），已加守卫。另外重指了接线断言 C3 —— 原形状被新代码触发，改为「`payload.path || sessionCwd` 一律经 `localPathOf`，`fs.tree` 的空路径哨兵除外」，牙齿保留。

### 接管：better-sidebar 0.26.1 新增端点 `fs.readPage`

- 上游 0.26.1 为「5 MiB 以上文件的只读分页预览」新增了 `fs.readPage`（128 KiB/页、页尾回退到最后一个换行、整页无换行时原样返回，返回 `{kind,text,offset,nextOffset,eof,size,mtimeMs,encoding}`）。本插件未接管时，**远程工作区**下这一端点会落到上游实现上读**本地镜像**那份 —— 预览会显示陈旧副本（与 0.25.0 的 `fs.createFile` 同一类问题）。
- 本地分支新增 `localReadPage()`（行为与上游逐字段对齐）；远端分支新增 `remoteReadPageForSidebar()`：一次 SSH 往返用 `stat` 帧拿 `size/mtime` + `tail -c +N | head -c 131072 | base64 -w0` 拿该页字节，**页尾回退与解码在本地做**，保证两端返回同一形状；失败映射成上游同款 `400 fs-error`。
- `fs.readPage` 的 `path` **必填**（没有 `fs.tree` 那种「空路径=主目录」的语义），空路径仍 400。
- **测试**：新增 `tests/fs-read-page.test.mjs`（**43 条断言**）：本地部分在真实文件系统上跑真实现（逐页读到 eof 后**与原文件逐字节相同**、页数与 `ceil(size/页大小)` 一致、末页外每页都以换行结束、单行超页不回退、`offset ≥ size` 收敛、目录/不存在/负 offset 的报错）；远端部分用真实现 + **伪造 SSH 出口**（命令里的 1-based 偏移与页大小、字节推进、mtime 秒→毫秒、ERR 帧/无帧/SSH 失败的透出）。
- **变异负向控制 4 个**（独立副本）：页大小改 64 KiB → A9/A13/A14 红；`tail -c` 少 1 → B2 红；不做页尾回退 → A4/A7b 红；远端分支不走 `remotePathForRequest`（把镜像路径发给远端）→ C3 红。全部命中预期断言。

### 测试基建：对拍 harness 适配上游 0.26.1

- `tests/sidebar-0250-endpoints.test.mjs` 的上游沙箱补抽 `assertSingleSegmentName`：0.26.1 把「单段名」检查从 `assertCreatableFileName` 里拆了出去，不补的话它对**每个**输入都抛 `ReferenceError`，看起来像「上游把 `readme.md` 都拒绝了」（27 处假不一致）。补上后 D1/D2 恢复为 **105 条断言 0 失败**，语义逐项一致。

### 套件

- 全量 **28 个测试文件 / 1468 条断言 0 失败**（新增 `fs-read-page.test.mjs` 43 条、`session-path` +7 条、对拍 +1 条）。

### 已知隐患（与本次功能无关，记录在案）

- 本仓 `core.autocrlf=true`，`git stash`/`git checkout` 会把 `lib/index.js` 的**行尾换成 CRLF**；多个测试用含 `\n` 的标记切片源码，一旦换行被改写会**整文件抛错**（本次排查中实际踩到）。建议后续加 `.gitattributes`（`*.js text eol=lf`）一次性消除。
## [2.4.30] — 走不走远端由**请求路径本身**决定（issue #26：本机绝对路径被推到远端、远端绝对路径被再拼一次远端根）

### 修复
- **缺陷一：会话在远程工作区 ≠ 这个路径在远端。** 此前 fs 处理器只拿**会话 cwd** 判定"这次请求是远程还是本地"：会话 cwd 命中镜像 → `remoteInfo` 与 `remoteBase` 就定死了，随后**再看请求路径**时即使发现它不属于任何镜像/工作区，也**不回收** `remoteBase`（2.4.29 那句 `else` 只写 `remoteInfo`），于是本机绝对路径照样进远端分支。后果：
  - `fs.read` 报远端 `No such file`（本机文件明明在）—— 容易让人以为文件被删了；
  - **远端恰好有同路径文件时静默返回另一份文件**（无任何提示）；
  - `fs.write` 本机不落盘、反而在远端 `<root>/<本机路径>` 下新建/改写；`fs.remove`/`fs.rename` 把删除/重命名打到远端 —— 与 issue #25、2.4.29 一直在防的是同一类错位事故，只是方向相反。
  - **修法**：新增模块级纯函数 `classifyRequestPathSyntax()`（`win-abs` / `win-unc` / `posix-abs` / `tilde` / `relative` / `empty`）与 `looksLikeRemoteAbsolutePath()`，并在 fs 处理器里按**每个请求路径**的最终归属决定分支：`mirror`（已注册工作区镜像成员 → 远端映射）、`self-described`（目录自带 `.remote-ssh.json` → 保持旧行为）、`remote-abs`（已是远端绝对路径 → 远端**原样下发**）、`local`（盘符 / UNC 本机路径 → **本地分支，即使会话在远程工作区**）、`relative`（按会话 cwd 决定）。会话 cwd 从此只回答"相对路径该相对谁"。
  - 同一次请求里混用本机路径与镜像/远端路径 → 明确 `400`（猜一侧就会让另一侧被静默忽略，正是这类事故的老毛病）。
- **缺陷二：`localToRemote()` 的兜底把"不在镜像下"一律当成相对路径。** 它剥掉盘符与前导斜杠再拼远端根，于是**已经正确的远端绝对路径**（`<root>/sub/a.md`、工作区之外的 `/tmp/x.log`）被拼成 `<root><root>/…`、`<root>/tmp/…`，必然打不开；而且没有任何提示说"这其实是条远端路径"。报告里的路径矩阵显示：能可靠工作的只有"镜像形态绝对路径"与"工作区相对路径"两种，其余形态全落到这一个假设上。
  - **修法**：远端分支新增 `remotePathForRequest()`，按①远端绝对路径**原样下发** → ②镜像成员剥镜像前缀拼远端根 → ③相对路径按工作区根解析的**顺序**判定（顺序是关键：先排除远端绝对路径，否则它又会被当相对路径）。判定 ① 时必须排除镜像成员 —— DSH 跑在 Linux 上时镜像路径本身就是 `/…` 形态。
  - `localToRemote()` 的那句兜底同时从 `debug` 提到 **`warn`**：新分类到位后它不该再被触发，真被触发说明又出现了同类误判，而 `debug` 在默认日志里看不见、等于把错误藏起来。

### 测试
- 新增 `tests/request-path-ownership.test.mjs`：A 段语法分类真值表（含"盘符绝对路径与 `/…` 必须分开"这条关键反例）；B 段**真实处理器**行为共 29 条 —— 报告点名的两条验收断言逐条落地（① 会话 cwd = 镜像根 + `payload.path` = 镜像外绝对路径 ⇒ **完全不产生 SSH 命令**且读到本机那一份；② 会话 cwd = 镜像根 + `payload.path` = 远端绝对路径 ⇒ 命令里该路径**原样出现**且没有 `<root><root>/…`），并覆盖镜像成员映射（未回退）、相对路径两种会话、孤儿镜像路径 400 + canary 原封不动、混用 400、本机写/删确实落在本机、盘符相对与 `~` 的如实报错、`localToRemote` 兜底的 warn；C 段接线（8 个 fs 方法都走新映射、处理器里不再有"直接拿会话基准映射"的写法）。
- 判定相关函数一律用**真实源码**（不 stub），避免拿被 mock 掉的逻辑自证。
- **全量套件**：27 个测试文件、**1420 条断言 0 失败**（含新文件 51 条）。2.4.29 的 `tests/remote-workspace-root.test.mjs` 等文件的沙箱补上了两个新纯函数；其中 5 条"接线断言"原本断言的是旧网关的源码文本，已改指新机制（C9 还顺势把窗口从"处理器前 4200 字符"改成**处理器本体**，此前那个 1 是采样窗口造成的假绿）。
- **变异负向控制 6 个**（各自独立副本，工作树不动）：把"本机绝对路径走本地分支"改回看会话决定 → 7 条红（B1/B2/B18/B19/B20/B21/B22）；去掉"已是远端绝对路径 → 原样下发" → 5 条红（B3/B4/B5/B7/B7b）；不再按镜像成员归属 → 4 条红（B8/B10/B16/B25）；兜底日志退回 debug → 2 条红（B28 + 接线 C9）；去掉孤儿镜像报错 → 3 条红（B13/B14/B15）；去掉"混用"报错 → 2 条红（B16/B17）。全部命中预期断言，无"怎么写都过"的断言。
- **独立复现**：用报告人复现包里的脚本（好/坏两版同 harness 对照）—— 对 2.4.29 复现出两个缺陷，其中 ② 那条是"远端恰好有同路径文件 → **HTTP 200 静默返回另一份文件**"；对 2.4.30，本地路径那一步**一条远端命令都没有**（脚本因此在取 `addressed[0]` 时崩掉，正是修复目标）。
- **集成台**（真实模块 + 真实 HTTP server + 真实文件系统）17 条断言 0 失败：注册 30 条 exact 路由、镜像外本地文件正常读、未注册镜像路径 400 且文件原封不动等既有行为全部保持。

## [2.4.29] — 远程工作区判定改为按工作区根**前缀**匹配（真机验证 2.4.28 时发现的边界）

### 修复
- **远程工作区的判定此前只认"正好放着 `.remote-ssh.json` 的那一级目录"**：`readRemoteInfoSync(p)` 的实现就是 `readFileSync(join(p, ".remote-ssh.json"))`，**不向上遍历**。真实客户端总带有效 `sessionId`（会话 cwd 就是镜像根）所以一直没暴露，但两种情况会漏判，而漏判的后果是**写/删静默落在本地镜像上**（与 2.4.27 修的 issue #25 同源）：
  - ① 会话是在工作区的**子目录**里启动的（会话 cwd 是子目录，不是镜像根）；
  - ② 客户端带了**过期/未知 `sessionId`**，判定回退到 `payload.path`，而它可能是工作区根之下的任意层级。
  - **发现过程**：2.4.28 真机验证时，用过期 sessionId + 工作区根之下的绝对路径调 `fs.remove` → `400 ENOENT … lstat '<镜像路径>'`（远端什么都没动，本地镜像里也没有这个文件）；换成真实 sessionId 同一请求 → 200 且远端文件消失。由此定位到判定方式。
  - **修法**：新增 `remoteWorkspaceForPath(absPath)` —— 复用已有的 `matchRemoteWorkspace`（它本来就是**前缀**匹配）把任意绝对路径匹配到已注册工作区，再取该工作区根下的 `.remote-ssh.json`。fs 处理器的两条判定路径（会话 cwd、`payload.path`）都改走它；`@` 引用补全（`remoteRefListForAgent`）同样改走它 —— 它在会话 cwd 是子目录时会退回本地实现，只能搜到镜像目录（正是 issue #10 的现象）。
- **判定命中时必须以"工作区根"当 remoteBase，不能用传进来的那条更深路径**：`localToRemote()` 是"剥掉镜像前缀再拼远端根"，基准传成子目录就会把文件映射到远端**错误的位置**（`<root>/nested/x` 而不是 `<root>/sub/deep/nested/x`）。子目录会话 + 相对路径这条组合此前会踩到。
- **镜像根之下、但不属于任何已注册工作区的路径现在明确报错，而不是当成本地路径操作**：新增 `isUnderMirrorBase()` + fs 处理器的报错分支（读写都报，`400 bad-request`，文案说清"在镜像目录下 / 不属于已注册工作区"）。这类路径（工作区被移除、镜像成了孤儿、sessionId 过期）**不可能是**合法的本地目标，静默在镜像上读写就是错位。
- `mirrorBaseDir()` 集中镜像根（`<home>/.dsh/remote-workspaces`）的构造，镜像目录创建与判定共用一处，避免两边各写一遍后漂移。

### 测试
- 新增 `tests/remote-workspace-root.test.mjs`（**39 条断言，0 失败**）：A 段 `isUnderMirrorBase` 真值表（含"镜像根名多一段"的边界与 Windows/POSIX 大小写口径）；B 段**真实处理器**行为 —— 深层文件 `fs.remove` 走远端且远端命令是**完整正确**的远端路径、深层目录 `createFile`、子目录会话 + 相对路径的映射、未注册镜像路径的读/写都报错且 canary 文件**原封不动**、真正本地路径行为不变、`@` 引用补全列出的是**对应的远端子目录**；C 段接线 + "关键路径上不能再有只精确匹配的判定"。判定相关的函数全部使用**真实源码**（不 stub），避免拿被 mock 掉的逻辑自证。
- **变异负向控制 7 个**（各自独立副本，工作树不动）：remoteBase 换回深路径 → 6 条红；只废会话 cwd 那一路 → 3 条红（B7 + 接线）；只废 `payload.path` 那一路 → 1 条红（两路互为冗余，属设计意图）；两路都废 → 7 条红；去掉镜像越界报错 → 3 条红（含 canary）；`@` 引用退回精确匹配 → 3 条红；越界判定去掉目录边界 → 1 条红。全部命中预期断言，无"怎么写都过"的断言。
- **真机回归**：用过期 sessionId + 工作区根之下的绝对路径重跑此前失败的那一步（`fs.remove`）、以及真实 sessionId 的 `createFile` → `fs.remove` 往返，远端文件消失、本地镜像干净、远端 `git status` 计数与 HEAD 均回到初始值。

## [2.4.28] — 接管 better-sidebar 0.25.0 新增的 6 个端点（fs.createFile / git.blame / diff-head / worktrees / pull / push）
### 修复
- **本机 profile 里的 `dsh-better-sidebar` 从 0.24.1 升到 0.25.0，新增 9 个端点，其中 6 个与仓库/路径相关 —— 本插件此前没有注册它们**（不是用户报的 issue，是维护笔记里"升级 better-sidebar 后必做对拍"这条硬规则查出来的）。本插件用 `kind: "exact"` 接管 `/sidebar/api/fs.*` 与 `git.*`，**没注册的端点会回落到上游实现**，而远程工作区里上游拿到的 cwd 是**本地镜像目录**：
  - `fs.createFile`（0.25.0 新增）→ 空文件只建在**本地镜像**里，远端永远没有这个文件（与 2.4.18 那次 `fs.trees` 绕过拦截同一类，用户侧看到的是"建好了但远端没有"）；
  - `git.blame` / `git.diff-head`（0.25.0 新增）→ 按镜像的 git 状态计算（镜像里通常没有 `.git`，于是空结果或报错）；
  - `git.worktrees`（0.24.1 就有，此前也漏了，本次一并补上）→ 同上；
  - `git.pull` / `git.push`（0.25.0 新增）→ 在**镜像**上跑 `git pull --ff-only` / `git push`，动的是一个与远端无关的仓库。
  - **修法**：`fs.createFile` 加进 fs 的 exact 路由数组并实现本地/远程两条分支；`GIT_METHODS` 补上 5 个方法及其与上游一致的实参（`blame --porcelain -L <s>,<e> -- <path>`、`diff --no-ext-diff --no-color -U3 HEAD -- <path>`（无 HEAD 时回退 `--cached`）、`worktree list --porcelain`、`pull --ff-only`、`push`）。
- **新增纯函数**（规则逐条对齐上游，便于单测）：`creatableFileNameProblem`（单段名 + 非法字符 `<>:"|?*` 与控制字符 + Windows 保留设备名；按码点迭代，合法 emoji 名不会被拆成两个非法半字符）、`isoWithOffset`、`parseBlamePorcelain`（同一 commit 只在**首块**取 author/date/summary，后续行复用）、`parseWorktreeList`（换行 / NUL 两种分隔都能吃）、`countStatusEntries`（改名在 `-z` 输出里占两条 NUL 记录，只算一条 —— 口径同上游 `entries.length`）、`posixPathIdentity` / `localPathIdentity`。
- **`git.worktrees` 有意少一次往返**：上游对每个 worktree 调用完整的 `status()`（4 次 git 调用），远程工作区下每个 worktree 就是 4 次 SSH 往返；这里每个 worktree 只跑一条 `status --porcelain=v1 -z --untracked-files=all`，计数口径相同。其余字段（`path` / `branch` / `current` / 排序）与上游一致。
- **`git.pull` 成功后清两处缓存**：整棵远端列举缓存失效（工作树可能变了），并清掉写回桥的**远端指纹**记录 —— 那些记录描述的是 pull 之前的远端内容，留着只会让下一次写回被误判成"远端已改动"而拒绝写入。`git.push` 不动工作树，因此不做失效（避免无谓刷新）。
- **状态码对齐上游**：`fs.mkdir` / `fs.createFile` 的"已存在"统一 **409**（本地分支此前误给 400，与自己的远程分支都不一致）；形状/参数错误统一 400 + wire code **`bad-request`**（本地分支此前一律 `fs-error`），这样客户端才能显示"哪条规则不对"。
- **远端建空文件用 `set -C`（noclobber）重定向**：即使"探测是否已存在"与"创建"之间有人抢先建了同名文件，这里也只会失败，不会把别人的文件清空。
- **不接管 3 个纯模型端点**（`git.models` / `git.suggest-message` / `git.commit-model`）：它们不碰仓库路径（`models` 走 `ctx.get("llm")` 列 provider），交给上游才对。已知小瑕疵：`suggest-message` 取的是镜像里的 `git status`，远程工作区下可能滞后一次同步。
- **已知边界（既有的，不是本次引入）**：`payload.repoRoot`（多仓库选择器）本插件的 git 端点一概不处理；镜像里通常没有 `.git`（同步排除 `.git`），所以未接管的仓库类端点只会报 `not a git repository`，不会给出错的仓库结果。

### 测试
- `tests/sidebar-0250-endpoints.test.mjs`（新增）**105 条断言**，三层：
  - **纯函数真值表**：文件名校验（单段 / 非法字符 / 控制字符 / 22 个保留名 / 不误伤 `nulx` 与 emoji 名）、`isoWithOffset`（带偏移 / 无偏移 / 非法时区）、blame porcelain（首块复用语义）、worktree 列表（换行 / NUL / locked / prunable / 末尾无空行）、status 计数（改名只算一条）；
  - **真实处理器的行为**（源码切片 + 假 `ctx`/`req`/`res` + 假远端）：本地 `fs.createFile` 真落盘（含"宿主目录里不能多出文件"的 canary 断言）与 409；远程分支断言**SSH 命令形状**（远端绝对路径、创建前探测、noclobber、父目录列举失效）；5 个 git 端点的实参与返回形状；`worktrees` 必须用**每个 worktree 自己的目录**跑 status（不是会话 cwd）；pull 的失效与指纹清理；
  - **接线 + 上游对拍（自动化）**：注册数组必须含这 6 个端点、模型类端点必须**不**在里面；若本机装了 `dsh-better-sidebar`，① 读它的 `lib/index.js` 把宿主 handler 键集合与注册集合逐项比对，② 把它的**真实纯函数**抽出来与本次实现做**语义差分对拍**（文件名校验的接受/拒绝与拒绝文案、`isoWithOffset`、blame porcelain、worktree 列表，同一批输入逐条比较）—— 没装则 SKIP、不算失败。两段合起来把 MAINTENANCE 里"升级后必做"的人工步骤变成会红的断言。

### 升级
```bash
dsh plugin --profile <name> add @zhangfengshun/dsh-remote-ssh@2.4.28
```
升级后**重启 DSH**（宿主侧路由逻辑）。若你在远程工作区里用过文件树的"新建文件"，或 git 面板的 blame / 工作树 / 拉取 / 推送，建议升级。

## [2.4.27] — 本地会话的相对路径被解析到**插件宿主目录**（fs.* / /sidebar/file / git / open.external）
### 修复
- **接管 `/sidebar/file` 与 `/sidebar/api/fs.*` 之后，本地会话的相对路径丢了"按会话 cwd 解析"的语义（issue [#25](https://github.com/ZhangFengshun/dsh-remote-ssh/issues/25)，2026-10-13 guolei1993 报）**。为了让远程工作区可用，本插件以 `kind: "exact"` 接管了 better-sidebar 的这些路由 —— **exact 路由连本地会话一起抢**，而本地分支把路径原样交给 `fs`，Node 于是按**插件宿主进程的 `process.cwd()`**（pnpm profile 目录）解析：
  `cannot read: ENOENT: no such file or directory, stat '<profile>/tools/check_file_size.py'`。
  被接管的原实现是 `ensureWorkspacePath(activeWorktreeRootOf(ctx, sessionId, sessionCwd), raw)`，即**相对路径按会话 cwd 解析**。绝对路径不受影响，所以用户侧只表现为"部分文件打不开"，几乎无法自查。报告人逐行给出了 5 处落点（含 `handleSidebarFile` 里 cwd 算完却未被使用）。
  - **修法**：新增模块级纯函数 `resolveSessionPath(raw, base)`（绝对路径原样返回；相对路径按会话 cwd 拼接；`~` 原样返回不擅自展开）+ `unresolvedPathMessage()`（统一的可读报错）。**每一处落点都过它**：`/sidebar/file`、`fs.read / tree / trees / write / rename / remove / mkdir / search`（本地与远程两条分支）、`git.*` 的本地分支、`open.external` 的 `reveal`。
  - **取不到会话 cwd 时一律报错，绝不回退 `process.cwd()`**：那是这个 bug 的成因，留着当兜底等于把 bug 留一半。报错文案会带上用户给的相对路径并提示补 `cwd` / `sessionId`。
  - **写操作尤其危险**：`fs.write` / `fs.remove` 拿到相对路径会在**插件宿主目录**里写/删（例如覆盖 profile 里的同名文件、删掉 profile 下的目录）。测试用一个 canary 目录把这一点钉死。
  - `fs.trees` 采用**逐条报错**：一条路径解析不了只让那一条带 `error`（客户端按 level 渲染），同一批里能解析的照常返回 —— 不让一条坏路径把整棵树拖成 400。
  - 顺带收敛两处重复：`isAbsoluteLocalPath` 由 `apply()` 闭包里的一份改为模块级唯一实现（并补上 UNC）；会话 cwd 的取法统一成 `sessionCwdFrom(payload, explicit)`（`payload.cwd` 优先 → `sessionId` 查注册表），`gitContextOf` 等处不再各写一遍。
  - **一处有意的行为变化**：`git.*` 在既没有 `cwd` 也取不到会话工作目录时，此前会静默按 `process.cwd()`（插件宿主目录）跑 —— 也就是**显示一个错的仓库**；现在改为明确报错。
  - **客户端传来的 `cwd` 只在绝对路径时采信**（对齐上游 `sessionCwdOf` → `requireAbsolute()`：连 `C:foo` 这种盘符相对形式都拒）。相对 cwd 拼出来的仍是相对路径，fs 又会按 `process.cwd()` 解析 —— 等于把 bug 放回来。基准确认为相对时同样按"解析不了"报错。
  - 远程分支同样归一：相对路径此前会被 `localToRemote` 当作"镜像外路径"追加到远端根，落在**错误的位置**（工作区子目录下会缺一段）。
- **与上游/举报人实现的一处差异（知情选择）**：上游 `sessionCwdOf()` 的阶梯是 会话注册表 → 客户端 cwd（必须绝对）→ `sessionPersistence` 里的持久化元数据 → **`process.cwd()`**；[#25](https://github.com/ZhangFengshun/dsh-remote-ssh/issues/25) 的举报人也保留了这个最后的 `process.cwd()` 兜底（"仅兜底并记一行日志"）。本插件改为**明确报错**：`process.cwd()` 是插件宿主进程的目录（pnpm profile，或 DSH 恰好从别的仓库启动时的那个仓库），拿它当兜底等于在不确定的目录里跑 `git status`（读）甚至 `git discard` / `git revert`（写）。上游的阶梯只有在注册表**与**持久化元数据都取不到时才走到那一步；上游 `cwdOf()` 本身又**强制要求 `payload.sessionId`**，所以正常面板流量永远拿得到会话 cwd，这条兜底实际上是死代码 —— 换成一条看得懂的报错不会影响任何真实客户端。本插件也没有引入 `sessionPersistence` 那一级（那要用上游的内部 API），已知差异如实记在这里。
- **致谢**：[#25](https://github.com/ZhangFengshun/dsh-remote-ssh/issues/25) 的举报人独立做出了同一修复（纯函数 + 16 处接线）并给出了可重放的锚点脚本与残留检查，还提供了上游 `ensureWorkspacePath` / 路径阶梯的关键事实；2.4.27 的落点与其一致，另补了 `fs.search` 的本地分支。
- **边界如实说清**：会话 cwd 与 git worktree 根不同的场景（会话在仓库子目录里启动）下，本插件按**会话 cwd** 解析，而上游 `activeWorktreeRootOf` 会先上溯到 worktree 根。插件侧没有 worktree 概念，暂不引入；等真遇到再补。

### 测试
- `tests/session-path.test.mjs`（新增）**80 条断言**，三层：
  - **纯函数真值表**：绝对（POSIX / 盘符 / 正斜杠盘符 / UNC）、相对拼接、`./` 与 `..` 归一、无基准不解析、空值、`~` 不展开，以及每类失败的可读文案；
  - **真实处理器的行为**（源码切片 + 假 `ctx`/`req`/`res`，并把 `process.chdir()` 到一个"插件宿主目录"，里面放 canary 文件）：`fs.read`/`tree`/`trees`/`write`/`rename`/`remove`/`mkdir`/`search`、`/sidebar/file`、`git.diff`、`open.external reveal` —— 相对路径必须落在**会话 cwd** 下；canary 文件**既读不到也删不掉**；解析不了时必须报错（旧的"落到宿主目录"行为会让这些断言直接红）；
  - **接线与文档**：每处落点都归一、本地分支不再把 `payload.path` 直传 fs 函数、这些处理器（剥掉注释后）**不再出现 `process.cwd()`**、绝对路径判断与会话 cwd 取法各只有一份实现、版本/CHANGELOG/README。

### 升级
```bash
dsh plugin --profile <name> add @zhangfengshun/dsh-remote-ssh@2.4.27
```
升级后**重启 DSH**（这些是宿主侧路由逻辑，重启才会重新加载）。本地会话里用相对路径打开文件/文件树/git 面板都受此影响，建议升级。

## [2.4.26] — 护栏 B 的「只记日志」变成可验证的行为（判定与处置抽成纯函数）
### 修复 / 变更
- **护栏 B 的判定、文案与处置从 `apply()` 的闭包里抽成三个可注入的纯函数**（issue [#24](https://github.com/ZhangFengshun/dsh-remote-ssh/issues/24) 结案时举报人点出的"未覆盖"项）：
  - `freshnessGuardPlan(prevStamp, before, mode, remoteFile)` —— 判定 + 两份文案（短日志行 / 长报告），三态 × 两种失败模式都是纯输入输出；
  - `applyFreshnessPlan(plan)` —— 把 plan 落成调用方的动作 `{ pushed, err }`：拦 / 抛 / 放行与"带标记的错误"都在这里产生；
  - `freshnessGuardCheck({ runner, profile, stateDir, profileId, remoteFile, mode, log })` —— 读记录 → `stat` 远端 → 判定 → 记日志；`runner` / `stateDir` / `log` 都可注入，所以测试能用假 runner 走完整条链。
  - `mirrorWriteToRemote` 里的接线因此只剩三行（`throw guard.err` / 拦住则 return / 继续推送），**行为与 2.4.25 逐字一致**，区别只是"判断"从闭包搬到了能单测的地方。
- **一处顺带的行为改进**：`writeBackFailure: "log"` 模式下被护栏拦下时，那份带补救步骤的长报告现在会**写进日志**（2.4.25 只记一行短提示 —— "只报告、不推送"实际上退化成了"连报告都没有"）。工具返回值不变：本地写入照常算成功、不报错。
- 为什么值得单独发一版：2.4.25 对这段只有**源码形状断言**（`/if \(verdict\.changed\)/` 这类），而"log 模式下写入应当返回成功"是一条**行为**，此前**两边都没有观测过**（举报人复测时验的是读路径：`getPrefs` 能读回 `"log"`）。现在它是 `applyFreshnessPlan` 的返回值，可以直接断言。

### 测试
- `tests/fs-write-bridge.test.mjs` 98 → **126 条断言**，新增 E5 段：
  - 判定与文案：没有记录 / 记录一致 / 读失败（必须放行且只记一行）/ 被改过（报告同时给出"上次记录"与"现在读到"**两个具体数值**、点明远端文件、给出 sync 与 push 两条出路）/ 远端已消失；
  - 处置：push → `{pushed:true, err:null}`；**log 模式被拦 → `{pushed:false, err:null}`（不产生错误对象 = 写回桥不抛 = 工具返回成功）**；error 模式被拦 → 错误带 `dshRemoteSshWriteBack` 标记且带完整报告；`null` plan → 照常推送（负向控制）；
  - **整链五例**（假 runner + 真实状态文件）：远端变了 + error 模式 → 拦下并报错、日志里有一条"不推送（护栏 B）"；同一条记录 + log 模式 → 不推送、不抛，且长报告落进日志；`stat` 读失败 → 照常推送 + 一行"无法确认远端状态"；**没有记录 → 不花那次 SSH 往返**（runner 调用计数为 0）；远端没变 → 推且**不产生任何日志**（安静路径）；
  - **不变量矩阵**（2 种记录 × 4 种远端状态 × 2 种模式）：只有"被改过"才可能拦、`fail` 只出现在 error 模式、没变时完全安静、`apply` 与 `plan` 自洽且错误必带标记 —— 与"具体输入 → 具体期望"互补，防止将来有人为了"更安全"把未知态也拦下。
- 另做了一次**独立校验**（脚本不进仓库）：从源码切片直接跑 30 组矩阵 + 7 条性质（含"模式不影响未变/未知的处置"、"拦下必有日志与报告"、"报告里的依据就是判据给出的 `why`"），并交叉核对 `freshnessGuardCheck` 与"读记录 → `stat` → `plan`"逐字段一致、日志条数符合模式 —— 0 处违反。
- 全套 **23 个文件 / 1138 条断言**通过（上一版 23 个文件 / 1110 条）。

### 升级
```bash
dsh plugin --profile <name> add @zhangfengshun/dsh-remote-ssh@2.4.26
```
纯逻辑搬迁 + 测试，无接口变化；照常重启 DSH 即可。

## [2.4.25] — 打包版 Desktop 上 node 解析五条候选全落空；写回前的远端新鲜度检查；这些开关终于能在设置面板里够到
### 修复
- **打包版 Desktop 上「终端」仍然起不来：2.4.24 的五条候选在这台机器上一条都不成立（issue [#23](https://github.com/ZhangFengshun/dsh-remote-ssh/issues/23) 第二轮验收，SundaeYAGO）**。举报人对着官方打包产物逐条核对：主进程 `execPath` 是 `DeepSeek Harness.exe`（第③条被"文件名得像 node"的守卫正确挡掉）、`DSH_DESKTOP_NODE_EXECUTABLE` 在子进程环境里根本不存在（第④条）、同目录也没有 node（第⑤条）→ 解析结果为空串。**所以 2.4.24 里"不再依赖 PATH"的说法对打包版是过强的**（它只在这台开发机的启动方式下成立）—— 本版把话收回来，并补两条兜底候选：
  - **第⑥条** `%DSH_HOME%\dsh-runtimes\*\dependencies\node\bin\node.exe`：`DSH_HOME` 是宿主自己导出的通用根（不是猜的私有目录），举报人也点名建议了这条。
  - **第⑦条** `<应用安装目录>\resources\runtime\*\dependencies\node\bin\node.exe`（以及 `process.resourcesPath\runtime\*`）：取自 `process.execPath`，同属"自己的安装位置"这个既有事实来源。
  - **运行时实例名不写死**（`dsh-primary-runtime` 只是当前的名字）：探测该层目录，`primary` 优先、其余按名排序，**逐个 `existsSync` 验证通过才采用**；用哪条、解析到什么，都写进那行日志（`终端 wrapper 使用的 node: …（来源：…）`）。
  - **边界如实说清**：在官方给出稳定的 runtime 入口之前，插件侧到此为止。⑥⑦ 都落空时仍是那行可操作错误 + `nodePath` 设置（现在能在设置面板里填，见下）。
- **写回可能静默覆盖远端已被改过的内容 → 新增护栏 B（写回前的远端新鲜度检查，默认开；issue [#24](https://github.com/ZhangFengshun/dsh-remote-ssh/issues/24) 第二轮现场）**。举报人的现场是共享集群上最常见的那个"另一个写入者"——**自己刚跑完的作业**：作业写了远端，镜像还是旧版，agent 再写一次就把远端的改动静默覆盖。按他给的首选语义（只报告 + 不推送）实现：
  - 推送成功后记录远端的 `size:mtime`（`~/.dsh/remote-ssh/writeback-mtimes.json`，profile → 远端路径）；下次推同一路径前复查，**不一致或远端这份已消失 → 不推送**，并报错说明"本地镜像已写入成功、只是没推到远端"，给出 `remote_ssh_sync`（拉下来比对）与 `remote_ssh_push`（确认以本地为准）两条出路。
  - **只在远端自己的时间轴上自比，绝不与本地 mtime 比**：跨机时钟偏移、tar/base64 重写都会让两边不可比（举报人明确提示过这一点）。判据抽成纯函数 `freshnessVerdict` 单独验证。
  - **读不到 ≠ 被改过**：`stat` 失败、ssh 抖动一律归为"状态未知"照常推送，只留一行日志 —— 把 flaky 连接变成"拦住写入"是错的；状态文件损坏同样当作没有记录。
  - 记录是**"允许下次覆盖"的通行证**：显式写远端（`remote_ssh_write`、文件面板保存、API `writeFile`）之后忘掉该路径；`remote_ssh_push` / `remote_ssh_sync` 成功之后忘掉该连接的全部记录 —— 这也是被护栏拦下后的官方出路。
  - 关掉它：设置 `writeBackFreshness: false`，或 `DSH_REMOTE_SSH_WRITEBACK_FRESHNESS=off`（回到"每次都无条件覆盖"，即 2.4.24 行为）。
- **这些开关此前在界面上够不着，普通用户等于没有（同一份验收里的"可达性"部分）**。举报人指出 `nodePath` / `writeBackFailure` / `writeBack*` 在 `lib/client.js` 里 0 命中 —— 而 #23 的场景恰恰是"终端完全打不开、最需要一条自救路径"的那批用户。修法：
  - 设置面板新增「写回与终端（进阶）」：`nodePath` 输入框、`writeBackFailure` 下拉（让模型看见 / 只写日志）、`writeBackFreshness` 勾选；每个远程工作区多一组"启用写回 + 写回排除"（护栏 A，占位示例就是验收里用过的 `_patch/, *.log, wbdeep/**`）。中英双语键齐备。
  - 宿主侧新增 `getPrefs` / `savePrefs` / `updateWorkspaceGuards` 端点（字段白名单；`writeBackFailure` 只归一化成 `error` / `log` 两态）。
  - **顺带修掉一个 2.4.24 的隐性 bug**：`settingsFace.read()` 只回 `profiles` / `workspaces`，于是 `read().writeBackFailure` 永远是 `undefined` —— 用户把设置写成 `"log"` 也不生效，只有环境变量管用。现在三个 face（新版 / 旧版 / 只读兜底）都回标量，并新增 `prefsScalar`（`false` 是合法取值，不能被当成"没设"而回退默认）。

### 测试
- `tests/wrapper-terminal.test.mjs` 59 → **69 条断言**：新增场景 11 直接造出**打包版桌面端**的进程画像（`execPath` 指向 `DeepSeek Harness.exe`、没有 `DSH_DESKTOP_NODE_EXECUTABLE`、同目录无 node），断言第⑥/⑦条能解析到真实存在的 node、显式 `nodePath` 仍然优先、`primary` 实例优先的确定性、目录不存在时探测返回空，以及**负向控制**（`execPath` 挪到不存在的树下且不给 `DSH_HOME` → 一条候选都解析不到，`bin === ''`）。
- `tests/fs-write-bridge.test.mjs` 67 → **98 条断言**：护栏 B 判据真值表（没变 / `size:mtime` 变了 / 只有 size 变了 / 远端已消失 / **读失败必须放行** / 没有记录放行）、状态文件读写与 `forget` / `forgetProfile`（且不碰别的连接）、状态文件损坏与目录不存在时不抛也不挡、`remoteMtimeInfo` 三态由真实 `stat` 输出决定（命令形状与既有代码一致），以及"查→推→记"顺序与 push/sync/显式写之后的清理接线。
- `tests/settings-ui-reachability.test.mjs`（新增）**37 条断言**：客户端真的有这些控件、10 个新 i18n 键在 zh/en 各定义一次、三个端点存在且只接受白名单字段、`updatePrefs` 在三个 face 都实现、`read()` 回标量且运行时判断读的正是它。
- `tests/settings-compat.test.mjs` 48 → **54 条断言**：新增 `prefsScalar`（`false` 必须原样返回、volatile `.get()`、抛错跳过、`0` 不算空）。
- **真实集群实测**（护栏 B 唯一新增的远端依赖）：在真实 SSH 集群上跑 `stat -c'%s %Y' <文件>` → `8 1633938245`（size 与 mtime 都在）；对不存在的路径 → `stat: cannot stat '…': No such file or directory`（退出码 1），正是判据里"远端已消失"那一态；远端 `stat` 的引号是本地化的弯引号，所以匹配只认 `No such file` 这一段。
- 全套 **23 个文件 / 1110 条断言**通过（上一版 22 个文件 / 1026 条）。

### 升级
```bash
dsh plugin --profile <name> add @zhangfengshun/dsh-remote-ssh@2.4.25
```
升级后**重启 DSH**（终端 wrapper 每次加载都会重写；设置面板新增的进阶区块也要重新加载客户端）。

## [2.4.24] — Desktop 终端再也起不来（wrapper 裸调 `node`）；写回桥推送失败对模型不可见
### 修复
- **DSH Desktop 上集成「终端」页签 100% 打不开：wrapper 裸调 `node`（issue [#23](https://github.com/ZhangFengshun/dsh-remote-ssh/issues/23)，2026-10-11 SundaeYAGO 报）**。生成出来的两个薄壳（`.cmd` / POSIX `sh`）此前都是裸名 `node "…/dsh-remote-shell.js"`，而**桌面端按设计不把自带 node 放进子进程 PATH**（举报人逐条引证官方源码与设计笔记：`packageManager` 的 JSDoc 明写只覆盖包操作、`installPrimaryRuntime` 明写不改 PATH、宿主自己是用**绝对路径**的 node 去跑 pnpm；`runtime\bin\node.cmd` 垫片依赖的 `DSH_DESKTOP_NODE_EXECUTABLE` 又恰在子进程环境的脱敏名单里）。于是 PATH 上没有 node 的机器（桌面端的主流状态）一开终端就是 cmd 的 `'node' is not recognized…` 并立刻退出 —— 与 SSH、密钥、跳板机全都无关。
  - **修法**：与同一份 wrapper 里 `ssh` 早就采用的做法同构（`sysSsh` 绝对路径 + 回退），node 也解析成**绝对路径**写死进薄壳，优先级：`nodePath` 设置 → 环境变量 `DSH_REMOTE_SSH_NODE` → **正在运行本插件的那个解释器**（`process.execPath`，且文件名形如 `node`/`node.exe` 时才用 —— 桌面端若以 Electron 可执行文件为主进程，用它只会再开一个 DSH 实例）→ `DSH_DESKTOP_NODE_EXECUTABLE` → 与解释器同目录的 node。
  - **刻意不去猜 DSH 的私有 runtime 目录**：举报人明确不建议（那需要官方点头），本文只用"自己的解释器"与"用户显式给的路径"。
  - **失败要可操作**：写死路径失效（换机/卸载）时回退 `where node` / `command -v node`；两条都失败就打一条说明"这是本插件的终端、桌面端为何没有 node、`nodePath` 怎么配"的错误并 `exit 127`，而不是把 cmd 的原文糊到用户脸上。POSIX 半边只用 shell 内建（`${0%/*}`、`command -v`、`exec`），连 `dirname` 都不依赖。
  - 新增设置项 `nodePath`（留空 = 自动解析）与环境变量 `DSH_REMOTE_SSH_NODE`；解析结果与来源写一行日志。
- **`write` / `edit` 在推送失败时照常返回成功，模型以为远端已有该文件（issue [#24](https://github.com/ZhangFengshun/dsh-remote-ssh/issues/24)，同一举报人）**。写回桥的注释里写着"写好了就意味着远端也已有"，但失败路径只打一行宿主日志：
  - **确定性失败**：内容超过 `MAX_BYTES`（4 MiB）时 `remoteWriteFile` 直接返回失败 —— 一个日志、一个 CSV、一个 notebook 就够，而 4 MiB 不是难以触及的门槛。
  - **其余失败**：ssh 断开、权限、配额，同样静默。
  - **修法①（消灭确定性失败）**：写回桥改走 `remoteWriteFileChunked` —— 超过 4 MiB 时按 **3 MiB** 分块 base64 追加（3 的倍数 → 非末块不带 padding，可直接拼接；先按 UTF-8 编码成 Buffer 再切**字节**，避免劈开代理对），首块 `>`、后续 `>>`，最后用 `wc -c` 校验远端字节数，任一块失败即报出块序号并提示文件可能被截断。小文件仍是一次 `base64 -d >`（行为与 2.4.23 相同，无额外往返）。
  - **修法②（失败可见）**：推送失败默认**抛错**，消息写清"本地镜像已写入成功、只是没同步到远端"、远端路径、原因，并给出 `remote_ssh_push` 补推路径。**为什么只能选"报错"而不能"在成功结果里附一条警告"**：本版 `write` 工具的输出 schema 是 `additionalProperties: false` 且只取 `path`/`operation`/`before`/`after`，`execute` 自己重建返回对象（附加字段到不了模型），成功渲染又是固定信封 —— 已按打包产物逐行核对。想恢复旧行为：设置 `writeBackFailure: "log"`（或 `DSH_REMOTE_SSH_WRITEBACK_FAILURE=log`）。
  - **护栏（举报人的可选建议 A）**：工作区可设 `writeBack: false` 整体关掉写回，或用 `writeBackExclude` 排除路径（镜像相对路径，支持 `*` / `**` / `?`，结尾带 `/` 视为目录前缀）—— 免得草稿、验证脚本、抓取 dump 被无声推到共享集群的项目目录。两者默认都不改变旧行为。
  - **护栏 B（写回前的远端新鲜度检查）本版未做**，原因见下：它需要记录"上次推给远端的是什么"（新状态存储 + 陈旧判定语义），不是一次往返能解决的；举报人也把它列为可选护栏，留作后续单独设计。
  - 一个需要知道的副作用：报错会让宿主**不记录这次写入的"已观测"状态**（工具把异常当失败路径处理），于是紧接着对同一文件的 `edit` 会要求先 `read`。方向是安全的（宁可多读一次），读的仍是本地镜像里的完整内容。

### 测试
- `tests/wrapper-terminal.test.mjs` 29 → **59 条断言**：
  - node 解析优先级（设置 > 环境变量 > `process.execPath`；配置路径不存在时不盲用）；
  - 薄壳文本（写死绝对路径、旧形状已消除、PATH 回退、可操作错误 + 127、路径里的 `'` 与 `%` 转义）；
  - **真实 `.cmd` 端到端 + 干净 PATH**（`PATH=C:\Windows\System32`）：假 node 留下标记证明走的是写死的绝对路径；**负向控制**把旧形状放回同一环境，必须复现 `'node' is not recognized`；写死路径失效时是 127 + 插件自己的提示；真 node + 干净 PATH 时失败点**后移到 ssh**（退出码 255，正是举报人给的验收判据）；
  - **POSIX 半边在 WSL 里真实执行**，`PATH=/nonexistent` 也能跑（只用 shell 内建）、`bash -n` 语法检查、缺 node 时 127 + 可操作提示。
- `tests/fs-write-bridge.test.mjs` 33 → **67 条断言**：
  - **分块上传**：7 MiB 载荷（含中文与 emoji）→ 分块数 = `ceil(字节数 / 3 MiB)`、首块 `>` 后续 `>>`、非末块无 padding、**各块解码后拼接与原内容逐字节相同**、`wc -c` 校验、字节数不一致判失败、中途失败报块序号；**负向控制**：旧路径对同一内容是确定性失败（模型看不见）；
  - **glob 语义**：`**` 跨目录、`*` 不跨目录、`?` 单字符、精确路径、结尾 `/` 目录前缀（且 `_patch/` 不误伤 `_patch2/`）、正则元字符按字面、空规则不排除；
  - **失败可见端到端**：标记过的失败让 `writeText` 抛错且消息点明本地已写入并给出 `remote_ssh_push`；未标记的异常仍只告警、写入结果照常返回。
- 全套 **22 个文件 / 1026 条断言**通过（上一版 22 个文件 / 962 条）。

### 升级
```bash
dsh plugin --profile <name> add @zhangfengshun/dsh-remote-ssh@2.4.24
```
升级后**重启 DSH**（终端 wrapper 每次加载都会重写）。

## [2.4.23] — Windows 上拉取非 ASCII 文件名被静默改写（`报告.csv` → `鎶ュ憡.csv`）；顺带给出旧乱码名的清理通道
### 修复
- **Windows 上 `remote_ssh_sync` 会把非 ASCII 文件名拉成乱码，且完全静默；随后一次 push 就把乱码名固化到远端（issue [#22](https://github.com/ZhangFengshun/dsh-remote-ssh/issues/22)，2026-10-11 SundaeYAGO 报，1450 文件镜像里 7 个非 ASCII 名 7/7 中招、7/7 可逆）**。三方各自都没错，错在组合：
  - **远端**：GNU tar 对较短的非 ASCII 名写的是**纯 ustar 头** —— `typeflag='0'`、GNU magic `"ustar  \0"`、名字字段直接放**裸 UTF-8 字节**，既没有 PAX 记录、也没有任何字符集声明（GNU tar 1.35 实测；`--format=pax` 才会写 `path=` 记录并改用 POSIX magic `"ustar\0"`）。
  - **本地**：Windows 自带的 `C:\Windows\System32\tar.exe` 是 **bsdtar 3.8.8 / libarchive 3.8.8**，它按**本地 ANSI 代码页**（中文机器 = CP936/GBK）解码 ustar 名字字段 → `报告_2026Q1.csv` 变成 `鎶ュ憡_2026Q1.csv`，**退出码 0、stderr 为空**，文件内容完好，只有名字被改写。该构建**不支持 `--hdrcharset`**（`tar: Option --hdrcharset=UTF-8 is not supported`，退出码 1）—— 所以本地侧没有可用的开关。
  - **magic 决定"静默"还是"报错"**：GNU magic 走静默转码路径；POSIX magic（PAX）会让 bsdtar 优先采用 `path=` 记录 —— 这正是修法的着力点。
  - **修法**：让**远端**改用 PAX 输出。`remote_ssh_down` 的远端命令现在前置 `--format=pax --pax-option=delete=atime,delete=ctime,delete=mtime`，**并且** `cf` 改成 `-cf`（带横线 —— GNU tar 的"无横线旧式选项"只在首参生效，前面一旦有长选项，`cf` 会被当成文件名并报 `You must specify one of the '-Acdtrux'…`；`-cf` 同时更符合 POSIX、GNU/bsdtar/busybox 都认）。
  - **体积代价为零（实测）**：GNU tar 的 pax 默认给**每个**文件都写 `mtime`/`atime` 记录，301 个 200 B 文件的树从 317,440 B 涨到 624,640 B（**+97%**）；加上 `delete=atime,delete=ctime,delete=mtime` 后，GNU tar 只为**真正需要**的条目写扩展头（实测 301 个条目里只有 1 个 `x` 记录，就是那个中文名），归档大小与 ustar **逐字节相同**（317,440 B）。
  - **能力探测而不是猜版本**：每次会话对每个 profile 做一次廉价探针（`tar <args> -cf /dev/null /dev/null`，不遍历任何目录，结果缓存）：第一级要 `min` 变体，失败退到纯 `--format=pax`（例如 macOS 的 bsdtar 没有 `--pax-option`），再失败才退回原样并**明确告知**——在 Windows 上会乱码、请升级远端 GNU tar。默认只在 `win32` 启用（其它平台的 ANSI 代码页就是 UTF-8，本来不会乱码）；`DSH_REMOTE_SSH_SYNC_PAX=off|plain|min` 可强制覆盖。
- **旧版本已经拉下来的乱码名，现在会被认出来**（而不是被当成"本地独有文件"拒绝整个同步）：整树同步在触发「仅存在于镜像的文件」保护时，会先做一次乱码配对 —— 把新树里每个非 ASCII 路径按 UTF-8 字节交给 **GBK 解码**（这正是 bsdtar 当年的行为），若结果与镜像里某个"独有文件"逐字符相同，就判定它是**旧乱码名**并给出 `鎶ュ憡_2026Q1.csv → 报告_2026Q1.csv` 这样的对应关系，提示两条出路：`repairNames: true` 让插件清理，或先在本地改回正确名再 push（能保住你在这份副本上做过的修改）。
  - **只在本来就要拒绝的那条路径上扫描**（日常同步零成本）；**只有全部**镜像独有文件都被证明是乱码名时才放行 —— 混着真正的本地独有文件时仍然拒绝，绝不借"修复"之名删真文件（有专门断言）。
  - 新增参数 `repairNames`（默认 false，逐次生效、不持久化）与结果字段 `repairedNames` / `mojibakeNames` / `notice`。局部同步（`paths`）不替换镜像，所以默认只**提示**乱码名存在，显式 `repairNames: true` 才删除并顺手清理空的乱码目录。
- **顺带确认 push 方向本来就是对的**：本地 bsdtar **写**归档时会为非 ASCII 名写 PAX `path=` 记录，远端 GNU tar 解出来是正确名字（真实工具端到端断言）；`--hdrcharset` 这条路只堵在**读**的方向。
### 测试
- 新增 `tests/unicode-names.test.mjs`（**31 条断言**）：**不造假 tar** —— WSL 里的真实 `GNU tar 1.35`（与举报人的 Ubuntu 24.04 同版本）扮演远端，Windows 自带的真实 `bsdtar 3.8.8` 做本地解包，中间跑插件**真实的** `remoteSyncDown`/`remoteSyncUp`，而"远端命令"是拿插件生成的那条字符串**真的**交给 WSL 的 bash 去执行 —— 于是"生成了什么命令 → 归档是什么形状 → Windows 上落盘什么名字"整条链路一起被验证。
  - **前提自检**：直接按 512 字节块解析归档，断言默认格式确实是"`typeflag='0'` + GNU magic `"ustar "` + 无 `path=` 记录"，PAX 格式确实是"`x` 记录 + `path=./报告_2026Q1.csv` + POSIX magic"（GNU tar 以后若改默认格式，这里会先失败）。
  - **A**：默认（探针命中 → `min`）→ `实验数据/批次2.csv`、`报告_2026Q1.csv`、`ascii/plain.csv` 全部正确落盘、无乱码名、内容完好，且生成的远端命令确实带 PAX 前缀。
  - **B（负向控制）**：`DSH_REMOTE_SSH_SYNC_PAX=off` + **同一个远端树** → 必须复现 `鎶ュ憡_2026Q1.csv`。这条保证测试真的能抓到回归，而不是"恰好没跑到那条分支"。
  - **C**：旧乱码名迁移端到端（默认拒绝并点名对应关系；`repairNames: true` 放行并报 `repairedNames=1`；乱码名 + 真·本地独有文件同时存在时**仍然拒绝**且真文件完好）。
  - **D**：反方向（本地 bsdtar 打包 → 远端 GNU tar 解包）中文名正确，且 2.4.22 的排除修复仍然有效（`.remote-ssh.json` 与占位 `README.md` 没有被推到远端）。
  - 没有 WSL / WSL 里没有 GNU tar 时整体跳过（打印一行说明，不计失败）。
- `tests/sync-safety.test.mjs` 103 → **138 条断言**：新增 I 段覆盖探针阶梯与缓存（第一级通过只探一次、失败退第二级、`off` 完全不探、强制 `min` 不看探针）、`mojibakeName` 单元（与举报人的 `报告_2026Q1.csv → 鎶ュ憡_2026Q1.csv` 逐字符一致；整条相对路径一起解码所以可整路径配对；纯 ASCII 返回 null）、整树乱码拒绝与 `repairNames` 放行、混合场景保护、局部同步的"默认只提示/显式才清理/空乱码目录一并清掉"，以及参数与输出 schema 的静态防线；体积探测断言改为只看 `du` 那一类调用（PAX 探针也走同一个 runner）。
- `tests/tool-output-schema.test.mjs` 21 → **23 条**：`repairedNames` / `notice` / `mojibakeNames` 在成功与失败两条路径上都被 schema 声明（`additionalProperties: false` 会拒未声明字段）。
- 全套 **22 个文件 / 962 条断言**通过（上一版 21 个文件 / 894 条）。
### 说明
- 升级到 2.4.23 **不会**自动修复已经乱码的镜像（那属于删除动作），首次整树同步会明确告诉你怎么做；不愿意让插件删的，按提示在本地改回正确名即可。
- 这条 issue 也是"同一个 helper 不能跨 shell 边界"（2.4.22 的教训）的姊妹篇：**同一份字节流，两端对"名字该怎么解码"的默认假设不同**。凡涉及编码/引号/行尾这类**静默**差异，只能靠真实工具链路复现，合成 fixture 与桩断言都不算数 —— 已写进 `MAINTENANCE.md`。

## [2.4.22] — push 侧 `--exclude` 全部失效：同一个 helper 跨了 shell 边界（2.4.20 的回归）
### 修复
- **`remote_ssh_push` 的排除规则一条都没生效，包括代码里写死的那两条（issue [#20](https://github.com/ZhangFengshun/dsh-remote-ssh/issues/20) 重测，2026-10-11 SundaeYAGO 报）**：`syncTarExcludes()` 用 `shellQuote()` 把模式包成 POSIX 单引号 —— 这对 **sync 方向**是对的（结果被拼进**远端命令字符串**，由远端 shell 解释），但 **push 方向**把同样的字符串当 **argv 元素**交给本地 tar：argv 不经 shell，`--exclude='./x'` 里的引号于是成了模式的**字面字符**，匹配不到 `./x`。
  - **后果**：`.remote-ssh.json`（含 profileId / host / port / user / keyPath / remotePath）与占位 `README.md` **真的被解到了远端根目录**；用户显式 `exclude` 掉的目录也照推 —— 2.4.20 CHANGELOG 里「连接信息**绝不**推到远端」那句承诺当时并不成立。举报人用真实 bsdtar + 插件生成的精确 argv 复现（远端根 11 项 → 14 项，两个文件的 size/mtime 与本地镜像源文件逐字节一致）。
  - **静默**：`GNU tar 1.35` / `bsdtar 3.8` 对「不匹配任何成员」的 `--exclude` 都退出 0，既不报错也不提示，只能靠比对远端根才发现（这也解释了为什么它能一路发出去）。
  - **修法**：`syncTarExcludes(list, forShell)` —— `forShell: true`（sync 方向，拼命令字符串）保持 `shellQuote`；argv 语境（push 方向）用**裸模式**；写死的两条（`.remote-ssh.json`、占位 `README.md`）同样改裸模式。
- **已经 push 过的用户可以自查自清**：远端根若多出 `.remote-ssh.json` / `README.md`（size 与本地镜像里的那两个文件一致），删掉即可；升级到 2.4.22 后不会再推。
- **文档补一条 tar 语义**（举报人指出，非缺陷）：`exclude` **不会**抑制被显式列进 `paths` 的路径 —— tar 对命令行点名的成员不做 `--exclude` 过滤；要排除大目录，请把 `paths` 提到它的父目录，让大目录成为「成员」而不是「目标」。工具描述与 README 都已写明（另注明：不匹配任何内容的 exclude 模式不会报错，所以"传了无效 exclude 却没反应"不能反过来当作参数被丢弃的证据）。

### 测试
- `tests/sync-safety.test.mjs` 86 → **103 条断言**：
  - **真实 tar 端到端，且消费的是生成出来的 argv**（不是我手打的近似）：捕获 `remoteSyncUp` 实际 spawn 的 `--exclude=…` 参数，交给本机真实 tar 打包并列出归档，断言 `.remote-ssh.json` / 占位 `README.md` / 用户 exclude 的目录都不在归档里、`keep.txt` 仍在；配**负向控制** —— 把这些模式重新加引号，同一判据必须判为泄漏（复现 2.4.20 的实际行为，本机 `bsdtar 3.8.8` 实测）。
  - sync 侧的 shell 语境：断言生成的远端命令里排除**带**引号，并把这两条 `--exclude=…` 交给真实 POSIX shell，断言解析后正好退化成裸模式（= 上一条已证明可用的形态）—— 两个语境各自闭环。
  - 单元级：`syncTarExcludes` 两种形态 + 越界归一化照旧生效。
  - 测试注射的 `shellQuote` 换成**从源码抽出的真实实现** —— issue #22 恰恰是「引号该不该加」，用桩去断言桩没有意义。
  - 修正旧断言：D / F 段此前断言的正是**带引号的形状**（等于把 bug 一起断言了）。这是两天内第二次「测试断言了产物、而不是行为」（前一次是 wrapper 的 proxyJump 分支从未被任何场景走过），已写进 `MAINTENANCE.md`。
- 全套 **21 个文件 894 条断言**通过（原 877 条）。

## [2.4.21] — 填了 ProxyJump 的连接，内置「终端」页签不再一开就退出 255（`no argument after keyword "-j"`）
### 修复
- **配了 ProxyJump 的连接里，内置「终端」页签永远打不开（issue [#21](https://github.com/ZhangFengshun/dsh-remote-ssh/issues/21)，2026-10-11 berries-tart 报）**：终端 wrapper（`~/.dsh/remote-ssh/dsh-remote-shell.js`）拼 ssh argv 时，用**位置插入**把 ProxyJump 塞进了 `-o` 与其取值之间：
  ```js
  const args = ['-tt', '-o', 'StrictHostKeyChecking=no', '-o', 'ExitOnForwardFailure=no', '-p', …];
  if (j.proxyJump) { args.splice(2, 0, '-J', j.proxyJump); }   // 插点(2) 正好是 '-o' 的下一个位置
  ```
  实际命令行于是成了 `ssh -tt -o -J jump-host StrictHostKeyChecking=no …`：ssh 把 `-J` 当成 **`-o` 的关键字**（关键字比较前会小写化，所以报文里显示 `-j`），按 `readconf.c` 的解析直接报 `command-line line 0: no argument after keyword "-j"` 并退出 **255**。边界与举报人观察完全一致：只有"该连接填了 ProxyJump"才命中（清空该字段、或换不走跳板机的连接都正常），而模型工具那套远端操作走的是另一条 argv 构造路径（`-o ProxyJump=<值>`，正确）所以一直正常。本机用同版本 `OpenSSH_for_Windows_9.5p2` 复现出**逐字节相同**的报文。
  现在改为**按顺序 push、选项之间不交叉**：`-tt` → 两个 `-o` 对 → `-J <跳板机>` → `-p` → `-i` → `user@host`；跳板机取值经 `String()` 原样透传（`user@host:2222` 形态不会被拆词，argv 不经 shell）。
- **升级即生效**：wrapper 文件在每次插件加载时都会被**无条件重写**，所以升级 2.4.21 + 重启 DSH 就够了，不需要手动删 `~/.dsh/remote-ssh/` 下的旧文件。

### 测试
- `tests/wrapper-terminal.test.mjs` 从 16 条扩到 **29 条**：新增 ProxyJump 三个场景（基本场景 / `user@host:port` 原样透传 / 未配置时不得凭空多出 `-J` 的负向控制）、一条**结构化不变式**（每个 `-o` 必须紧跟自己的取值 —— 含 `=` 且不以 `-` 开头；`-J`/`-p`/`-i` 同理），以及一条**真实 ssh 的离线判据**：
  - 用 `ssh -G`（只解析命令行与 config、**不建立连接**）跑 wrapper 实际生成的 argv，断言 exit 0 且配置转储里出现 `proxyjump jump-host`、`port 2222`、`stricthostkeychecking false` —— 即"ssh 真的吃下了这串 argv、且 ProxyJump 真的生效"，而不只是"没报错"；
  - 配一条**负向控制**：把 `-J` 插回 `-o` 与取值之间，同一判据必须判失败并复现 `no argument after keyword "-j"` —— 证明这条判据自己就能抓住 issue #21；
  - 本机没有可用 `ssh` 时该组断言打印跳过、不计入失败。
- 这组断言之所以必要：**旧测试断言了 wrapper 的 argv，但没有任何场景设置 `proxyJump`** —— 分支从未被走过，于是坏形状一路绿灯发到了 2.4.20。教训写进 `MAINTENANCE.md`。
- 全套 **21 个文件 877 条断言**通过（原 864 条）。

## [2.4.20] — 同步不再「先删后取」：体积哨兵 + 临时目录原子替换 + 范围控制 + push 不再污染远端根
### 修复
- **`remote_ssh_sync` 先 `rm -rf` 镜像、再全树拉取 → 拉取失败会销毁只存在于镜像的文件（issue [#20](https://github.com/ZhangFengshun/dsh-remote-ssh/issues/20)，2026-10-10 SundaeYAGO 报）**：旧顺序是「`rm(mirrorPath,{recursive,force})` → `tar cf - -C <远端根> . | tar xf - -C <镜像>`」，**删除发生在任何成功证据之前**。而镜像里完全可能存在「只存在于本地」的文件：agent 的 `write` 超过 `MAX_BYTES`（4 MiB）时**本地镜像写入已成功**、`remoteWriteFile` 却拒绝推送（宿主侧只有一行 warn，模型侧完全不可见），此时一次 sync（哪怕随后失败）就把这份唯一副本永久删掉。报告作者把真实函数抽出来配真实子进程、在有界 fixture 上复现，并明确区分「实测」与「46 G 规模的推断」；本版按该报告建议修复：
  - **新不变式**：**体积哨兵 → 解包到临时目录 →（整树时）比对「只存在于镜像的文件」→ 原子替换 → 恢复占位文件**。任何一步失败，旧镜像都原样保留，错误信息里明确写「本地镜像未改动」。
  - **临时目录 + 原子替换**：新内容先解到同级 `.dsh-sync-tmp-<basename>-<stamp>-<pid>/`，`tar` 两端退出码都为 0 才 `rename` 替换（旧目录先挪成 `.dsh-sync-old-*`，替换失败自动回滚并说明回滚结果）；成功后补写 `.remote-ssh.json` **与占位 `README.md`**（旧实现里前者由调用方补写、后者**没人补** —— 一次 sync 后镜像根说明文件就永久消失）；中断残留的 tmp/old 目录在下次同步时按 1 小时年龄清理。
  - **新增「仅存在于镜像的文件」保护**：整树替换前用 `scanMirrorOnly()` 比对旧镜像与临时目录（跳过插件自有的 `.remote-ssh.json` 与按首行指纹识别的占位 README；8 秒 / 2 万条目预算），一旦发现本地独有文件就**默认拒绝**，并把清单（最多 20 条，`onlyMirror` / `onlyMirrorTotal` 字段）回传给模型；拒绝理由给两条出路 —— ① 先 `remote_ssh_push` 补推；② 确认放弃后带 `force: true` 重试。预算内无法完成比对时同样保守拒绝。
  - **体积哨兵（删除之前的唯一前置门槛）**：先 `du -sb -c -- <目标>`（**只测本次要同步的范围**：整树 = 远端根，`paths` = 那些子路径）并带 15 秒预算；超过上限（默认 **2 GiB**，可用 `syncMaxBytes` / `DSH_REMOTE_SSH_SYNC_MAX_BYTES` 调整）或探测超时 / 远端无 `du` / 输出不可解析，**一律拒绝**并要求显式 `force: true`（保守优先：宁可让用户多传一个参数，也不做不可撤销的全量复制）。
  - **范围控制**：`remote_ssh_sync` / `remote_ssh_push` 新增 `paths`（只同步这些子路径，**局部同步只覆盖对应子路径、不删除镜像里任何其它文件**）、`exclude`（下推为远端/本地 `tar --exclude=./x`）；两者随工作区持久化（`WorkspaceSchema` 新增 `syncExclude` / `syncPaths` / `syncMaxBytes`，`updateWorkspace` 可写入），逐次调用可覆盖。越界规则（`../`、绝对路径、`~`、单独 `.`）在归一化时直接丢弃，不进 tar 参数。
  - **命令形状经真实工具实测**：`--exclude=./data` / `--exclude=./*.log` 在真实 tar 上确实排除（`data/big.bin`、`top.log` 都不进镜像）、`tar cf - -C <根> src` 只打包该子路径、push 的 `--exclude=./README.md` 不把占位文件解到远端根、`du -sb -c -- <目录> | tail -n 1 | cut -f1` 在真实 GNU coreutils 上取到合计字节。
  - **墙钟预算**：同步/推送新增 `timeoutMs`（默认 10 分钟，`DSH_REMOTE_SSH_SYNC_TIMEOUT_MS` 可调，0 = 不限）——旧实现的 46 G 拉取**既不会超时也无法从插件侧取消**，只能杀进程。
- **`remote_ssh_push` 会把插件自己的文件解到远端根目录**：镜像根的 `README.md`（工作区创建时由插件写入）与 `.remote-ssh.json`（连接信息）此前会随 `tar cf - -C <镜像> .` 一起被解到**远端 `remotePath` 下**。现在 push **始终**排除 `.remote-ssh.json`（连接信息绝不推到远端），并按**内容指纹**（首行 `# 🌐 Remote Workspace / 远程工作区`）判定占位 README 后排除 —— 用户自己写的同名 `README.md` 不会被误伤（有专门的回归断言）。
- **工具描述写明整树语义**：`sync` 的描述改为「**整树**拉取、可用 paths/exclude/force、远端超过上限会被拒、镜像独有文件默认拒绝删除」，并加一句「**读远端文件请用文件面板或 `remote_ssh_cat`，不要用 sync**」——旧描述的「把远端文件同步到本地镜像目录」完全没有体积与破坏性的暗示，这正是 issue #20 现象一的诱因之一。
- **`armPipeTimeout` 不 `unref()`**（实现过程中由测试抓到）：`unref` 过的定时器在事件循环空转时会被跳过，而「两端进程都卡住、没有其它句柄」恰恰是最需要它触发的场景 —— 预算到点必须真的能终止管道（`done` 结束后立即 `clearTimeout`）。
- 顺带：被拒/失败路径不再有任何"先删后写"步骤；`remoteSyncDown` 的签名加了 `runner`（体积探测走池化 SSH 会话）与 `opts`，四处入口（2 个模型工具 + 2 个 HTTP API）统一经 `syncOptsFrom(ws, args)` 组装参数。

### 测试
- 新增 `tests/sync-safety.test.mjs`（**86 条断言**）：抽出真实实现区（常量 + helpers + `remoteSyncDown`/`remoteSyncUp`），注入真实 fs 与可编排的假 `spawnOne`/假 runner，逐条验证 —— ① 哨兵在任何 `rm` 之前（记录 `rm` 调用序列断言为空）、超限/超时/不可解析三种拒绝、`force` 跳过、`maxBytes` 逐次覆盖、`paths` 时只探测子路径；② 失败不毁镜像（ssh 退出码、本地解包退出码、墙钟超时三种，`keep.txt` 逐条断言仍在 + tmp 清理 + 无 `.dsh-sync-old-*` 残留）；③ 整树成功后镜像 = 远端树、`.remote-ssh.json` 与占位 README 恢复、远端自带 README.md 时不被覆盖、解包目标是临时目录；④ 「仅存在于镜像」拒绝（回到清单、两条出路）与 `force` 时的显式放弃；⑤ push 排除 `.remote-ssh.json` 与占位 README、**不**排除用户自己的 README.md、tar 选项在操作数之前、失败时不清缓存；⑥ 越界 `exclude`/`paths` 丢弃与 `--exclude=./x` 精确形态；⑦ 选项组装（逐次参数 > 工作区字段）与 `updateWorkspace` 写入三个字段；⑧ 静态防线（`remoteSyncDown` 里不存在 `rm(mirrorPath)`、哨兵 < 解包 < 比对 < 替换的文本顺序、schema/参数/描述/四处入口与旧签名清零）。
- `tests/tool-output-schema.test.mjs`（21 条，+4）：改为使用同一份实现区抽取，`remoteSyncDown` 传入体积探测桩；新增断言 `bytes`/`paths`/`onlyMirror`/`onlyMirrorTotal` 都在 `syncOutput.schema` 里（`additionalProperties: false` 会拒未声明字段 —— 这正是 issue #14 的教训）。
- 全套 **21 个文件 864 条断言**通过（原 20 个文件 774 条）。

## [2.4.19] — 认证失败不再"答非所问"：先给一手证据（私钥文件不存在 / 远端允许交互式认证），再给登录横幅降噪
### 修复
- **「连接失败：公钥认证失败」把真实根因埋在二维码横幅里（issue [#19](https://github.com/ZhangFengshun/dsh-remote-ssh/issues/19)，2026-10-03 jackie2455 报）**：用户贴出的「测试输出」里真正的根因只有一行 —— `Warning: Identity file "…\id_rsa.cloud_and_wsl" not accessible: No such file or directory.`（**配置的私钥文件根本不存在**），而它被两件事埋掉了：① 这行是 `Warning:` 而不是 `debug1:`，正好落在 `testConnection` 的 `-v` 诊断过滤器之外（过滤器只捞 `debug1: Offering public key|Trying private key|…`）；② 服务端 `/etc/ssh/banner.txt` 的**预认证登录横幅**（腾讯云的扫码二维码 ASCII 画）被拼进了「原始信息」的 300 字截断窗口，把关键行挤了出去 —— 用户因此判断成"是扫码导致的连接失败"。现在认证类失败按**证据优先**重排：
  - **私钥文件不存在直接作为首条提示**：新增 `findMissingIdentityFile()` 识别 `Warning: Identity file "…" not accessible`（无引号形式与 `debug1: no such identity:` 兜底都覆盖），命中即输出「配置的私钥文件不存在或不可读：<路径>」并给两条可执行动作 —— 改 `keyPath`，或清空 `keyPath` 改用 ssh-agent / `~/.ssh/config` 里的 `IdentityFile`。
  - **`-v` 诊断过滤器补上这行**：`Identity file .*not accessible` 现在会进入「ssh -v 诊断」，没有预检也看得见。
  - **交互式认证的边界讲清楚**：新增 `offeredAuthMethods()`，从 `Permission denied (publickey,password,keyboard-interactive)`（或 `Authentications that can continue:`）取远端允许的认证方式；只要含 `password`/`keyboard-interactive` 就补一段说明 —— 扫码、动态口令/二次验证属于**交互式**认证，而本插件的文件与工具能力走**非交互**公钥通道（`BatchMode=yes` + `PreferredAuthentications=publickey`），不会弹出扫码提示；需要交互式登录请用内置**「终端」页签**（shell wrapper 是 `ssh -tt`、不设 BatchMode，可扫码/输密码），文件能力则需在远端 `~/.ssh/authorized_keys` 收录公钥。
  - **登录横幅降噪**：新增 `stripLoginBanner()` —— 判据是"整行几乎只有装饰字符（框线/方块/ASCII 画）**且**不是诊断行"（诊断行白名单 `debug\d+:` / `Warning:` / `Permission denied` / `Authentications that can continue` / `Identity file` / `Connection …` 等一律保留，短行也保留），命中即丢弃并附一句「（已省略服务端登录横幅 N 行：它在认证前打印，与本机认证结果无关）」，避免用户再把横幅当成报错内容。
  - **「原始信息」改为诊断行优先**：新增 `sshExcerpt()` 取代原来的 `stderr.trim().slice(0, 300)` 硬截断 —— 有诊断行时只列诊断行（去重、最多 8 行、超长省略），没有才回落到原文。
- **`keyPath` 预检：私钥文件不在就别等到 SSH 往返之后（但也不阻断探测）**：`testConnection` 先 `expandSshPath()` + `existsSync()` 检查配置的私钥文件；不存在时把「⚠️ 配置的私钥文件不存在：<路径>（若你依赖 ssh-agent 或 `~/.ssh/config` 里的 IdentityFile，可清空 keyPath）」前置到失败原因之前。**仍然照常探测** —— ssh-agent 或 `~/.ssh/config` 里的其它身份可能让连接真的成功，那种情况把这个提醒放进结果的 `warning` 字段，设置页「测试连接」成功时一并显示（此前成功路径只显示 `echo` 回显）。
- 顺带把送进 `sshErrorHint` 的 stderr 由空格拼接改为**按行拼接**（`sshExcerpt` 按行取诊断才有意义）。

### 测试
- 新增 `tests/auth-error-diagnostics.test.mjs`（**52 条断言**）：A 段实例化 5 个纯函数（`stripPqBanner` / `stripLoginBanner` / `findMissingIdentityFile` / `offeredAuthMethods` / `sshExcerpt`）跑真实输入 —— 二维码横幅被丢弃且省略行数统计正确、诊断行与短行永不被误删、带引号 / 无引号 / `no such identity:` 三种私钥缺失形态都能取到路径、无证据时不误报、认证方式提取与回落、截断只保留诊断行且超长带省略号；B 段把 issue #19 的**真实 stderr（已脱敏）**喂进 `sshErrorHint`，断言证据在前、路径与修复动作齐全、二维码不出现、不再用泛泛的"公钥认证失败"掩盖根因、交互式边界与「终端」页签指路都在，并以"远端只提供公钥"作负向控制（不硬塞交互式建议）；C 段为接线断言（`existsSync` 预检、`expandSshPath` 展开、成功路径带 `warning`、失败路径前置预检、`-v` 过滤器含 `Identity file … not accessible`、按行拼接、旧硬截断已清零、客户端展示 `warning`、`lib/client.js` 可解析）与版本/文档一致性（含本文与 README 的两处记录）。

- 全套 **20 个文件 774 条断言**通过（含新增 52 条；另把 `fs-trees-contract` / `open-external-contract` 里写死的版本号断言改为「`package.json` 与 CHANGELOG 顶部版本一致」——此前每发一版都要手改测试字面量，属测试自身的维护成本）。

## [2.4.18] — 适配 better-sidebar 0.23/0.24（`fs.trees`、`fs.mkdir`、`open.external`）+ 未安装 better-sidebar 时不再卡住 web boot
### 修复
- **远程项目的侧边栏文件树显示的是本地目录（用户 2026-09-29 反馈：「侧边栏的文件打开是本地目录而不是远程目录」）**：`dsh-better-sidebar` ≤ 0.22.1 的文件树每展开一层发一次 `fs.tree`（N 次 POST）；**0.23/0.24 起改为一次 `fs.trees` 批量请求「可见集」**（工作区根 + 所有已展开目录，≤64 条，客户端按返回的 `level.path` 落缓存）。本插件此前只注册了 `fs.tree` 的 exact 路由 → 新版的树列举**绕过了拦截**，直接落到 better-sidebar 自己的宿主实现（读本地 fs）→ 远程项目里看到的正是**本地镜像目录**，点开文件也读本地。现在注册 `fs.trees` 并实现批量分支（远程走 SSH，本地照旧走本地 fs）。
  - **一次 SSH 往返列举 N 个目录**：新增 `remoteListDirsBatch()` —— 逐目录打印标记行（`__DSH_LVL__<路径>`）再 `find -printf` 列举，一次 exec 拿回全部结果（保持上游「一次请求」的意图，而不是退化成 N 次 SSH）；单层 `cd` 失败只让该层带 `error`（标记 `__DSH_LVLERR__`），**整批仍成功** —— 与上游「某一层失败不影响其它层」的语义一致。命中 `treeCache`（TTL 5s）的层 0 RTT，epoch（远端已变更）递增即作废。
  - **`level.path` 必须回显客户端给的路径**：客户端把 `level.path` 当缓存键（`storeLevel(level.path, …)`），所以镜像路径原样返回；条目内 `path` 同样映射回本地镜像路径（`fs.read`/`fs.write` 再由本插件映射回远端），对客户端完全透明。
- **新建目录同样落到远端**：0.23+ 新增 `fs.mkdir` 端点（`{path, name}`，单段名、不覆盖、返回新绝对路径）。此前未拦截 → 远程工作区里「新建目录」只会让**本地镜像**多出一个空目录（用户以为建好了，远端其实没有）。现在远程分支 `test -e` 判重（同名回 409）后 `mkdir -- <远端路径>`，并让父目录列举缓存失效；**不在本地镜像里建目录**（镜像不是事实来源，与 `fs.write`/上传一致）。
- **「打开方式 / 在文件管理器中显示」在远程工作区打开的是本地目录**：better-sidebar 0.24 的文件树右键菜单把**客户端已知的绝对路径**直接交给宿主打开器（Windows 上 `reveal` = `explorer.exe /select,<路径>`，`url` = `rundll32 url.dll,FileProtocolHandler <url>`），而客户端在远程工作区里只知道**本地镜像路径** —— 于是「在文件管理器中显示」打开本地镜像目录，「用 VS Code 打开」拉起本机 VS Code 打开 `vscode://file/C:\…镜像…`。（0.24 的"远程打开"能力要用户在 `openWith.sshHost` 里手填 SSH 主机，且填了之后路径仍是镜像路径，对远程机器无效。）现在本插件拦截 `/sidebar/api/open.external`（第 9 个 exact 路由）：远程工作区把路径翻译成**远端路径**，改开 **`vscode://vscode-remote/ssh-remote+<别名><远端路径>`**。
  - **别名取自 `~/.ssh/config`**：按「Host 同名」或「HostName 相同」+ **端口一致** + 用户兼容选出别名，让 VS Code 复用该条目的 `Port`/`User`/`IdentityFile`/`ProxyJump`（端口非 22 或走跳板机时这是唯一能连通的形式）；没有别名时标准端口退化为 `user@host`，否则**回退本机行为并打 warn**（宁可维持现状也不静默失败）。别名匹配是纯函数 `remoteEditorAuthority(profile, hosts)`，与 `listSshConfigHosts()`（已支持 `Include` 递归）共用同一份解析。
  - **`reveal` 的远端语义 = 打开该文件所在的远端目录**（`posixDirname` 后翻译成远端路径），即"这东西在远端哪儿"；`url` 保留客户端选中的编辑器 scheme（`vscode://`/`cursor://`/`zed://`…）。本地工作区行为与上游逐字一致（同一套 `revealCommand`/`urlCommand` 命令，argv 数组、不经 shell、`detached`+`unref` 不阻塞请求）。
  - **`~` 必须自己展开**：URL 不经过 shell，`ssh-remote+<别名>/~/run/...` 里的 `~` 不会被展开（VS Code 会去 stat 一个字面 `~` 目录）。工作区 `remotePath` 默认形态就是 `~/…`（真机两条工作区都是），所以拼 URL 前用 `printf %s "$HOME"` 取远端 home（**按 profile 缓存 10 分钟**，只在需要时查一次）把 `~`/相对路径展开成绝对路径；拿不到绝对 home 就**回退本机行为 + warn**（绝不拼出打不开的 URL）。纯函数 `expandRemotePathForUrl(remotePath, home)` 负责这段（`~user` 形态不支持 → 回退）。
  - 测试干跑开关 `DSH_REMOTE_SSH_NO_LAUNCH=1`：只记录将要执行的命令而不真正拉起打开器（自动化验证不弹窗）。
- **没装 `dsh-better-sidebar` 时客户端条目永久 pending，前端直接 `web boot: 1 entry did not activate`（issue [#18](https://github.com/ZhangFengshun/dsh-remote-ssh/issues/18)，2026-09-29 lyc10031 报）**：客户端半边的 `exports.inject` 把**第三方 bundle 提供的** `betterSidebar` 与内核服务并列声明成硬依赖，而 cordis 的 fiber **只要有一个 inject 键对应的服务没注册就整体停在 pending**（`Fiber._refresh()`：逐个键查 store，任一缺失即 `epoch = INACTIVE`，没有 required/optional 之分）——于是没装 better-sidebar 的用户前端报 `@zhangfengshun/dsh-remote-ssh: pending (waiting for service: betterSidebar)`、Desktop 还会弹「插件恢复」，**即便内核自带侧边栏、其余插件都正常**。现在 `exports.inject` 只声明内核一定提供的 `slots`/`locale`，better-sidebar 改为 `ctx.inject(["betterSidebar"], cb)` **子 fiber 软注入**（与前端自身 `e.inject(["uiRenderer"], …)`、本插件宿主半边软注入 `webRuntime` 同一套写法）：装了才注册远程文件编辑器页签，没装就静默降级 —— 设置页「远程连接」、模型工具、终端集成照常可用。
  - **真机 A/B（DSH 0.2.0-rc.2 沙箱，无头 Chrome 读前端真实状态）**：已发布 2.4.17 + 未装 better-sidebar → 屏幕上正是 `Failed to load plugins / web boot: 1 entry did not activate / @zhangfengshun/dsh-remote-ssh: pending (waiting for service: betterSidebar)`（精确复现）；换修复版 → 引导正常、`window.__dshRemoteSshGlobeStats` 已定义、设置页出现「远程连接」小节；再装回 better-sidebar 0.24.1 → 行为不变（回归通过）。
  - 边界说明：better-sidebar 缺席时**没有**远程文件树/编辑器页签集成 —— 内核原生侧边栏走的是它自己的一套 `/api/*` 通道（`fs.trees` 只存在于 dsh-better-sidebar），所以「文件」页签的远程读写依赖 better-sidebar。另外该 bundle 不在时宿主仍会打一条 `patch: entry "better-sidebar" not found` 的 warn（`dsh-app-boot` 对缺席 patch 目标无条件告警，无法关闭，属正常）。
- **本地工作区也必须实现这两个端点**：本插件注册的是 exact 路由 —— 只在远程分支处理会让本地会话的 `fs.trees`/`fs.mkdir` 变成 404，反而把原本正常的本地文件树弄坏。新增 `localMakeDir()`（单段名校验、不覆盖），`fs.trees` 本地分支复用 `localListDir` 逐层列举。
- 顺带抽出 `collectFindEntries` / `sortFindEntries` / `sidebarEntriesFrom`（单目录与批量列举共用同一套解析、排序与镜像路径映射，避免两套实现漂移）；远程工作区探测新增 `paths[0]` 兜底（`fs.trees` 没有 `path` 字段、只有 `paths[]`）。
### 测试
- 新增 `tests/fs-trees-contract.test.mjs`（**59 条断言**）：从真实源码截取 `remoteListDirsBatch` / `readPathsField` / `sidebarEntriesFrom` / `localMakeDir` + 假 runner，断言**一次往返列举 3 个目录**（不是 3 次 SSH）、标记分段与单层失败隔离、整批失败逐层带原因、含单引号路径的注入防护、TTL 命中 0 额外往返、epoch 递增作废缓存、`level.path` 覆盖请求集（客户端缓存键）、`localMakeDir` 真实落盘（含非法名 / 同名不覆盖）、以及 8 个 exact 路由与两条分支的接线断言。
- 新增 `tests/client-optional-deps.test.mjs`（**41 条断言**）：断言客户端 `exports.inject` 只剩内核服务（**不含 `betterSidebar`**）、页签注册改走 `ctx.inject(["betterSidebar"], …)` 子 fiber（含 `registerTab` 可用性守卫、`bsCtx.effect` 生命周期绑定、`remssh:editor` 的 `hidden`/`dedupeKey` 语义不变）、apply 里不再有裸取 `ctx.betterSidebar`、剩余 `betterSidebar` 用法全部空安全、宿主半边 inject 只含内核服务、以及 CHANGELOG/README/README_EN/MAINTENANCE 的记录与真机验证结论。
- 新增 `tests/open-external-contract.test.mjs`（**100 条断言**）：从真实源码截取 5 个纯函数执行 —— URL 解析（百分号解码、忽略 query/fragment、拒绝 http(s)、坏 `%` 不抛）、file URL 还原本地路径（`/C:/`、反斜杠、`//home/u`、`localhost`、`vscode-remote` 与自定义 authority 不误判）、别名匹配（HostName/Host 同名、端口或用户不符即拒、端口 22 才允许 `user@host`）、Remote-SSH URL 组装（空格/中文百分号编码、`u@h:2222` 原样、scheme 保留）、三平台打开命令形状；接线断言覆盖 exact 路由唯一注册、两条分支、回退告警、`detached`+`unref`、不经 shell、干跑开关。**真机验证**（DSH 0.2.0-rc.2 沙箱 + better-sidebar 0.24.1，干跑模式）：远程工作区 `reveal`/`url` 均命中远程分支（响应 `remote:true`），本地工作区仍走本机打开器。
- 全套 **19 个文件 722 条断言**通过（含上述两个新测试文件与更新后的 `trust-fence.test.mjs`：路由调用点 5 → 6）。


## [2.4.17] — 远程工作区「地球角标」的普适性：主题自适应 + 匹配容错 + 自检诊断
### 修复
- **浅色主题下地球角标不可见**（用户 2026-09-29 反馈：另一台电脑装同一版本后远程工作区文件夹图标上没有本机看到的地球角标）：该角标不是宿主原生能力 —— 壳层工作区行用的是固定图标原语（`IconFolderOpen16/Close16`），没有 per-workspace 图标 API，所以本插件在客户端半边按**工作区标题文本**定位那一行，再向行首文件夹 `svg` 追加一组"地球经纬线"（`data-rssh-globe`）。此前这组线的颜色**硬编码 `stroke="#ffffff"`**（同文件里的显示器图标却用 `currentColor`）→ **浅色主题下白线落在浅色侧边栏上几乎不可见**，看起来就像"没有角标"。现在改为取**文件夹图标自身的计算颜色**（`getComputedStyle().color`；透明或取不到时退回 `currentColor` 继承行文本色），浅色/深色主题都可见；几何与笔数（轮廓/经线/赤道/南北纬弧共 5 笔）完全不变。
- **标题匹配更耐操**（同一问题的次要成因）：标题文本先做**空白归一化**（折叠换行/多空格，壳层渲染可能插入）再匹配；候选元素集加入 `[title]`/`[aria-label]` 并支持按属性值匹配（部分主题把标题放在属性上、行内文本另有装饰）；继续兼容自愈前遗留的「🌐 」前缀标题。
- **新增角标自检与诊断**（便于在别的机器上一眼定位）：启动后 8s / 25s 各做一次自检，只在"**宿主返回了远程工作区、但工作区行上一个角标都没加上**"时打一条 warn（区分"宿主未返回工作区"的另一种情形并给出不同提示）；控制台暴露 `window.__dshRemoteSshGlobeStats(true)`，输出 `{ remoteWorkspaces, decoratedRows, globesInDom, watchedRows, titleKeys, titleSamples }` —— 可区分①客户端半边未加载（接口不存在）②宿主/设置未就绪（`remoteWorkspaces: 0`）③标题未匹配（`titleKeys` 与 `titleSamples` 对不上侧边栏文字）④壳层 DOM 结构变化（有工作区但 `globesInDom: 0`）。
### 测试
- 新增 `tests/workspace-globe.test.mjs`（**25 条断言**）：用**真实源码**截取角标相关函数 + 最小假 DOM，断言颜色主题自适应（传入计算色 / 取不到退回 `currentColor` / **代码里不再出现硬编码白色** / 5 笔几何与线宽不变）、计算色解析（深色、透明、抛错、空元素四种情形）、幂等应用与计数（React 还原后复检不会重复追加）、标题归一化（首尾空白、换行折叠、空值），以及匹配容错与诊断接线（归一化匹配、`title`/`aria-label` 容错、旧 🌐 前缀兼容、工作区计数、自检入口与告警文案、8s 延迟自检）。全套 **16 个文件 522 条断言**通过。

## [2.4.16] — 适配 DSH 0.2.0-rc.1：通过 harness 的插件兼容性门（peer 版本范围）
### 修复
- **插件不再被新版 harness 拒绝安装/激活**：DSH 0.2.0-rc.1（DeepSeek Harness 桌面端 nightly，2026-09-28 更新）的插件管理器会用**插件自己声明的 DSH peer 版本范围**判定兼容性；范围覆盖不到当前运行时版本时，`dsh plugin add` 直接**拒绝**（`Plugin @zhangfengshun/dsh-remote-ssh@2.4.15 is incompatible with dsh 0.2.0-rc.1: peerDependencies … compatible with this dsh runtime`），已装的捆绑包也不会激活（宿主里看不到本插件的任何 entry / 工具），只能靠 `dsh plugin allow-version … --accept-risk` 逐版本豁免（官方警告可能崩溃、丢数据）。2.4.15 只声明 `^0.1.0-rc.6` → 在 0.2.0-rc.1 上被整条拦下。现在三条 DSH peer（`dsh-tools` / `dsh-client-locale` / `dsh-client-ui-primitives`）都显式列出**每条已验证版本线**：`^0.1.0-rc.6 || ^0.1.5-rc.1 || ^0.1.7-rc.2 || ^0.2.0-rc.1`，**无需任何豁免**即可安装与激活。
  - 之所以要逐条列：判定用**严格 npm semver** —— 预发布版本只被"元组相同且自身带预发布"的比较器接受，所以 `^0.1.0-rc.6` 既覆盖不到 `0.1.5-rc.1`/`0.1.7-rc.2`，也覆盖不到 `0.2.0-rc.1`（`dsh-cron` 用同样的逐条列法）。
- **客户端注入清单去掉运行时已不提供的包**：`@deepseek-ai/dsh-client-runtime` 自 0.2.0-rc.1 起不再随运行时提供（本插件代码也从未使用它，客户端半边只 `require` `react` 与 `@deepseek-ai/dsh-client-ui-primitives`），从 `dsh.client.inject` 移除，避免客户端半边去解析不存在的包。
### 验证（真机，DSH 0.2.0-rc.1）
- 把官方 **0.2.0-rc.1** CLI 装到临时目录，用 shipped 的 `web` 模板建一次性 profile：修复前 `dsh plugin add` **被拒**（原文见上）；修复后**安装被接受**并进入 bundles。
- 以该 CLI 启动实例（备用端口，不打扰正在使用的桌面会话）：插件**正常挂载**（`/remote-ssh/api/listProfiles` 返回 200）；`settings` 新 API 读取正常（形状探针：`form=true ns=remote-ssh valueProfilesArray=true`）；**升级后首次启动**即从旧 `settings.yaml` 恢复 **2 条连接 + 2 个工作区**（原 id / host / port / keyPath / profileId / title 全对）；`--dump-config` 确认 `terminal-controller` 仍拿到本插件的 wrapper（`patchId` 命中，0.2.0-rc.1 的 entry 以 `include:` 前缀组合不影响 patch 目标）。
- 与运行中的宿主的接口目录逐项对拍：`webServer` / `fs.writeText`+`editText` / `fileReferences` / `tools` / `subprocess` / `workspaceRegistry` / `sessions` / `profileContext` / `settings` 全部仍在；`ctx.webRuntime`（信任围栏的信任源）**已被移除**，软注入下自动退回 loopback-only（与 2.4.9 行为一致；桌面端本身以 `networkExposure: loopback` 运行，功能无损失）。客户端槽位 `sidebar.workspaces.directoryFlow` / `conversation.hero.workspace.directoryFlow` / `settings.section` 等仍然存在。
### 测试
- 新增 `tests/manifest-compat.test.mjs`（**43 条断言**）：内置**严格 npm semver** 比较器（含回归点自检：`^0.1.0-rc.6` 必须**不**覆盖 `0.2.0-rc.1`），断言每个 DSH peer 覆盖**全部已验证版本线**（0.1.0-rc.6 / 0.1.5-rc.1 / 0.1.7-rc.2 / 0.2.0-rc.1）与当前官方最新、且**不越界**声明未验证的线（0.3 / 1.x）；`cordis` 范围覆盖运行时实际版本；`dsh.bundle.patch` 指向的文件存在；`dsh.client.inject` 含客户端半边真正引用的包、且不含已移除的 `dsh-client-runtime`。官方再开新版本线时这条测试会失败，提醒扩范围而不是让用户点"接受风险"。

## [2.4.15] — 适配 DSH 0.1.7-rc.2：settings 新 API + 旧数据迁移 + 原生终端（issue #16 / #17）
### 修复
- **连接与工作区不再变空列表（issue #16）**：DSH 0.1.7-rc.2 的 `settings` 服务移除了 `register(ns, schema)`，改为 `configure / describe / update / replace / mutate`；用户偏好存放于**本插件 loader 行的 Config**，命名空间是 **entry id**（我们的 bundle 里是 `remote-ssh`），而旧 settings 的 section 键是**包名** `dsh-remote-ssh` —— 因此升级后旧数据既读不到、也不会被自动迁移。现在：
  - **双版本兼容**：按能力探测分支——新版走 `describe({redactSecrets:true})` 按 entry id 读、`update(entryId, patch, revision)` 写（带 revision 防并发覆盖）、`configure({auto:false})` 注册页面策略；旧版（≤0.1.6，含 0.1.5-rc.x）保留 `register + scope.get()/update()`；两者都不可用时退回 `apply(ctx, config)` 的值（只读并打日志）。
  - **Config 字段必须 `.volatile()`**：`Config` 改为由 `PrefsSchema` 派生并逐字段标 `.volatile()` —— 只有 DSH 分支的 `@deepseek-ai/schemastery` 实现该标记（公共 `schemastery` 没有），没有它新版 Loader 的 volatile-commit 路径不会提交，写入会"报成功但值不变"。依赖相应从 `schemastery` 换成 `@deepseek-ai/schemastery`。
  - **一次性迁移旧数据**：`ctx.loader.await()` 之后读 `$DSH_HOME/settings.yaml.imported`（退 `settings.yaml`）里 `dsh-remote-ssh` section 的 `profiles` / `workspaces`，**仅在用户层为空时**导入（绝不覆盖升级后的设置），把原连接 ID、工作区 ID、mirrorPath 全部还原——**用户不需要重建任何连接或工作区**。新增 `yaml` 依赖用于解析退役文档。
- **远程工作区不再静默打开本地终端（issue #17）**：DSH 0.1.7-rc.2 起侧边栏终端由宿主原生 `terminal-controller`（`@deepseek-ai/dsh-api-terminal-controller`）管理，其 `Config.shell = { path, name, args }`，**不再读** `better-sidebar.config.shell`。`cordis.patch.yml` 现在**同时**把 wrapper 交给两个入口（`terminal-controller` 与 `better-sidebar`，后者供旧侧边栏版本），路径按平台动态解析；旧版 DSH 没有该 entry 时 patch 目标不存在、被忽略（无害）。wrapper 本身不变：远程工作区（cwd 含 `.remote-ssh.json` 且 keyPath 非空）→ `ssh -tt` 连远程；本地工作区 → 本地 shell。

### 测试
- 新增 `tests/settings-compat.test.mjs`（**43 条断言**）：`ownEntryId`（fiber 命中 / 同包名未禁用回退 / 全禁用 → undefined / loader 抛错安全）、旧 section 解析（取字段、过滤未声明顶层键、YAML 损坏不抛、section 非对象、过滤后为空不写）、旧文件读取（`.imported` 优先、退回 `settings.yaml`、都不在 → undefined、空 home）、`prefsArray`（volatile 引用对象不是数组，退回 apply(config)）、新版外观（按 entry id 读、`redactSecrets`、`update` 带 revision 与只带被改字段、表单缺失回退、describe 抛错不炸）、迁移（用户层为空才导入、已有值不动、无 profile home / 无旧文件的分支）、以及接线与 schema 断言（volatile 派生、Config 定义顺序、双版本分支、`loader.await` 时机、两个新依赖）。
- 新增 `tests/terminal-integration.test.mjs`（**23 条断言**）：解析 bundle patch 并**真实求值**两条 `!!js` 表达式（win32 / linux 各一组）——`terminal-controller` 必须得到 `{ path, name, args }` 且字段恰为这三个、两个入口指向同一 wrapper、Windows 用 `.cmd`；并与宿主 `terminal-controller` 的 Config schema 对拍（`shell` 是对象联合体、`path`/`name` 必填、`args` 为字符串数组）。
- `tests/module-load.test.mjs` 改为**自动解析源码里的裸依赖**并 junction 到真实包（新增依赖不会再伪装成加载失败）。

## [2.4.14] — 远程工作区里 agent 的 `write`/`edit` 现在会同步到远端（issue #15）
### 新增
- **模型侧文件工具写回远端**（感谢 @Linhaojing 的桥接面分析与三条修法）：远程工作区会话里 agent 的 `write` / `edit` 走的是**进程内 `ctx.fs`**（宿主 base bundle 挂的是本地 `fs-sandbox`），不经过任何 HTTP 路由——因此此前只落**本地镜像**，用户在远端机器上找不到文件，只能人工 `remote_ssh_push`/`scp`；工具返回"已创建"而远端 `ls` 为空，容易被误判为失败。这与 #10（`fileReferences` 是进程内服务）同源不同面。
  - **接法刻意保守**：包装 `ctx.fs` 的 `writeText` / `editText`，**原方法照旧调用**——镜像内容、沙箱围栏（`sandboxPolicy`）、写意图（`createIfAbsent` / `replaceIfVersion`）、`signal` 全部原样透传，我们**不伪造 `FsTarget`、不改 `resolve()` 行为**，只读它的返回值（`FsWriteOutcome.after` / `FsEditOutcome.after` 即写入后的完整内容）；
  - 成功后把**这一份内容定向推回远端对应的那个文件**（沿用既有 `remoteWriteFile` 的 base64 写入 + 缓存失效），写前自动 `mkdir -p` 远端父目录；**不调用整镜像 push**（那会用旧镜像覆盖远端其它文件——正是报告者担心的点）；
  - **等待同步完成再返回**：工具说"写好了"时远端已有该文件，消除"说写了却找不到"的歧义；
  - **失败只告警，绝不让写操作变失败**：本地写入已成功，推送失败打一条 warn（提示可用 `remote_ssh_push` 补推）；
  - 路径识别用「向上找最近的 `.remote-ssh.json`」（有界 8 层），非远程工作区路径直接返回 → **本地会话零影响**；软注入 `ctx.fs`（服务缺失/被替换时退回旧行为并打日志），清理时恢复原方法。
- **文档补齐**（同 issue 的方案 1）：README「原理」与「缓存与一致性」写明模型侧文件工具的落点与 2.4.14 起的同步行为；新增一条已知限制——**agent 的 `read` 仍读本地镜像**（远端被他人改动时 agent 读到旧内容，需 `remote_ssh_sync` 刷新）。

### 测试
- 新增 `tests/fs-write-bridge.test.mjs`（**33 条断言**）：`installFsWriteBridge` 行为（原方法先调用、返回值透传、`expected`/`signal`/`sandboxPolicy` 原样透传、`target` 不被伪造、回调收到 `processPath` 规范路径与 `outcome.after`、原写入抛错时不回调、回调抛错不影响写入结果且只告警、无 `processPath` 时退回 `displayPath`、非法服务安全返回 null、恢复函数生效）、`findMirrorRoot` 真实文件系统测试（嵌套深层识别、非镜像路径、标记缺字段不误判、超 8 层有界）、以及接线断言（软注入、清理恢复、定向推送而非整镜像、`mkdir -p` 父目录）。

## [2.4.13] — `remote_ssh_push` / `remote_ssh_sync` 成功却报 `returned invalid output`（issue #14）
### 修复
- **推送成功却被判为工具输出非法**（感谢 @Linhaojing 的根因定位与复现）：`sync` / `push` 共用的 output schema 把 `error` 声明为**必填**且 `additionalProperties: false`，而两条成功路径返回 `{ ok: true, mirrorPath }` / `{ ok: true, remotePath }` —— 成功时既缺 `error` 又带未声明字段，必然被 output 校验拒掉；**失败路径反而合法**，于是症状是「**只有成功会报错**」：模型看到 `Error: tool "remote_ssh_push" returned invalid output: missing required property "value.error"; "value.remotePath" is not a declared property`，但远端文件其实已经写好了，只能靠再跑一次 `ls`/`sha256sum` 确认，很容易误判成需要重试。而这条链路正是远程工作区里 agent `write`/`edit` 落回远端的唯一通道，成功信号不可信影响面不小。
  - `syncOutput` 现在声明 `remotePath` / `mirrorPath`（成功路径本来就会带），`error` 改为**可选**；
  - 两条成功路径补上 `error: ""`，与同文件其它工具（`normExec()`、`remote_ssh_ls` / `cat` / `grep` / `glob`）的风格一致；
  - **并把全文件 6 处 output schema 的 `error` 一律改为可选**（通用护栏：`error` 按定义在成功时不存在，标必填就是定时炸弹）。失败路径的 `{ ok: false, error }` 不受影响。

### 测试
- 新增 `tests/tool-output-schema.test.mjs`（**17 条断言**）：用**真实的 `remoteSyncUp` / `remoteSyncDown`**（桩掉 `subprocess`）取实际返回对象，再用**真实的 `syncOutput.schema`** 跑一个模拟宿主校验器的 mini-validator（必填齐全 + 无未声明字段 + 类型正确）——成功路径、参数缺失失败路径、非零退出码失败路径全部通过校验；另有静态护栏断言（**任何** output schema 都不得把 `error` 标成必填、`ok` 仍必填、两个路径字段已声明）与**反向自检**（把历史的坏 schema 喂给校验器，逐字复现报告者看到的 `missing required property "value.error"; "value.mirrorPath" is not a declared property`）。

## [2.4.12] — 公开产物脱敏（无功能改动）
### 变更
- **移除文档、代码注释与测试夹具中的真实标识**：此前 CHANGELOG / README / 代码注释 / issue 回复里出现了真实的项目名、HPC 主机名、内网 IP、真实远程路径与镜像目录 ID。现已全部替换为通用占位符（`proj-a` / `my-project` / `project-b`、`~/proj`、`hpc-a.example.com`、`192.0.2.10`（TEST-NET-1 文档网段）、`wmirror1`…、`solver`），并在 `MAINTENANCE.md` 写入硬规则：**公开产物一律用占位符**，发布前跑一次私有标识扫描。README 七夕段落里刻意保留的署名不受影响。
- **本版不含任何功能改动**：与 2.4.11 的代码逐字相同，仅为让 npm 上的 `latest` 产物不再包含上述标识（2.4.11 的 tarball 因 npm 撤回策略限制无法删除，见 `MAINTENANCE.md`）。

## [2.4.11] — `fs.search` 返回契约对齐 better-sidebar：补上 `matches`（issue #13）
### 修复
- **「文件」页签的「按文件名搜索」不再崩掉整块页签**（感谢 @Linhaojing 的契约考古与最小复现）：better-sidebar 客户端契约是 `{ matches: string[], truncated }`（其注释原文：*matches are cwd-relative '/'-separated paths*，自 v0.13.0 引入搜索框起未变），并在渲染阶段直接读 `results.matches.length` / `results.matches.map(rel => …)`；而本插件的 `fs.search` 拦截只返回 `{ entries: [{path,isDir}], truncated }`，于是 `undefined.length` 抛 TypeError 被 `RenderBoundary` 兜住 → 整个页签变成错误条、搜索框与文件树一起消失。因为拦截是**无条件**的（不区分远程/本地会话），**本地工作区同样复现**，与 better-sidebar 版本无关。
  - 两条分支统一经 `fsSearchResult()` 产出：`matches` **必定存在**且为 **cwd 相对、`/` 分隔**的字符串数组（与 better-sidebar 自带 `searchFiles` 的行为一致，结果行显示相对路径），`entries`（绝对路径 + `isDir`）保留作向前兼容；
  - 本地分支：`matches` 由 `toPosixRelative(sessionCwd, entry.path)` 从绝对路径裁剪而来（Windows 盘符路径大小写不敏感、POSIX 保持大小写敏感、前缀相近的非子路径不误裁、非 ASCII 安全）；
  - **附带修复远程分支的路径 bug**：`remoteGlob` 的 `files` 是 `find` 以命令行起点拼出的**远端绝对路径**，此前却用 `join(mirrorBase, f)` 拼成了畸形镜像路径（如 `<镜像根>/home/user/proj/src/a.jl`），远程搜索结果的路径本来就是错的；现在 `remoteGlob` 新增 `opts.relative`（`-printf '%P\n'`）取相对路径，`entries` 再据此拼镜像绝对路径（`remote_ssh_glob` 工具仍走默认的 `%p`，行为不变）。
- README 兼容性表中原先笼统的 `fs.tree/read/write/search（4 端点契约）` 一行，已改为显式写明 `fs.search` 的 `{ matches, truncated }` 契约。
- **远程工作区的搜索不再一直「加载中…」**（同 issue 的实测跟进：崩溃修好后，在真实的大型远程项目工作区里搜索变成永久 loading）。旧命令有两个致命点：① `… | sort | head -n 500` 里的 `sort` 会缓冲**全部** `find` 输出后才吐第一行，`head` 的提前短路完全失效；② 没有深度/时间约束，而 `find` 是深度优先——巨型子目录（`processor*` / 数据目录）会吃光预算，连顶层文件都轮不到。实测该工作区：**旧命令 5 分钟零输出**（还占住池化 SSH 会话，把文件树/读写一起拖住）。现在：
  - **浅层优先 + 有结果即返回**：第一趟 `-maxdepth 3`（3s 预算，实测冷 0.68s / 热 0.11s）——**只要有命中就立刻返回**，深挖转**后台预热缓存**（同一 query 的后续请求会拿到更全的结果）；只有浅层**一无所获**时才同步等深挖趟（`-maxdepth 8`，5s 预算，实测会吃满）。此前条件是「浅层命中 < 200 就同步深挖」，而文件名片段极少命中 200 个 → 几乎每次查询都要多等一趟 ≤5s 的深挖（用户实测反馈「有点慢」），现已消除；两趟结果合并去重后本地排序（不再需要远端 `sort`）。实测同一工作区：**浅层 0.96s 返回 43 条命中**（旧命令 5 分钟 0 条）；
  - **遍历前剪噪声目录**：`REMOTE_SEARCH_SKIP_DIRS` = 本插件索引排除表 ∪ 上游 `SEARCH_SKIP_DIRS`（`.git` / `node_modules` / `dist` / `.next` / `.pnpm-store` / `.turbo` / …）；
  - **远端墙钟预算**：`timeout`（macOS 回退 `gtimeout`，都没有则退回无预算版本由 SSH 层兜底）到点杀掉 `find`，并把**已收集到的部分结果**照常返回 + `truncated: true`——宁可给部分结果，也不让 UI 无限转圈；
  - **命中上限 200**（与上游 `DEFAULT_MAX_MATCHES` 一致）、**SSH 层 15s 超时**（不再占用池化会话 120s）、**同 query 30s 短缓存 + 并发合并**（连打键盘不会堆起一串 `find`），缓存挂 `cacheEpoch`（写/exec 后自动失效）。
- **`@文件名` 在某些远程项目里完全没有候选**（用户实测反馈：同一台机器上两个远程项目对照：一个正常、另一个全空；而单独输入 `@` 正常——因为 `@` 走目录列举、模糊查询走索引）。根因：索引在 git 仓库里首选 `git ls-files --cached --others --exclude-standard`，而 `--others` 需要**遍历整棵工作树**枚举未跟踪文件，在巨型项目上根本跑不完（实测该目录 **10s 被超时杀掉、零输出**；`git ls-files --cached` 反而只要 0.085s 且为 0 条——仓库里没有任何已跟踪文件）→ 20s 构建预算内拿不到条目 → 索引为空。现在三级降级，每级都有墙钟预算：
  - ① 完整 git（6s）→ ② 仅索引 git（3s，恒定快）→ ③ 有界 `find`（`maxdepth 3` + 5s；原为 `maxdepth 5` 且无预算，实测该目录 5 层遍历 >180s 都跑不完）；
  - 实测同一项目：新命令 **921 条 / 6.68s**（其中 916 条含 `solver`、`node_modules` 零残留），三级合计 ≤14s < 20s 构建预算；
  - **另外加了即时兜底**：模糊查询在索引尚未就绪（大仓库要 6.7s 才建好，而单次查询只等 900ms）时，**不再直接返回空列表**，而是用与侧栏搜索同一套有界 find（剪噪声 + 无 `sort` + `maxdepth 3` + 5s 预算，实测 **0.65s**）立刻给出候选；索引建好后自动切换到更全的索引结果。

### 测试
- 新增 `tests/fs-search-contract.test.mjs`（**34 条断言**）：`toPosixRelative`（POSIX / 尾部斜杠 / Windows 反斜杠 / 盘符大小写不敏感 / POSIX 大小写敏感 / 非子路径不误裁 / 空 base / null / 非 ASCII）、`fsSearchResult` 形状（`matches` 恒为字符串数组——**原崩溃点**、缺参数时仍为空数组而非 undefined、过滤空串与非字符串、`truncated` 归一化）、**契约模拟**（客户端 `.length` / `.map(rel)` 渲染相对路径 / 点击解析回 `entries.path`）、接线断言（两条分支、`remoteGlob` 的 `relative` 选项与 `%p` 默认值、不再有只回 `entries` 的旧分支）与 README 契约描述。
- 新增 `tests/remote-search.test.mjs`（**36 条断言**）：两趟命令生成（`-maxdepth 3/8`、3s/5s 预算、无 `sort`、`%P`、`head 200`、`-prune`、`timeout`/`gtimeout` 探测与回退）、**延迟策略**（浅层有结果立即返回、后台预热写回缓存、浅层零命中才同步深挖、浅层满额不再深挖、预算到点返回部分结果 + `truncated`）、硬失败不深挖且不缓存、缓存命中与 `cacheEpoch` 失效、三个并发同 query 只跑一趟遍历、以及 `fs.search` 分支的接线。

## [2.4.10] — 非 loopback 访问不再全线 403：信任判定改用宿主 webRuntime.trustedHosts（issue #12）
### 修复
- **信任判定与 `/api` 网关、better-sidebar 同源**（感谢 @Linhaojing 的验证矩阵与自我更正后的方案）：此前 `isTrusted()` 硬编码 loopback 白名单（`localhost` / `127.0.0.1` / `::1` / `0.0.0.0`），从局域网（例如经配对设备或反向代理访问）打开 GUI 时，本插件的 **5 类路由全部 403** —— `/remote-ssh/api/*` 全部 RPC、6 个被拦截的 `fs.*`、`git.*`、文件上传、`/sidebar/file`，也就是文件树 / 读写 / 搜索 / 重命名 / 删除 / git / 上传全线失效，插件几乎等于没装。而同一 Host 下 DSH 官方路由正常，说明是本插件单方面比宿主更严。
  - 现在改为读宿主官方运行时能力 **`ctx.webRuntime.trustedHosts`**（启动时采样的局域网 IP 字面量 + `--trusted-host` 指定的 authority）——与 `/api` 网关的 fence 及 better-sidebar 的 `src/trust-fence.ts` 完全一致（后者是 `@deepseek-ai/dsh-client-connection` 的 `api-request-trust.ts` 的拷贝，上游未导出这些 helper，故按同样方式复刻并在注释中标注来源）；
  - **按请求实时读取** `trustedHosts`：用户改动信任列表无需重启插件；
  - **软注入 `webRuntime`**（`ctx.inject(["webRuntime"])` 而非硬 `inject`）：万一宿主将来改名/移除该服务，插件仍能挂载，只是远程访问退回 loopback-only，行为与 2.4.10 之前一致——**零回归**；
  - 安全性不降低：`sec-fetch-site: cross-site` 与新增的 **Origin 围栏**（带 Origin 时必须与本请求 hostname 一致；`Origin: null` 拒绝）都在，Host 白名单依旧存在，只是信任源从硬编码换成宿主权威列表；用户未配置信任列表时 `trustedHosts` 只含 loopback，行为与之前完全相同。
- **403 文案不再误导**：此前无论何种拒绝原因都回 `missing x-requested-with header`，把排查方向带偏（提问者一开始就在查客户端是否漏带头）。现在按原因区分：缺头 → `missing x-requested-with header`（错误码仍为 `csrf`，保持兼容）、Host 不可信 → 明确提示 `untrusted host: … start DSH with --trusted-host <host[:port]> …`、跨站 → `cross-site request refused`、Origin 不符 → `origin does not match the request host`；`/sidebar/file` 的纯文本 403 也带准确原因。

### 测试
- 新增 `tests/trust-fence.test.mjs`（**61 条断言**）：loopback 判定（`localhost` / `[::1]` / `127.x.x.x` 整段 / 越界段拒绝 / `0.0.0.0` 历史放行）、authority 端口语义（条目带端口精确匹配、不带端口按主机名、无效条目跳过）、**逐条复现 issue #12 的验证矩阵**（`127.0.0.1:3080` ✅ / `localhost:3080` ✅ / 局域网 IP 无信任列表 ❌ / 局域网 IP + `trustedHosts` ✅）、cross-site 与 Origin 围栏（含 Edge 151 的「Origin 缺端口」特例与 `Origin: null` 拒绝）、文案区分（Host 被拒不再报缺头、并给出 `--trusted-host` 指引）、以及**组合行为**（提取真实 `requestTrust` + 桩 `trustedHosts`：可信局域网 + 缺头 → 报 `header`；信任列表被替换后立即生效）与接线断言（5 处调用点、软注入、实时读取、错误码兼容）。

## [2.4.9] — 「添加工作区」目录选择器支持新建目录（issue #11）
### 新增
- **「添加工作区」弹窗的目录选择器新增「新建目录」**（感谢 @Linhaojing 的定位与接线建议）：此前本地 / 远程两个 tab 都只有「打开 / 上级 / 选择此目录」，要把**尚不存在**的目录加为工作区（例如远端起新项目 `~/work/new-project`）必须先跳出 DSH 用别的终端 `mkdir`。现在底部操作区多一个「📁 新建目录」按钮：点开输入行 → 填名字（回车即提交）→ 在当前 `path` 下创建 → **自动进入新目录**，紧接着点「选择此目录」即可成为工作区，全程不离开 DSH（对齐 VSCode「新建文件夹」的交互预期）。
  - **两个 tab 都支持**：远程走既有 `api("mkdir")`（`mkdir -p` + 缓存失效，与远程资源管理器的「新建目录」同一条已验证链路）；本地新增宿主 API `mkdirLocal`（`fs.mkdir(recursive)`），补齐此前本地侧完全没有入口的缺口；
  - **名字校验**：只接受单个路径段——空名、`.`、`..`、含 `/` 或 `\` 一律拦截并给出中英文提示（避免「在 path 下新建」变成任意位置写入）；
  - **路径拼接**：`joinChild()` 沿用基路径的分隔符（POSIX `/`、Windows `\`，含 `C:\` 根与 `~` 前缀），不改变远端路径语义；
  - **失败与异常都不影响弹窗**：后端报错（如远端只读）展示原文且不跳转；Promise 异常被捕获；提交中按钮禁用并显示「处理中…」。

### 测试
- 新增 `tests/dir-picker-newdir.test.mjs`（**48 条断言**）：名字校验（空/空白/`.`/`..`/含分隔符/中文/含点号）、路径拼接（POSIX、尾部多分隔符、空基路径、根路径、`~`、Windows 反斜杠、盘符根、非 ASCII）、**组件行为**（提取 DirPicker 里真实的 `submitNewDir` 逻辑注入桩状态：非法名不调用 createFn、成功进入新目录、后端未回 path 时回退 joinChild、失败不跳转、异常被捕获、未进入新建状态时 no-op）、以及接线断言（两个 tab 都传 createFn、远程/本地分流、宿主 `mkdirLocal` 用 recursive mkdir、5 个 i18n 键中英齐全）。

## [2.4.8] — 修复大仓里 `@` 补全不可用：索引排除必须发生在截断之前（issue #10 实测反馈）
### 修复
- **根因**：2.4.7 的索引命令在 git 分支里是 `git ls-files … | head -n 20001 | sed …`——**先截断、后排除**（排除原本只在客户端 `refParseIndexOutput` 里做）。而 `git ls-files --cached --others` 的输出**不是全局字典序**：未跟踪文件按 readdir 顺序先输出，`node_modules/` 这类目录可能占满前两万行。实测报告者的仓库 node_modules 有 **18,880 条（84.5%）**，把 `head` 配额吃掉 94%，`AGENTS.md` 落在第 **20417** 行被整段切掉，`src/**`（1,742 个文件）同样全部缺失——症状是 `@AGENTS` 搜不到、返回一堆 pip 内部目录（命中 300 分子序列分支）。
- **修法**：把排除**下推到远端**、置于 `head` 之前——git 分支新增 `grep -vE '<排除正则>'`（正则由 `REF_EXCLUDED_DIRS` 单一事实来源生成，只匹配完整路径段，`distribution/` 这类前缀相同的普通目录不会被误伤）；find 分支本就用 `-prune` 在远端剪枝，无需改动。客户端的 `excludedSegment` 保留作双保险。
- **效果**（报告者仓库）：过滤后 **3,470 条 < 20,000 上限**，`AGENTS.md` 回到第 1,537 行、`src/` 1,742 条全部保留、输出体积从 1.44 MB 降到 205 KB（**−85%**）——该仓库本就不该触发截断，纯属顺序问题造成的误伤。
- **新增截断告警**（采纳其建议 1）：索引按上限 +1 行取样，若有效行数超限即打一条 warn（每个 workspace 只报一次），说明「文件过多、`@` 可能漏文件」并建议在远端 `.gitignore` 忽略构建产物/虚拟环境；避免用户只看到「搜不到」而不知被截断。

### 测试
- 新增 `tests/file-references-truncation.test.mjs`（**38 条断言**），其中 **B 段是真实端到端**：临时 git 仓库（已跟踪 `AGENTS.md` + `src/**`，未跟踪 400 个 `node_modules` 包）→ 用**真实代码生成**的命令跑**真实 POSIX 管道**，断言「旧行为（先截断）AGENTS.md 被切掉、前 200 行全是 node_modules」而「新行为 AGENTS.md 存活、src 40 条全保留、node_modules 零残留、输出更小」；另含命令结构断言（grep 必须在 head 之前、正则单一事实来源、完整路径段匹配、不误伤 `distribution/`）、解析器双保险与告警接线。
- 该测试还**锁定了一个此前未被记录的事实**：`git ls-files --cached --others` 非全局字典序（未跟踪文件在前）——夹具中 `AGENTS.md` 落在第 401/441 行。

## [2.4.7] — `@` 文件引用补全支持远程工作区（issue #10）
### 新增
- **远程工作区会话里 `@` 补全现在列远端文件**（感谢 @Linhaojing 的通道分析与挂载点核实）：`@` 补全由宿主 `ctx.fileReferences` 服务提供（官方 provider `@deepseek-ai/dsh-file-reference-local`），它只遍历**本地磁盘**——远程工作区会话的 cwd 是本地镜像目录，于是候选只有镜像里那几个文件（通常只有本插件写入的 `README.md`）。该链路不经过任何 HTTP 路由（客户端经 remote gateway 调 `ctx.fileReferences.list`），因此采用**服务层包装**：
  - 在 `ctx.inject(["fileReferences"])` 里包装已注册的服务实例，**远程工作区自己算候选**，其余一律委托回原实现——本地会话的索引与模糊排序**零改动**，不替换 composition row，也不新增 `@deepseek-ai/*` 运行时依赖；
  - 桥接侧动态解析服务（`dsh-api-session-controller` 的 `this.ctx.fileReferences.list(...)`），实例包装对其立即生效（已核实）；
  - 服务缺失或不可包装时打印一条 warn 并保持原行为；卸载时自动还原原方法。
- **查询语义与官方 provider 逐条对齐**：空查询/含 `/` 走目录列举、纯片段走模糊查询；隐藏文件仅在小片段以 `.` 开头时可见；评分常量（同名 1000 / 前缀 900 / 名称子串 700 / 路径子串 500 / 子序列 300+间隔惩罚）、目录 +25、排序 tiebreak（目录优先 → 路径短 → 字典序）、排除目录表（与上游 `DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES` 的 15 条一致）全部照搬。
- **索引来源按远端实际测量取舍**：git 仓库用 `git ls-files --cached --others --exclude-standard`（真实超算实测 **0.117s / 137 条**，尊重 `.gitignore`、含未跟踪文件），非 git 回退有界 `find`（`maxdepth 5` + 剪枝，实测 **1.57s / 3121 条**）——作为对照，深遍历 `find` 在同一仓库要 **18.6s**。
- **性能与降级**：索引按 workspace 缓存 60s 并挂到既有 `cacheEpoch`（写/exec 后自动失效）；单次查询只等 **900ms**，超时用陈旧索引或空结果作答、重建继续在后台（与本地 provider 的"陈旧索引照常回答"一致）；`AbortSignal` 已取消时直接返回空；任何异常一律降级到本地实现，绝不把光标卡在 SSH 上。

### 测试
- 新增 `tests/file-references.test.mjs`（**62 条断言**）：查询拆分、索引解析（git/find 两种帧、父路径合成目录、排除目录剪枝、符号链接跳过、CRLF、条目上限）、评分与排序（含逐条对照上游常量）、隐藏文件可见性、索引命令生成（两条分支 + 15 条排除目录）、服务包装（远程走远端 / 本地委托 / 异常降级 / 恢复函数 / 非法服务安全返回）、以及**真实 HPC 输出样例**喂给解析器。

## [2.4.6] — 「文件」页签树根显示远程目录名（issue #9）
### 修复
- **树根标签不再显示本地镜像目录 ID**（感谢 @Linhaojing 的链路定位）：better-sidebar「文件」页签的树根标签取自会话 cwd（= 本地镜像路径）的 basename，于是显示成 `wmirror3` 之类的镜像目录名。这条链路**不经过任何 `fs.*` 路由**，且 Host 侧 `session.cwd` 虽已返回 `root` 字段但客户端只消费 `cwd`（`api.sessionCwd(...).then(r => setFetchedCwd(r.cwd))`，另有 `useSessionCwd` 直接读客户端会话列表的 `cwd`），因此只能在渲染层替换文本。现由客户端取 `listWorkspaces` 的 `mirrorPath`/`remotePath` 建立「镜像 basename → 远程 basename」映射，把树根那一行换成**远程目录名**（如 `my-project`），并给该行加 `title` 显示完整远程路径（如 `~/work/my-project`）。
  - **定位不依赖构建期哈希类名**：根行是树里唯一带内联 `padding-left:6px` 的行，仅当该行内纯文本节点恰好等于某远程工作区的镜像 basename 时才替换——同名子条目、本地工作区、无根行标志（上游改版）时一律保守不动；
  - **同步替换 + 幂等自愈**：与设置导航图标同样在 MutationObserver 回调（微任务、绘制前）内完成，不会先闪一下镜像 ID；React 重渲染还原文本时由 1s 复检与 30s 工作区轮询恢复。

### 测试
- 新增 `tests/tree-root-label.test.mjs`：从 `lib/client.js` 提取**真实**实现配极简 DOM 桩执行，覆盖 7 组场景共 17 条断言（替换、假阳性防护、幂等、React 还原自愈、本地工作区、同名边界、样式容错、接线检查）。

## [2.4.5] — 集成终端落在工作区远程目录（issue #7）+ 密码认证回退提示
### 修复
- **「终端」页签现在落在工作区对应的远程目录**（感谢 @Linhaojing 的完整定位与验证矩阵）：此前生成的 `dsh-remote-shell.js` 只拼 host/user/port/keyPath/proxyJump，`ssh -tt` 不带远程命令，交互式 shell 落在远程 `$HOME`；同一会话里出现「文件树在工作区目录、终端在 $HOME」的割裂。现在 wrapper 读取标记文件里**已有的** `remotePath` 并追加远程命令：
  - `~`/`~/x` 的展开交给**远端** shell（`$HOME/...`）——本地 homedir 与远程不同，本地展开必错；
  - `cd … 2>/dev/null || cd "$HOME"`：目标目录被删/改名时回退，终端仍可打开；
  - `exec "${SHELL:-/bin/bash}" -l`：尊重远端登录 shell（zsh/fish 等），保持单进程与退出码语义；
  - 无 `remotePath` 的旧标记文件不追加命令，行为与 2.4.5 之前完全一致（向后兼容）。
- **密码认证的远程工作区现在会明确提示**：集成终端仅支持密钥认证，此前静默回退为本地 shell，用户会误以为已连上远程；现在向 stderr 打印中英双语提示（本地工作区与密钥认证路径不受影响）。

### 测试
- 新增 `tests/wrapper-terminal.test.mjs`：从 `lib/index.js` 提取**真实**的 wrapper 生成文本，用 CJS runner 桩掉 `child_process` 后捕获实际 spawn argv，覆盖 5 组场景（`~/子路径`、`~`、绝对路径、无 remotePath、非密钥认证）共 16 条断言。

## [2.4.4] — 文档结构补全（README 代码示例 / 兼容性矩阵 / 故障排查）
### 文档
- **新增「代码示例」章节**（中英双语）：6 组可直接照抄的示例——远程命令（含 `timeoutMs`）、文件读写、长时任务与挂起恢复（`timeoutMs: 0` / `remote_ssh_kill`）、远程工作区内的免参调用、`~/.ssh/config` 导入、镜像 sync/push，并给出真实返回值形状。
- **新增「兼容性」矩阵**：逐行列出 DSH 0.1.5-rc.1 / 0.1.2 稳定线、dsh-better-sidebar 0.15–0.18（4 端点）与 0.19.x（6 端点，并标注上游主机半边加载问题）、远程 sshd 的实测状态。
- **新增「故障排查」表**：公钥认证失败（口令密钥 / Administrators 授权文件 / 用户名写法）、git-bash 启动、文件页签「这类内容还没有可用的查看方式。」、终端仅密钥认证、`minimumReleaseAge`、命令挂起、大文件截断——每条给出原因与解法。
- **新增「安装」前置要求表与卸载命令**、README 顶部目录导航、「更新日志」入口与 Star 引导。
- 中文 README 与英文 README_EN 保持结构对齐。

## [2.4.3] — 适配 better-sidebar 0.19 新增端点（fs.rename / fs.remove）+ 版本兼容性核查
### 新增
- **拦截 better-sidebar 0.19 新增的 `fs.rename` / `fs.remove` 端点**（exact 路由从 4 条增至 6 条）：远程工作区的「重命名 / 删除」此前会落到本地镜像目录（0.19 之前 better-sidebar 没有这两个端点，操作走客户端 API，不存在该问题）。现在：
  - 远程工作区 → 走 SSH（`mv -f --` / `rm -rf --`），语义对齐 better-sidebar（单个路径段校验、目标已存在返回 409、禁止操作工作区根），并失效相关读/列举缓存；
  - 本地工作区 → 本地实现（不覆盖、lstat 判定符号链接、目录递归删除），契约与 better-sidebar 完全一致；
  - 旧版 better-sidebar（无此端点）不调用这两个路由，注册无副作用。

### 兼容性核查（重要）
- **dsh-better-sidebar 0.19.0 / 0.19.1（以及 0.18.1）在当前 DSH Desktop（v2.0.9，DSH 0.1.5-rc.1）上主机半边无法加载**：其 `lib/index.js` 以**值**方式导入 `SessionLogOffset`（`import { SessionLogOffset } from "@deepseek-ai/dsh-session"`），而 DSH 2.0.9 面向插件的模块面只提供该符号的**类型**声明，运行时导入抛 `does not provide an export named 'SessionLogOffset'` → better-sidebar 主机半边（fs/git/terminal/jobs 等全部 API）整体失效，侧边栏文件页签因此回落到「这类内容还没有可用的查看方式。」
- **已验证的版本矩阵**：`0.19.1`（导入该符号）、`0.19.0`（导入）、`0.18.1`（导入）→ 在 DSH 2.0.9 上不可用；`0.18.0`、`0.17.1`（不导入）→ 可用。本插件在 `0.18.0` 上逐点验证：`fs.tree/read/write/search` 返回形状、`betterSidebar` 服务与 `registerTab`、`/sidebar/upload` 上传拦截全部咬合。
- 建议：在 better-sidebar 修复该导入（或 DSH 恢复该运行时导出）之前，desktop profile 使用 **dsh-better-sidebar@0.18.0**；本插件对 0.18/0.19 两套契约均已适配。

## [2.4.2] — 修复设置导航显示器图标「先齿轮后显示器」闪现
### 修复
- **图标替换从防抖路径改为同步执行**：此前设置面板挂载后，显示器图标替换走 500ms 防抖定时器，用户会先看到半秒壳层默认齿轮再变成显示器图标。现在在 MutationObserver 回调里**同步原位替换**——回调是微任务、在浏览器绘制前执行，齿轮刚插入 DOM 就被换掉，**第一帧即最终图标**，无闪现。
- 防抖批量路径保留给工作区地球角标（依赖异步 remoteTitles 数据）；语言切换的全量补扫照旧。

## [2.4.1] — 设置页「远程连接」选项卡改用真实 SVG 显示器图标
### 变更
- **去掉标签文本里的 🖥️ emoji**：`settings.nav` 标签改为纯文本「远程连接 / Remote Connections」，不再以表情文字充当图标。
- **替换为真实 SVG 图标**：壳层对未知 `settings.section` 一律渲染齿轮兜底，且插槽契约暂不接受自定义图标（壳层注释：Desktop-owned display glyph kept local until the upstream slot accepts icons）。沿既有 DOM 方案把兜底齿轮原位替换为**桌面显示器轮廓图标**（圆角屏幕 + 支架 + 底座，16×16，`currentColor` 跟随主题，与 DSH 原语线稿风格一致）——与 🖥️ 语义最接近的真实图标。
- `replaceChild` 后 React 仅对已脱离文档的旧齿轮节点做属性更新，无对账冲突；设置面板按需挂载、语言切换、React 重渲染由 MutationObserver + 1s 幂等复检（`data-rssh-monitor` 判据）兜底。

## [2.4.0] — 命令级超时 + `remote_ssh_kill` 兜底恢复（issue #5）
### 新增
- **命令级超时**：一条挂起的远端命令（网络卡顿 / 远端进程僵死 / 等待 stdin 的 `cat`）此前会永久占用池化会话并阻塞其后所有命令，工具调用永不返回。现在所有 SSH 命令默认 **120 秒**超时：
  - 环境变量 `DSH_REMOTE_SSH_CMD_TIMEOUT_MS` 覆盖全局默认，`0` 禁用；
  - `remote_ssh_exec` 新增可选参数 `timeoutMs`（长时构建/训练显式放宽预算，`0` 禁用）；
  - 池化会话超时即**整体丢弃并自动重建**（挂起的命令仍占着共享 bash 进程，唯一可靠恢复是终止 SSH 重建），后续命令不受影响；
  - 一次性连接（`runRemote`）超时即 `handle.terminate()`，返回带 `isTimeout` 标记的错误；
  - 超时命令**刻意不做回退重试**（重试一条挂起的命令只会再次挂起）。
- **新增工具 `remote_ssh_kill`**：强制关闭某个连接的池化会话，或 `all: true` 关闭全部会话，返回 `{ ok, killed, active, message }`——agent 从此拥有挂起命令的兜底恢复手段，不再只能重启 DSH。
- 工具输出（exec 系列）新增 `isTimeout` 字段，模型可直接识别超时结果并决定恢复策略。

### 兼容性验证
- 逐点验证 **dsh-better-sidebar 0.19.0**（`fs.tree/read/write/search` 端点、`/sidebar/api` 挂载、`config.shell` 终端覆盖、client `betterSidebar` 服务与 `registerTab`、`/sidebar/upload` 上传拦截）与 **DSH 0.1.5-rc.1**（主机服务、`defineTool`/`settings.register`、UI slot、`workspaceRegistry`）全部咬合，无需代码改动。

## [2.3.9] — 修复 git-bash 启动导致的密钥认证失败（ssh 解析钉定到系统 OpenSSH）
### 修复
- **Windows 下 ssh 可执行文件优先解析为系统自带 OpenSSH 的绝对路径**（`%SystemRoot%\System32\OpenSSH\ssh.exe`，存在才使用，否则回落 PATH）：此前从 **git-bash** 启动 `dsh web` 时，子进程 PATH 里 Git 自带的 MSYS2 ssh 排在系统 OpenSSH 之前，插件实际调用 Git 的 ssh——其 HOME/config/agent 语义与系统 OpenSSH 不同，导致"终端能连、测试连接 Permission denied"。ssh 主机侧忽略用户 authorized_keys 的 HPC 集中授权环境同样受此影响。
- **终端 shell wrapper 同步修复**：生成的 `dsh-remote-shell.js` 同样优先解析系统 OpenSSH 绝对路径。
- 非 Windows 平台、未安装系统 OpenSSH 的环境：行为与之前完全一致（回落 PATH），零破坏。

## [2.3.8] — `/remote-ssh/api` CSRF 加固（合并 PR #4 + 服务端强制校验）
### 安全
- **合并 PR #4**（感谢 @anupamme / OrbisAI Security）：客户端 API 调用（`/remote-ssh/api/*`）统一携带 `x-requested-with: XMLHttpRequest` 头。
- **服务端强制校验该头**（PR 的服务端半边）：`/remote-ssh/api/*` 前缀路由现在要求请求必带 `x-requested-with`，缺失返回 403 `csrf`——跨站攻击者无法在 no-cors POST 中携带非简单头（预检也会被拒），为不支持 `Sec-Fetch-*` 头的旧浏览器补上 CSRF 防线。现有 `Sec-Fetch-Site` 检查、localhost 限定与 DSH 网关认证全部保留；`fs.*`/`git.*`/上传/下载路由不受影响（其调用方为 better-sidebar 自带客户端，不带该头）。

## [2.3.7] — Windows host 连接诊断增强：过滤 PQ 警告、ssh -v 诊断、跨平台测试探测
### 修复
- **过滤 OpenSSH「后量子 KEX」警告横幅**：新版本客户端对非 PQ 加密的 stderr 警告（三行 `** WARNING…`）与认证成败无关，此前混入错误信息会误导用户以为是不支持加密算法；现在统一过滤（错误提示、一次性连接 stderr、持久会话关闭诊断）。
- **测试连接探测命令改为跨平台 `echo __DSH_OK__`**：旧命令尾部 `uname -a`/`pwd` 在 Windows host（cmd/PowerShell）上必然报错，导致**认证成功的 Windows host 也误报失败**。
- **认证失败自动带 ssh -v 诊断**：测试连接认证失败时重跑一次 `ssh -v` 握手，抽取关键诊断行（私钥加载 / 公钥提供 / 服务器拒绝方法 / 口令要求）附在错误信息里，用户一眼定位失败环节。
- **公钥失败提示覆盖 Windows 三大圈套**：① 私钥带口令 + 批处理模式无法交互输入（先 ssh-add 或去口令）；② Windows host 且用户在 Administrators 组时公钥须写入 `C:\ProgramData\ssh\administrators_authorized_keys`；③ 用户名写法（`user` / `.\user` / `user@domain`）须与手动连接一致。

## [2.3.6] — settings 注册迁移至字符串命名空间，移除 legacy 导出依赖
### 变更
- **不再从 `@deepseek-ai/dsh-settings` 导入 `settingsNamespace`**：该导出在 dsh-settings 中被标注为 legacy（仅为 alpha.2 之前的插件保留，未来版本可能移除）。`parseSettingsNamespace` 实为恒等函数（校验 `/^[a-z][a-z0-9-]*$/` 后原样返回），故 `register(NS, schema)` 与原 `register(settingsNamespace(NS), schema)` 存储键完全一致——零数据迁移，老用户配置无缝保留。
- **peerDependencies 移除 `@deepseek-ai/dsh-settings`**（已无导入；`ctx.settings` 能力由 DSH 内核的 settings 服务提供，与该 npm 包导入无关），安装时少一条未解析 peer 警告。

## [2.3.5] — 地球角标样式重制：右下角、默认文件夹形状、透明底白经纬线
### 变更
- **文件夹形状与默认完全一致**：不再自绘/改写文件夹几何，壳层 IconFolderOpen16/Close16 的原始路径与几何零改写，仅向工作区行首槽位 svg **追加**一个透明地球经纬线组（appendChild 不触碰 React 管理的子节点，零对账风险）。
- **角标移到右下角**：地球中心 (11.6, 11.9)，含轮廓圈、经线椭圆、赤道与南北纬弧。
- **透明底色**：去掉蓝色圆盘与描边底环，仅保留白色经纬线（0.9 描边），地球区域全透明。
- 状态判据改为 svg 内 `[data-rssh-globe]` 子节点存在性（React 属性还原/子节点重建均覆盖），1s 复检自愈逻辑不变。

## [2.3.4] — 修复点击会话后图标退化 + 角标加大
### 修复
- **图标退化**：点击会话等交互触发 React 重渲染，会把 svg 的 viewBox/children 还原成纯文件夹（属性级变化不触发 childList 观察器），而 2.3.3 的防重入守卫只认 data 标记——标记在即跳过，还原后永不重刷。改为：守卫校验**实际状态**（viewBox 是否为目标帧），不匹配即重新应用；并维护已匹配标题元素清单，**每 1s 幂等复检**（断连清理），任何还原 1 秒内自愈。
- **角标加大**：地球角标半径 3.1 → 5.2（渲染直径 ≈5px → ≈8.3px，视觉接近翻倍），地球线稿与描边同步放大，位置微调至文件夹左下角不越界。

## [2.3.3] — 修复工作区图标替换不生效
### 修复
- 2.3.2 的图标替换向上爬找「直接子级含 svg 的祖先」，但壳层工作区行的文件夹 svg 位于标题的**前兄弟槽位**（`projectRow > [slot.folder(svg), …, projectText > title]`），不是任何祖先的直接子级 → 匹配后静默跳过、图标从未被替换。改为：从标题向上最多 4 层，取每层容器的**第一个子元素**，首个含 svg 的即行首文件夹槽位；并将「插入新节点」改为**原位改写**该 svg 的 viewBox/尺寸/内容（不插入/删除节点，避免 React 对账风险；展开态切换重建 svg 后由观察器 500ms 内自动重刷）。

## [2.3.2] — 远程工作区图标改为单个「地球角标文件夹」
### 变更
- **工作区标题去掉 🌐 前缀**：新建远程工作区的原生标题不再带 🌐（此前标题 emoji + 壳层文件夹图标造成「文件夹 + 地球」双重标识）；启动自愈同步剥掉既有工作区标题中的旧 🌐 前缀（仅限已知旧形态，不覆盖自定义标题）。
- **客户端图标替换**：按工作区标题文本定位侧边栏工作区行，隐藏壳层默认纯文件夹 svg，插入内联「地球角标文件夹」SVG（文件夹描边 + 主题色圆形地球角标，跟随明暗主题）；复用 2.3.1 的增量观察器（只扫新增子树、30s 刷新标题集、data 标记防重入），稳态成本≈0。

## [2.3.1] — 修复 2.3.0 上线后的界面卡顿（GC 压力 + 客户端全页扫描）
### 修复
- **读缓存字节预算（review m1）**：单条结果 >1MiB 不再缓存（结果照常返回），缓存总量上限 32MB 超限逐出最旧条目——消除大文件驻留字符串造成的 GC 压力（最坏 ~270MB → ≤32MB）。
- **设置导航齿轮观察器改为增量扫描**：此前任何 DOM 变动都会触发全文档 `querySelectorAll("button")` 扫描（流式聊天期间持续打断主线程）；现改为只扫描新增子树、节流 500ms、后台页签零开销，稳态成本≈0。
- **exec 失败不再 bump epoch（review m3）**：失败的命令通常无副作用，不再无谓打断整代缓存（部分副作用由 ≤5s TTL 兜底）。
- **git 只读命令不再整代失效（review m4）**：仅 add/reset/commit/checkout/revert/cherry-pick 变更类子命令 bump，status/diff/log/branch/show 不再打断缓存。

## [2.3.0] — 远程文件打开提速：单往返合并读 + 结果缓存（实测 ≈1.3×~5×）
### 性能
- **fs.read 单往返合并读**：size/mtime 与文件内容合并为一条池化命令（`__DSH_ST__` 帧，`_` 不在 base64 字母表故标记天然抗噪），去掉每文件一次的 stat 往返。真实 HPC 实测（100KB 文件，各 10 次 p50）：raw 直传 396.6→301.8ms、base64 443.8→337.9ms，约 **1.31×**；1MB 大文件同步受益。>4MB 仍 `head -c 4MiB` 截断，二进制探测与解码语义不变。
- **raw 文本快路径**：文本扩展名白名单（.py/.js/.md/… 等）免 base64 直传（传输段再省 ≈24-27%）；字节长度 + U+FFFD 双校验，不符自动回退 base64 重读——结果与旧实现逐字节一致，仅多 1 RTT。
- **主机侧结果缓存**：读结果与目录列举各 LRU（32/64 条）+ TTL 5s。TTL 内重复打开/切回页签 **0 RTT**（实测 ≈0.02ms）；过期后 1 次轻量 mtime+size 复验，未变免重传（实测 84.9ms，约 **5×**）；目录列举 TTL 内 0ms。写/删/移/建目录/上传/推送/远端 exec/git 自动失效，并引入每 profile 缓存代（epoch）兜底「同秒同 size 写」与 `~/x` vs `/home/u/x` 路径字符串空间差。
- **目录列举 `cd` 包进子 shell**：修复列举后 `cd` 残留污染共享会话 cwd 的既有问题（旧实现会使会话内后续相对路径命令落空）。
### 修复
- **写路径字节精确**：`remote_ssh_write` / 文件页签保存改走 `base64 -d` 管道写入，修复旧 `cat > file` heredoc 帧每次保存尾随多 1 字节的问题（实测 3/3/4B，旧实现 4/4/5B），且对 NUL/二进制内容安全。
### 已知限制
- 集成终端（`ssh -tt`）与远端外部进程改动的文件，插件缓存最多 **5s** 陈旧；外部进程「同秒内同 size 写」且此后不再变化时，mtime 复验无法察觉（极窄窗口；插件自身写/exec/git 路径经失效与 epoch 兜底，不受此限）。
- `/sidebar/file` 下载池化路径有效上限 ≈**6.29MB**（会话 8MB 输出熔断 ÷ base64 4/3 膨胀）；更大文件自动退回一次性连接下载（可成功，但多付一次废传输与重连），2.4.0 候选修复。
- 二进制内容伪装文本扩展名时，raw 校验拒绝后自动回退 base64 重读（多 1 RTT，结果正确）。

## [2.2.1] — 去掉设置导航「远程连接」左侧的齿轮图标
### 修复
- DSH 壳层对未知 `settings.section` 渲染默认齿轮图标，且导航类名是构建期哈希（每版都会变），旧版硬编码的 CSS 选择器（`VOzbGW_*`）已随 DSH 更新失效。改为按栏目标题文本定位设置导航按钮并隐藏其图标 svg（MutationObserver + 语言切换自动重跑），跨 DSH 构建版本稳定。

## [2.2.0] — 远程命令连接复用（实测 ≈15× 提速）+ 协议/安全加固
### 性能
- **`remote_ssh_exec` 走持久会话池**：不再每次调用做完整 SSH 握手。真实 HPC（ssh.hpc-a.example.com，2222 端口）实测：一次性连接单命令平均 **1292ms**，连接复用后单命令平均 **84.3ms**，**约 15.3× 提速**；`stdin` 参数经 heredoc 走同一条复用通道。
- **stderr/stdout 分离语义保留**：stderr 重定向到远端临时文件、退出码哨兵后 cat 回传并以第二个哨兵收尾（双哨兵协议）。
- **读路径保持轻量**：`ls`/`cat`/`grep`/`glob` 继续走 `2>&1` 合并协议，热路径避开子 shell 与临时文件开销。
- **大文件读取先 stat**：超过 4MB 只读前 4MB（`head -c` 截断并标记 truncated），不再让持久会话缓冲无限增长。
### 安全 / 健壮性
- **会话输出硬上限 8MB**：单条命令哨兵到达前缓冲超限即重置会话并给出明确报错，防止远端海量输出撑爆内存。
- **密钥认证非交互连接加 `-o BatchMode=yes -o PreferredAuthentications=publickey`**：带口令的私钥/意外交互立即失败并返回可读提示（不再挂到超时），同时缩短建连时间；交互式终端（`ssh -tt`）不受影响。
- **分离协议用双层子 shell**：用户命令中的 `exit`/`cd` 不再弄挂共享会话（内层子 shell 隔离，实测远端 `exit 7` 后会话存活且退出码正确传回）。
- **写入上限 4MB**：超限直接拒绝并给出清晰报错；写入失败现在能拿回远端 stderr（此前错误信息丢失）。
- 配合 2.1.7 纳入的修复（`--include` 转义、stderr 排空、删除配置级联清理、keyPath `~` 展开、会话池 key 含认证信息），完成一轮兼容性/安全性全面检查。

## [2.1.7] — 兼容 DSH Desktop ≥ 2.0.4：polyfill __DSH_MODULES__ + 可靠性/安全修复
### 修复
- **__DSH_MODULES__ polyfill**：better-sidebar 0.15+ 的懒加载 chunk（编辑器等）依赖 `globalThis.__DSH_MODULES__`，而 DSH Desktop ≥ 2.0.4 的 shell 不再挂载该全局，导致侧边栏面板打不开（"chunk ... client module system unavailable"）。Client 半边启动时用内核 `modules` 服务补挂该全局（better-sidebar 已注入则保持原值），并带定期兜底重试。
- **持久会话 stderr 排空**：SSH 会话的 stderr 管道此前无人消费，写满后远端 ssh 进程阻塞、会话假死；现在持续排空并保留最近 64KB，会话意外关闭时报错会附带最近 stderr 尾部，便于排查断连原因。
- **修复 `remote_ssh_grep` 命令注入**：`--include` 参数此前未做 shell 转义，可通过构造参数在远端执行任意命令；现已与其它参数一样经 `shellQuote` 引用。
- **删除连接配置时级联清理**：删除 profile 时同步删除其远程工作区的原生注册与本地镜像目录（复用统一的 `cleanupWorkspace`），不再留下指向已删配置的孤儿工作区。
- **密钥路径支持 `~` 展开**：`keyPath` 按 `~`、`~/` 前缀展开为绝对路径，与设置界面占位符（`~/.ssh/id_rsa`）行为一致。
- **会话池 key 纳入认证信息**：修改连接配置的 keyPath/authMethod 后立即重建 SSH 会话，不再复用旧连接。
- 清理每次文件请求的 `console.log` 调试输出（改走 `ctx.logger.debug`）；`localToRemote` 对镜像目录之外的路径不再静默拼出错误远程路径。
- 文档：补全 2.1.0 以来缺失的 CHANGELOG 条目；README 安装命令版本号同步为 2.1.7。

## [2.1.6] — P0 打磨：远程下载 / 流式上传完善 / 远程 Git / 重连
### 修复 / 改进
- **远程文件下载与媒体预览**：拦截 better-sidebar 的 `/sidebar/file`（同路径 exact 路由优先），远程工作区中的文件直接从远端 base64 拉回（上限 64MB），本地照旧。
- **流式上传**：`/remote-ssh/upload` 把请求体直接管道到远端 `cat > target`（二进制安全、恒定内存），请求中断时终止远端进程。
- **远程 Git 面板**：拦截 `/sidebar/api/git.*`（status/diff/log/branch/commit-diff/show/stage/unstage/commit/checkout/discard/revert/cherry-pick），远程工作区中在远端目录执行同语义 git 命令。
- **SSH 失败修复建议**：端口转发占用 / 公钥认证失败 / 连接拒绝 / 超时 / 域名解析失败翻译为带修复建议的中文提示。

## [2.1.5] — 同步 better-sidebar 0.15+ 上传到远程工作区
### 修复
- better-sidebar 0.15+ 的上传 UI 直连 `/sidebar/upload`，远程工作区镜像目录会导致文件只落在本地镜像。Client 半边包装 `fetch`：目标目录位于远程工作区镜像内时把上传重定向到 `/remote-ssh/upload`，经 SSH 直接写远端。

## [2.1.4] — 修复远程工作区标题卡在镜像目录名
### 修复
- `workspaceRegistry.create` 只对新建记录应用 title，旧工作区（早期版本未传 title）标题卡在镜像目录名（如 `wmirror1`）。创建时显式 `setTitle`，并新增启动自愈 `healWorkspaceTitles`（仅在标题等于镜像目录 basename 时修复，不覆盖用户自定义标题）。

## [2.1.3] — 远程工作区标题默认取远程路径最后一段
### 改进
- 创建远程工作区时的默认标题改为远程路径最后一段目录名（如 `~/proj/DSH_Test → DSH_Test`），取不到有效段时回退为 `连接名:远程路径`；原生工作区标题带 🌐 前缀。

## [2.1.2] — 修复 ssh config RemoteForward 端口占用导致连接失败
### 修复
- 插件内部连接（文件读写 / 工具 / 同步）追加 `ClearAllForwardings=yes`；shell wrapper 追加 `ExitOnForwardFailure=no`。`~/.ssh/config` 里的 `RemoteForward` 端口被上次会话占用且 `ExitOnForwardFailure yes` 时不再导致连接直接失败。
- 把 SSH 常见失败（端口转发占用 / 公钥认证失败 / 连接拒绝 / 超时 / 域名解析失败）翻译成带修复建议的中文提示。

## [2.1.1] — 新增英文 README
### 文档
- 新增 README_EN.md，中英文版本互链。

## [2.1.0] — README 拆分语言版本
### 文档
- 移除 README 内联双语，拆分为 README.md（中文）与 README_EN.md（英文）。

## [2.0.1] — 修复远程检测：从 payload.path 也查找 .remote-ssh.json
### 修复
- **sessionCwd 为空时无法检测远程工作区**：客户端请求有时只带 `payload.path` 不带 `cwd`，而 `ctx.sessions.get(sessionId)` 可能返回 undefined（session 未创建或 ID 不匹配）。现改为：先尝试 `sessionCwd`，再尝试 `payload.path`，两者都会检查 `.remote-ssh.json`。
- 添加调试日志（`ctx.logger.info`）记录每次拦截的方法、sessionId、cwd 和远程检测结果。

## [2.0.0] — 内置文件页签直接 SSH 读写远程文件（不再需要同步）
### 重大变更
- **内置「文件」页签直接操作远程文件**：通过注册更长前缀 `/sidebar/api/fs.` 拦截 better-sidebar 的文件 API（`fs.tree`/`fs.read`/`fs.write`/`fs.search`），在远程工作区中直接通过 SSH 读写远程文件，不再需要 sync/push 同步。
- **透明路径映射**：客户端看到的是本地镜像路径，host 拦截器自动转换为远程路径，通过 SSH 执行操作后返回结果。
- **本地工作区照常**：非远程工作区的请求走本地 fs，行为与 better-sidebar 原始实现一致。
- 不再依赖 tar 同步——打开文件 = 直接读远程，保存文件 = 直接写远程。

## [1.9.3] — 修复 syncDown 删除 .remote-ssh.json 导致终端不工作
### 修复
- **`remoteSyncDown` 会清空镜像目录**：syncDown 先 `rm -rf` 镜像目录再 `tar xf` 展开，导致之前写入的 `.remote-ssh.json`（供 shell wrapper 读取连接信息）被删掉，终端 wrapper 检测不到远程工作区，降级到本地 shell。
- **修复**：在 `createRemoteWorkspace`、`syncDown` API、`remote_ssh_sync` 工具三处，都在 `remoteSyncDown` 完成后重新写入 `.remote-ssh.json`。
- 已为现有工作区补写 `.remote-ssh.json`（无需重新创建工作区）。

## [1.9.2] — 修复自动配置 patch 不生效（bundles 顺序）
### 修复
- **config 覆盖被跳过**：`cordis.patch.yml` 中的 `id: better-sidebar` config 覆盖需要在 `better-sidebar` 条目被 insert 之后才能生效。如果 `@zhangfengshun/dsh-remote-ssh` 在 bundles 列表中排在 `dsh-better-sidebar` 之前，patch 会因"entry not found"被跳过。
- **修复方式**：在 README 中明确要求安装顺序（`@zhangfengshun/dsh-remote-ssh` 必须在 `dsh-better-sidebar` 之后），并提供手动调整 `profile/package.json` 中 `dsh.profile.bundles` 顺序的说明。

## [1.9.1] — 安装时自动配置 better-sidebar shell
### 改进
- **安装即生效**：`cordis.patch.yml` 新增 `id: better-sidebar` 的 `config.shell` 覆盖，用 `!!js` 动态计算 wrapper 脚本路径（适配不同平台和用户主目录）。安装插件后无需手动编辑任何配置文件，重启 DSH 即可使用远程终端透明接入。

## [1.9.0] — 远程文件/终端合并到内置页签
### 重大变更
- **移除 `remssh:files` 和 `remssh:term` 页签**：远程文件和远程终端不再使用独立侧边栏页签。
- **远程文件 → 内置「文件」页签**：创建远程工作区时自动 `tar | ssh` 同步远程文件到本地镜像目录，内置「文件」页签直接显示真实远程文件。编辑后通过设置页「同步/推送」按钮或 `remote_ssh_push` 工具回传。
- **远程终端 → 内置「终端」页签**：插件启动时自动生成跨平台 shell wrapper 脚本（`~/.dsh/remote-ssh/dsh-remote-shell[.cmd]`）。在 DSH 设置中将 better-sidebar 的 `shell` 指向该脚本后，内置「终端」页签在远程工作区中自动 SSH 到远程主机，在本地工作区中照常启动本地 shell。
- **设置页新增「远程工作区」管理区**：列出所有远程工作区，支持同步/推送/删除操作。
- **创建工作区时写入 `.remote-ssh.json`**：镜像目录中写入连接信息（host/port/user/keyPath/proxyJump/remotePath），供 shell wrapper 读取。
- 保留隐藏的 `remssh:editor` 页签用于远程文件编辑器。
- ⚠️ 终端透明接入仅支持**密钥认证**（密码无法安全传入 wrapper 脚本）。

## [1.8.3] — 浏览按钮改回「打开」
### 变更
- 「浏览」按钮改回「打开」：按输入框路径加载该路径下的文件树，空路径时打开主目录。本地/远程行为一致，不再调用 `pickDirectory`（该原生对话框在仅有 `browse` capability 的环境下不可用）。回车导航保留。

## [1.8.2] — 修复浏览按钮：本地回退 + 远程打开主目录
### 修复
- **本地浏览**：`pickDirectory()` 在仅有 `browse` capability（无 `native`）的 DSH 环境下会报错 `host.pickDirectory needs the native capability`。现改为：尝试原生选择框，失败时静默回退到加载用户主目录（`listDirectory` 默认列举 home）。用户取消也回到主目录。
- **远程浏览**：点击「浏览」改为打开**远程用户主目录**（`~`），而非按输入框路径刷新。
- 路径输入框支持**回车导航**：输入路径后按 Enter 即跳转到该目录。

## [1.8.1] — 浏览按钮调用原生目录选择框
### 修复
- **「浏览」按钮**：本地模式下点击调用 `ctx.workspaces.pickDirectory()` 弹出操作系统原生目录选择框（默认打开用户主目录），选中后自动加载该目录的文件树并填入路径栏。原先该按钮只是按输入框路径刷新树，没有实际选择作用。远程模式无系统对话框，仍按输入路径刷新远端文件树。

## [1.8.0] — 重做「添加工作区」弹窗
### 改进
- **统一弹窗布局**：原先本地/远程是两个独立弹窗（各自标题），现改为**单个弹窗**：顶部「📁 本地目录 / 🌐 远程目录」分段切换按钮（当前激活的高亮），下方依次为连接选择（远程时）、路径栏（浏览按钮紧挨输入框右侧）、当前路径下的文件树（仅目录、可滚动）。
- 路径栏右侧的「浏览」按钮紧挨输入框，点击后按输入框路径加载文件树（原为「打开」）。
- 文件树无子目录时显示占位提示。
- 本地/远程切换不再关闭重开弹窗，在同一弹窗内即时切换。

## [1.7.0] — SSH 连接复用（大幅加速）
### 重大优化
- **持久 SSH 会话池**：`ls`/`cat`/`write`/`grep`/`glob`/`mkdir`/`delete`/`move` 等文件操作不再每次新建 ssh 子进程（每次都要完整 TCP 握手 + 密钥交换 + 认证，超算/跳板机单次 2-10 秒）。改为维护一条常驻 `ssh <host> bash` 进程，所有命令复用它，用哨兵标记（sentinel）分隔输出、解析退出码。首次连接后，后续操作近乎瞬时。
- **自动回退**：持久会话断开（网络中断、远端重启等）时自动清理并回退到一次性 `runRemote`，保证可靠性。
- **空闲清理**：会话空闲超过 10 分钟自动断开，避免占着连接。插件卸载时全部清理。
- `remote_ssh_exec` 与测试连接仍用一次性连接（保留 stdout/stderr 分离）。
- Windows OpenSSH 不支持 ControlMaster（已验证），故采用此进程内会话池方案，不依赖 ControlMaster。

## [1.6.0] — 远程搜索与文件操作工具
### 新增
- **内容搜索 `remote_ssh_grep`**：在远端递归搜索文件内容（`grep -rnIE`，扩展正则），支持 `include` 文件名过滤（如 `*.py`）、`ignoreCase` 忽略大小写、`maxResults` 限流（默认 200）。借鉴 dsh-remote / dsh-remote-ssh 的远程搜索，但用通用 GNU grep（超算/Linux 通用，不依赖 ripgrep）。
- **文件名查找 `remote_ssh_glob`**：按通配符查找远程文件（`find -name`，递归），自动剥离前导 `**/` 以适配 POSIX find。
- **创建目录 `remote_ssh_mkdir`**：`mkdir -p`（含父目录）。
- **删除 `remote_ssh_delete`**：删除远程文件或目录（`rm -rf`，递归不询问，⚠️ 不可恢复）。
- **移动/重命名 `remote_ssh_move`**：`mv` 移动或重命名文件/目录。
- 上述 5 个工具均会话感知：在远程工作区会话中免填 `profileId`，相对路径基于工作区远程目录解析。
- 「远程文件」页签新增操作栏（选中工作区或连接时显示）：🔍 搜索 / 按名查找 / 新建目录 / 重命名移动 / 删除，均以弹窗形式执行并就地显示结果。
- 远程工作区镜像目录的 `README.md` 补全新增工具说明。

## [1.5.0] — 导入 OpenSSH 配置 + 双向同步
### 新增
- **从 `~/.ssh/config` 导入连接**：设置小节「从 ~/.ssh/config 导入…」按钮读取本机 OpenSSH 用户配置（递归解析 `Include`），多选主机后批量导入为连接配置（`HostName` / `User` / `Port` / `IdentityFile` / `ProxyJump` 一并带入）。借鉴 Yan-Zero `dsh-remote-ssh`，免去逐条手动录入。
- **跳板机（ProxyJump）**：连接配置新增可选 `ProxyJump` 字段，`sshArgv` 追加 `-o ProxyJump=...`，OpenSSH 原生支持；导入的带跳板机主机开箱即用。
- **tar-over-ssh 双向同步**：新增 `syncDown`（远端 → 本地镜像）/ `syncUp`（本地镜像 → 远端）HTTP API 与 `remote_ssh_sync` / `remote_ssh_push` 模型工具，用流式管道把一条 ssh 的 stdout 喂给本地 `tar` 的 stdin（反之亦然），不经过 4MB 缓冲上限。借鉴 flymysql `dsh-remote` 的 `rw_sync` / `rw_push`，但复用现有 `ssh.exe` + `tar`，不引入 `ssh2` 依赖。
- 「远程文件」页签在选中工作区时显示「⬇ 同步 / ⬆ 推送」按钮，同步后镜像目录装下真实远程文件，内置 `read`/`grep`/`glob` 工具可直接读取镜像。
- `remote_ssh_sync` / `remote_ssh_push` 工具会话感知：在远程工作区会话中无需 `workspaceId`，自动识别当前工作区。

## [1.4.0] — 远程文件单开一栏预览
### 新增
- 点击「远程文件」文件树中的文件，改为在 better-sidebar 中**单开一栏（独立页签）预览/编辑**，与内置「文件」页签一致，不再在文件树下方内嵌预览。新增隐藏页签类型 `remssh:editor`，同一远程文件按 (profileId, path) 去重复用。

## [1.3.1] — 修复远程文件树滚动
### 修复
- 「远程文件」页签改为 flex 布局：文件树在文件很多时占据剩余高度并内部滚动（`flex:1; overflow-y:auto`），不再因父容器 `overflow:hidden` 而无法往下拉。

## [1.3.0] — 外观跟随主题
### 新增
- 远程连接相关界面（设置小节、远程文件 / 终端页签、添加工作区弹窗）的颜色全部改用 DSH 主题 token（`--dsw-alias-*`），自动跟随 DSH 明暗主题（`body[data-ds-dark-theme]`）切换，不再硬编码深色配色。

## [1.2.1] — 修复包名不一致
### 修复
- Host 半边导出的 `name` 与 Client 半边 `__ModuleLoader__.load({ id })` 统一改为作用域包名 `@zhangfengshun/dsh-remote-ssh`，与 `package.json` / `cordis.patch.yml` 一致，修复在新机器上安装时报「名字与发布名不一致」的错误。

## [1.2.0] — 中英文双语
### 新增
- **界面国际化**：Client 半边接入 `ctx.locale`，注册 `dsh-remote-ssh` 命名空间的 `zh` / `en` 词典，所有界面文案（页签标题、设置小节、文件/终端页签、添加工作区弹窗）跟随 DSH 设置中的语言自动切换。
- 模型工具 `description` 与远程工作区 `README.md` 改为中英双语。
- **会话切换状态记忆**：「远程文件」页签记住已选工作区/连接、浏览目录与打开的文件，「远程终端」页签记住已选连接与已打开的终端（按 `sessionId` 分桶，模块级存活）。切换到其它会话再切回时不再丢失选择。
### 变更
- **包名改为作用域包 `@zhangfengshun/dsh-remote-ssh`**（npm 上无作用域的 `dsh-remote-ssh` 已被占用）。
- 清理开发者使用痕迹：设置表单占位符改为通用示例（`login.example.com`、`your-username`、`~/.ssh/id_rsa` 等），移除特定超算厂商信息。
- 文档修正：README 中已移除的「远程连接」侧边栏页签描述更新为当前「远程文件 / 远程终端」两个页签 + 设置页小节。
- 设置面板栏目名改为「🖥️ 远程连接 / 🖥️ Remote Connections」，并隐藏壳层对第三方栏目硬编码的齿轮图标（CSS 定位最后一个导航项）。
### 修复
- 「添加工作区」弹窗在打开时重新拉取连接配置，避免在设置中新建连接后、弹窗下拉里看不到该连接（此前 `useProfiles` 仅在挂载时拉取一次）。

## [1.1.0] — 原生远程工作区
### 重大变更
- 移除 better-sidebar 的「远程连接」页签；连接配置改由 DSH 设置页「远程连接」小节统一管理。
- 接管 DSH 原生「添加工作区」流程（`directoryFlow` 槽位，优先级 -100 覆盖内置本地目录选择器），提供「本地目录 / 远程目录」两选。
### 新增
- 创建远程工作区时：在本地生成镜像目录（`~/.dsh/remote-workspaces/<id>`），注册进原生 `workspaceRegistry`，远程工作区直接出现在原生工作区列表、按原生流程创建会话。
- 远程工作区元数据（`profileId` / `remotePath` / `mirrorPath`）持久化到 settings；删除时同步清理原生注册与镜像目录。
- 「远程文件」页签：选中远程工作区后可编辑其**默认目录**（`remotePath`），保存后打开该工作区即进入该目录。
- 「添加工作区 → 选择本地/远程目录」改用原生 `Modal` 弹窗（与本地目录浏览器一致），不再内联渲染。
- 本地目录选择改用 DSH `browse` 能力（`workspaces.listDirectory`）在弹窗内浏览，不再依赖不可用的原生对话框。
- 修复远程目录浏览：`remoteRoot` 以 `~` 开头时正确展开为家目录（此前 `cd '~'` 会失败导致「读取目录失败」）。
- 模型工具**会话感知**：在远程工作区会话中，`remote_ssh_ls/cat/write/exec` 无需 `profileId`，自动使用该工作区的连接与目录（相对路径基于 `remotePath` 解析，`remote_ssh_exec` 自动 `cd` 到远程目录）。
- `remote_ssh_profiles` 增加 `currentRemote` 字段，返回当前会话所属远程工作区上下文。
- 创建远程工作区时在镜像目录写入 `README.md`，提示模型使用 `remote_ssh_*` 工具操作远程文件与终端。
- 「添加工作区」弹窗宽度默认 690px（原约 460px 的 1.5 倍），右下角可拖拽手动调整宽度。

## [1.0.0] — 静态插件版
### 重大变更
- 从动态 Cordis 插件重构为**静态 DSH Web 插件包**（durable settings 必需），安装到 profile。
### 新增
- 连接配置 + 远程工作区持久化到 DSH `settings` 命名空间 `dsh-remote-ssh`（密码 `role('secret')` 脱敏）。
- 通过 `ctx.betterSidebar.registerTab` 注册「远程文件 / 远程终端 / 远程连接」三个侧边栏页签。
- DSH 设置页新增「远程连接」小节（`settings.section`）管理连接配置。
- 远程工作区：选择远程目录创建 / 打开 / 删除（与本地工作区选目录体验一致）。
- Host 暴露 `/remote-ssh/api/*` HTTP JSON API（Client 通过 fetch 调用，替代动态插件的 `host.call`）。
- 5 个模型工具改为 `ctx.tools.register(defineTool(...))` 注册。

## [0.5.0] — 2025-XX-XX（pkg-5）
### 修复
- 文件列举：`find -printf` 用 `%Y`（跟随软链接取目标类型），软链接目录在文件树中按目录导航（适配家目录软链接，如 `run -> /data/run01/<user>`）。

## [0.4.0] — 2025-XX-XX（pkg-4）
### 修复
- 模型工具渲染：`remote_ssh_exec` 成功时优先显示 stdout，`remote_ssh_write` 成功时显示「已写入」——不再被首次连接时 ssh 写入 stderr 的 `Permanently added ... to known hosts` 警告掩盖。

## [0.3.0] — 2025-XX-XX（pkg-3）
### 修复
- 移除 `-o LogLevel=ERROR`，使 ssh 的致命错误（连接被拒绝、主机密钥校验失败、认证失败等）原样返回给界面与模型工具。
- `runRemote` 在「非零退出且 stdout/stderr 均为空」时合成兜底错误信息 `ssh 退出码 N`，避免出现空泛的 `failed`。

## [0.2.0] — 2025-XX-XX（pkg-2）
### 新增
- 5 个模型可调用工具：`remote_ssh_profiles`、`remote_ssh_exec`、`remote_ssh_ls`、`remote_ssh_cat`、`remote_ssh_write`。
- Host 逻辑重构为可复用函数（`resolveProfile` / `remoteListDir` / `remoteReadFile` / `remoteWriteFile`），RPC 与工具共用同一套连接配置存储。

## [0.1.0] — 2025-XX-XX（pkg-1）
### 新增
- 右侧侧边栏面板（`shell.overlay` 槽位）：连接 / 文件 / 终端三个页签。
- 连接配置管理（名称 / host / 端口 / 用户 / 认证方式 / 远程根目录），密钥与密码（sshpass）认证，测试连接。
- 远程文件浏览（进入目录 / 返回上级 / 打开查看 / 内嵌编辑并保存）。
- `ssh -tt` 集成远程终端（多开、关闭、输出流式回显）。
