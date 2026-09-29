// open.external 契约回归测试 —— 「侧边栏打开文件/目录，打开的是本地目录而不是远程目录」（2026-09-29）
//
// 背景：better-sidebar 0.24 的文件树右键「打开方式 / 在文件管理器中显示」把**客户端已知的绝对路径**
// 直接交给宿主打开器（Windows: explorer.exe /select,<path>，或 rundll32 url.dll,FileProtocolHandler <url>）。
// 远程工作区里客户端只知道本地镜像路径，于是：
//   · 「在文件管理器中显示」→ 打开本地镜像目录；
//   · 「用 VS Code/Cursor 打开」→ `vscode://file/C:/…镜像…`（openWith.sshHost 未配置时走上游模板分支）
//     → 拉起本机 VS Code 打开镜像副本。
// 本插件现在拦截 `/sidebar/api/open.external`：远程工作区把路径翻译成远端路径并改开
// `vscode://vscode-remote/ssh-remote+<~/.ssh/config 别名><远端路径>`；本地工作区保持上游行为。
//
// 三层：
//   A. 纯函数：URL 解析 / file URL 还原本地路径 / SSH 别名匹配 / 远端编辑器 URL 组装 / 打开命令
//   B. 接线：注册 exact 路由、两条分支、回退与告警、detached 启动、干跑开关
//   C. 文档与版本号
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const src = readFileSync(root + '/lib/index.js', 'utf8')
const changelog = readFileSync(root + '/CHANGELOG.md', 'utf8')
const readme = readFileSync(root + '/README.md', 'utf8')
const maintenance = readFileSync(root + '/MAINTENANCE.md', 'utf8')
const pkg = JSON.parse(readFileSync(root + '/package.json', 'utf8'))

function grab(text, name) {
  const start = text.indexOf(name)
  if (start < 0) throw new Error(name + ' not found')
  const declStart = text.lastIndexOf('\n', start)
  let i = text.indexOf('{', start)
  let depth = 0
  for (; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') { depth--; if (depth === 0) break }
  }
  return text.slice(declStart + 1, i + 1)
}

let pass = 0, fail = 0
const check = (cond, label) => { if (cond) { pass++; console.log('  ✓ ' + label) } else { fail++; console.log('  ✗ FAIL: ' + label) } }

// ---------------------------------------------------------------------------
// 沙箱：纯函数（posixDirname/normalizeCachePath 一并注入，openerCommand 的 linux 分支要用）
// ---------------------------------------------------------------------------
const pure = new Function([
  grab(src, 'function normalizeCachePath'),
  grab(src, 'function posixDirname'),
  grab(src, 'function parseExternalUrl'),
  grab(src, 'function localPathFromExternalUrl'),
  grab(src, 'function remoteEditorAuthority'),
  grab(src, 'function remoteEditorUrl'),
  grab(src, 'function expandRemotePathForUrl'),
  grab(src, 'function openerCommand'),
  'return { parseExternalUrl, localPathFromExternalUrl, remoteEditorAuthority, remoteEditorUrl, expandRemotePathForUrl, openerCommand };'
].join('\n'))()

const { parseExternalUrl, localPathFromExternalUrl, remoteEditorAuthority, remoteEditorUrl, expandRemotePathForUrl, openerCommand } = pure

