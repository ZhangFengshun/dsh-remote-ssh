// 2.4.30（issue #26）：走不走远端由**请求路径本身**决定，不由会话 cwd 决定
//
// 报告（用户实测 + 附件复现）指出两处缺陷，且都是从 2.4.27/2.4.29 那条线上漏下来的：
//   缺陷一：会话在远程工作区时，**本机绝对路径**被当成远端路径 → 远端凭空多一层（`<root>/Users/…`），
//           读报 "No such file"（文件明明在本机）、写/删**静默落到错的位置**。
//   缺陷二：`localToRemote()` 对"不在镜像下"的输入一律剥盘符当相对路径 → **远端绝对路径**
//           （`/mnt/.../work/sub/a.md`、`/tmp/x.log`）被拼成 `<root><root>/…`，必然打不开。
// 报告里点名的两条验收断言，本文件逐条落地（B1/B2），并补上矩阵里其余形态。
//
// 三层：A 语法分类纯函数；B 真实处理器行为（命令级证据）；C 接线 + 变异可打性。
import { readFileSync, existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { stat, open, readFile, writeFile, rename, rm, mkdir, opendir, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const src = readFileSync(root + '/lib/index.js', 'utf8')
const pkg = JSON.parse(readFileSync(root + '/package.json', 'utf8'))
const changelog = readFileSync(root + '/CHANGELOG.md', 'utf8')
// 远端读的帧标记：从源码里取，避免测试自己写死一个值后与实现漂移
const DSH_ST_MARK = (src.match(/const DSH_ST_MARK = "([^"]+)";/) || [])[1]
if (!DSH_ST_MARK) throw new Error('DSH_ST_MARK not found in lib/index.js')

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

const PATH_HELPERS = [
  grab(src, 'function isAbsoluteLocalPath'),
  grab(src, 'function resolveSessionPath'),
  grab(src, 'function unresolvedPathMessage'),
  grab(src, 'function classifyRequestPathSyntax'),
  grab(src, 'function looksLikeRemoteAbsolutePath'),
].join('\n')

const NEW_HELPERS = (() => {
  const a = src.indexOf('// ---- better-sidebar 0.25.0 新端点的纯函数')
  const b = src.indexOf('/**\n * 解析 better-sidebar 0.24 的 `open.external` URL')
  if (a < 0 || b < 0 || b <= a) throw new Error('0.25.0 helper block not found')
  return src.slice(a, b)
})()

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------
const base = mkdtempSync(join(tmpdir(), 'dsh-2430-'))
const MIRROR_BASE = join(base, 'remote-workspaces')
const WS_ROOT = join(MIRROR_BASE, 'ws-alpha')
const WS_SUB = join(WS_ROOT, 'sub', 'deep')
const ORPHAN = join(MIRROR_BASE, 'ws-orphan')
const LOCAL_DIR = join(base, 'local-real')
const REMOTE_ROOT = '/mnt/disk/data/<user>/work'
mkdirSync(WS_SUB, { recursive: true })
mkdirSync(ORPHAN, { recursive: true })
mkdirSync(LOCAL_DIR, { recursive: true })
writeFileSync(join(WS_ROOT, '.remote-ssh.json'), JSON.stringify({
  profileId: 'p1', host: '<host>', port: 2222, user: '<user>', keyPath: '<key>', remotePath: REMOTE_ROOT
}))
writeFileSync(join(WS_SUB, 'existing.txt'), 'REMOTE-SIDE-MIRROR-COPY')
writeFileSync(join(LOCAL_DIR, 'plain.txt'), 'LOCAL-CONTENT')
const CANARY = join(ORPHAN, 'keepme.txt')
writeFileSync(CANARY, 'ORPHAN-LOCAL-CONTENT')

// ---------------------------------------------------------------------------
// A. 语法分类
// ---------------------------------------------------------------------------
console.log('A. classifyRequestPathSyntax（请求路径的语法形态）')
const syntaxOf = new Function('classifyRequestPathSyntax', grab(src, 'function classifyRequestPathSyntax') + '\nreturn classifyRequestPathSyntax;')(undefined)
check(syntaxOf('C:\\Users\\x\\a.md') === 'win-abs' && syntaxOf('C:/Users/x/a.md') === 'win-abs', 'A1 盘符绝对路径 → win-abs')
check(syntaxOf('C:foo/bar.md') === 'win-abs', 'A2 盘符相对（C:foo）也归 win-abs（随后按本机路径处理并如实报错）')
check(syntaxOf('\\\\host\\share\\a') === 'win-unc' && syntaxOf('//host/share/a') === 'win-unc', 'A3 UNC → win-unc')
check(syntaxOf('/mnt/disk/data/user/work/sub/a.md') === 'posix-abs', 'A4 以 / 开头 → posix-abs（可能是远端路径）')
check(syntaxOf('/tmp/x.log') === 'posix-abs', 'A5 工作区之外的远端路径同样是 posix-abs')
check(syntaxOf('sub/a.md') === 'relative' && syntaxOf('./sub/a.md') === 'relative', 'A6 相对路径 → relative')
check(syntaxOf('~/x.md') === 'tilde' && syntaxOf('~') === 'tilde', 'A7 ~ → tilde')
check(syntaxOf('') === 'empty' && syntaxOf(undefined) === 'empty' && syntaxOf(123) === 'empty', 'A8 空值/非字符串 → empty')
// 关键反例：Windows 上 `path.isAbsolute('/tmp/x')` 也是 true，两者必须分开
check(syntaxOf('/tmp/x.log') !== syntaxOf('C:/tmp/x.log'), 'A9 同样是"绝对路径"，posix 与盘符**必须分开**（混为一谈正是 #26 的成因）')

// ---------------------------------------------------------------------------
// B. 真实处理器行为
// ---------------------------------------------------------------------------
const writeJson = (res, status, obj) => { res.status = status; res.body = obj }
const writeOk = (res, value) => { res.status = 200; res.body = { ok: true, value: value } }
const readJsonBody = async (req) => req.__body
const requestTrust = () => 'ok'
const denyRequest = (res, why) => { res.status = 403; res.body = { ok: false, error: { code: 'denied', message: why } } }
const makeRes = () => ({ status: 0, body: undefined, writeHead(s) { this.status = s; return this }, end() { return this }, setHeader() { return this } })
// 安全读取响应内容：状态不对时应当表现为**断言失败**，而不是 TypeError 把整个文件崩掉
const contentOf = (r) => (r && r.body && r.body.value && r.body.value.content) || ''

function sandboxReal(opts) {
  const rec = { cmds: [], warns: [], remotePaths: [] }
  const workspaces = opts.workspaces || []
  const sandboxSrc = [
    NEW_HELPERS,
    PATH_HELPERS,
    grab(src, 'function readRemoteInfoSync'),
    grab(src, 'function matchRemoteWorkspace'),
    grab(src, 'function remoteWorkspaceForPath'),
    grab(src, 'function isUnderMirrorBase'),
    grab(src, 'function localToRemote'),
    grab(src, 'function readPathsField'),
    grab(src, 'function sidebarEntriesFrom'),
    grab(src, 'function toPosixRelative'),
    grab(src, 'function fsSearchResult'),
    grab(src, 'function sessionCwdFrom'),
    grab(src, 'async function localReadText'),
    grab(src, 'async function localWriteFile'),
    grab(src, 'async function localListDir'),
    grab(src, 'async function localRenameEntry'),
    grab(src, 'async function localRemoveEntry'),
    grab(src, 'async function localMakeDir'),
    grab(src, 'async function localCreateFile'),
    grab(src, 'async function interceptFsHandler'),
  ].join('\n')
  const built = new Function(
    'join', 'dirname', 'basename', 'stat', 'open', 'readFile', 'writeFile', 'rename', 'rm', 'mkdir',
    'opendir', 'lstat', 'existsSync', 'readFileSync', 'homedir', 'READ_LIMIT', 'LIST_LIMIT', 'process',
    'ctx', 'requestTrust', 'denyRequest', 'writeJson', 'writeOk', 'readJsonBody',
    'getProfile', 'shellQuotePath', 'runPooled', 'invalidateRemoteCaches',
    'settingsFace', 'mirrorBaseDir', 'remoteRefList',
    // 下游"已经算出远端路径之后"的事情（SSH 会话池 / 帧解析 / 缓存）不是本 issue 的被测对象，
    // 但**必须**把交给它们的远端路径记录下来 —— 这正是 #26 的判定点。本地那一半用真实实现。
    'remoteReadForSidebar', 'remoteListForSidebar', 'remoteWriteFile',
    sandboxSrc + '\nreturn { interceptFsHandler: interceptFsHandler, localToRemote: localToRemote, classifyRequestPathSyntax: classifyRequestPathSyntax };'
  )(
    join, dirname, basename, stat, open, readFile, writeFile, rename, rm, mkdir,
    opendir, lstat, existsSync, readFileSync, () => base, 524288, 1000, process,
    { get: () => null, logger: { debug() {}, warn(m) { rec.warns.push(String(m)) }, error() {} } },
    requestTrust, denyRequest, writeJson, writeOk, readJsonBody,
    () => ({ id: 'p1' }), (p) => "'" + String(p) + "'",
    async (profile, cmd) => {
      rec.cmds.push(cmd)
      if (/^test -e /.test(cmd)) {
        const taken = (opts.taken || []).some((n) => cmd.indexOf(n) > 0)
        return taken ? { ok: true, stdout: '' } : { ok: false, stdout: '', stderr: 'not found', exitCode: 1 }
      }
      return { ok: true, stdout: '', stderr: '' }
    },
    (p, path, o) => {},
    { read: () => ({ workspaces: workspaces }) },
    () => MIRROR_BASE,
    async () => [],
    async (profile, rp) => { rec.remotePaths.push(rp); return { kind: 'text', content: 'REMOTE:' + rp, truncated: false } },
    async (profile, rp) => { rec.remotePaths.push(rp); return [] },
    async (runner, profile, rp) => { rec.remotePaths.push(rp); return { ok: true, exitCode: 0 } }
  )
  return { ...built, rec }
}

const call = async (api, payload, method) => {
  const res = makeRes()
  await api({ method: 'POST', headers: {}, __body: payload }, res, method)
  return res
}
const WS = [{ mirrorPath: WS_ROOT, title: 'ws-alpha' }]

console.log('\nB. 真实处理器：请求路径决定走向')
{
  // 报告验收断言 1：「会话 cwd = 已注册镜像根 + payload.path = 镜像外绝对路径 ⇒ 必须不产生任何 SSH 命令」
  const { interceptFsHandler, rec } = sandboxReal({ workspaces: WS })
  const r = await call(interceptFsHandler, { sessionId: 's1', cwd: WS_ROOT, path: join(LOCAL_DIR, 'plain.txt') }, 'fs.read')
  check(rec.cmds.length === 0 && rec.remotePaths.length === 0,
    'B1 本机绝对路径在远程会话里**完全不产生 SSH 命令**（旧写法会发 stat <root>/Users/…）')
  check(r.status === 200 && r.body && r.body.value && contentOf(r) === 'LOCAL-CONTENT',
    'B2 读到的就是本机那一份（status=' + r.status + '）')
}
{
  // 报告验收断言 2：「会话 cwd = 已注册镜像根 + payload.path = 远端绝对路径 ⇒ 命令里该路径必须原样出现」
  const { interceptFsHandler, rec } = sandboxReal({ workspaces: WS })
  const remote = REMOTE_ROOT + '/sub/a.md'
  const r = await call(interceptFsHandler, { sessionId: 's1', cwd: WS_ROOT, path: remote }, 'fs.read')
  check(rec.remotePaths[0] === remote, 'B3 远端绝对路径**原样**交给远端（实际 ' + JSON.stringify(rec.remotePaths[0]) + '）')
  check(!String(rec.remotePaths[0] || '').includes(REMOTE_ROOT + REMOTE_ROOT), 'B4 没有被再拼一次远端根（<root><root>/…）')
  check(r.status === 200 && contentOf(r) === 'REMOTE:' + remote, 'B5 读的就是那条远端路径本身（status=' + r.status + '）')
  check((rec.cmds.join('\n') || '') === '', 'B6 这条路不需要额外裸命令（由 remoteRead 负责）')
}
{
  // 工作区**之外**的远端绝对路径同样原样下发
  const { interceptFsHandler, rec } = sandboxReal({ workspaces: WS })
  const r = await call(interceptFsHandler, { sessionId: 's1', cwd: WS_ROOT, path: '/tmp/x.log' }, 'fs.read')
  check(rec.remotePaths[0] === '/tmp/x.log', 'B7 /tmp/x.log 原样下发（不被塞进工作区根），实际 ' + JSON.stringify(rec.remotePaths[0]))
  check(contentOf(r) === 'REMOTE:/tmp/x.log', 'B7b 读的是 /tmp/x.log 本身')
}
{
  // 控制组：镜像成员路径仍按 2.4.29 的映射（剥镜像前缀 → 拼远端根）
  const { interceptFsHandler, rec } = sandboxReal({ workspaces: WS })
  const r = await call(interceptFsHandler, { sessionId: 's1', cwd: WS_ROOT, path: join(WS_SUB, 'existing.txt') }, 'fs.read')
  const want = REMOTE_ROOT + '/sub/deep/existing.txt'
  check(rec.remotePaths[0] === want, 'B8 镜像成员路径仍正确映射（未回退），实际 ' + JSON.stringify(rec.remotePaths[0]))
  check(!String(rec.remotePaths[0] || '').includes('ws-alpha'), 'B9 交给远端的路径里不出现本地镜像路径')
  check(contentOf(r) === 'REMOTE:' + want, 'B10 读的是映射后的远端路径')
}
{
  // 相对路径：远程会话按会话 cwd 的工作区根解析
  const { interceptFsHandler, rec } = sandboxReal({ workspaces: WS })
  await call(interceptFsHandler, { sessionId: 's1', cwd: WS_ROOT, path: 'sub/deep/rel.txt' }, 'fs.read')
  check(rec.remotePaths[0] === REMOTE_ROOT + '/sub/deep/rel.txt', 'B11 远程会话里的相对路径 → 远端根下（行为不变），实际 ' + JSON.stringify(rec.remotePaths[0]))
}
{
  // 相对路径：本地会话按本地 cwd 解析（不许被远程会话的规则污染）
  const { interceptFsHandler, rec } = sandboxReal({ workspaces: WS })
  const r = await call(interceptFsHandler, { sessionId: 's2', cwd: LOCAL_DIR, path: 'plain.txt' }, 'fs.read')
  check(rec.cmds.length === 0 && rec.remotePaths.length === 0 && r.status === 200 && contentOf(r) === 'LOCAL-CONTENT',
    'B12 本地会话读本地相对路径（仍走本地）')
}
{
  // 2.4.29 的守卫不回退：镜像根之下、未注册 → 400，绝不动手
  const { interceptFsHandler, rec } = sandboxReal({ workspaces: WS })
  const r = await call(interceptFsHandler, { sessionId: 's1', cwd: WS_ROOT, path: CANARY }, 'fs.remove')
  check(existsSync(CANARY) && readFileSync(CANARY, 'utf8') === 'ORPHAN-LOCAL-CONTENT', 'B13 孤儿镜像路径的文件**原封不动**（canary）')
  check(r.status === 400 && /bad-request/.test(JSON.stringify(r.body)) && /镜像目录下/.test(JSON.stringify(r.body)), 'B14 明确 400 + 文案点明镜像目录')
  check(rec.cmds.length === 0 && rec.remotePaths.length === 0, 'B15 没有发出任何 SSH 命令')
}
{
  // 混用本机路径与镜像路径 → 明确报错（猜一侧会让另一侧被静默忽略）
  const { interceptFsHandler, rec } = sandboxReal({ workspaces: WS })
  const localFile = join(LOCAL_DIR, 'plain.txt')
  const r = await call(interceptFsHandler, { sessionId: 's1', cwd: WS_ROOT, path: join(WS_SUB, 'existing.txt'), paths: [localFile, join(WS_SUB, 'existing.txt')] }, 'fs.remove')
  check(r.status === 400 && /混用/.test(JSON.stringify(r.body)), 'B16 本机路径 + 镜像路径混用 → 400')
  check(existsSync(localFile) && rec.cmds.length === 0, 'B17 本机文件没被删、也没发 SSH 命令')
}
{
  // 写：本机路径在远程会话里应当**写本机**（报告里这条以前是"远程建了文件、本机什么都没有"）
  const { interceptFsHandler, rec } = sandboxReal({ workspaces: WS })
  const target = join(LOCAL_DIR, 'written-local.txt')
  try { rmSync(target, { force: true }) } catch (e) {}
  const r = await call(interceptFsHandler, { sessionId: 's1', cwd: WS_ROOT, path: target, content: 'LOCAL-WRITE' }, 'fs.write')
  check(rec.cmds.length === 0 && rec.remotePaths.length === 0, 'B18 写本机路径不产生 SSH 命令')
  check(existsSync(target) && readFileSync(target, 'utf8') === 'LOCAL-WRITE', 'B19 内容真的落在**本机**那个路径上')
  const r2 = await call(interceptFsHandler, { sessionId: 's1', cwd: WS_ROOT, path: target }, 'fs.remove')
  check(rec.cmds.length === 0 && !existsSync(target), 'B20 删本机路径同样走本机（且删除成功）')
}
{
  // 盘符相对 C:foo：按本机路径处理（如实报错，不再推到远端）
  const { interceptFsHandler, rec } = sandboxReal({ workspaces: WS })
  const r = await call(interceptFsHandler, { sessionId: 's1', cwd: WS_ROOT, path: 'C:foo/bar.md' }, 'fs.read')
  check(rec.cmds.length === 0 && rec.remotePaths.length === 0, 'B21 C:foo 这类盘符相对路径按本机处理（不推到远端）')
  check(r.status === 400, 'B22 本机找不到就如实 400（status=' + r.status + '）')
}
{
  // ~ 写法：保持原有明确报错（不因新分支被误当本机路径）
  const { interceptFsHandler, rec } = sandboxReal({ workspaces: WS })
  const r = await call(interceptFsHandler, { sessionId: 's1', cwd: WS_ROOT, path: '~/x.md' }, 'fs.read')
  check(r.status === 400 && /~/.test(JSON.stringify(r.body)), 'B23 ~ 仍明确 400（不支持的写法）')
  check(rec.cmds.length === 0, 'B24 且不发 SSH 命令')
}
{
  // 本地会话 + 镜像路径 → 仍走远端（2.4.27/2.4.29 的既定行为：镜像不是事实来源，需在文档里写明）
  const { interceptFsHandler, rec } = sandboxReal({ workspaces: WS })
  await call(interceptFsHandler, { sessionId: 's2', cwd: LOCAL_DIR, path: join(WS_SUB, 'existing.txt') }, 'fs.read')
  check(rec.remotePaths[0] === REMOTE_ROOT + '/sub/deep/existing.txt',
    'B25 本地会话打开镜像成员路径 → 仍读远端（既定行为），实际 ' + JSON.stringify(rec.remotePaths[0]))
}
{
  // 本地会话 + 远端绝对路径 → 本地分支（本机按 `<当前盘>:\tmp\x.log` 解析）。
  // 断言只看**决定**（不发 SSH、响应不可能来自远端），不看本机上碰巧有没有这个文件 ——
  // 否则这条断言会随机器状态变化（实测：`C:\tmp\x.log` 可能是别的工具留下的）。
  const { interceptFsHandler, rec } = sandboxReal({ workspaces: WS })
  const r = await call(interceptFsHandler, { sessionId: 's2', cwd: LOCAL_DIR, path: '/tmp/x.log' }, 'fs.read')
  check(rec.cmds.length === 0 && rec.remotePaths.length === 0, 'B26 本地会话里的远端绝对路径不发 SSH（本机没有这种文件）')
  check(contentOf(r) !== 'REMOTE:/tmp/x.log', 'B27 响应不可能来自远端（status=' + r.status + '）')
}
{
  // 兜底必须变响：契约外的入参要留下 warn（debug 级别等于把同类误判藏起来）
  const { localToRemote, rec } = sandboxReal({ workspaces: WS })
  const out = localToRemote(join(LOCAL_DIR, 'plain.txt'), WS_ROOT, REMOTE_ROOT)
  check(rec.warns.some((w) => /localToRemote 收到镜像之外的路径/.test(w)), 'B28 兜底触发时留下 **warn**（不再静默 debug）')
  check(typeof out === 'string' && out.startsWith(REMOTE_ROOT), 'B29 兜底仍返回字符串（不改函数契约）')
}

// ---------------------------------------------------------------------------
// C. 接线 + 变异可打性
// ---------------------------------------------------------------------------
console.log('\nC. 接线')
check(typeof syntaxOf === 'function', 'C1 classifyRequestPathSyntax 在模块级')
check(/function looksLikeRemoteAbsolutePath/.test(src), 'C2 looksLikeRemoteAbsolutePath 在模块级')
const gate = src.slice(src.indexOf('async function interceptFsHandler'), src.indexOf('async function remoteRefListForAgent'))
check(/classifyRequestPathSyntax/.test(gate) && /ownerships/.test(gate), 'C3 fs 处理器里用上了请求路径分类')
check(/looksLikeRemoteAbsolutePath/.test(gate), 'C4 远端分支用 looksLikeRemoteAbsolutePath 判"已经是远端路径"')
check(/const sessionHit = sessionCwd !== "" \? remoteWorkspaceForPath\(sessionCwd\) : null;/.test(gate), 'C5 会话命中与请求路径归属是**两个**独立输入')
// 关键路径上不能再有"直接拿会话基准映射"的写法（那正是 #26 的入口）
check(!/localToRemote\(localPath, remoteBase/.test(gate), 'C6 处理器里不再有 localToRemote(…, remoteBase, …) 直调')
check((gate.match(/remotePathForRequest\(/g) || []).length >= 8, 'C7 8 个 fs 方法都走 remotePathForRequest（实际 ' + (gate.match(/remotePathForRequest\(/g) || []).length + ' 处）')
check(/mirror-orphan/.test(gate) && /混用/.test(gate), 'C8 孤儿镜像路径与混用两条守卫都在')
check(/\bwarn\(/.test(grab(src, 'function localToRemote')), 'C9 localToRemote 的兜底用的是 warn')
// C10–C12 不写死版本号：写死的话每次发版都要手改测试，忘改就是一条必红断言
//（2.4.31 发版时实际踩到，一次红了 3 个文件）。改成「package.json 的版本必须在 CHANGELOG 里有对应段落」。
const ver = pkg.version
check(/^2\.4\.\d+$/.test(ver), 'C10 package.json 版本形如 2.4.x = ' + ver)
check(changelog.includes('## [' + ver + ']'), 'C11 CHANGELOG 有 ' + ver + ' 段（发版即同步）')
check(/issue #26/.test(changelog.slice(changelog.indexOf('## [2.4.30]'), changelog.indexOf('## [2.4.30]') + 4000)), 'C12 CHANGELOG 2.4.30 段引用了 issue #26')

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败')
try { rmSync(base, { recursive: true, force: true }) } catch (e) {}
process.exit(fail ? 1 : 0)
