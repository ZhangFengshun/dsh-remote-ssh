// 本地会话相对路径归一 —— issue #25（guolei1993，2026-10-13）
//
// 背景：本插件以 kind:"exact" 接管了 `dsh-better-sidebar` 的 `/sidebar/file` 与 `/sidebar/api/fs.*`
// 路由（为了远程工作区），**本地会话也走这里**。被接管的原实现按会话 cwd / worktree 根解析相对路径
// （`ensureWorkspacePath(sessionCwd, raw)`），而本插件的本地分支把路径原样交给 fs —— Node 于是按
// **插件宿主进程的 process.cwd()**（pnpm profile 目录）解析：
//     cannot read: ENOENT: no such file or directory, stat '<profile>/tools/check_file_size.py'
// 绝对路径不受影响，所以用户侧只是「部分文件打不开」。`handleSidebarFile` 里更明显：
// cwd 已经算出来了，却没被使用。写操作（fs.write / fs.remove）同理会打到插件宿主目录。
//
// 三层：
//   A. 纯函数 resolveSessionPath / unresolvedPathMessage 的真值表（绝对 / 相对 / 无基准 / ~ / 空）
//   B. **真实处理器的行为**（源码切片 + 假 ctx/req/res，并把 process.cwd() 搬到一个"宿主目录"上）：
//      fs.read / fs.tree / fs.trees / fs.write / fs.rename / fs.remove / fs.mkdir / fs.search、
//      `/sidebar/file`、`git.*`、`open.external` —— 相对路径必须落在会话 cwd 下；
//      取不到会话 cwd 时必须**报错**，绝不能读到宿主目录里的同名文件（宿主目录里放了 canary 文件）。
//   C. 接线与文档：所有落点都归一；这些处理器里不再出现 process.cwd() 兜底；版本/CHANGELOG/README。
import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import {
  stat, open, readFile, writeFile, rename, rm, mkdir, opendir, lstat
} from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

// 用 fileURLToPath 而不是 URL.pathname：后者会把 8.3 短路径里的 `~` 百分号编码成 %7E（Windows 上很常见）。
const root = fileURLToPath(new URL('..', import.meta.url))
const src = readFileSync(root + '/lib/index.js', 'utf8')
const changelog = readFileSync(root + '/CHANGELOG.md', 'utf8')
const readme = readFileSync(root + '/README.md', 'utf8')
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
// 沙箱：真实代码片段 + 假宿主
// ---------------------------------------------------------------------------
const MODULE_HELPERS = [
  grab(src, 'function isAbsoluteLocalPath'),
  grab(src, 'function resolveSessionPath'),
  grab(src, 'function unresolvedPathMessage')
].join('\n')

/** 造一个"会话注册表"：只有 sess-1 存在，cwd 指向 sessionDir。 */
function makeCtx(sessionDir) {
  const session = { header: { cwd: sessionDir } }
  const sessions = { get: (id) => (id === 'sess-1' ? session : null) }
  return { get: (name) => (name === 'sessions' ? sessions : null), logger: { debug() {}, warn() {}, error() {} } }
}

/** 假 req / res：res 记录 status 与 body（writeOk 的包装与真实实现一致）。 */
function makeRes() {
  const res = {
    status: 0, body: undefined, headers: undefined, raw: undefined,
    writeHead(status, headers) { res.status = status; res.headers = headers; return res },
    end(body) { if (body !== undefined && res.body === undefined) { res.raw = body } ; return res },
    setHeader() { return res }
  }
  return res
}
const writeJson = (res, status, obj) => { res.status = status; res.body = obj }
const writeOk = (res, value) => { res.status = 200; res.body = { ok: true, value: value } }
const readJsonBody = async (req) => req.__body
const requestTrust = () => 'ok'
const denyRequest = (res, why) => { res.status = 403; res.body = { ok: false, error: { code: 'denied', message: why } } }