console.log('A1 · parseExternalUrl：只认自定义协议（上游 validateExternalUrl 同规则）')
{
  const one = parseExternalUrl('vscode://file/C:/Users/u/proj/a.ts')
  check(one && one.scheme === 'vscode' && one.authority === 'file' && one.path === '/C:/Users/u/proj/a.ts', 'vscode://file/<盘符路径> 解析')
  const spaced = parseExternalUrl('vscode://file/C:/Users/u/my%20proj/a%23b.ts')
  check(spaced && spaced.path === '/C:/Users/u/my proj/a#b.ts', '百分号解码（空格 / #）')
  const cur = parseExternalUrl('cursor://file//home/u/a.ts')
  check(cur && cur.scheme === 'cursor' && cur.path === '//home/u/a.ts', 'POSIX 形态与 scheme 保留（cursor）')
  check(parseExternalUrl('zed://file/C:/a%zz') !== null, '含裸 % 的路径不抛异常')
  check(parseExternalUrl('http://example.com/a') === null, 'http 拒绝')
  check(parseExternalUrl('https://example.com/a') === null, 'https 拒绝')
  check(parseExternalUrl('C:\\Users\\u\\a.ts') === null, '裸 Windows 路径不是协议 URL')
  check(parseExternalUrl('not a url') === null, '普通文本拒绝')
  check(parseExternalUrl('') === null && parseExternalUrl(undefined) === null, '空值拒绝')
  const remoteForm = parseExternalUrl('vscode://vscode-remote/ssh-remote+myhost/data/x')
  check(remoteForm && remoteForm.authority === 'vscode-remote', '识别 vscode-remote 形态（客户端已自处理的形状）')
  const withQuery = parseExternalUrl('vscode://file/C:/a/b.ts?x=1#frag')
  check(withQuery && withQuery.path === '/C:/a/b.ts', '忽略 query / fragment')
}

console.log('A2 · localPathFromExternalUrl：file URL → 本地路径')
{
  check(localPathFromExternalUrl(parseExternalUrl('vscode://file/C:/Users/u/proj/a.ts')) === 'C:/Users/u/proj/a.ts', '/C:/ → C:/')
  check(localPathFromExternalUrl(parseExternalUrl('vscode://file/C:\\Users\\u\\a.ts')) === 'C:\\Users\\u\\a.ts', '反斜杠形态原样还原')
  check(localPathFromExternalUrl(parseExternalUrl('vscode://file//home/u/a.ts')) === '/home/u/a.ts', '//home/u → /home/u')
  check(localPathFromExternalUrl(parseExternalUrl('vscode://localhost/C:/a.ts')) === 'C:/a.ts', 'authority=localhost 视为本地（同样还原盘符）')
  check(localPathFromExternalUrl(parseExternalUrl('vscode://vscode-remote/ssh-remote+h/data/a')) === null, 'vscode-remote 不当作本地路径')
  check(localPathFromExternalUrl(parseExternalUrl('myeditor://open/C:/a.ts')) === null, '自定义 authority 不当作本地路径')
  check(localPathFromExternalUrl(null) === null, 'null 安全')
}

console.log('A3 · remoteEditorAuthority：优先 ~/.ssh/config 别名（端口/用户必须一致）')
{
  const profile = { id: 'p1', host: 'ssh.example.com', port: 2222, user: 'u@CLUSTER', authMethod: 'key', keyPath: '/k' }
  const hosts = [
    { name: 'other', hostName: 'other.example.com', user: 'u@CLUSTER', port: 2222 },
    { name: 'ssh.example.com', hostName: 'ssh.example.com', user: 'u@CLUSTER', port: 2222 },
    { name: 'alias-2222', hostName: 'real.hpc.internal', user: '', port: 2222 },
    { name: 'wrong-port', hostName: 'ssh.example.com', user: 'u@CLUSTER', port: 22 },
    { name: 'wrong-user', hostName: 'ssh.example.com', user: 'someone-else', port: 2222 }
  ]
  check(remoteEditorAuthority(profile, hosts) === 'ssh.example.com', 'HostName + Host 同名 + 端口/用户一致 → 取该别名')
  const aliasOnly = { id: 'p2', host: 'real.hpc.internal', port: 2222, user: '' }
  check(remoteEditorAuthority(aliasOnly, hosts) === 'alias-2222', 'HostName 匹配 + 用户未设 → 取别名（VS Code 复用 Port/User/IdentityFile/ProxyJump）')
  const noAlias = { id: 'p3', host: 'unknown.hpc', port: 2222, user: 'u' }
  check(remoteEditorAuthority(noAlias, hosts) === null, '无别名且端口非 22 → null（避免误连 22 端口）')
  const stdPort = { id: 'p4', host: 'unknown.hpc', port: 22, user: 'u' }
  check(remoteEditorAuthority(stdPort, hosts) === 'u@unknown.hpc', '无别名但端口 22 → user@host 兜底')
  const stdPortNoUser = { id: 'p5', host: 'unknown.hpc', port: 22, user: '' }
  check(remoteEditorAuthority(stdPortNoUser, hosts) === null, '无别名、端口 22 但无用户名 → null（不猜）')
  check(remoteEditorAuthority({ host: '' }, hosts) === null, 'host 为空 → null')
  check(remoteEditorAuthority(profile, []) === null, 'ssh config 为空 → null')
  check(remoteEditorAuthority(profile, null) === null, 'hosts 为 null 时不抛')
}

