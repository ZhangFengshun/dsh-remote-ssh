// 2.4.29：远程工作区判定按**前缀**匹配（不再只认"正好放着 .remote-ssh.json 的那一级目录"）
//
// 背景（真机实测发现）：`readRemoteInfoSync(p)` = `readFileSync(join(p, ".remote-ssh.json"))`，**不向上遍历**，
// 所以只有把**工作区根**传进去才命中。真实客户端总带有效 sessionId（会话 cwd = 镜像根）所以一直没暴露，
// 但两种情况会漏判，而漏判的后果是写/删**静默落在本地镜像上**（与 issue #25 同源）：
//   ① 会话是在工作区的**子目录**里启动的（会话 cwd 是子目录，不是镜像根）；
//   ② 客户端带了过期/未知 sessionId，判定回退到 `payload.path`，而它可能是根之下的任意层级。
// 另一个连带问题：判定命中时若把**更深的那条路径**当 remoteBase，`localToRemote()` 会按子目录相对映射，
// 文件会落到远端**错误的位置** —— 所以判定必须同时给出工作区根。
//
// 三层：A 纯函数；B 真实处理器行为（含"远端命令里的远端路径必须完整正确"这种决定性断言）；
// C 接线 + 变异可打性（旧写法必须已经不在关键路径上）。
import { readFileSync, existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { stat, open, readFile, writeFile, rename, rm, mkdir, opendir, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const src = readFileSync(root + '/lib/index.js', 'utf8')
const pkg = JSON.parse(readFileSync(root + '/package.json', 'utf8'))
const changelog = readFileSync(root + '/CHANGELOG.md', 'utf8')

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
  // 2.4.30（issue #26）：fs 处理器改为按请求路径**语法 + 归属**分派，沙箱必须带上这两个纯函数，
  // 否则沙箱里跑真实处理器会 "classifyRequestPathSyntax is not defined"（那是沙箱缺件，不是被测行为）。
  grab(src, 'function classifyRequestPathSyntax'),
  grab(src, 'function looksLikeRemoteAbsolutePath'),
  grab(src, 'function resolveSessionPath'),
  grab(src, 'function unresolvedPathMessage')
].join('\n')

// 0.25.0 新端点的纯函数是**连续一段**且无外部依赖（fs.createFile 的远程分支要用 creatableFileNameProblem 等）
const NEW_HELPERS = (() => {
  const a = src.indexOf('// ---- better-sidebar 0.25.0 新端点的纯函数')
  const b = src.indexOf('/**\n * 解析 better-sidebar 0.24 的 `open.external` URL')
  if (a < 0 || b < 0 || b <= a) throw new Error('0.25.0 helper block not found')
  return src.slice(a, b)
})()

// ---------------------------------------------------------------------------
// 夹具：造一个"镜像根 / 工作区根 / 子目录 / 文件"的真实目录结构
// ---------------------------------------------------------------------------
const base = mkdtempSync(join(tmpdir(), 'dsh-2429-'))
const MIRROR_BASE = join(base, 'remote-workspaces')
const WS_ROOT = join(MIRROR_BASE, 'ws-alpha')
const WS_SUB = join(WS_ROOT, 'sub', 'deep')
const ORPHAN = join(MIRROR_BASE, 'ws-orphan')            // 在镜像根之下，但**没有**注册
const LOCAL_DIR = join(base, 'local-real')                // 真正的本地目录（镜像根之外）
mkdirSync(WS_SUB, { recursive: true })
mkdirSync(join(WS_SUB, 'nested'), { recursive: true })
mkdirSync(ORPHAN, { recursive: true })
mkdirSync(LOCAL_DIR, { recursive: true })
writeFileSync(join(WS_ROOT, '.remote-ssh.json'), JSON.stringify({
  profileId: 'p1', host: '<host>', port: 2222, user: '<user>', keyPath: '<key>', remotePath: '/remote/root'
}))
writeFileSync(join(WS_ROOT, 'sub', 'deep', 'existing.txt'), 'REMOTE-SIDE-MIRROR-COPY')
writeFileSync(join(ORPHAN, 'keepme.txt'), 'ORPHAN-LOCAL-CONTENT')
writeFileSync(join(LOCAL_DIR, 'plain.txt'), 'LOCAL-CONTENT')
const CANARY = join(ORPHAN, 'keepme.txt')

// ---------------------------------------------------------------------------
// A. 纯函数
// ---------------------------------------------------------------------------
console.log('A. isUnderMirrorBase（镜像根之下的判定）')
const helpers = new Function(['process', 'join', 'homedir', 'mirrorBaseDir', 'isUnderMirrorBase'].join(','),
  grab(src, 'function isUnderMirrorBase') + '\nreturn isUnderMirrorBase;')(
  process, join, () => base, () => MIRROR_BASE, undefined)
check(helpers(MIRROR_BASE) === true, 'A1 镜像根本身 → true')
check(helpers(WS_ROOT) === true, 'A2 工作区根 → true')
check(helpers(join(WS_SUB, 'x.txt')) === true, 'A3 深层文件 → true')
check(helpers(MIRROR_BASE + '\\x') === true, 'A4 反斜杠分隔同样识别')
check(helpers(MIRROR_BASE + '/') === true, 'A5 末尾斜杠不影响')
check(helpers(join(base, 'local-real', 'plain.txt')) === false, 'A6 镜像根之外的本地路径 → false')
check(helpers(base + '-sibling/x') === false, 'A7a 临时目录的兄弟路径 → false')
check(helpers(MIRROR_BASE + '-sibling/x') === false, 'A7 前缀相似但不同层（镜像根名多一段）→ false（去掉目录边界检查这条就会红）')
check(helpers('') === false && helpers(undefined) === false, 'A8 空值 → false')
if (process.platform === 'win32') check(helpers(MIRROR_BASE.toUpperCase()) === true, 'A9 Windows 下大小写无关（→ true）')
else check(helpers(MIRROR_BASE.toUpperCase()) === false, 'A9 POSIX 下大小写有关（→ false，不会误判）')

// ---------------------------------------------------------------------------
// B. 真实处理器行为
// ---------------------------------------------------------------------------
const writeJson = (res, status, obj) => { res.status = status; res.body = obj }
const writeOk = (res, value) => { res.status = 200; res.body = { ok: true, value: value } }
const readJsonBody = async (req) => req.__body
const requestTrust = () => 'ok'
const denyRequest = (res, why) => { res.status = 403; res.body = { ok: false, error: { code: 'denied', message: why } } }
const makeRes = () => ({ status: 0, body: undefined, writeHead(s) { this.status = s; return this }, end() { return this }, setHeader() { return this } })

/** 真实 readRemoteInfoSync（读目录里的 .remote-ssh.json）+ 真实 matchRemoteWorkspace（读 settingsFace）
 *  + 真实 remoteWorkspaceForPath / isUnderMirrorBase，并记录发出的远端命令。
 *  注意：判定相关的三个函数**用真实源码**（不 stub），否则就是在拿"被 mock 掉的逻辑"自证 —— 那正是
 *  这次要防的失效模式。 */
function sandboxReal(opts) {
  const rec = { cmds: [], invalidations: [], refCalls: [] }
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
    grab(src, 'async function remoteRefListForAgent')
  ].join('\n')
  const built = new Function(
    'join', 'dirname', 'basename', 'stat', 'open', 'readFile', 'writeFile', 'rename', 'rm', 'mkdir',
    'opendir', 'lstat', 'existsSync', 'readFileSync', 'homedir', 'READ_LIMIT', 'LIST_LIMIT', 'process',
    'ctx', 'requestTrust', 'denyRequest', 'writeJson', 'writeOk', 'readJsonBody',
    'getProfile', 'shellQuotePath', 'runPooled', 'invalidateRemoteCaches',
    'settingsFace', 'mirrorBaseDir', 'remoteRefList',
    sandboxSrc + '\nreturn { interceptFsHandler: interceptFsHandler, remoteRefListForAgent: remoteRefListForAgent };'
  )(
    join, dirname, basename, stat, open, readFile, writeFile, rename, rm, mkdir,
    opendir, lstat, existsSync, readFileSync, () => base, 524288, 1000, process,
    { get: () => null, logger: { debug() {}, warn() {}, error() {} } }, requestTrust, denyRequest, writeJson, writeOk, readJsonBody,
    () => ({ id: 'p1' }), (p) => "'" + String(p) + "'",
    async (profile, cmd) => {
      rec.cmds.push(cmd)
      // 必须**按命令判别**：createFile 会先跑 `test -e` 探测（ok:true = 已存在 → 409）。
      // 一个"永远成功"的桩会把探测结果搞反，测出来的 409 是桩的产物而不是被测行为。
      if (/^test -e /.test(cmd)) {
        const taken = (opts.taken || []).some((n) => cmd.indexOf(n) > 0)
        return taken ? { ok: true, stdout: '' } : { ok: false, stdout: '', stderr: 'not found', exitCode: 1 }
      }
      return { ok: true, stdout: '', stderr: '' }
    },
    (p, path, o) => { rec.invalidations.push([path, o]) },
    { read: () => ({ workspaces: workspaces }) },
    () => MIRROR_BASE,
    async (profile, dir, query) => { rec.refCalls.push([profile, dir, query]); return [{ path: dir + '/cand.txt', kind: 'file' }] }
  )
  return { ...built, rec }
}

