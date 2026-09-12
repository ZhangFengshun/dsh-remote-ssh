# @zhangfengshun/dsh-remote-ssh

[English](./README_EN.md) | 中文

类 **VSCode Remote-SSH** 的 **DSH** 插件：通过 SSH 连接远程超算 / 服务器，在 DSH 内置「文件」「终端」页签中直接操作远程文件和终端。

## 功能

| 能力 | 说明 |
| --- | --- |
| 🔌 SSH 连接 | 密钥 / 密码认证，ProxyJump 跳板机，`~/.ssh/config` 一键导入 |
| 📂 远程文件 | 内置「文件」页签直接 SSH 读写远程文件，无需同步 |
| 💻 远程终端 | 内置「终端」页签自动检测远程工作区，SSH 交互式终端 |
| 🌐 远程工作区 | 选择远程目录创建原生工作区，一键进入远程环境 |
| 🤖 模型工具 | 13 个 `remote_ssh_*` 工具，会话感知免填连接参数；命令级超时 + `remote_ssh_kill` 兜底恢复 |
| ⚡ 打开提速 | 单往返合并读 + raw 文本快路径 + 结果缓存（LRU + 5s TTL）：首开 ≈**1.31×**，TTL 内重复打开 **0 往返**，过期复验 **≈5×**（真实超算实测）；`remote_ssh_exec` 连接复用 **≈15×** |

## 截图

**设置 → 远程连接**：连接配置（密钥 / 密码 / ProxyJump 跳板机）· 连接测试 · 从 `~/.ssh/config` 一键导入

<p align="center"><img src="assets/settings-remote-connections.png" width="420" alt="设置：远程连接"></p>

**内置「文件」页签**：直接浏览远程主机文件（右侧文件树即远程目录，编辑保存直写远程）

<p align="center"><img src="assets/remote-files-tab.webp" width="820" alt="内置文件页签直接浏览远程文件"></p>

**内置「终端」页签**：自动 SSH 到远程超算（图为 SLURM 作业调度环境）；左侧会话即模型免填调用 `remote_ssh_*` 工具

<p align="center"><img src="assets/remote-terminal.webp" width="820" alt="内置终端页签自动 SSH 远程超算"></p>

## 安装

```bash
dsh plugin --profile <name> add @zhangfengshun/dsh-remote-ssh@2.4.3
```

> 安装后需**重启 DSH**。`@zhangfengshun/dsh-remote-ssh` 必须在 bundles 列表中排在 `dsh-better-sidebar` **之后**。
>
> 内置「文件」页签的 SSH 直读依赖 **dsh-better-sidebar ≥ 0.15** 的文件 API（`/sidebar/api/fs.*` 端点），请勿使用更早版本。
>
> ⚠️ **版本兼容性（2026-09 实测）**：`dsh-better-sidebar` **0.18.1 / 0.19.0 / 0.19.1** 在 DSH Desktop v2.0.9（DSH 0.1.5-rc.1）上**主机半边无法加载**——它们以值方式导入 `SessionLogOffset`，而当前 DSH 面向插件的模块面只提供该类型声明，导入直接抛错，导致侧边栏文件页签显示「这类内容还没有可用的查看方式。」。请使用 **0.18.0**（本插件已逐点验证）直到上游修复；本插件对 0.18（4 端点）与 0.19（6 端点，含 `fs.rename`/`fs.remove`）两套契约均已适配。

## 使用

1. **设置 → 远程连接** → 添加连接（主机/端口/用户/密钥）→ 点「测试连接」验证
2. **添加工作区** → 选「选择远程目录…」→ 选连接 → 浏览并选择远程目录
3. 打开内置「文件」页签 → 直接显示远程文件，编辑保存直接写回远程
4. 打开内置「终端」页签 → 自动 SSH 到远程主机（仅密钥认证）

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

## 命令超时与恢复

所有 SSH 命令默认 **120 秒**超时（issue #5）：一条挂起的远端命令（网络卡顿、远端进程僵死、等待 stdin 的 `cat`）不会再永久占用会话、拖死后续命令。

- **超时后自动恢复**：池化会话超时即被丢弃并自动重建，后续命令照常执行；一次性连接超时即终止 SSH 进程；
- **显式放宽**：`remote_ssh_exec` 传 `timeoutMs`（毫秒）覆盖单次预算，`0` 禁用超时（长时构建/训练）；环境变量 `DSH_REMOTE_SSH_CMD_TIMEOUT_MS` 覆盖全局默认；
- **手动兜底**：`remote_ssh_kill`（或 `all: true`）强制关闭某个/全部池化会话，挂起命令随时可清理；
- 超时命令**不做自动重试**（重试一条挂起的命令只会再次挂起），由模型决定是否改用 `remote_ssh_kill` 或换命令重试。

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

## 许可证

[MIT](./LICENSE)