/** 构造 interceptFsHandler 沙箱（本地分支所需依赖一应俱全；远程分支不会被调用）。 */
function fsSandbox(sessionDir) {
  const rec = { runPooledCalls: 0 }
  const fn = new Function(
    'join', 'dirname', 'basename', 'stat', 'open', 'readFile', 'writeFile', 'rename', 'rm', 'mkdir',
    'opendir', 'lstat', 'existsSync', 'homedir', 'READ_LIMIT', 'LIST_LIMIT',
    'ctx', 'requestTrust', 'denyRequest', 'writeJson', 'writeOk', 'readJsonBody',
    'readRemoteInfoSync', 'localSearchFiles',
    MODULE_HELPERS + '\n' +
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
    grab(src, 'async function interceptFsHandler') + '\n' +
    'return { interceptFsHandler, localReadText };'
  )(
    join, dirname, basename, stat, open, readFile, writeFile, rename, rm, mkdir,
    opendir, lstat, existsSync, homedir, 524288, 1000,
    makeCtx(sessionDir), requestTrust, denyRequest, writeJson, writeOk, readJsonBody,
    () => null,                       // readRemoteInfoSync → 一律本地分支
    async () => ({ entries: [], truncated: false })  // localSearchFiles → 本测试不查内容
  )
  return { api: fn, rec }
}

async function fsCall(api, sessionDir, method, payload) {
  const res = makeRes()
  await api.interceptFsHandler({ method: 'POST', headers: {}, __body: payload }, res, method)
  return res
}

// ---------------------------------------------------------------------------
// A. 纯函数
// ---------------------------------------------------------------------------
console.log('\nA. resolveSessionPath 真值表')
{
  const { resolveSessionPath, unresolvedPathMessage, isAbsoluteLocalPath } = new Function('join', MODULE_HELPERS +
    '\nreturn { resolveSessionPath, unresolvedPathMessage, isAbsoluteLocalPath };')(join)
  const win = 'C:\\work\\proj'
  const posix = '/work/proj'
  check(resolveSessionPath('/etc/hosts', win).path === '/etc/hosts', 'A1 POSIX 绝对路径原样返回')
  check(resolveSessionPath('C:\\work\\proj\\a.py', posix).path === 'C:\\work\\proj\\a.py', 'A2 Windows 绝对路径原样返回（基准是 POSIX 也不动它）')
  check(resolveSessionPath('D:/x/y', win).path === 'D:/x/y', 'A3 正斜杠盘符路径也认作绝对')
  check(resolveSessionPath('\\\\srv\\share\\x', win).path === '\\\\srv\\share\\x', 'A4 UNC 路径认作绝对')
  check(resolveSessionPath('tools/x.py', win).path === join(win, 'tools/x.py'), 'A5 相对路径按基准拼接')
  check(resolveSessionPath('tools/x.py', win).resolved === true, 'A6 拼接成功的 resolved 为 true')
  check(resolveSessionPath('./tools/../tools/x.py', win).path === join(win, 'tools/x.py'), 'A7 相对路径里的 . / .. 归一')
  check(resolveSessionPath('tools/x.py', '').resolved === false, 'A8 没有基准 → 不解析（不猜）')
  check(resolveSessionPath('tools/x.py', '').reason === 'no-base', 'A9 原因是 no-base')
  check(resolveSessionPath('tools/x.py', null).resolved === false, 'A10 基准为 null 同样不解析')
  check(resolveSessionPath('', win).resolved === false, 'A11 空路径不解析')
  check(resolveSessionPath(undefined, win).reason === 'empty', 'A12 undefined 归为 empty')
  check(resolveSessionPath('~/a.py', win).path === '~/a.py', 'A13 ~ 开头原样返回（不拼出 base/~/x）')
  check(resolveSessionPath('~/a.py', win).resolved === false, 'A14 ~ 视为未解析，交给调用方报错')
  check(resolveSessionPath('tools/x.py', 'relative/dir').resolved === false, 'A14b 相对 base → 不解析（否则 join 出来仍是相对路径，等于把 bug 放回来）')
  check(resolveSessionPath('tools/x.py', 'relative/dir').reason === 'relative-base', 'A14c 原因是 relative-base')
  check(resolveSessionPath('tools/x.py', 'C:foo').resolved === false, 'A14d 盘符相对形式（C:foo）也拒（对齐上游 requireAbsolute）')
  check(unresolvedPathMessage('tools/x.py', 'relative/dir', 'relative-base').includes('不是绝对路径'), 'A14e 相对 base 的文案说清是基准的问题')
  check(isAbsoluteLocalPath('C:/x') && isAbsoluteLocalPath('/x') && isAbsoluteLocalPath('\\\\s\\x') && !isAbsoluteLocalPath('x/y'), 'A15 isAbsoluteLocalPath 覆盖盘符/斜杠/UNC')
  check(unresolvedPathMessage('tools/x.py', '', 'no-base').includes('tools/x.py'), 'A16 报错文案里带上用户给的相对路径')
  check(unresolvedPathMessage('tools/x.py', '', 'no-base').includes('cwd'), 'A17 报错文案告诉用户补 cwd / sessionId')
  check(unresolvedPathMessage('', '', 'empty') === 'path 为必填项', 'A18 空路径的文案')
  check(unresolvedPathMessage('~/a', '', 'unexpanded-tilde').includes('不支持'), 'A19 ~ 的文案说明不支持展开')
}

