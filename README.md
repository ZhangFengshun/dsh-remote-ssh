# @zhangfengshun/dsh-remote-ssh

类 **VSCode Remote-SSH** 的 **DeepSeek Harness（DSH）** Web 插件：通过 SSH 连接远程超算 / 服务器，在 DSH 中完成远程工作区、远程文件浏览 / 编辑、集成远程终端，并让模型可以直接读写远程文件、执行远程命令。

界面与工具描述均支持**中英文双语**，跟随 DSH 设置中的语言自动切换。

## 功能特性

| 能力 | 说明 |
| --- | --- |
| 🔌 远程连接 | SSH 连接超算 / 服务器，密钥认证（推荐）或密码认证（需本机 `sshpass`），内置「测试连接」；支持 `ProxyJump` 跳板机 |
| ⚡ 连接复用 | 持久 SSH 会话池，文件操作复用同一条已认证连接，不再每次握手（首次后近乎瞬时） |
| 📥 配置导入 | 一键从 `~/.ssh/config`（递归 `Include`）发现主机并批量导入连接配置 |
| 🗂️ 远程文件 | 在 better-sidebar「远程文件」页签浏览 / 打开 / 编辑 / 保存远程文件；选中工作区后可双向同步 |
| 💻 远程终端 | 在 better-sidebar「远程终端」页签打开 `ssh -tt` 集成终端，支持多终端并发 |
| 🔄 双向同步 | `remote_ssh_sync`（远端 → 本地镜像）/ `remote_ssh_push`（本地镜像 → 远端），tar 流式管道，同步后内置文件工具可见 |
| 🌐 远程工作区 | 选择远程目录创建**原生工作区**（本地镜像目录 + 原生注册），一键打开进入远程环境 |
| 🤖 模型工具 | 12 个 `remote_ssh_*` 工具，模型可读写远程文件、执行远程命令、内容搜索、文件名查找、目录/删除/移动、双向同步；在远程工作区会话中免填连接参数 |
| 🌍 国际化 | 界面文案 + 工具描述中英双语，通过 `ctx.locale` 跟随 DSH 语言设置自动切换 |
| 🧠 会话记忆 | 切换会话后，「远程文件」「远程终端」页签记住已选连接、浏览目录、打开的文件与终端 |

## 安装

### 本地 / 开发安装

```bash
dsh plugin --profile <name> add /absolute/path/to/dsh-remote-ssh
```

### 发布后安装

```bash
dsh plugin --profile <name> add @zhangfengshun/dsh-remote-ssh@1.8.0
```

> ⚠️ 安装后需**重启 DSH** 才生效；后续仅修改 Client 半边时刷新浏览器即可。

## 快速开始

1. 安装插件并重启 DSH。
2. 打开 **设置 → 🖥️ 远程连接**，添加一条连接（主机 / 端口 / 用户名 / 密钥或密码），点「测试连接」验证。
3. 在侧边栏打开 **🗂️ 远程文件** 或 **💻 远程终端** 页签使用。
4. 需要把远程目录当作工作区时：走 DSH 原生「添加工作区」流程，在弹窗中选择「**选择远程目录…**」。

## 使用指南

### 1. 添加远程连接

设置 → 🖥️ 远程连接，填写：

| 字段 | 说明 |
| --- | --- |
| 名称 | 自定义显示名 |
| 主机 | SSH 主机名或 IP（如 `login.example.com`） |
| 端口 | SSH 端口，默认 `22` |
| 用户名 | 登录用户 |
| 认证方式 | `密钥`（推荐）或 `密码` |
| 密钥路径 / 密码 | 私钥路径（如 `~/.ssh/id_rsa`）或登录密码 |
| 远程根目录 | 远程默认目录，默认 `~` |

连接配置持久化在 DSH 设置命名空间 `dsh-remote-ssh` 中（密码字段 `role('secret')` 脱敏）。

### 2. 远程文件（🗂️）

- 选择**远程工作区**或**连接配置**，浏览远程目录；
- 点击文件即可打开并编辑，保存后写回远程；
- 已选连接 / 目录 / 打开的文件在**切换会话后自动恢复**。

### 3. 远程终端（💻）

- 选择连接配置，点「新建终端」打开 `ssh -tt` 交互式终端；
- 支持同时打开多个终端，会话切换后终端列表自动恢复（终端本体在宿主进程存活，恢复后继续回显）。

### 4. 远程工作区（🌐）

1. 打开 DSH 原生「添加工作区」流程；
2. 选择「**选择远程目录…**」→ 选择连接 → 浏览并选择远程目录；
3. 插件在本地生成镜像目录 `~/.dsh/remote-workspaces/<id>` 并注册进原生工作区列表（标题 `🌐 <名称>`）；
4. 从工作区创建会话后，会话工作目录即该镜像目录，模型工具自动感知对应的远程连接与目录。

### 5. 模型工具（🤖）

插件向模型注册 5 个工具，模型可直接操作远程环境：