const fsCall = async (api, payload, method) => {
  const res = makeRes()
  await api({ method: 'POST', headers: {}, __body: payload }, res, method)
  return res
}

console.log('\nB1. 子目录 / 深层路径 + 过期 sessionId（判定回退到 payload.path）')
{
  const { interceptFsHandler, rec } = sandboxReal({ workspaces: [{ mirrorPath: WS_ROOT, title: 'ws-alpha' }] })
  // ① 删除工作区根**之下**的文件：旧代码在这里会落到本地分支（真机实测就是 400 ENOENT lstat 镜像路径）
  const deepFile = join(WS_SUB, 'existing.txt')
  const r1 = await fsCall(interceptFsHandler, { sessionId: 'expired-session', path: deepFile }, 'fs.remove')
  check(r1.status === 200, 'B1 深层文件的 fs.remove → 200（旧代码：本地分支 400 ENOENT）')
  check(rec.cmds.some((c) => c === "rm -rf -- '/remote/root/sub/deep/existing.txt'"),
    'B2 远端命令用的是**完整正确的远端路径**（remoteBase 必须是工作区根，不能是深层目录）：' + JSON.stringify(rec.cmds))
  check(!existsSync(deepFile) || readFileSync(deepFile, 'utf8') === 'REMOTE-SIDE-MIRROR-COPY',
    'B3 镜像副本的清理是本地的、且不影响判定（本次远端分支只发 SSH 命令）')

  // ② 在工作区子目录里新建文件
  const r2 = await fsCall(interceptFsHandler, { sessionId: 'expired-session', path: WS_SUB, name: 'created.txt' }, 'fs.createFile')
  check(r2.status === 200 && r2.body.value.path === join(WS_SUB, 'created.txt'), 'B4 深层目录里 createFile → 200 且回显镜像路径')
  check(rec.cmds.some((c) => c.indexOf("/remote/root/sub/deep/created.txt") > 0),
    'B5 创建命令里的远端路径同样是完整的（/remote/root/sub/deep/created.txt）')
}

