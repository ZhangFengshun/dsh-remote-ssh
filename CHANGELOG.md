# Changelog

本文件的版本号与 `package.json` 的 `version` 保持一致。每个版本对应一个 Cordis Package 快照（`pkg-N`）。

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