// ---------------------------------------------------------------------------
// B. 真实处理器行为（把 process.cwd() 搬到一个"插件宿主目录"上）
// ---------------------------------------------------------------------------
console.log('\nB. 真实处理器行为（宿主目录里放 canary，验证不会被读到/写到）')
const hostDir = mkdtempSync(join(tmpdir(), 'rssh-host-'))
const sessionDir = mkdtempSync(join(tmpdir(), 'rssh-sess-'))
const otherDir = mkdtempSync(join(tmpdir(), 'rssh-other-'))
const originalCwd = process.cwd()
try {
  mkdirSync(join(hostDir, 'tools'), { recursive: true })
  writeFileSync(join(hostDir, 'tools', 'x.py'), 'HOST-CANARY')
  writeFileSync(join(hostDir, 'tools', 'canary.txt'), 'HOST-CANARY')
  mkdirSync(join(sessionDir, 'tools'), { recursive: true })
  mkdirSync(join(sessionDir, 'sub'), { recursive: true })
  writeFileSync(join(sessionDir, 'tools', 'x.py'), 'SESSION-CONTENT')
  writeFileSync(join(sessionDir, 'sub', 'y.txt'), 'SUB-CONTENT')
  mkdirSync(join(otherDir, 'otherSub'), { recursive: true })
  writeFileSync(join(otherDir, 'otherSub', 'z.txt'), 'OTHER-CONTENT')
  process.chdir(hostDir)   // ← 插件宿主进程的 cwd（issue #25 里相对路径落到的那个目录）

  const { api } = fsSandbox(sessionDir)

  // ---- fs.read ----
  let r = await fsCall(api, sessionDir, 'fs.read', { sessionId: 'sess-1', path: 'tools/x.py' })
  check(r.status === 200 && r.body.value.content === 'SESSION-CONTENT',
    'B1 fs.read 相对路径 → 读的是**会话 cwd** 下的文件（旧代码会读到宿主目录或 ENOENT）')
  check(r.body.value.content !== 'HOST-CANARY', 'B2 不会读到宿主目录里的同名文件')
  r = await fsCall(api, sessionDir, 'fs.read', { sessionId: 'sess-1', path: join(sessionDir, 'tools', 'x.py') })
  check(r.status === 200 && r.body.value.content === 'SESSION-CONTENT', 'B3 绝对路径照旧可用（无回归）')
  r = await fsCall(api, sessionDir, 'fs.read', { cwd: sessionDir, path: 'tools/x.py' })
  check(r.status === 200 && r.body.value.content === 'SESSION-CONTENT', 'B4 只给 cwd（没有 sessionId）同样能解析')
  // 客户端传相对 cwd 时不能拿它当基准（否则 join 出来仍是相对路径 → 又按 process.cwd() 解析）
  r = await fsCall(api, sessionDir, 'fs.read', { cwd: 'relative/dir', path: 'tools/canary.txt' })
  check(r.status === 400 && r.body.value === undefined, 'B4b 相对 cwd 不被采信 + 有会话时回退到会话 cwd 之外一律报错（读不到宿主 canary）')
  r = await fsCall(api, sessionDir, 'fs.read', { sessionId: 'sess-1', cwd: 'relative/dir', path: 'tools/x.py' })
  check(r.status === 200 && r.body.value.content === 'SESSION-CONTENT', 'B4c 相对 cwd 被忽略后回退到会话注册表（仍读到正确文件）')
  r = await fsCall(api, sessionDir, 'fs.tree', { sessionId: 'sess-1', cwd: 'relative/dir', path: '.' })
  check(r.status === 200 && r.body.value.entries.some((e) => e.name === 'sub'), 'B4d 相对 cwd 被忽略后 tree 仍按会话 cwd 列目录')
  r = await fsCall(api, sessionDir, 'fs.read', { sessionId: 'sess-UNKNOWN', path: 'tools/canary.txt' })
  check(r.status === 400, 'B5 会话取不到 + 相对路径 → 明确报错（400）')
  check(r.body && r.body.error && r.body.error.code === 'bad-request', 'B6 报错码是 bad-request')
  check(String((r.body && r.body.error && r.body.error.message) || '').includes('tools/canary.txt'), 'B7 报错文案带上原始相对路径，便于自查')
  check(r.body.value === undefined, 'B8 绝不回退到宿主目录（旧代码会在这里返回宿主 canary 的内容）')

  // ---- fs.tree ----
  r = await fsCall(api, sessionDir, 'fs.tree', { sessionId: 'sess-1', path: 'sub' })
  check(r.status === 200 && r.body.value.entries.some((e) => e.name === 'y.txt'), 'B9 fs.tree 相对路径 → 列的是会话 cwd 下的目录')
  r = await fsCall(api, sessionDir, 'fs.tree', { sessionId: 'sess-1', path: '.' })
  check(r.status === 200 && r.body.value.entries.some((e) => e.name === 'sub'), 'B10 fs.tree path="." → 会话 cwd 本身')

  // ---- fs.trees ----
  r = await fsCall(api, sessionDir, 'fs.trees', { sessionId: 'sess-1', paths: ['tools', 'sub'] })
  check(r.status === 200 && r.body.value.levels.length === 2, 'B11 fs.trees 两条相对路径都处理')
  check(r.body.value.levels[0].path === join(sessionDir, 'tools'), 'B12 fs.trees 回显的 level.path 是**解析后的绝对路径**（客户端据此落缓存）')
  check(r.body.value.levels[0].entries.some((e) => e.name === 'x.py'), 'B13 fs.trees 真的列出了会话 cwd 下的内容')
  r = await fsCall(api, sessionDir, 'fs.trees', { sessionId: 'sess-UNKNOWN', paths: ['tools', join(sessionDir, 'sub')] })
  check(r.status === 200 && !!r.body.value.levels[0].error && r.body.value.levels[0].path === 'tools',
    'B14 fs.trees 解析不了的那条**只让自己**报错（回显原始路径；不静默落到宿主目录）')
  check(r.body.value.levels[0].entries.length === 0, 'B15 坏条目不返回任何条目（不可能来自宿主目录）')
  check(r.body.value.levels[1].entries.some((e) => e.name === 'y.txt'), 'B15b 同一批里能解析的那条照常返回（一条坏路径不拖垮整棵树）')
  r = await fsCall(api, sessionDir, 'fs.trees', { paths: ['tools'] })
  check(r.status === 200 && !!r.body.value.levels[0].error, 'B15c 完全没有会话信息 + 相对路径 → 该条带 error')
  r = await fsCall(api, sessionDir, 'fs.trees', { sessionId: 'sess-1', paths: [join(sessionDir, 'sub')] })
  check(r.status === 200 && r.body.value.levels[0].entries.some((e) => e.name === 'y.txt'), 'B16 fs.trees 绝对路径照旧可用')

  // ---- fs.write（写操作最危险：旧代码会写进插件宿主目录）----
  r = await fsCall(api, sessionDir, 'fs.write', { sessionId: 'sess-1', path: 'tools/new.txt', content: 'W1' })
  check(r.status === 200, 'B17 fs.write 相对路径 → 成功')
  check(existsSync(join(sessionDir, 'tools', 'new.txt')), 'B18 文件落在**会话 cwd** 下')
  check(!existsSync(join(hostDir, 'tools', 'new.txt')), 'B19 没有出现在插件宿主目录里（旧代码会写在那里）')
  r = await fsCall(api, sessionDir, 'fs.write', { sessionId: 'sess-UNKNOWN', path: 'tools/evil.txt', content: 'X' })
  check(r.status === 400 && !existsSync(join(hostDir, 'tools', 'evil.txt')), 'B20 解析不了时既不写、也不报成功')

  // ---- fs.rename ----
  r = await fsCall(api, sessionDir, 'fs.rename', { sessionId: 'sess-1', path: 'tools/new.txt', name: 'renamed.txt' })
  check(r.status === 200 && existsSync(join(sessionDir, 'tools', 'renamed.txt')), 'B21 fs.rename 相对路径 → 改的是会话 cwd 下的文件')
  check(!existsSync(join(hostDir, 'tools', 'renamed.txt')), 'B22 宿主目录里没有被动过')

  // ---- fs.remove（最危险的破坏性操作）----
  r = await fsCall(api, sessionDir, 'fs.remove', { sessionId: 'sess-1', path: 'tools/renamed.txt' })
  check(r.status === 200 && !existsSync(join(sessionDir, 'tools', 'renamed.txt')), 'B23 fs.remove 相对路径 → 删的是会话 cwd 下的文件')
  check(existsSync(join(hostDir, 'tools', 'canary.txt')), 'B24 宿主目录里的 canary 毫发无损（旧代码会删到它）')
  r = await fsCall(api, sessionDir, 'fs.remove', { sessionId: 'sess-UNKNOWN', path: 'tools/canary.txt' })
  check(r.status === 400 && existsSync(join(hostDir, 'tools', 'canary.txt')), 'B25 解析不了时拒绝执行（canary 仍在）')

  // ---- fs.mkdir ----
  r = await fsCall(api, sessionDir, 'fs.mkdir', { sessionId: 'sess-1', path: 'tools', name: 'made' })
  check(r.status === 200 && existsSync(join(sessionDir, 'tools', 'made')), 'B26 fs.mkdir 相对路径 → 建在会话 cwd 下')
  check(!existsSync(join(hostDir, 'tools', 'made')), 'B27 宿主目录里没有多出目录')

  // ---- fs.search ----
  r = await fsCall(api, sessionDir, 'fs.search', { sessionId: 'sess-UNKNOWN', query: 'x' })
  check(r.status === 400, 'B28 fs.search 没有会话 cwd → 400（不在宿主目录里乱搜）')
  r = await fsCall(api, sessionDir, 'fs.search', { sessionId: 'sess-1', query: 'x' })
  check(r.status === 200, 'B29 fs.search 有会话 cwd → 正常（无回归）')

  // ---- /sidebar/file ----
  {
    const md = new Function('join', 'stat', 'readFile', 'ctx', 'requestTrust', 'trustErrorMessage',
      'writeJson', 'matchRemoteWorkspace', 'mediaTypeForPath', 'readRemoteInfoSync', 'getProfile',
      MODULE_HELPERS + '\n' + grab(src, 'function sessionCwdFrom') + '\n' + grab(src, 'async function handleSidebarFile') +
      '\nreturn handleSidebarFile;')(
      join, stat, readFile, makeCtx(sessionDir), requestTrust, (w) => 'blocked: ' + w,
      writeJson, () => null, () => 'text/plain', () => null, () => null
    )
    const fileReq = (qs) => ({ method: 'GET', url: '/sidebar/file?' + qs, headers: {} })
    let res = makeRes()
    await md(fileReq('sessionId=sess-1&path=' + encodeURIComponent('tools/x.py')), res)
    check(res.status === 200 && String(res.raw) === 'SESSION-CONTENT',
      'B30 /sidebar/file 相对路径 → 读会话 cwd 下的文件（旧代码 ENOENT 到宿主目录）')
    res = makeRes()
    await md(fileReq('sessionId=sess-1&cwd=' + encodeURIComponent(otherDir) + '&path=' + encodeURIComponent('otherSub/z.txt')), res)
    check(res.status === 200 && String(res.raw) === 'OTHER-CONTENT', 'B31 /sidebar/file 里显式 cwd 参数优先于会话 cwd')
    res = makeRes()
    await md(fileReq('sessionId=sess-UNKNOWN&path=' + encodeURIComponent('tools/canary.txt')), res)
    check(res.status === 400 && String(res.raw) !== 'HOST-CANARY', 'B32 /sidebar/file 解析不了 → 400，不读宿主 canary')
    res = makeRes()
    await md(fileReq('sessionId=sess-1&path=' + encodeURIComponent(join(sessionDir, 'tools', 'x.py'))), res)
    check(res.status === 200 && String(res.raw) === 'SESSION-CONTENT', 'B33 /sidebar/file 绝对路径照旧可用')
  }

  // ---- git.* ----
  {
    const rec = { cwd: null }
    const git = new Function('join', 'existsSync', 'readFileSync', 'ctx', 'requestTrust', 'denyRequest',
      'writeJson', 'writeOk', 'readJsonBody', 'matchRemoteWorkspace', 'readRemoteInfoSync', 'getProfile', 'localToRemote',
      'runGitLocal', 'runGitRemote', 'gitStatusImpl', 'parseLogLines', 'posixDirname',
      MODULE_HELPERS + '\n' + grab(src, 'function sessionCwdFrom') + '\n' + grab(src, 'function gitContextOf') + '\n' +
      grab(src, 'async function interceptGitHandler') + '\nreturn interceptGitHandler;')(
      join, existsSync, readFileSync, makeCtx(sessionDir), requestTrust, denyRequest,
      writeJson, writeOk, readJsonBody, () => null, () => null, () => null, (a) => a,
      async (cwd) => { rec.cwd = cwd; return '' }, async () => '', async () => '', () => [], (p) => p
    )
    let res = makeRes()
    await git({ method: 'POST', headers: {}, __body: { sessionId: 'sess-1' } }, res, 'diff')
    check(res.status === 200 && rec.cwd === sessionDir, 'B34 git.diff 用**会话 cwd** 跑 git（旧代码退到 process.cwd() = 插件宿主目录）')
    rec.cwd = null
    res = makeRes()
    await git({ method: 'POST', headers: {}, __body: { cwd: otherDir } }, res, 'diff')
    check(res.status === 200 && rec.cwd === otherDir, 'B35 git 面板显式给的 cwd 优先')
    rec.cwd = null
    res = makeRes()
    await git({ method: 'POST', headers: {}, __body: { sessionId: 'sess-UNKNOWN' } }, res, 'diff')
    check(res.status === 400 && rec.cwd === null, 'B36 取不到会话 cwd → 400，**不跑** git（不给一个错的仓库）')
  }

  // ---- open.external ----
  {
    const rec = { kind: null, value: null }
    const open2 = new Function('join', 'ctx', 'requestTrust', 'denyRequest', 'writeJson', 'writeOk', 'readJsonBody',
      'launchRemoteEditor', 'launchExternal', 'parseExternalUrl', 'localPathFromExternalUrl',
      MODULE_HELPERS + '\n' + grab(src, 'function sessionCwdFrom') + '\n' + grab(src, 'async function interceptOpenExternalHandler') +
      '\nreturn interceptOpenExternalHandler;')(
      join, makeCtx(sessionDir), requestTrust, denyRequest, writeJson, writeOk, readJsonBody,
      async () => false, (kind, value) => { rec.kind = kind; rec.value = value; return true },
      () => null, () => null
    )
    let res = makeRes()
    await open2({ method: 'POST', headers: {}, __body: { action: 'reveal', sessionId: 'sess-1', path: 'tools/x.py' } }, res)
    check(res.status === 200 && rec.value === join(sessionDir, 'tools', 'x.py'),
      'B37 open.external reveal 相对路径 → 先归一（旧代码直接 400 “path must be an absolute path”）')
    rec.value = null
    res = makeRes()
    await open2({ method: 'POST', headers: {}, __body: { action: 'reveal', path: 'tools/x.py' } }, res)
    check(res.status === 400 && rec.value === null, 'B38 reveal 解析不了 → 400，不带着相对路径去调本机打开器')
    rec.value = null
    res = makeRes()
    await open2({ method: 'POST', headers: {}, __body: { action: 'reveal', path: join(sessionDir, 'sub', 'y.txt') } }, res)
    check(res.status === 200 && rec.value === join(sessionDir, 'sub', 'y.txt'), 'B39 reveal 绝对路径照旧可用')
  }
} finally {
  process.chdir(originalCwd)
  for (const d of [hostDir, sessionDir, otherDir]) { try { rmSync(d, { recursive: true, force: true }) } catch (e) {} }
}

