# Changelog

本文件的版本号与 `package.json` 的 `version` 保持一致。每个版本对应一个 Cordis Package 快照（`pkg-N`）。

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