console.log('A4 · remoteEditorUrl：远端编辑器 URL 组装')
{
  check(remoteEditorUrl('vscode', 'myhost', '/data/run01/proj/a.ts') === 'vscode://vscode-remote/ssh-remote+myhost/data/run01/proj/a.ts', '基本形态')
  check(remoteEditorUrl('vscode', 'myhost', 'data/a.ts') === 'vscode://vscode-remote/ssh-remote+myhost/data/a.ts', '缺前导斜杠自动补齐')
  check(remoteEditorUrl('vscode', 'myhost', '/data/my proj/a.ts') === 'vscode://vscode-remote/ssh-remote+myhost/data/my%20proj/a.ts', '空格 → %20')
  check(remoteEditorUrl('vscode', 'myhost', '/data/项目/a.ts') === 'vscode://vscode-remote/ssh-remote+myhost/data/%E9%A1%B9%E7%9B%AE/a.ts', '中文路径百分号编码')
  check(remoteEditorUrl('cursor', 'h', '/x') === 'cursor://vscode-remote/ssh-remote+h/x', '保留客户端选择的编辑器 scheme')
  check(remoteEditorUrl('vscode', 'u@h:2222', '/x') === 'vscode://vscode-remote/ssh-remote+u@h:2222/x', '别名里的 @ / : / + 不被编码')
  check(remoteEditorUrl('vscode', 'h', '/') === 'vscode://vscode-remote/ssh-remote+h/', '根路径不炸')
}

console.log('A5 · expandRemotePathForUrl：URL 不经过 shell，`~` 必须自己展开（真机工作区就是 `~/run/...`）')
{
  check(expandRemotePathForUrl('~/run/zfs/proj', '/home/u') === '/home/u/run/zfs/proj', '~ → 远端 home')
  check(expandRemotePathForUrl('~', '/home/u') === '/home/u', '裸 ~ → home')
  check(expandRemotePathForUrl('~/', '/home/u') === '/home/u', '~/ → home')
  check(expandRemotePathForUrl('/data/run01/proj', null) === '/data/run01/proj', '绝对路径原样通过（不需要 home）')
  check(expandRemotePathForUrl('user/zfs/case', '/home/u') === '/home/u/user/zfs/case', '相对路径按登录 shell 起始目录（home）展开')
  check(expandRemotePathForUrl('/home/u/', '/home/u') === '/home/u/', '绝对路径不做规范化（交给 URL 层）')
  check(expandRemotePathForUrl('~/run', '/home/u/') === '/home/u/run', 'home 末尾斜杠归一')
  check(expandRemotePathForUrl('~/run', null) === null, '拿不到 home → null（调用方回退，不拼出假路径）')
  check(expandRemotePathForUrl('rel/path', null) === null, '相对路径且无 home → null')
  check(expandRemotePathForUrl('~other/x', '/home/u') === null, '~user 形态不支持 → null')
  check(expandRemotePathForUrl('', '/home/u') === '/home/u', '空路径落到 home')
  check(expandRemotePathForUrl(undefined, null) === null, '未定义输入不抛异常')
}

