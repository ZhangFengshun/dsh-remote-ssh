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
| 🤖 模型工具 | 12 个 `remote_ssh_*` 工具，会话感知免填连接参数 |

## 安装

```bash
dsh plugin --profile <name> add @zhangfengshun/dsh-remote-ssh@2.1.7
```

> 安装后需**重启 DSH**。`@zhangfengshun/dsh-remote-ssh` 必须在 bundles 列表中排在 `dsh-better-sidebar` **之后**。

## 使用

1. **设置 → 🖥️ 远程连接** → 添加连接（主机/端口/用户/密钥）→ 点「测试连接」验证
2. **添加工作区** → 选「选择远程目录…」→ 选连接 → 浏览并选择远程目录
3. 打开内置「文件」页签 → 直接显示远程文件，编辑保存直接写回远程
4. 打开内置「终端」页签 → 自动 SSH 到远程主机（仅密钥认证）

## 模型工具

| 工具 | 用途 |
| --- | --- |
| `remote_ssh_profiles` | 列出连接配置 + 当前会话远程工作区上下文 |
| `remote_ssh_exec` | 执行远程命令 |
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

远程工作区会话中调用工具可免填 `profileId` 等连接参数。

## 原理

插件注册 4 个 exact 路由（`/sidebar/api/fs.tree`、`fs.read`、`fs.write`、`fs.search`），在 better-sidebar 的 prefix 路由之前拦截。会话 cwd 含 `.remote-ssh.json` 时走 SSH，否则走本地 fs。客户端看到的是本地镜像路径，Host 自动转换为远程路径——对客户端完全透明。

Shell wrapper（`~/.dsh/remote-ssh/dsh-remote-shell[.cmd]`）检测工作区 `.remote-ssh.json`，自动 `ssh -tt` 连接远程，使内置「终端」页签透明接入。

## ❤️ 七夕快乐

本项目是送给 **zhangyi** 的七夕礼物。

愿它像连接起一台台远方的超算一样，也把我们紧紧连在一起。七夕快乐 ❤️

—— 2026 年 8 月 18 日

## 许可证

[MIT](./LICENSE)