console.log('\nB2. 会话 cwd 是工作区**子目录**（相对路径场景）')
{
  const { interceptFsHandler, rec } = sandboxReal({ workspaces: [{ mirrorPath: WS_ROOT, title: 'ws-alpha' }] })
  // 客户端形状：path 是**目录**、name 是文件名；这里 path 用相对路径，基准是会话 cwd（子目录）。
  const r = await fsCall(interceptFsHandler, { sessionId: 's1', cwd: WS_SUB, path: 'nested', name: 'rel-new.txt' }, 'fs.createFile')
  const detail = '（HTTP ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 160) + '）'
  check(r.status === 200, 'B6 子目录会话 + 相对目录路径 → 200' + detail)
  check(rec.cmds.some((c) => c.indexOf("/remote/root/sub/deep/nested/rel-new.txt") > 0),
    'B7 相对路径按会话 cwd 解析后，再按**工作区根**映射到远端（旧代码会映射成 /remote/root/nested/rel-new.txt）：' + JSON.stringify(rec.cmds))
  check(!rec.cmds.some((c) => c.indexOf("/remote/root/nested/rel-new.txt'") > 0), 'B8 没有出现"少了子目录那一段"的错误远端路径')
}

console.log('\nB3. 镜像根之下但**未注册**的工作区：明确报错，且绝不在镜像上动手')
{
  const { interceptFsHandler, rec } = sandboxReal({ workspaces: [{ mirrorPath: WS_ROOT, title: 'ws-alpha' }] })
  const before = readFileSync(CANARY, 'utf8')
  const r = await fsCall(interceptFsHandler, { sessionId: 'expired-session', path: CANARY }, 'fs.remove')
  // 先断"没动本地镜像"：这是安全属性，且不依赖响应形状（守卫被去掉时它会立刻红，
  // 而不是因为后面读 r.body.error.error 抛异常把余下断言一起吞掉）。
  check(existsSync(CANARY) && readFileSync(CANARY, 'utf8') === before, 'B11 canary 文件**原封不动**（没有在本地镜像上执行删除）')
  check(rec.cmds.length === 0, 'B12 也没有发任何 SSH 命令（既不动远端也不动本地）')
  const errBody = (r.body && r.body.error) || {}
  check(r.status === 400 && errBody.code === 'bad-request',
    'B9 未注册的镜像路径 fs.remove → 400 bad-request（明确报错）：HTTP ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 120))
  check(/镜像目录下/.test(String(errBody.message)) && /已注册的远程工作区/.test(String(errBody.message)),
    'B10 报错文案说清"在镜像目录下 / 不属于已注册工作区"')
  const r2 = await fsCall(interceptFsHandler, { sessionId: 'expired-session', path: CANARY }, 'fs.read')
  check(r2.status === 400, 'B13 读操作同样报错（不静默列出镜像内容）')
}

console.log('\nB4. 镜像根之外的真正本地路径：行为不变')
{
  const { interceptFsHandler, rec } = sandboxReal({ workspaces: [{ mirrorPath: WS_ROOT, title: 'ws-alpha' }] })
  const target = join(LOCAL_DIR, 'plain.txt')
  const r = await fsCall(interceptFsHandler, { sessionId: 's1', path: target }, 'fs.read')
  check(r.status === 200 && r.body.value.content === 'LOCAL-CONTENT', 'B14 本地文件照常读（走本地分支）')
  const r2 = await fsCall(interceptFsHandler, { sessionId: 's1', path: join(LOCAL_DIR, 'made.txt'), content: 'x' }, 'fs.write')
  check(r2.status === 200 && existsSync(join(LOCAL_DIR, 'made.txt')), 'B15 本地写照常落盘')
  check(rec.cmds.length === 0, 'B16 本地操作不发 SSH 命令')
}

console.log('\nB5. @ 引用补全（会话 cwd 是子目录时也要走远端）')
{
  const { remoteRefListForAgent, rec } = sandboxReal({ workspaces: [{ mirrorPath: WS_ROOT, title: 'ws-alpha' }] })
  const agent = { session: { header: { cwd: WS_SUB } } }
  const out = await remoteRefListForAgent(agent, 'can', null)
  check(Array.isArray(out) && out.length === 1, 'B17 子目录会话的 @ 引用返回远端候选（旧代码返回 null → 退回本地实现）')
  check(rec.refCalls.length === 1 && rec.refCalls[0][1] === '/remote/root/sub/deep',
    'B18 列出的是**对应的远端子目录**（不是远端根）：' + JSON.stringify(rec.refCalls))
  const local = await remoteRefListForAgent({ session: { header: { cwd: LOCAL_DIR } } }, 'can', null)
  check(local === null, 'B19 本地会话仍返回 null（交给原实现）')
}

// ---------------------------------------------------------------------------
// C. 接线
// ---------------------------------------------------------------------------
console.log('\nC. 接线与快照')
check(/function remoteWorkspaceForPath\(/.test(src), 'C1 remoteWorkspaceForPath 存在')
check(/const sessionHit = sessionCwd !== "" \? remoteWorkspaceForPath\(sessionCwd\) : null;/.test(src), 'C2 fs 判定对会话 cwd 走前缀匹配（2.4.30 起只是两个输入之一）')
check(/const hit = remoteWorkspaceForPath\(raw\);/.test(src), 'C3 fs 判定对**每条**请求路径走前缀匹配')
check(/remoteBase = hit\.root;/.test(src) && /remoteBase = sessionHit\.root;/.test(src), 'C4 remoteBase 取**工作区根**（不是更深的那条路径）')
check(/isUnderMirrorBase\(raw\)/.test(src) && /ownerships\.indexOf\("mirror-orphan"\)/.test(src), 'C5 未注册镜像路径有明确报错分支（按每条路径判定）')
check(/const matched = remoteWorkspaceForPath\(cwd\)/.test(src), 'C6 @ 引用补全同样用前缀匹配')
check(/join\(mirrorBaseDir\(\), wsId\)/.test(src), 'C7 镜像目录构造与判定共用 mirrorBaseDir()')
check(/function mirrorBaseDir\(\) \{\s*return join\(homedir\(\), "\.dsh", "remote-workspaces"\)/.test(src), 'C8 mirrorBaseDir 就是 ~/.dsh/remote-workspaces')
// 关键路径上不能再有"只精确匹配"的判定：窗口精确到 fs 处理器本体（到它后面第一个 async function 为止），
// 这样既不会漏（旧写法用的是固定 4200 字符窗口），也不会把后面其它端点的注释算进来。
const gateStart = src.indexOf('async function interceptFsHandler')
const gateEnd = src.indexOf('\n  async function ', gateStart + 10)
const gateRegion = src.slice(gateStart, gateEnd > gateStart ? gateEnd : gateStart + 6000)
const exactCalls = [...gateRegion.matchAll(/readRemoteInfoSync\((?!ws\.mirrorPath)/g)].length
check(exactCalls === 2, 'C9 整个 fs 处理器里精确匹配只剩 2 处（都用于「目录自带 .remote-ssh.json」的兜底），不再拿会话 cwd / 深层路径去精确匹配：' + exactCalls)
check(new RegExp('## \\[' + pkg.version.replace(/\./g, '\\.') + '\\]').test(changelog), 'C10 CHANGELOG 有当前版本条目（' + pkg.version + '）')

try { rmSync(base, { recursive: true, force: true }) } catch (e) {}
console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败')
process.exit(fail ? 1 : 0)