console.log('A6 · openerCommand：与上游 revealCommand / urlCommand 同形（argv 数组，无 shell）')
{
  check(JSON.stringify(openerCommand('reveal', 'C:\\tmp\\a.txt', 'win32')) === JSON.stringify({ command: 'explorer.exe', args: ['/select,C:\\tmp\\a.txt'] }), 'win32 reveal → explorer.exe /select,<path>')
  check(JSON.stringify(openerCommand('reveal', '/tmp/a.txt', 'darwin')) === JSON.stringify({ command: 'open', args: ['-R', '/tmp/a.txt'] }), 'darwin reveal → open -R')
  check(JSON.stringify(openerCommand('reveal', '/tmp/dir/a.txt', 'linux')) === JSON.stringify({ command: 'xdg-open', args: ['/tmp/dir'] }), 'linux reveal → xdg-open 父目录')
  check(JSON.stringify(openerCommand('url', 'vscode://x/y', 'win32')) === JSON.stringify({ command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', 'vscode://x/y'] }), 'win32 url → rundll32 url.dll,FileProtocolHandler')
  check(JSON.stringify(openerCommand('url', 'vscode://x/y', 'darwin')) === JSON.stringify({ command: 'open', args: ['vscode://x/y'] }), 'darwin url → open')
  check(JSON.stringify(openerCommand('url', 'cursor://file//a b', 'linux')) === JSON.stringify({ command: 'xdg-open', args: ['cursor://file//a b'] }), 'linux url → xdg-open（值不被额外加引号）')
  check(openerCommand('reveal', 'a b.txt', 'win32').args[0].includes(' ') && !openerCommand('reveal', 'a b.txt', 'win32').args[0].includes('"'), '带空格路径不做 shell 引用')
}

console.log('B1 · 注册：open.external 的 exact 路由（抢在 better-sidebar 的 prefix 路由之前）')
{
  const regs = src.split('ctx.webServer.register(').length - 1
  const hits = src.split('path: "/sidebar/api/" + OPEN_EXTERNAL_METHOD').length - 1
  check(src.includes('const OPEN_EXTERNAL_METHOD = "open.external"'), '端点名常量化')
  check(hits === 1, '只注册一处 open.external（重复注册会互相覆盖 / 报冲突）')
  const block = src.slice(src.indexOf('path: "/sidebar/api/" + OPEN_EXTERNAL_METHOD'))
  check(block.includes('kind: "exact"'), 'exact 路由（prefix 匹配不到点分隔端点）')
  check(block.includes('handler: interceptOpenExternalHandler'), '挂到 interceptOpenExternalHandler')
  check(block.includes('ctx.effect('), '注册包在 ctx.effect 里（插件卸载即注销）')
  check(regs >= 6, '注册点数量正常（未破坏既有注册，实际 ' + regs + ' 处）')
}

console.log('B2 · 两条分支：远程翻译成远端路径，本地保持上游行为')
{
  const handler = src.slice(src.indexOf('async function interceptOpenExternalHandler'))
  check(handler.includes('requestTrust(req, false)') && handler.includes('denyRequest'), '信任校验（与 fs.* 同规则）')
  check(handler.includes('req.method !== "POST"') && handler.includes('405'), '非 POST → 405')
  check(handler.includes('isAbsoluteLocalPath(localPath)'), 'reveal 必须是绝对路径')
  check(handler.includes('path must be an absolute path'), 'reveal 非法路径 → bad-request')
  check(handler.includes('url must be a custom-scheme URL'), 'url 非法协议 → bad-request')
  check(handler.includes("action must be \"reveal\" or \"url\""), '未知 action → bad-request（对齐上游文案）')

  const remote = src.slice(src.indexOf('async function remoteHomeDir'), src.indexOf('async function interceptOpenExternalHandler'))
  check(remote.includes('matchRemoteWorkspace(localPath, null)'), '远程判定按镜像路径归属（open.external 没有 sessionId/cwd）')
  check(remote.includes('getProfile(ws.profileId)'), '按工作区 profileId 取连接')
  check(remote.includes('listSshConfigHosts()'), '读 ~/.ssh/config 找 VS Code 别名')
  check(remote.includes('remoteEditorAuthority(profile,'), '别名匹配（端口/用户一致）')
  check(remote.includes('posixDirname(localToRemote('), 'reveal → 翻译到远端「所在目录」')
  check(remote.includes('localToRemote(localPath, ws.mirrorPath, ws.remotePath)'), 'url → 翻译到远端原路径')
  check(remote.includes('expandRemotePathForUrl(raw, home)') && remote.includes('remoteHomeDir(profile)'), '拼 URL 前把 ~ 展开成远端 home')
  check(remote.includes("'printf %s \"$HOME\"'"), '远端 home 用 printf %s "$HOME" 查询（不解析 shell 提示符噪声）')
  check(remote.includes('home.charAt(0) !== "/"'), '远端 home 必须是绝对路径才采信')
  check(remote.includes('REMOTE_HOME_TTL_MS'), '远端 home 按 profile 缓存（避免每次点击一次 SSH 往返）')
  check(src.includes('const remoteHomeCache = new Map()'), 'home 缓存实例存在')
  check(remote.includes('无法把远端路径展开成绝对路径'), '展开失败 → 告警 + 回退（不拼出打不开的 URL）')
  check(remote.includes('remoteEditorUrl(scheme || "vscode", authority, remotePath)'), '组装 Remote-SSH URL')
  check(remote.includes('return false'), '拿不到别名/profile 时返回 false（调用方回退，不静默失败）')
  check(remote.includes('~/.ssh/config 里没有与'), '回退前告警说明原因（可诊断）')
  check(remote.includes('remote profile not found'), 'profile 丢失同样告警')

  check(handler.includes('launchExternal("reveal", localPath)'), '本地工作区 reveal 复用上游命令')
  check(handler.includes('launchExternal("url", rawUrl)'), '本地工作区 url 原样交给协议处理器')
  check(handler.includes('parsed.scheme'), '远程 url 分支保留客户端选择的 scheme')
  check(handler.includes('writeOk(res, { started: true, remote: true })'), '远程命中时回报 started/remote')
  check(handler.includes('writeOk(res, { started: launchExternal("reveal", localPath), remote: false })'), '本地回退回报 remote:false')
  check(handler.includes('"vscode-remote"'), '已是 Remote-SSH 形态时不重复改写')
}

console.log('B3 · 启动方式：detached + 不阻塞请求 + 测试干跑开关')
{
  const launch = src.slice(src.indexOf('function launchExternal'), src.indexOf('async function launchRemoteEditor'))
  check(launch.includes('spawn(spec.command, spec.args, { detached: true, stdio: "ignore" })'), 'detached + stdio ignore（不拖住 HTTP 请求）')
  check(launch.includes('child.unref()'), 'unref（宿主退出不等待打开器）')
  check(launch.includes('child.on("error", () => {})'), '打开器缺失只吞掉错误（与上游一致）')
  check(launch.includes('DSH_REMOTE_SSH_NO_LAUNCH'), '干跑开关（自动化测试不弹窗）')
  check(launch.includes('openerCommand(kind, value, process.platform)'), '按平台构造命令')
  check(!launch.includes('shell: true') && !launch.includes('exec('), '不经 shell（无注入面）')
  check(src.includes('import { spawn } from "node:child_process"'), '显式依赖 node:child_process')
}

console.log('B4 · 文档与版本')
{
  check(pkg.version === '2.4.18', 'package.json 版本 = 2.4.18（当前 ' + pkg.version + '）')
  check(changelog.includes('open.external'), 'CHANGELOG 记录 open.external 修复')
  check(changelog.includes('vscode-remote/ssh-remote+'), 'CHANGELOG 说明改开 Remote-SSH URL')
  check(readme.includes('open.external'), 'README 写明 open.external 也在拦截清单里')
  check(readme.includes('ssh-remote+'), 'README 给出 Remote-SSH 打开语义')
  check(maintenance.includes('open.external'), 'MAINTENANCE 对拍清单含 open.external')
  check(maintenance.includes('openWith.sshHost'), 'MAINTENANCE/README 提醒 openWith.sshHost 的坑')
}

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
