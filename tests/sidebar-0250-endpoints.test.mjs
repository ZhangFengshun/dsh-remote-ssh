// better-sidebar 0.25.0 新端点的接管 —— fs.createFile + git.blame / diff-head / worktrees / pull / push
//
// 背景：0.25.0 新增了 9 个端点，其中 6 个与「仓库 / 路径」相关。本插件用 kind:"exact" 接管
// `/sidebar/api/fs.*` 与 `/sidebar/api/git.*`，所以**没被注册的端点会回落到上游实现**，
// 而远程工作区里上游的 cwd 是本地镜像目录（镜像没有 .git、也不是文件系统的事实来源）：
//   · fs.createFile     → 空文件只建在本地镜像里，远端永远没有（与 0.24 的 fs.trees 同一类）
//   · git.blame / diff-head / worktrees → 按镜像里的 git 状态返回（通常是空/报错）
//   · git.pull / push   → 在镜像上跑 git，动的是一个与远端无关的仓库
// 维护笔记里的硬规则（MAINTENANCE「升级 better-sidebar 后必做对拍」）就是这条：升级后必须
// 把上游宿主 handler 键集合与本插件注册集合逐项比对。本文件的 C 段把这条规则**自动化**。
//
// 三层：
//   A. 纯函数真值表：creatableFileNameProblem / isoWithOffset / parseBlamePorcelain /
//      parseWorktreeList / countStatusEntries / 路径同一性 —— 规则逐条对齐上游。
//   B. **真实处理器的行为**（源码切片 + 假 ctx/req/res + 假远端）：
//      本地 fs.createFile 落盘与 409、远程 fs.createFile 走 SSH（命令形状）、
//      git.blame / diff-head / worktrees / pull / push 的实参与返回形状（pull 还要失效缓存）。
//   C. 接线与上游覆盖率：注册数组包含 6 个端点；若本机装了 better-sidebar，
//      直接与它的宿主 handler 键集合对拍（没装则 SKIP，不算失败）。
import { readFileSync, existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs'
import { stat, open, readFile, writeFile, rename, rm, mkdir, opendir, lstat } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const src = readFileSync(root + '/lib/index.js', 'utf8')
const changelog = readFileSync(root + '/CHANGELOG.md', 'utf8')
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

// 0.25.0 新端点的纯函数是**连续一段**，整段切出来即可（它是模块作用域、无外部依赖）。
const HELPER_BLOCK_START = '// ---- better-sidebar 0.25.0 新端点的纯函数'
const HELPER_BLOCK_END = '/**\n * 解析 better-sidebar 0.24 的 `open.external` URL'
const NEW_HELPERS = (() => {
  const a = src.indexOf(HELPER_BLOCK_START)
  const b = src.indexOf(HELPER_BLOCK_END)
  if (a < 0 || b < 0 || b <= a) throw new Error('0.25.0 helper block not found')
  return src.slice(a, b)
})()

// issue #25 (2.4.27) 引入的路径归一helper，处理器沙箱还要用
const PATH_HELPERS = [
  grab(src, 'function isAbsoluteLocalPath'),
  grab(src, 'function resolveSessionPath'),
  grab(src, 'function unresolvedPathMessage')
].join('\n')

const helpersModule = new Function(NEW_HELPERS + '\nreturn { creatableFileNameProblem, isoWithOffset, parseBlamePorcelain, parseWorktreeList, countStatusEntries, posixPathIdentity, localPathIdentity, firstIllegalNameChar, RESERVED_FILE_NAMES };')()
const {
  creatableFileNameProblem, isoWithOffset, parseBlamePorcelain, parseWorktreeList,
  countStatusEntries, posixPathIdentity, localPathIdentity, firstIllegalNameChar, RESERVED_FILE_NAMES
} = helpersModule

// ---------------------------------------------------------------------------
// A. 纯函数
// ---------------------------------------------------------------------------
console.log('\nA. 纯函数（规则对齐上游）')
check(creatableFileNameProblem('readme.md') === '', 'A1 普通文件名可用')
check(creatableFileNameProblem('📁数据.txt') === '', 'A2 emoji/中文名可用（按码点迭代，不误判成非法半字符）')
check(creatableFileNameProblem('') === 'name must be a single path segment', 'A3 空名 → 单段名错误')
check(creatableFileNameProblem('.') === 'name must be a single path segment', 'A4 "." 拒绝')
check(creatableFileNameProblem('..') === 'name must be a single path segment', 'A5 ".." 拒绝')
check(creatableFileNameProblem('a/b') === 'name must be a single path segment', 'A6 含 "/" 拒绝')
check(String.raw`a\b`.length === 3 && creatableFileNameProblem(String.raw`a\b`) === 'name must be a single path segment', 'A7 含 "\\" 拒绝')
for (const bad of ['a<b', 'a>b', 'a:b', 'a"b', 'a|b', 'a?b', 'a*b']) {
  check(creatableFileNameProblem(bad).indexOf('not allowed in a file name') > 0, 'A8 非法字符拒绝: ' + bad)
}
check(creatableFileNameProblem('a\u0001b').indexOf('not allowed in a file name') > 0, 'A9 控制字符拒绝（码点 < 32）')
for (const res of ['NUL', 'nul.txt', 'COM1', 'lpt9.tar.gz', 'con']) {
  check(creatableFileNameProblem(res).indexOf('reserved device name') > 0, 'A10 Windows 保留名拒绝: ' + res)
}
check(creatableFileNameProblem('nulx').indexOf('reserved device name') < 0, 'A11 前缀相同的普通名（nulx）不被误拒')
check(firstIllegalNameChar('ok') === undefined && firstIllegalNameChar('a<b') === '<', 'A12 firstIllegalNameChar 返回首个非法字符')
check(RESERVED_FILE_NAMES.size === 22, 'A13 保留名共 22 个（con/prn/aux/nul + com1-9 + lpt1-9）')

check(isoWithOffset(1700000000, '+0800') === '2023-11-15T06:13:20+08:00', 'A14 isoWithOffset 带偏移 → 该偏移下的**本地时刻** + 偏移后缀')
check(isoWithOffset(1700000000, '') === '2023-11-14T22:13:20Z', 'A15 无时区 → UTC 时刻 + Z 结尾')
check(isoWithOffset(1700000000, 'garbage') === '2023-11-14T22:13:20Z', 'A16 时区格式不合法 → 退化成 Z（与上游同）')

const H1 = '1'.repeat(40)
const H2 = '2'.repeat(40)
const BLAME = [
  H1 + ' 3 3 1',
  'author Alice',
  'author-time 1700000000',
  'author-tz +0800',
  'summary fix: first',
  '\tline three',
  H2 + ' 4 4 1',
  'author Bob',
  'author-time 1700003600',
  'author-tz +0000',
  'summary feat: second',
  '\tline four',
  H1 + ' 5 5 1',
  '\tline five'
].join('\n')
const blameRows = parseBlamePorcelain(BLAME)
check(blameRows.length === 3, 'A17 blame 解析出 3 行')
check(blameRows[0].hash === H1 && blameRows[0].line === 3 && blameRows[0].author === 'Alice' &&
  blameRows[0].date === '2023-11-15T06:13:20+08:00' && blameRows[0].summary === 'fix: first', 'A18 首块取到 author/date/summary 与行号')
check(blameRows[1].author === 'Bob' && blameRows[1].line === 4, 'A19 第二个 commit 独立解析')
check(blameRows[2].hash === H1 && blameRows[2].line === 5 && blameRows[2].author === 'Alice' && blameRows[2].date === '2023-11-15T06:13:20+08:00',
  'A20 同 commit 重复出现 → 复用首块信息（porcelain 只在首块给 author）')
check(parseBlamePorcelain('').length === 0 && parseBlamePorcelain('not a blame').length === 0, 'A21 空/非 blame 输出 → []')

const WT = [
  'worktree /remote/root',
  'HEAD abc123',
  'branch refs/heads/main',
  '',
  'worktree /remote/wt2',
  'HEAD def456',
  'branch refs/heads/feature',
  'locked',
  '',
  'worktree /remote/gone',
  'HEAD 000',
  'prunable gitdir file points to non-existent location',
  ''
].join('\n')
/** worktree 列表夹具：把主 worktree 的路径换成给定根（本地用会话目录，远端用远端根）。 */
const wtFixture = (rootPath) => WT.split('/remote/root').join(String(rootPath))
const wtRows = parseWorktreeList(wtFixture('/remote/root'))
check(wtRows.length === 3, 'A22 worktree 解析出 3 条')
check(wtRows[0].path === '/remote/root' && wtRows[0].branch === 'main' && wtRows[0].locked === false && wtRows[0].prunable === false, 'A23 第一条 path/branch 正确')
check(wtRows[1].branch === 'feature' && wtRows[1].locked === true, 'A24 locked 被识别')
check(wtRows[2].prunable === true, 'A25 prunable 被识别')
check(parseWorktreeList('worktree /a\nHEAD x\nbranch refs/heads/b').length === 1, 'A26 末尾没有空行也能收尾（上游 framed 语义）')
check(parseWorktreeList('worktree /a\0HEAD x\0branch refs/heads/b\0\0').length === 1, 'A27 NUL 分隔（-z）同样能解析')
check(parseWorktreeList('').length === 0, 'A28 空输出 → []')

check(countStatusEntries('') === 0, 'A29 空 status → 0 条')
check(countStatusEntries(' M a.txt\0?? b.txt\0') === 2, 'A30 普通修改 + 未跟踪 → 2 条')
check(countStatusEntries('R  new.txt\0old.txt\0') === 1, 'A31 改名占两条 NUL 记录，只算 1 条（口径同上游 entries.length）')
check(countStatusEntries('R  n1\0o1\0R  n2\0o2\0') === 2, 'A32 连续两个改名 → 2 条')
check(countStatusEntries('?? sub/\0 M x\0A  y\0') === 3, 'A33 混合状态 → 3 条')

check(posixPathIdentity('/a/b/') === '/a/b' && posixPathIdentity('/A/B') === '/A/B', 'A34 远端同一性：去尾斜杠、区分大小写')
const lp = localPathIdentity('C:\\Dir\\Sub\\')
check(lp === (process.platform === 'win32' ? 'c:\\dir\\sub' : 'C:\\Dir\\Sub'), 'A35 本机同一性：Windows 下大小写无关')

// ---------------------------------------------------------------------------
// B. 真实处理器行为
// ---------------------------------------------------------------------------
const writeJson = (res, status, obj) => { res.status = status; res.body = obj }
const writeOk = (res, value) => { res.status = 200; res.body = { ok: true, value: value } }
const readJsonBody = async (req) => req.__body
const requestTrust = () => 'ok'
const denyRequest = (res, why) => { res.status = 403; res.body = { ok: false, error: { code: 'denied', message: why } } }
function makeRes() {
  const res = { status: 0, body: undefined, raw: undefined, writeHead(s) { res.status = s; return res }, end(b) { if (b !== undefined && res.raw === undefined) res.raw = b; return res }, setHeader() { return res } }
  return res
}
function makeCtx(sessionDir) {
  const sessions = { get: (id) => (id === 'sess-1' ? { header: { cwd: sessionDir } } : null) }
  return { get: (n) => (n === 'sessions' ? sessions : null), logger: { debug() {}, warn() {}, error() {} } }
}

const originalCwd = process.cwd()
const hostDir = mkdtempSync(join(tmpdir(), 'dsh-0250-host-'))
const sessionDir = mkdtempSync(join(tmpdir(), 'dsh-0250-sess-'))
mkdirSync(join(sessionDir, 'tools'), { recursive: true })
writeFileSync(join(sessionDir, 'tools', 'x.py'), 'SESSION-CONTENT')
writeFileSync(join(hostDir, 'tools-canary.txt'), 'HOST-CANARY')
const REMOTE_ROOT = '/remote/root'
const HOST = '<host>'
const USER = '<user>'
const KEY = '<key>'

/** 远程工作区沙箱：readRemoteInfoSync 认得 sessionDir，runPooled 记录远端命令。 */
function fsSandbox(opts) {
  const rec = { cmds: [], invalidations: [] }
  const remote = !!opts.remote
  const fn = new Function(
    'join', 'dirname', 'basename', 'stat', 'open', 'readFile', 'writeFile', 'rename', 'rm', 'mkdir',
    'opendir', 'lstat', 'existsSync', 'homedir', 'READ_LIMIT', 'LIST_LIMIT',
    'ctx', 'requestTrust', 'denyRequest', 'writeJson', 'writeOk', 'readJsonBody',
    'readRemoteInfoSync', 'localSearchFiles', 'getProfile', 'localToRemote', 'shellQuotePath',
    'runPooled', 'invalidateRemoteCaches',
    PATH_HELPERS + '\n' + NEW_HELPERS + '\n' +
    grab(src, 'function readPathsField') + '\n' +
    grab(src, 'function sidebarEntriesFrom') + '\n' +
    grab(src, 'function toPosixRelative') + '\n' +
    grab(src, 'function fsSearchResult') + '\n' +
    grab(src, 'function sessionCwdFrom') + '\n' +
    grab(src, 'async function localReadText') + '\n' +
    grab(src, 'async function localWriteFile') + '\n' +
    grab(src, 'async function localListDir') + '\n' +
    grab(src, 'async function localRenameEntry') + '\n' +
    grab(src, 'async function localRemoveEntry') + '\n' +
    grab(src, 'async function localMakeDir') + '\n' +
    grab(src, 'async function localCreateFile') + '\n' +
    grab(src, 'async function interceptFsHandler') + '\n' +
    'return interceptFsHandler;'
  )(
    join, dirname, basename, stat, open, readFile, writeFile, rename, rm, mkdir,
    opendir, lstat, existsSync, homedir, 524288, 1000,
    makeCtx(sessionDir), requestTrust, denyRequest, writeJson, writeOk, readJsonBody,
    remote
      ? (p) => (typeof p === 'string' && p.indexOf(sessionDir) === 0
        ? { profileId: 'p1', host: HOST, user: USER, keyPath: KEY, remotePath: REMOTE_ROOT, mirrorPath: sessionDir } : null)
      : () => null,
    async () => ({ entries: [], truncated: false }),
    () => ({ id: 'p1', host: HOST, user: USER, keyPath: KEY }),
    (local, mirror, remoteRoot) => String(remoteRoot) + String(local).replace(/\\/g, '/').slice(String(mirror).replace(/\\/g, '/').length),
    (p) => "'" + String(p).replace(/'/g, "'\\''") + "'",
    async (profile, cmd) => {
      rec.cmds.push(cmd)
      // 只把 taken.txt 当作"远端已存在"，其余不存在 —— 用于验证 409 分支。
      if (/^test -e /.test(cmd)) return { ok: /taken\.txt/.test(cmd), stdout: '', stderr: '' }
      if (/set -C/.test(cmd)) return { ok: true, stdout: '', stderr: '' }
      return { ok: true, stdout: '', stderr: '' }
    },
    (p, path, o) => { rec.invalidations.push([path, o]) }
  )
  return { handler: fn, rec }
}

const fsCall = async (api, payload, method) => {
  const res = makeRes()
  await api({ method: 'POST', headers: {}, __body: payload }, res, method)
  return res
}

console.log('\nB1. fs.createFile（本地分支：真落盘、真 409）')
try {
  process.chdir(hostDir)
  const { handler } = fsSandbox({ remote: false })
  let r = await fsCall(handler, { sessionId: 'sess-1', path: 'tools', name: 'new.txt' }, 'fs.createFile')
  check(r.status === 200 && r.body.ok === true && r.body.value.path === join(sessionDir, 'tools', 'new.txt'),
    'B1 createFile 相对 path → 建在**会话 cwd** 下并返回绝对路径（旧代码会建到插件宿主目录）')
  check(existsSync(join(sessionDir, 'tools', 'new.txt')) && readFileSync(join(sessionDir, 'tools', 'new.txt'), 'utf8') === '',
    'B2 文件真的存在于会话目录，且是空文件')
  check(!existsSync(join(hostDir, 'tools', 'new.txt')), 'B3 宿主目录里没有多出这个文件')

  r = await fsCall(handler, { sessionId: 'sess-1', path: 'tools', name: 'new.txt' }, 'fs.createFile')
  check(r.status === 409 && /"new.txt" already exists/.test(r.body.error.message), 'B4 同名已存在 → 409（上游契约，不是 400）')

  r = await fsCall(handler, { sessionId: 'sess-1', path: 'tools', name: 'a/b' }, 'fs.createFile')
  check(r.status === 400 && r.body.error.code === 'bad-request' && /single path segment/.test(r.body.error.message),
    'B5 非法名 → 400 bad-request（带上游文案，客户端能直接显示）')
  r = await fsCall(handler, { sessionId: 'sess-1', path: 'tools', name: 'nul' }, 'fs.createFile')
  check(r.status === 400 && /reserved device name/.test(r.body.error.message), 'B6 Windows 保留名 → 400')

  r = await fsCall(handler, { sessionId: 'sess-UNKNOWN', path: 'tools', name: 'host-side.txt' }, 'fs.createFile')
  check(r.status === 400 && !existsSync(join(hostDir, 'tools', 'host-side.txt')),
    'B7 取不到会话 cwd → 400，绝不在宿主目录里建文件')

  // fs.mkdir 的"已存在"对齐成 409（此前本地分支误给 400）
  r = await fsCall(handler, { sessionId: 'sess-1', path: 'tools', name: 'new.txt' }, 'fs.mkdir')
  check(r.status === 409, 'B8 本地 fs.mkdir 同名已存在 → 409（与上游/本插件远程分支一致）')
} finally { process.chdir(originalCwd) }

console.log('\nB2. fs.createFile（远程分支：必须落到远端）')
try {
  process.chdir(hostDir)
  const { handler, rec } = fsSandbox({ remote: true })
  const r = await fsCall(handler, { sessionId: 'sess-1', path: 'tools', name: 'far.txt' }, 'fs.createFile')
  check(r.status === 200 && r.body.value.path === join(sessionDir, 'tools', 'far.txt'),
    'B9 远程 createFile → 200 且返回镜像路径（客户端认镜像路径）')
  const create = rec.cmds.filter((c) => /set -C/.test(c))
  check(create.length === 1 && create[0].indexOf(REMOTE_ROOT + '/tools/far.txt') > 0,
    'B10 空文件是在**远端**创建的（命令含远端绝对路径）：' + (create[0] || '(无命令)'))
  check(rec.cmds.some((c) => /^test -e /.test(c) && c.indexOf(REMOTE_ROOT + '/tools/far.txt') > 0),
    'B11 创建前先探测远端是否已存在')
  check(rec.invalidations.length === 1 && rec.invalidations[0][0] === REMOTE_ROOT + '/tools',
    'B12 父目录列举缓存被失效（面板能立刻看到新文件）')
  const r2 = await fsCall(handler, { sessionId: 'sess-1', path: 'tools', name: 'taken.txt' }, 'fs.createFile')
  check(r2.status === 409, 'B13 远端已存在（探测命中）→ 409 且不执行创建')
  const r3 = await fsCall(handler, { sessionId: 'sess-1', path: 'tools', name: 'bad/name' }, 'fs.createFile')
  check(r3.status === 400 && !rec.cmds.some((c) => c.indexOf('bad/name') > 0), 'B14 非法名在本地就被挡下（不产生任何 SSH 命令）')
  check(rec.cmds.every((c) => typeof c === 'string' && c.length > 0), 'B15 所有远端命令都是字符串（无 undefined 拼接）')
} finally { process.chdir(originalCwd) }

console.log('\nB3. git.* 新端点（真实处理器 + 假 git）')
function gitSandbox(opts) {
  const rec = { calls: [], invalidations: [], freshness: [] }
  const remote = !!opts.remote
  const responses = opts.responses || {}
  const key = (dir, args) => dir + ' :: ' + args.join(' ')
  const handler = new Function(
    'join', 'existsSync', 'readFileSync', 'ctx', 'requestTrust', 'denyRequest', 'writeJson', 'writeOk', 'readJsonBody',
    'matchRemoteWorkspace', 'readRemoteInfoSync', 'getProfile', 'localToRemote', 'runGitLocal', 'runGitRemote',
    'invalidateRemoteCaches', 'freshnessForgetProfile', 'wrapperDir',
    PATH_HELPERS + '\n' + NEW_HELPERS + '\n' +
    grab(src, 'function sessionCwdFrom') + '\n' +
    grab(src, 'function parsePorcelainZ') + '\n' +
    grab(src, 'function parseLogLines') + '\n' +
    grab(src, 'async function gitStatusImpl') + '\n' +
    grab(src, 'async function gitWorktreesImpl') + '\n' +
    grab(src, 'function gitContextOf') + '\n' +
    grab(src, 'async function interceptGitHandler') + '\n' +
    'return interceptGitHandler;'
  )(
    join, existsSync, readFileSync, makeCtx(sessionDir), requestTrust, denyRequest, writeJson, writeOk, readJsonBody,
    remote ? (a, b) => ({ mirrorPath: sessionDir }) : () => null,
    remote ? (p) => (typeof p === 'string' && p.indexOf(sessionDir) === 0
      ? { profileId: 'p1', host: HOST, user: USER, keyPath: KEY, remotePath: REMOTE_ROOT, mirrorPath: sessionDir } : null) : () => null,
    () => ({ id: 'p1' }),
    (local, mirror, remoteRoot) => String(remoteRoot) + String(local).replace(/\\/g, '/').slice(String(mirror).replace(/\\/g, '/').length),
    async (dir, args) => {
      rec.calls.push(['local', dir, args.join(' ')])
      if (responses[key(dir, args)] !== undefined) {
        const v = responses[key(dir, args)]
        if (v instanceof Error) throw v
        return v
      }
      if (args[0] === 'status') return ''
      if (args[0] === 'worktree') return ''
      return ''
    },
    async (profile, dir, args) => {
      rec.calls.push(['remote', dir, args.join(' ')])
      if (responses[key(dir, args)] !== undefined) {
        const v = responses[key(dir, args)]
        if (v instanceof Error) throw v
        return v
      }
      if (args[0] === 'status') return ''
      return ''
    },
    (p, path, o) => { rec.invalidations.push([path, o]) },
    (stateDir, profileId) => { rec.freshness.push([stateDir, profileId]) },
    '<wrapperDir>'
  )
  return { handler, rec }
}
const gitCall = async (api, method, payload) => {
  const res = makeRes()
  await api({ method: 'POST', headers: {}, __body: payload }, res, method)
  return res
}

try {
  process.chdir(hostDir)

  // ---- blame ----
  {
    const { handler, rec } = gitSandbox({ remote: false, responses: { [sessionDir + ' :: blame --porcelain -L 3,7 -- src/a.ts']: BLAME } })
    const r = await gitCall(handler, 'blame', { sessionId: 'sess-1', path: 'src/a.ts', startLine: 3, endLine: 7 })
    check(r.status === 200 && r.body.value.lines.length === 3 && r.body.value.lines[0].author === 'Alice',
      'B16 git.blame → {lines:[…]}（真实处理器解析 porcelain）')
    check(rec.calls.length === 1 && rec.calls[0][1] === sessionDir && rec.calls[0][2] === 'blame --porcelain -L 3,7 -- src/a.ts',
      'B17 blame 用会话 cwd 跑，实参与上游一致（-L start,end -- path）')

    const bad1 = await gitCall(handler, 'blame', { sessionId: 'sess-1', path: 'src/a.ts', startLine: 0, endLine: 7 })
    check(bad1.status === 400 && rec.calls.length === 1, 'B18 startLine 非正整数 → 400，且**不跑** git')
    const bad2 = await gitCall(handler, 'blame', { sessionId: 'sess-1', path: 'src/a.ts', startLine: 7, endLine: 3 })
    check(bad2.status === 400 && /must not precede/.test(bad2.body.error.message), 'B19 endLine < startLine → 400（上游文案）')
    const bad3 = await gitCall(handler, 'blame', { sessionId: 'sess-1', startLine: 1, endLine: 2 })
    check(bad3.status === 400 && /path is required/.test(bad3.body.error.message), 'B20 缺 path → 400')

    const failing = gitSandbox({ remote: false, responses: { [sessionDir + ' :: blame --porcelain -L 1,1 -- untracked.txt']: new Error('fatal: no such path') } })
    const r2 = await gitCall(failing.handler, 'blame', { sessionId: 'sess-1', path: 'untracked.txt', startLine: 1, endLine: 1 })
    check(r2.status === 200 && r2.body.value.lines.length === 0, 'B21 blame 失败 → 静默降级成空数组（上游同）')
  }

  // ---- diff-head ----
  {
    const { handler, rec } = gitSandbox({ remote: false, responses: { [sessionDir + ' :: diff --no-ext-diff --no-color -U3 HEAD -- src/a.ts']: 'DIFF-HEAD-TEXT' } })
    const r = await gitCall(handler, 'diff-head', { sessionId: 'sess-1', path: 'src/a.ts' })
    check(r.status === 200 && r.body.value.diff === 'DIFF-HEAD-TEXT', 'B22 git.diff-head → {diff}')
    check(rec.calls[0][2] === 'diff --no-ext-diff --no-color -U3 HEAD -- src/a.ts', 'B23 diff-head 实参与上游一致（--no-ext-diff --no-color -U3 HEAD）')
    const noHead = gitSandbox({ remote: false, responses: { [sessionDir + ' :: diff --no-ext-diff --no-color -U3 HEAD -- src/a.ts']: new Error('fatal: ambiguous argument HEAD') } })
    const r2 = await gitCall(noHead.handler, 'diff-head', { sessionId: 'sess-1', path: 'src/a.ts' })
    check(r2.status === 200 && noHead.rec.calls.some((c) => c[2] === 'diff --no-ext-diff --no-color -U3 --cached -- src/a.ts'),
      'B24 没有 HEAD 时回退 --cached（上游的回退分支）')
    const r3 = await gitCall(handler, 'diff-head', { sessionId: 'sess-1' })
    check(r3.status === 400, 'B25 diff-head 缺 path → 400')
  }

  // ---- worktrees（本地）----
  {
    const { handler, rec } = gitSandbox({
      remote: false,
      responses: {
        [sessionDir + ' :: rev-parse --is-inside-work-tree']: 'true\n',
        [sessionDir + ' :: rev-parse --show-toplevel']: sessionDir + '\n',
        [sessionDir + ' :: worktree list --porcelain']: wtFixture(sessionDir),
        [sessionDir + ' :: status --porcelain=v1 -z --untracked-files=all']: ' M a.txt\0?? b.txt\0'
      }
    })
    const r = await gitCall(handler, 'worktrees', { sessionId: 'sess-1' })
    const rows = r.body.value
    check(r.status === 200 && Array.isArray(rows) && rows.length === 2, 'B26 git.worktrees → 数组（prunable 被过滤）')
    check(rows[0].path === sessionDir && rows[0].current === true && rows[0].branch === 'main' && rows[0].changes === 2,
      'B27 current 条目排最前，changes 为 status 条目数')
    check(rows[1].path === '/remote/wt2' && rows[1].current === false && rows[1].branch === 'feature' && rows[1].changes === 0,
      'B28 其他 worktree 保留远端路径形状，changes 缺省 0')
    check(rec.calls.some((c) => c[1] === '/remote/wt2' && c[2].indexOf('status --porcelain=v1 -z --untracked-files=all') === 0),
      'B29 每个 worktree 的 status 用**它自己的目录**跑（不是会话 cwd）')
    const notRepo = gitSandbox({ remote: false, responses: { [sessionDir + ' :: rev-parse --is-inside-work-tree']: 'false\n' } })
    const r2 = await gitCall(notRepo.handler, 'worktrees', { sessionId: 'sess-1' })
    check(r2.status === 200 && r2.body.value.length === 0, 'B30 不是仓库 → []（上游同）')
  }

  // ---- worktrees（远程：runIn 必须走 SSH + 用远端路径）----
  {
    const { handler, rec } = gitSandbox({
      remote: true,
      responses: {
        [REMOTE_ROOT + ' :: rev-parse --is-inside-work-tree']: 'true\n',
        [REMOTE_ROOT + ' :: rev-parse --show-toplevel']: REMOTE_ROOT + '\n',
        [REMOTE_ROOT + ' :: worktree list --porcelain']: wtFixture(REMOTE_ROOT),
        [REMOTE_ROOT + ' :: status --porcelain=v1 -z --untracked-files=all']: ' M a.txt\0'
      }
    })
    const r = await gitCall(handler, 'worktrees', { sessionId: 'sess-1' })
    check(r.status === 200 && r.body.value[0].current === true, 'B31 远程 worktrees：current 用远端路径判定')
    check(rec.calls.every((c) => c[0] === 'remote'), 'B32 远程分支只走 runGitRemote（不在本机跑 git）')
    check(rec.calls.some((c) => c[1] === '/remote/wt2'), 'B33 每个 worktree 用**远端**路径跑（/remote/wt2）')
    check(rec.calls.every((c) => !String(c[1]).startsWith(sessionDir)), 'B34 没有任何调用落到本地镜像目录')
  }

  // ---- pull / push ----
  {
    const { handler, rec } = gitSandbox({ remote: true, responses: { [REMOTE_ROOT + ' :: pull --ff-only']: 'Already up to date.\n' } })
    const r = await gitCall(handler, 'pull', { sessionId: 'sess-1' })
    check(r.status === 200 && r.body.value.ok === true, 'B35 git.pull → {ok:true}')
    check(rec.calls.length === 1 && rec.calls[0][1] === REMOTE_ROOT && rec.calls[0][2] === 'pull --ff-only',
      'B36 pull 在**远端仓库**上跑（--ff-only，与上游一致）')
    check(rec.invalidations.length === 1 && rec.invalidations[0][0] === REMOTE_ROOT && rec.invalidations[0][1].subtree === true,
      'B37 pull 之后整棵远端列举缓存失效（工作树可能变了）')
    check(rec.freshness.length === 1 && rec.freshness[0][1] === 'p1', 'B38 pull 之后清掉写回桥的远端指纹（否则下次写回被误判"远端已改动"）')

    const pushed = gitSandbox({ remote: true, responses: { [REMOTE_ROOT + ' :: push']: 'ok\n' } })
    const r2 = await gitCall(pushed.handler, 'push', { sessionId: 'sess-1' })
    check(r2.status === 200 && r2.body.value.ok === true && pushed.rec.calls[0][2] === 'push', 'B39 git.push → {ok:true} 且实参为 push')
    check(pushed.rec.invalidations.length === 0 && pushed.rec.freshness.length === 0, 'B40 push 不改工作树 → 不做缓存失效（避免无谓刷新）')

    const local = gitSandbox({ remote: false, responses: { [sessionDir + ' :: pull --ff-only']: '' } })
    const r3 = await gitCall(local.handler, 'pull', { sessionId: 'sess-1' })
    check(r3.status === 200 && local.rec.calls[0][1] === sessionDir, 'B41 本地 pull 用会话 cwd，且不触碰远端缓存/指纹')
    check(local.rec.invalidations.length === 0 && local.rec.freshness.length === 0, 'B42 本地 pull 不做远端失效')
  }

  // ---- 未注册的模型类端点不应被本插件接管（回归：别把它们塞进 GIT_METHODS）----
  {
    const { handler } = gitSandbox({ remote: false })
    const r = await gitCall(handler, 'models', { sessionId: 'sess-1' })
    check(r.status === 404, 'B43 git.models 不由本插件处理（纯模型端点，交给上游）')
  }
} finally { process.chdir(originalCwd) }

// ---------------------------------------------------------------------------
// C. 接线与上游对拍
// ---------------------------------------------------------------------------
console.log('\nC. 接线、文档与上游覆盖率')
const fsRouteArray = (() => {
  const m = src.match(/\["fs\.tree",[^\]]*\]\.forEach/)
  if (!m) throw new Error('fs route array not found')
  return [...m[0].matchAll(/"(fs\.[a-zA-Z]+)"/g)].map((x) => x[1])
})()
const gitMethods = (() => {
  const m = src.match(/const GIT_METHODS = \[([^\]]+)\]/)
  if (!m) throw new Error('GIT_METHODS not found')
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1])
})()
const NEED_FS = ['fs.createFile']
const NEED_GIT = ['blame', 'diff-head', 'worktrees', 'pull', 'push']
for (const m of NEED_FS) check(fsRouteArray.includes(m), 'C1 fs 路由注册了 0.25.0 新端点 ' + m)
for (const m of NEED_GIT) check(gitMethods.includes(m), 'C2 GIT_METHODS 注册了 0.25.0 新端点 git.' + m)
check(!gitMethods.includes('models') && !gitMethods.includes('suggest-message') && !gitMethods.includes('commit-model'),
  'C3 模型类端点（models / suggest-message / commit-model）**不**注册（它们不碰仓库路径，交给上游才对）')
