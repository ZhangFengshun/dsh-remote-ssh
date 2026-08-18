# @zhangfengshun/dsh-remote-ssh

类 **VSCode Remote-SSH** 的 **DeepSeek Harness（DSH）** Web 插件：通过 SSH 连接远程超算 / 服务器，在 DSH 中完成远程工作区、远程文件浏览 / 编辑、集成远程终端，并让模型可以直接读写远程文件、执行远程命令。

界面与工具描述均支持**中英文双语**，跟随 DSH 设置中的语言自动切换。

## 功能特性

| 能力 | 说明 |
| --- | --- |
| 🔌 远程连接 | SSH 连接超算 / 服务器，密钥认证（推荐）或密码认证（需本机 `sshpass`），内置「测试连接」；支持 `ProxyJump` 跳板机 |
| ⚡ 连接复用 | 持久 SSH 会话池，文件操作复用同一条已认证连接，不再每次握手（首次后近乎瞬时） |
| 📥 配置导入 | 一键从 `~/.ssh/config`（递归 `Include`）发现主机并批量导入连接配置 |
| 🗂️ 远程文件 | 创建远程工作区时自动同步到本地镜像，内置「文件」页签直接显示远程文件；编辑后通过设置页同步/推送回传 |
| 💻 远程终端 | 内置「终端」页签自动通过 shell wrapper 检测远程工作区，打开 SSH 交互式终端（仅密钥认证） |
| 🔄 双向同步 | 设置页一键同步（远端 → 本地镜像）/ 推送（本地镜像 → 远端），或通过 `remote_ssh_sync` / `remote_ssh_push` 工具 |
| 🌐 远程工作区 | 选择远程目录创建**原生工作区**（本地镜像目录 + 原生注册 + 自动同步），一键打开进入远程环境 |
| 🤖 模型工具 | 12 个 `remote_ssh_*` 工具，模型可读写远程文件、执行远程命令、内容搜索、文件名查找、目录/删除/移动、双向同步；在远程工作区会话中免填连接参数 |
| 🌍 国际化 | 界面文案 + 工具描述中英双语，通过 `ctx.locale` 跟随 DSH 语言设置自动切换 |

## 安装

### 本地 / 开发安装

```bash
dsh plugin --profile <name> add /absolute/path/to/dsh-remote-ssh
```

### 发布后安装

```bash
dsh plugin --profile <name> add @zhangfengshun/dsh-remote-ssh@2.0.0
```

> ⚠️ 安装后需**重启 DSH** 才生效；后续仅修改 Client 半边时刷新浏览器即可。
>
> ⚠️ **安装顺序**：本插件会自动覆盖 `dsh-better-sidebar` 的 `shell` 配置。为确保 patch 生效（config 覆盖在 insert 之后应用），`@zhangfengshun/dsh-remote-ssh` 必须在 bundles 列表中排在 `dsh-better-sidebar` **之后**。如果先安装了 `@zhangfengshun/dsh-remote-ssh`，再安装 `dsh-better-sidebar`，需手动调整 `profile/package.json` 中 `dsh.profile.bundles` 的顺序，把 `@zhangfengshun/dsh-remote-ssh` 移到最后。

## 快速开始

1. 安装插件并重启 DSH（安装时自动配置 better-sidebar 的 shell 指向 wrapper 脚本）。
2. 打开 **设置 → 🖥️ 远程连接**，添加一条连接（主机 / 端口 / 用户名 / 密钥或密码），点「测试连接」验证。
3. 需要把远程目录当作工作区时：走 DSH 原生「添加工作区」流程，在弹窗中选择「**选择远程目录…**」→ 选择连接 → 浏览并选择远程目录。
4. 创建后远程文件自动同步到本地镜像，内置「文件」页签直接可见。
5. 在远程工作区中打开内置「终端」页签 → 自动 SSH 到远程主机（仅密钥认证）。

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

### 2. 远程文件（内置「文件」页签）

- 创建远程工作区时，远程文件自动同步到本地镜像目录，内置「文件」页签直接显示；
- 内置编辑器编辑的是本地镜像副本，编辑后需**推送回远端**；
- 推送方式：设置 → 远程连接 → 远程工作区 → 点「⬆ 推送」按钮，或模型调用 `remote_ssh_push` 工具；
- 远程有更新时点「⬇ 同步」重新拉取。

### 3. 远程终端（内置「终端」页签）

通过 shell wrapper 实现：终端启动时自动检测当前工作目录下的 `.remote-ssh.json`，若存在且含密钥路径 → 自动 `ssh -tt` 连接远程主机；否则启动本地 shell。

**自动配置**：安装插件后，`cordis.patch.yml` 自动把 better-sidebar 的 `shell` 配置覆盖为 wrapper 脚本路径（用 `!!js` 动态计算，适配不同平台和用户主目录）。**无需手动编辑任何配置文件。**