// ---------------------------------------------------------------------------
// C. 接线与文档
// ---------------------------------------------------------------------------
console.log('\nC. 接线与文档')
{
  // 注释里会出现 process.cwd() 这个字样（说明为什么不能回退到它），所以断言前先把注释剥掉。
  const strip = (code) => code.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n')
  const fsHandler = strip(grab(src, 'async function interceptFsHandler'))
  const fileHandler = strip(grab(src, 'async function handleSidebarFile'))
  const gitHandler = strip(grab(src, 'async function interceptGitHandler'))
  const openHandler = strip(grab(src, 'async function interceptOpenExternalHandler'))

  check((fsHandler.match(/localPathOf\(/g) || []).length >= 12, 'C1 fs 处理器里 12 个落点都过 localPathOf（远程 7 + 本地 7，含 fs.trees/fs.mkdir）')
  check(!/localReadText\(payload|localWriteFile\(payload|localRenameEntry\(payload|localRemoveEntry\(payload|localMakeDir\(payload|localListDir\(payload/.test(fsHandler),
    'C2 本地分支不再把 payload.path 直接交给 fs 函数')
  check(!/payload\.path \|\| sessionCwd;(?!.*localPathOf)/.test(fsHandler), 'C3 远程分支不再用裸 payload.path')
  check(!fsHandler.includes('process.cwd()'), 'C4 fs 处理器里没有 process.cwd() 兜底')
  check(!fileHandler.includes('process.cwd()'), 'C5 /sidebar/file 里没有 process.cwd() 兜底')
  check(!gitHandler.includes('process.cwd()'), 'C6 git 处理器里没有 process.cwd() 兜底')
  check(fileHandler.includes('resolveSessionPath(rawPath, cwd)'),
    'C7 /sidebar/file 真的用了那个算出来的 cwd（此前 cwd 算完未被使用）')
  check(fileHandler.includes('unresolvedPathMessage(rawPath, cwd, localPath.reason)'), 'C8 /sidebar/file 解析失败时报可读错误')
  check(gitHandler.includes('无法确定会话工作目录'), 'C9 git 处理器在拿不到会话 cwd 时给出明确错误')
  check(openHandler.includes('resolveSessionPath(rawRevealPath, revealBase)'), 'C10 open.external reveal 先归一再打开')
  check(fsHandler.includes('if (!remoteInfo && probePath && isAbsoluteLocalPath(probePath))'),
    'C11 相对路径不再参与"这是不是一个远程工作区"的探测')
  check((src.match(/function isAbsoluteLocalPath\(/g) || []).length === 1, 'C12 绝对路径判断只有一份实现（原来 apply 内那份已收敛）')
  check((src.match(/function sessionCwdFrom\(/g) || []).length === 1, 'C13 会话 cwd 的取法只有一份实现')
  check(fsHandler.includes('resolveSessionPath(raw, pathBase)'), 'C14 fs.trees 逐条归一')
  check(fsHandler.includes('unresolvedPathMessage(raw, pathBase, r.reason)'), 'C15 fs.trees 的失败条目带可读原因（回显原始路径）')

  check(/^2\.4\.27$/.test(pkg.version), 'C16 版本号已升到 2.4.27')
  check(/## \[2\.4\.27\]/.test(changelog), 'C17 CHANGELOG 有 2.4.27 段落')
  check(changelog.includes('issue [#25]'), 'C18 CHANGELOG 引用了 issue #25')
  check(changelog.includes('process.cwd()'), 'C19 CHANGELOG 说明了根因（process.cwd()）')
  check(/dsh-remote-ssh@2\.4\.27/.test(readme), 'C20 README 的安装命令指向 2.4.27')
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