check(!/function createWorkspaceFile\(/.test(src) && !/function assertCreatableFileName\(/.test(src) &&
  !/function parseBlamePorcelain\(output\) \{\s*const rows = \[\];\s*const seen = \/\* @__PURE__ \*\//.test(src),
  'C4 没有把上游实现整段抄进来（只按契约重写；上游函数名最多出现在注释里）')
check(/set -C; : > /.test(src), 'C5 远端建空文件用 noclobber 重定向（探测与创建之间的竞态不会清空别人的文件）')
check(src.indexOf('creatableFileNameProblem(fileName)') > 0, 'C6 远程分支同样做文件名校验（不把非法名发到远端）')
check(/result\.exists === true \? 409 : 400/.test(src), 'C7 "已存在"统一映射成 409（本地/远端、mkdir/createFile 一致）')

// 与**实际安装的** better-sidebar 对拍（MAINTENANCE 硬规则的自动化）
const installed = (() => {
  const base = join(homedir(), '.dsh', 'profiles')
  if (!existsSync(base)) return null
  for (const dir of readdirSync(base)) {
    const p = join(base, dir, 'node_modules', 'dsh-better-sidebar')
    if (existsSync(join(p, 'lib', 'index.js'))) {
      return { version: JSON.parse(readFileSync(join(p, 'package.json'), 'utf8')).version, src: readFileSync(join(p, 'lib', 'index.js'), 'utf8') }
    }
  }
  return null
})()
if (!installed) {
  console.log('  · SKIP C8：本机没有安装 dsh-better-sidebar，跳过上游对拍（不算失败）')
} else {
  const keys = [...new Set([...installed.src.matchAll(/"(fs|git)\.[a-zA-Z-]+"/g)].map((m) => m[0].slice(1, -1)))]
  const fsKeys = keys.filter((k) => k.startsWith('fs.'))
  const gitKeys = keys.filter((k) => k.startsWith('git.'))
  const MODEL_ONLY = ['git.models', 'git.commit-model', 'git.suggest-message']
  const missingFs = fsKeys.filter((k) => !fsRouteArray.includes(k))
  const missingGit = gitKeys.filter((k) => !gitMethods.includes(k.slice(4)) && !MODEL_ONLY.includes(k))
  check(missingFs.length === 0, 'C8 对拍 better-sidebar@' + installed.version + '：所有 fs.* 端点都已接管（缺: ' + (missingFs.join(', ') || '无') + '）')
  check(missingGit.length === 0, 'C9 对拍 better-sidebar@' + installed.version + '：所有与仓库相关的 git.* 端点都已接管（缺: ' + (missingGit.join(', ') || '无') + '）')
  console.log('  · 对拍快照：fs ' + fsKeys.length + ' 个 / git ' + gitKeys.length + ' 个，其中模型类 3 个不接管')
}
check(new RegExp('## \\[' + pkg.version.replace(/\./g, '\\.') + '\\]').test(changelog), 'C10 CHANGELOG 有当前版本的条目（' + pkg.version + '）')
check(/0\.25\.0/.test(changelog), 'C11 CHANGELOG 记了这次升级到 0.25.0 的端点变化')

// ---------------------------------------------------------------------------
// D. 语义差分对拍（把上游真实纯函数抽出来，同一批输入逐条比较）
// ---------------------------------------------------------------------------
// C8/C9 只保证「端点都注册了」，D 段保证「语义没走样」：文件名校验的接受/拒绝与拒绝文案、
// isoWithOffset 的格式、blame porcelain 与 worktree 列表的解析、status 条目计数（对齐上游
// parsePorcelainZ().length）。上游内部实现随版本变化，抽不到就 SKIP、不算失败。
console.log('\nD. 语义差分对拍（vs 实际安装的 better-sidebar）')
function grabConst(text, marker, endMarker) {
  const i = text.indexOf(marker)
  if (i < 0) throw new Error('missing ' + marker)
  const start = text.lastIndexOf('\n', i) + 1
  const j = text.indexOf(endMarker, i)
  if (j < 0) throw new Error('missing end ' + endMarker)
  return text.slice(start, j + endMarker.length)
}
function grabFnText(text, marker) {
  const i = text.indexOf(marker)
  if (i < 0) throw new Error('missing ' + marker)
  const start = text.lastIndexOf('\n', i) + 1
  let depth = 0, k = text.indexOf('{', i)
  for (; k < text.length; k++) { if (text[k] === '{') depth++; else if (text[k] === '}') { depth--; if (!depth) break } }
  return text.slice(start, text.indexOf('\n', k))
}
if (!installed) {
  console.log('  · SKIP：本机没有安装 dsh-better-sidebar，跳过语义对拍（不算失败）')
} else {
  let up = null
  try {
    up = new Function([
      'class SidebarError extends Error { constructor(code, message, status = 400) { super(message); this.code = code; this.status = status } }',
      grabConst(installed.src, 'const ILLEGAL_FILE_NAME_CHARS =', ';'),
      grabFnText(installed.src, 'function firstIllegalNameChar('),
      grabConst(installed.src, 'const RESERVED_FILE_NAMES =', ']);'),
      grabFnText(installed.src, 'function assertCreatableFileName('),
      grabFnText(installed.src, 'function isoWithOffset('),
      grabFnText(installed.src, 'function parseBlamePorcelain('),
      grabFnText(installed.src, 'function parseWorktreeList('),
      'return { assertCreatableFileName, isoWithOffset, parseBlamePorcelain, parseWorktreeList };'
    ].join('\n'))()
  } catch (e) {
    console.log('  · SKIP：上游纯函数抽取失败（' + e.message + '）——升级后实现变了，人工看一眼')
  }
  if (up) {
    let same = 0, diff = 0
    const cmp = (label, u, m) => {
      if (JSON.stringify(u) === JSON.stringify(m)) { same++; return }
      diff++
      console.log('  ✗ 与上游不一致 [' + label + '] 上游=' + JSON.stringify(u).slice(0, 90) + ' 本插件=' + JSON.stringify(m).slice(0, 90))
    }
    const NAMES = ['readme.md', 'a', 'A.TXT', '.gitignore', '..hidden', '📁数据.txt', '中文 名.csv',
      '', '.', '..', 'a/b', String.raw`a\b`, 'a<b', 'a:b', 'a"b', 'a|b', 'a?b', 'a*b', 'a\u0000b', 'a\u001fb',
      'NUL', 'nul.txt', 'NUL.tar.gz', 'COM1', 'com9.log', 'LPT1', 'nulx', 'com0', 'com10', 'console.log', 'trailing ', 'a  b']
    for (const n of NAMES) {
      let uv = 'ok', ue
      try { up.assertCreatableFileName(n) } catch (e) { uv = 'reject:bad-request'; ue = e.message }
      const problem = creatableFileNameProblem(n)
      cmp('name=' + JSON.stringify(n), uv, problem === '' ? 'ok' : 'reject:bad-request')
      if (uv !== 'ok' && problem !== '') cmp('msg=' + JSON.stringify(n), ue, problem)
    }
    for (const [sec, tz] of [[1700000000, ''], [1700000000, '+0800'], [1700000000, '-0530'], [0, '+0000'], [-3600, '+0900'], [1700000000, 'garbage']]) {
      cmp('iso(' + sec + ',' + tz + ')', up.isoWithOffset(sec, tz), isoWithOffset(sec, tz))
    }
    for (let i = 0; i < 5; i++) {
      const fixtures = [BLAME, '', 'not a blame', BLAME.split('\n').slice(0, 6).join('\n'), BLAME.replace(/\t/g, ' ')]
      cmp('blame#' + i, up.parseBlamePorcelain(fixtures[i]), parseBlamePorcelain(fixtures[i]))
    }
    for (const w of [WT, '', 'worktree /a\nHEAD x\nbranch refs/heads/main', 'worktree /a\0HEAD x\0branch refs/heads/m\0\0']) {
      cmp('wt=' + JSON.stringify(w).slice(0, 30), up.parseWorktreeList(w), parseWorktreeList(w))
    }
    check(diff === 0, 'D1 与上游语义一致：' + same + ' 项输入全部相同（文件名校验含拒绝文案 / isoWithOffset / blame / worktree）')
    check(same >= 60, 'D2 对拍覆盖足够多的输入（' + same + ' 项 ≥ 60）')
  }
}

try { rmSync(hostDir, { recursive: true, force: true }) } catch (e) {}
try { rmSync(sessionDir, { recursive: true, force: true }) } catch (e) {}

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败')
process.exit(fail ? 1 : 0)
