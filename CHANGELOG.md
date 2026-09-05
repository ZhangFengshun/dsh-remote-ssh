# Changelog

本文件的版本号与 `package.json` 的 `version` 保持一致。每个版本对应一个 Cordis Package 快照（`pkg-N`）。

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
- **`remote_ssh_exec` 走持久会话池**：不再每次调用做完整 SSH 握手。真实 HPC（ssh.cn-zhongwei-1.paracloud.com，2222 端口）实测：一次性连接单命令平均 **1292ms**，连接复用后单命令平均 **84.3ms**，**约 15.3× 提速**；`stdin` 参数经 heredoc 走同一条复用通道。
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
- `workspaceRegistry.create` 只对新建记录应用 title，旧工作区（早期版本未传 title）标题卡在镜像目录名（如 `wmt3tev5cdfge`）。创建时显式 `setTitle`，并新增启动自愈 `healWorkspaceTitles`（仅在标题等于镜像目录 basename 时修复，不覆盖用户自定义标题）。

## [2.1.3] — 远程工作区标题默认取远程路径最后一段
### 改进
- 创建远程工作区时的默认标题改为远程路径最后一段目录名（如 `~/run/zfs/codex/DSH_Test → DSH_Test`），取不到有效段时回退为 `连接名:远程路径`；原生工作区标题带 🌐 前缀。

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