| 工具 | 用途 |
| --- | --- |
| `remote_ssh_profiles` | 列出已保存连接配置；返回当前会话的远程工作区上下文 |
| `remote_ssh_exec` | 在远程主机执行命令（返回 stdout / stderr / exitCode） |
| `remote_ssh_ls` | 列举远程目录 |
| `remote_ssh_cat` | 读取远程文本文件（base64 传输，二进制安全） |
| `remote_ssh_write` | 写入远程文件（覆盖写入） |
| `remote_ssh_sync` | 远端文件同步到本地镜像目录（tar 流式管道） |
| `remote_ssh_push` | 本地镜像目录推送回远端（tar 流式管道） |
| `remote_ssh_grep` | 递归搜索远程文件内容（grep -rnIE，支持 include/ignoreCase） |
| `remote_ssh_glob` | 按通配符查找远程文件（find -name，递归） |
| `remote_ssh_mkdir` | 创建远程目录（mkdir -p） |
| `remote_ssh_delete` | 删除远程文件或目录（rm -rf，⚠️ 不可恢复） |
| `remote_ssh_move` | 移动/重命名远程文件或目录（mv） |

**会话感知**：当会话是从远程工作区创建时，模型调用这些工具可**不填** `profileId` / `host` / `user` 等连接参数，自动复用该工作区的连接，相对路径基于该工作区远程目录解析。

## 目录结构

```
dsh-remote-ssh/
├── package.json       # npm 元数据 + dsh.bundle / dsh.client 声明
├── cordis.patch.yml   # bundle 挂载补丁（install 时加入 profile bundle 栈）
├── lib/
│   ├── index.js       # Host 半边（SSH + settings + 5 个工具 + HTTP API）
│   └── client.js      # Client 半边（better-sidebar 页签 + 设置小节 + i18n）
├── LICENSE
├── CHANGELOG.md
└── README.md
```

## 架构

```
浏览器 (Client 半边)                     Node 进程 (Host 半边)
┌───────────────────────────────┐  fetch  ┌──────────────────────────────────┐
│ ctx.betterSidebar.registerTab │ ──────▶ │ ctx.webServer /remote-ssh/api/*  │
│  · 远程文件 / 远程终端        │ ◀────── │  · SSH：listDir/readFile/…       │
│ ctx.slots: settings.section   │  JSON   │  · settings：profiles/workspaces  │
│  · DSH 设置页「远程连接」      │         │  · terminals：ssh -tt 管道        │
└───────────────────────────────┘         │ ctx.tools：12 个 remote_ssh_*    │
                                          └───────────────┬──────────────────┘
                                                          │ SSH
                                                     远程超算 / 服务器
```

关键设计：

- **免 shell 引号转义**：远程命令通过 `subprocess.spawn({ argv })` 以参数数组调起 `ssh.exe`，避免引号 / 空格问题。
- **二进制安全读文件**：远程 `base64 -w0` 输出，Host 用 `Buffer` 解码为 UTF-8。
- **写文件走 stdin**：远程 `cat > <file>`，内容经子进程 stdin 传入。
- **文件列举**：`find -printf '%Y\t%f\t%s\n'`（`%Y` 跟随软链接取目标类型，适配超算家目录软链接）。
- **终端**：`ssh -tt` 分配远程 PTY，本地管道转发，客户端 HTTP 轮询回显（无 `node-pty` 依赖，Windows 可用）。
- **国际化**：Client 接入 `ctx.locale`，注册 `zh` / `en` 词典，界面与工具描述跟随 DSH 语言自动切换。

## 已知限制

1. **终端非本地 PTY**：走 `ssh -tt` 管道通道（跨平台可用）；`vim` / `htop` 等全屏程序体验受限，后续可接入 `terminals.registerBackend` + `node-pty` 真 PTY。
2. **文件操作依赖 GNU 工具**（`find -printf`、`base64 -w0`）：目标为 Linux 超算时通用。
3. **密码认证需本机 `sshpass`**（Windows 默认没有）；密钥认证无此依赖。
4. **同步为全量 tar**：`remote_ssh_sync` / `remote_ssh_push` 用 `tar` 流式全量同步，单次同步大目录耗时与传输量较高，后续可换 `rsync -e ssh` 增量。
5. **原生工具编辑的是本地镜像副本**，不会自动回传 —— 须点「推送」或调用 `remote_ssh_push` 同步回远端（与 `dsh-remote` 的 `rw_sync` / `rw_push` 模型一致）。

## 路线图

- [x] 从 `~/.ssh/config` 自动导入连接
- [x] ProxyJump / 跳板机、SSH config 复用
- [x] `tar`-over-ssh 双向同步（`scp` / `sftp` 增量同步为后续优化）
- [ ] `rsync -e ssh` 增量同步
- [ ] 真 PTY 终端（`terminals.registerBackend` + `node-pty`）
- [ ] 密码凭据走 `credentials` 服务（避免明文进 argv）

## 许可证

[MIT](./LICENSE)

---

## ❤️ 七夕快乐

本项目是送给 **zhangyi** 的七夕礼物。

愿它像连接起一台台远方的超算一样，也把我们紧紧连在一起。七夕快乐 ❤️

—— 2026 年 8 月 18 日