工作流程：
1. 插件启动时自动在 `~/.dsh/remote-ssh/` 下生成 wrapper 脚本：
   - `dsh-remote-shell.js`（核心逻辑：检测 `.remote-ssh.json` → `ssh -tt`；否则本地 shell）
   - Windows: `dsh-remote-shell.cmd`（薄壳调用 .js）
   - POSIX: `dsh-remote-shell`（薄壳调用 .js）
2. 安装时自动覆盖 better-sidebar 的 `shell` config 指向 wrapper 脚本。
3. 重启 DSH 后，在远程工作区中打开终端 → 自动 SSH 到远程主机；在本地工作区中打开终端 → 照常启动本地 shell。

> ⚠️ 终端透明接入仅支持**密钥认证**（密码无法安全传入 wrapper 脚本）。密码认证的连接仍可使用模型工具。
> 若需覆盖自动配置，在 profile 的 `cordis.patch.yml` 中加一条 `id: better-sidebar` 的 `config.shell` 即可（profile patch 优先于 bundle patch）。

### 4. 远程工作区（🌐）

1. 打开 DSH 原生「添加工作区」流程；
2. 选择「**选择远程目录…**」→ 选择连接 → 浏览并选择远程目录；
3. 插件在本地生成镜像目录 `~/.dsh/remote-workspaces/<id>`，写入 `.remote-ssh.json`（连接信息，供 shell wrapper 读取），自动同步远程文件，并注册进原生工作区列表（标题 `🌐 <名称>`）；
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
│ ctx.betterSidebar.registerTab  │ ──────▶ │ ctx.webServer /remote-ssh/api/*  │
│  · remssh:editor (隐藏)        │ ◀────── │  · SSH：listDir/readFile/…       │
│ ctx.slots: settings.section    │  JSON   │  · settings：profiles/workspaces  │
│  · 连接配置 + 工作区管理       │         │  · 自动同步 + shell wrapper 生成  │
│ ctx.slots: directoryFlow       │         │ ctx.tools：12 个 remote_ssh_*    │
│  · 本地 / 远程目录两选弹窗     │         └───────────────┬──────────────────┘
└───────────────────────────────┘                          │ SSH
                                              ┌─────────────┴──────────┐
                                              │ ~/.dsh/remote-ssh/    │
                                              │  dsh-remote-shell.js   │
                                              │  dsh-remote-shell[.cmd]│ ← better-sidebar shell 指向此文件
                                              └────────────────────────┘
                                                     远程超算 / 服务器
```

关键设计：

- **免 shell 引号转义**：远程命令通过 `subprocess.spawn({ argv })` 以参数数组调起 `ssh.exe`，避免引号 / 空格问题。
- **二进制安全读文件**：远程 `base64 -w0` 输出，Host 用 `Buffer` 解码为 UTF-8。
- **写文件走 stdin**：远程 `cat > <file>`，内容经子进程 stdin 传入。
- **文件列举**：`find -printf '%Y\t%f\t%s\n'`（`%Y` 跟随软链接取目标类型，适配超算家目录软链接）。
- **自动同步**：创建远程工作区时立即 `tar | ssh` 拉取远程文件到本地镜像，使内置「文件」页签可见真实远程文件。
- **Shell wrapper**：插件启动时生成跨平台 wrapper 脚本（Node.js + 薄壳），检测工作区 `.remote-ssh.json` 自动 SSH，使内置「终端」页签透明接入远程。
- **国际化**：Client 接入 `ctx.locale`，注册 `zh` / `en` 词典，界面与工具描述跟随 DSH 语言自动切换。

## 已知限制

1. **终端透明接入仅限密钥认证**：shell wrapper 通过 `.remote-ssh.json` 读取密钥路径，密码认证无法安全传入。密码认证的连接仍可使用模型工具和远程文件操作。
2. **文件操作依赖 GNU 工具**（`find -printf`、`base64 -w0`）：目标为 Linux 超算时通用。
3. **密码认证需本机 `sshpass`**（Windows 默认没有）；密钥认证无此依赖。
4. **同步为全量 tar**：`remote_ssh_sync` / `remote_ssh_push` 用 `tar` 流式全量同步，单次同步大目录耗时与传输量较高，后续可换 `rsync -e ssh` 增量。
5. **内置编辑器编辑的是本地镜像副本**，不会自动回传 —— 须在设置页点「推送」或调用 `remote_ssh_push` 同步回远端。

## 路线图

- [x] 从 `~/.ssh/config` 自动导入连接
- [x] ProxyJump / 跳板机、SSH config 复用
- [x] `tar`-over-ssh 双向同步（`scp` / `sftp` 增量同步为后续优化）
- [x] 远程文件合并到内置「文件」页签（自动同步 + 镜像）
- [x] 远程终端合并到内置「终端」页签（shell wrapper 透明 SSH）
- [ ] `rsync -e ssh` 增量同步
- [ ] 密码凭据走 `credentials` 服务（避免明文进 argv）

## 许可证

[MIT](./LICENSE)

---

## ❤️ 七夕快乐

本项目是送给 **zhangyi** 的七夕礼物。

愿它像连接起一台台远方的超算一样，也把我们紧紧连在一起。七夕快乐 ❤️

—— 2026 年 8 月 18 日
