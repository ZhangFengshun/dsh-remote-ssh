# @zhangfengshun/dsh-remote-ssh

[English](./README_EN.md) | 中文

类 **VSCode Remote-SSH** 的 **DSH** 插件：通过 SSH 连接远程超算 / 服务器，在 DSH 内置「文件」「终端」页签中直接操作远程文件和终端。

**目录**：[功能](#功能) · [截图](#截图) · [安装](#安装) · [使用](#使用) · [代码示例](#代码示例) · [模型工具](#模型工具) · [命令超时与恢复](#命令超时与恢复) · [兼容性](#兼容性) · [故障排查](#故障排查) · [原理](#原理) · [缓存与一致性](#缓存与一致性) · [许可证](#许可证)

## 功能

| 能力 | 说明 |
| --- | --- |
| 🔌 SSH 连接 | 密钥 / 密码认证，ProxyJump 跳板机，`~/.ssh/config` 一键导入 |
| 📂 远程文件 | 内置「文件」页签直接 SSH 读写远程文件，无需同步 |
| 💻 远程终端 | 内置「终端」页签自动检测远程工作区，SSH 交互式终端，**落在工作区对应的远程目录**（与 VSCode Remote-SSH 一致） |
| 🌐 远程工作区 | 选择远程目录创建原生工作区，一键进入远程环境 |
| 🤖 模型工具 | 13 个 `remote_ssh_*` 工具，会话感知免填连接参数；命令级超时 + `remote_ssh_kill` 兜底恢复 |
| 🗂️ `@` 引用补全 | 远程工作区会话里 `@` 补全列**远端**文件（git 仓库走 `git ls-files`，实测 0.1s；非 git 用有界 `find`；索引缓存 + 900ms 查询预算，超时降级不卡输入框） |
| ⚡ 打开提速 | 单往返合并读 + raw 文本快路径 + 结果缓存（LRU + 5s TTL）：首开 ≈**1.31×**，TTL 内重复打开 **0 往返**，过期复验 **≈5×**（真实超算实测）；`remote_ssh_exec` 连接复用 **≈15×** |

## 截图

**设置 → 远程连接**：连接配置（密钥 / 密码 / ProxyJump 跳板机）· 连接测试 · 从 `~/.ssh/config` 一键导入

<p align="center"><img src="assets/settings-remote-connections.png" width="420" alt="设置：远程连接"></p>

**内置「文件」页签**：直接浏览远程主机文件（右侧文件树即远程目录，编辑保存直写远程）

<p align="center"><img src="assets/remote-files-tab.webp" width="820" alt="内置文件页签直接浏览远程文件"></p>

**内置「终端」页签**：自动 SSH 到远程超算（图为 SLURM 作业调度环境）；左侧会话即模型免填调用 `remote_ssh_*` 工具

<p align="center"><img src="assets/remote-terminal.webp" width="820" alt="内置终端页签自动 SSH 远程超算"></p>

## 安装

**前置要求**

| 项 | 要求 |
| --- | --- |
| DSH | ≥ 0.1.5-rc.1（0.1.2 稳定线请用 v0.18.1 时代的插件版本） |
| dsh-better-sidebar | ≥ 0.15（本插件依赖其 `/sidebar/api/fs.*` 文件 API） |
| 本机 SSH 客户端 | Windows：系统自带 OpenSSH（`%SystemRoot%\System32\OpenSSH\ssh.exe`）；Linux/macOS：openssh-client |
| 远程主机 | 任意标准 sshd（超算 / 服务器 / 跳板机均可） |

**一条命令安装**（无需 token、API Key 或额外配置）：

```bash
dsh plugin --profile <name> add @zhangfengshun/dsh-remote-ssh@2.4.11
```

安装后**重启 DSH**。`@zhangfengshun/dsh-remote-ssh` 必须在 bundles 列表中排在 `dsh-better-sidebar` **之后**。

卸载：

```bash
dsh plugin --profile <name> remove @zhangfengshun/dsh-remote-ssh
```

> ⚠️ **dsh-better-sidebar 版本兼容性（2026-09 实测）**：`0.18.1 / 0.19.0 / 0.19.1` 在 DSH Desktop v2.0.9（DSH 0.1.5-rc.1）上**主机半边无法加载**（它们以值方式导入 `SessionLogOffset`，桌面版模块面只提供该类型声明）→ 侧边栏文件页签显示「这类内容还没有可用的查看方式。」。请使用 **0.18.0**，或使用已修复该导入的构建；本插件对 0.18（4 端点）与 0.19（6 端点，含 `fs.rename`/`fs.remove`）两套契约均已适配。

## 使用

**三步上手**

1. **设置 → 远程连接** → 添加连接（主机 / 端口 / 用户 / 密钥）→ 点「测试连接」验证；已有 `~/.ssh/config` 可直接一键导入
2. **添加工作区** → 选「选择远程目录…」→ 选连接 → 浏览并选择远程目录（该目录会成为原生 DSH 工作区）；目录还不存在时点「📁 新建目录」就地创建（本地 / 远程 tab 均支持），创建后自动进入新目录
3. 进入该工作区会话：内置「文件」页签直接显示远程文件（编辑保存直写远程），「终端」页签自动 SSH 到该工作区的**远程目录**（仅密钥认证）

**会话内直接对模型说**（远程工作区会话中免填连接参数）：

```text
看看 /home/user/project 下有什么，然后把 train.py 的第 20 行改掉
跑一下 squeue -u $USER，把排队情况整理成表格
把这个目录的 *.log 里含 ERROR 的行抓出来
```

## 代码示例

**示例 1 · 执行远程命令**（`remote_ssh_exec`，默认 120s 超时）：

```json
{
  "command": "sinfo -h -o '%P %a %D %t %N' | head -20",
  "timeoutMs": 30000
}
```

返回 `{ ok, exitCode, stdout, stderr, error, truncated, isTimeout }`——例如：

```json
{ "ok": true, "exitCode": 0, "stdout": "cpu* up 12 idle 8 ...\n", "stderr": "", "error": "", "truncated": false, "isTimeout": false }
```

**示例 2 · 文件读写（无需同步）**：

```json
{ "path": "~/project/config.yaml", "content": "lr: 0.001\nepochs: 50\n" }
```

```json
{ "path": "~/project/train.py" }
```

`remote_ssh_cat` 走 base64 传输（二进制安全），`remote_ssh_write` 为原子写入（写临时文件再 rename）。

**示例 3 · 长时任务与挂起恢复**（构建 / 训练显式放宽，卡住可强杀会话）：

```json
{ "command": "cd ~/project && bash run_train.sh", "timeoutMs": 0 }
```

```json
{ "all": true }
```

`timeoutMs: 0` 禁用本次超时；环境变量 `DSH_REMOTE_SSH_CMD_TIMEOUT_MS=600000` 可改全局默认。超时后池化会话自动丢弃重建，`remote_ssh_kill` 是随时可用的手动兜底。

**示例 4 · 远程工作区内的工具调用**（免填 `profileId`，相对路径基于工作区远程目录）：

```json
{ "path": "configs/exp1.yaml" }
```

**示例 5 · 从 `~/.ssh/config` 导入连接**：设置 → 远程连接 → 「导入 SSH config」→ 勾选主机 → 自动填充 host / user / port / keyPath / ProxyJump。

**示例 6 · 本地镜像同步与回推**（离线批改后再一次性上传）：

```json
{ "workspaceId": "w_xxx" }
```

```json
{ "workspaceId": "w_xxx" }
```

`remote_ssh_sync` 把远端拉进本地镜像目录，`remote_ssh_push` 把镜像改动推回远端（tar over ssh，批量高效）。

## 模型工具

| 工具 | 用途 |
| --- | --- |
| `remote_ssh_profiles` | 列出连接配置 + 当前会话远程工作区上下文 |
| `remote_ssh_exec` | 执行远程命令（默认 120s 命令级超时，`timeoutMs` 可放宽/禁用） |
| `remote_ssh_kill` | 强制关闭池化 SSH 会话（挂起命令的兜底恢复） |
| `remote_ssh_ls` | 列举远程目录 |
| `remote_ssh_cat` | 读取远程文件 |
| `remote_ssh_write` | 写入远程文件 |
| `remote_ssh_grep` | 搜索远程文件内容 |
| `remote_ssh_glob` | 查找远程文件 |
| `remote_ssh_mkdir` | 创建远程目录 |
| `remote_ssh_delete` | 删除远程文件/目录 |
| `remote_ssh_move` | 移动/重命名 |
| `remote_ssh_sync` | 远端同步到本地镜像 |
| `remote_ssh_push` | 本地镜像推送回远端 |

远程工作区会话中调用工具可免填 `profileId` 等连接参数；全部文件/命令类工具走持久 SSH 会话池 + 结果缓存，`remote_ssh_exec` 单命令实测 ≈15× 提速。

## `@` 文件引用补全

远程工作区会话里输入 `@`，候选来自**远端**（与「文件」页签的树一致），而不是本地镜像目录：

- **索引来源**：git 仓库用 `git ls-files --cached --others --exclude-standard`（尊重 `.gitignore`、含未跟踪文件；真实超算实测 0.117s / 137 条），非 git 目录回退有界 `find`（`maxdepth 5` + 剪枝，实测 1.57s / 3121 条）；
- **排除在远端、截断之前**（2.4.8 修复）：`git ls-files --cached --others` 的输出**不是全局字典序**（未跟踪文件按 readdir 顺序先输出），`node_modules/` 这类目录可能占满前两万行把配额吃光——因此排除目录由远端 `grep -vE` 在 `head` 之前完成（与 `-prune` 同源，正则由同一份排除表生成），客户端过滤仅作双保险；索引达到上限时会打一条 warn 提示可能漏文件；
- **查询语义与官方 provider 逐条对齐**：`@` 与 `@src/` 走远端目录列举；`@read` 走索引模糊匹配（同名 > 前缀 > 名称子串 > 路径子串 > 子序列，目录加权 +25）；
- **不卡输入框**：索引按工作区缓存 60 秒（写文件/执行命令后自动失效），单次补全只等 900ms——超时先用旧索引作答、重建在后台进行；连接异常时自动回退到本地行为；
- **本地工作区不受影响**：非远程会话直接委托宿主原实现，索引与排序完全没有改动。

## 命令超时与恢复

所有 SSH 命令默认 **120 秒**超时（issue #5）：一条挂起的远端命令（网络卡顿、远端进程僵死、等待 stdin 的 `cat`）不会再永久占用会话、拖死后续命令。

- **超时后自动恢复**：池化会话超时即被丢弃并自动重建，后续命令照常执行；一次性连接超时即终止 SSH 进程；
- **显式放宽**：`remote_ssh_exec` 传 `timeoutMs`（毫秒）覆盖单次预算，`0` 禁用超时（长时构建/训练）；环境变量 `DSH_REMOTE_SSH_CMD_TIMEOUT_MS` 覆盖全局默认；
- **手动兜底**：`remote_ssh_kill`（或 `all: true`）强制关闭某个/全部池化会话，挂起命令随时可清理；
- 超时命令**不做自动重试**（重试一条挂起的命令只会再次挂起），由模型决定是否改用 `remote_ssh_kill` 或换命令重试。

## 兼容性

**实测矩阵**（2026-09-12，均为真机验证）：

| 组件 | 版本 | 状态 |
| --- | --- | --- |
| DSH | 0.1.5-rc.1（DSH Desktop v2.0.9） | ✅ 主机服务 / settings / tools / slot / 上传下载拦截全部咬合 |
| DSH | 0.1.2-rc.1 稳定线 | ✅（插件 2.3.x 时代基线） |
| dsh-better-sidebar | 0.15.0 – 0.18.0 | ✅ `fs.tree`/`fs.read`/`fs.write` + `fs.search`（`{ matches: cwd 相对 '/'-分隔路径, truncated }` 契约，2.4.11 起；此前只回 `entries` 会让「按文件名搜索」崩掉整块页签） |
| dsh-better-sidebar | 0.19.x | ⚠️ 插件侧已适配 6 端点（含 `fs.rename`/`fs.remove`）；但 0.19.0/0.19.1 自身在 DSH Desktop 上主机半边无法加载，需等上游修复（见[安装](#安装)的警告） |
| 远程主机 sshd | 标准 OpenSSH（Linux / 超算 / Windows） | ✅ 密钥认证；密码认证需本机 `sshpass`（POSIX） |

插件不修改 DSH 源码、不注入 profile 依赖树，全部能力经官方 `cordis.patch.yml` + profile 机制挂载。

## 故障排查

| 现象 | 原因与解法 |
| --- | --- |
| 「测试连接」报 `Permission denied (publickey)` | ① 私钥**带口令**：插件以批处理模式运行（`BatchMode=yes`），无法交互输口令——先用 `ssh-add` 加载，或去掉密钥口令；② Windows host 且用户在 Administrators 组时，公钥须写入 `C:\ProgramData\ssh\administrators_authorized_keys`；③ 用户名的写法（`user` / `.\user` / `user@domain`）要与手动连接一致 |
| 从 git-bash 启动 `dsh web` 后密钥认证失败 | 2.3.9 起已修复：Windows 下 ssh 解析固定为系统 OpenSSH 绝对路径（此前会误用 Git 自带的 MSYS2 ssh） |
| 侧边栏文件页签显示「这类内容还没有可用的查看方式。」 | `dsh-better-sidebar` 主机半边未加载：0.18.1 / 0.19.0 / 0.19.1 在 DSH Desktop 上会因 `SessionLogOffset` 运行时导入失败——降到 0.18.0 或使用修复版（上游 PR [#641](https://github.com/omdsh-dev/DSH-better-sidebar/pull/641)） |
| 内置「终端」页签连不上 | 终端为 `ssh -tt` 交互式通道，**仅支持密钥认证**；密码认证的连接会回退为本地 shell 并打印一行提示（避免把本地 shell 误认为已连上远程），密码认证请改用「文件」页签与模型工具 |
| 终端落在远程 `$HOME` 而不是工作区目录 | 2.4.5 起已修复（wrapper 会 `cd` 到工作区 `remotePath`，目录不存在时回退 `$HOME`）；若仍停在 `$HOME`，确认 2.4.5 已装入并重启 DSH |
| 「文件」页签树根显示镜像目录 ID（如 `wmu3sxe24jpvg`） | 2.4.6 起已修复：树根改为显示**远程目录名**（如 `IB_Robot`），悬停可见完整远程路径；该标签不经过 `fs.*` 路由，由客户端渲染层替换 |
| `@` 补全只搜到镜像里那几个文件 | 2.4.7 起已修复：远程工作区会话的 `@` 补全改列远端文件（索引缓存 60s + 900ms 查询预算）；若仍只有镜像文件，确认 2.4.7 已装入并重启 DSH |
| 大仓里 `@` 搜不到真实文件（如根目录 `AGENTS.md`、`src/**`） | 2.4.8 起已修复：此前排除目录发生在截断之后，`node_modules/` 这类目录会吃光索引配额；现在排除由远端 `grep`/`-prune` 在截断前完成，并会在索引达上限时打 warn 提示 |
| 想加的远程目录还不存在，「添加工作区」里没法创建 | 2.4.9 起「目录选择器」底部有「📁 新建目录」（本地 / 远程 tab 均有）：输入名字即可就地创建并自动进入 |
| 从局域网 / 另一台设备访问时插件文件能力全部报 403 | 2.4.10 起已修复：信任判定改用宿主 `ctx.webRuntime.trustedHosts`（与 `/api` 网关同源）。把访问地址加进 DSH 信任列表即可：启动时加 `--trusted-host <host[:port]>`（或经配对设备访问）；未配置时行为与之前一致（仅本机 loopback） |
| 「文件」页签的「按文件名搜索」一输入就报 `Cannot read properties of undefined (reading 'length')` | 2.4.11 起已修复：`fs.search` 拦截此前只返回 `entries`，而 better-sidebar 客户端契约是 `{ matches, truncated }`；现在补上 `matches`（cwd 相对、`/` 分隔，与上游自带实现一致）并保留 `entries` |
| 远程工作区里「按文件名搜索」一直转圈（大工作区） | 2.4.11 起已修复：改为浅层优先（`-maxdepth 3`，实测冷 0.68s / 热 0.11s）且**有命中就立即返回**（深挖转后台预热缓存，浅层零命中才同步等深挖 `-maxdepth 8`），遍历前剪噪声目录、去掉会阻塞短路的 `sort`，并加远端墙钟预算——到点返回**已收集的部分结果**并标记不完整。实测某 OpenFOAM 工作区：旧实现 5 分钟零输出 → 现在 **0.96s 返回 43 条** |
| 远程会话里 `@文件名` 没有候选，但单独输入 `@` 有 | 2.4.11 起已修复：模糊查询依赖索引，而索引首选 `git ls-files --cached --others`（`--others` 要遍历整棵工作树，巨型项目上跑不完 → 索引为空）。现在三级降级（完整 git 6s → 仅索引 git 3s → 有界 `find` `maxdepth 3` + 5s），并在索引未就绪时用有界 find 即时兜底（实测 0.65s），不再出现「全空」 |
| 安装时提示 `minimumReleaseAge` 或「No matching version」（刚发布） | npm 供应链新鲜度策略，等 1–5 分钟后重试即可 |
| 命令卡住不返回 | 默认 120s 超时后自动丢弃会话；长时任务用 `timeoutMs: 0`，随时可用 `remote_ssh_kill` 强杀 |
| 大文件读取被截断 | 单文件读取上限 4MB、下载池化路径约 6.29MB（更大自动回落一次性连接）；用 `remote_ssh_exec` + `head`/`tail` 分段处理 |

## 原理

插件注册 6 个 exact 路由（`/sidebar/api/fs.tree`、`fs.read`、`fs.write`、`fs.search`，以及 better-sidebar 0.19 新增的 `fs.rename`、`fs.remove`），在 better-sidebar 的 prefix 路由之前拦截。会话 cwd 含 `.remote-ssh.json` 时走 SSH，否则走本地 fs。客户端看到的是本地镜像路径，Host 自动转换为远程路径——对客户端完全透明。

远程读取采用**单往返合并读**：一条池化命令同时返回 `size/mtime` 帧与文件内容（文本类扩展名优先 raw 直传，字节长 + U+FFFD 双校验失败自动回退 base64，结果逐字节一致）；配合主机侧结果缓存与变更失效（见下节）。

Shell wrapper（`~/.dsh/remote-ssh/dsh-remote-shell[.cmd]`）检测工作区 `.remote-ssh.json`，自动 `ssh -tt` 连接远程，使内置「终端」页签透明接入。

## 缓存与一致性

远程读取与目录列举结果在主机侧缓存（读 LRU 32 条 + 列举 LRU 64 条，TTL 5 秒；单条 >1MiB 不缓存、总量 32MB 字节预算，防止大文件驻留拖慢宿主）：TTL 内重复打开或切回页签 **0 网络往返**；过期后先做一次轻量 mtime+size 复验，未变化则免重传。写、删除、移动、建目录、上传、推送（push）、成功的远端 exec 与变更类 git 子命令（add/reset/commit/checkout/revert/cherry-pick）会自动失效相关缓存，并以每 profile 缓存代（epoch）兜底「同秒同 size 写」等粒度盲区。

已知限制：

- 集成终端（`ssh -tt`）与远端其它进程改动的文件依赖 TTL + 复验兜底，最多 **5 秒**陈旧；
- `/sidebar/file` 下载池化路径有效上限约 **6.29MB**，更大文件自动退回一次性连接下载（可成功，多一次重连开销）；
- 二进制内容伪装成文本扩展名时会多一次 base64 回退往返（结果正确）。

## ❤️ 七夕快乐

本项目是送给 **zhangyi** 的七夕礼物。

愿它像连接起一台台远方的超算一样，也把我们紧紧连在一起。七夕快乐 ❤️

—— 2026 年 8 月 18 日

## 更新日志

版本历史与每版修复细节见 [CHANGELOG.md](./CHANGELOG.md)（最近：2.4.3 适配 better-sidebar 0.19 端点、2.4.2 修复设置图标闪现、2.4.0 命令级超时与 `remote_ssh_kill`）。

## 许可证

[MIT](./LICENSE)

---

如果这个插件帮到了你，欢迎在 GitHub 上点个 ⭐ [Star](https://github.com/ZhangFengshun/dsh-remote-ssh)，或到 [DSH Market](https://dshmarket.com) 收藏——这会帮助更多需要远程超算开发的人找到它。
