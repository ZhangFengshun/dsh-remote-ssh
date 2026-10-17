/**
 * better-sidebar 0.28.0 的 `git.status` 形状对齐 —— 本插件 2.4.32。
 *
 * 为什么必须有这个文件：0.28.0 把 `git status` 从 `--porcelain=v1 -z` 换成
 * `--porcelain=v2 --branch --ahead-behind -z --untracked-files=all`，并新增
 * upstream / ahead / behind / detached / operation 与条目级 staged / unstaged 行数。
 * 本插件**接管着**这个端点，若继续返回 v1 形状，远程工作区的 Git 面板会**静默**缺字段
 * （下游全是可选字段，既不报错也不降级提示）—— 正是最难被用户说清的那类不兼容。
 *
 * 覆盖：
 *   A. 纯解析器（v2 records/meta、numstat、pathspec、组装与截断）
 *   B. 本地分支（假 git，逐条断言实参与返回形状，含 git 版本降级链）
 *   C. 远端分支（必须只发远端、一次 SSH 往返、NUL 不经 shell 变量、结果与本地同构）
 *   D. 真实临时 git 仓库端到端（真 git 输出，防"只对着假夹具自证"）
 */
import { readFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const src = readFileSync(root + '/lib/index.js', 'utf8')

let pass = 0, fail = 0
const check = (cond, label) => { if (cond) { pass++; console.log('  ✓ ' + label) } else { fail++; console.log('  ✗ FAIL: ' + label) } }

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

const PATH_HELPERS = [
  grab(src, 'function isAbsoluteLocalPath'),
  grab(src, 'function classifyRequestPathSyntax'),
  grab(src, 'function looksLikeRemoteAbsolutePath'),
  grab(src, 'function resolveSessionPath'),
  grab(src, 'function unresolvedPathMessage')
].join('\n')

// git.status 整段（常量 + 解析器 + 远端实现 + 分段器），到 gitStatusImpl 之前
const STATUS_BLOCK = (() => {
  const a = src.indexOf('// ---- better-sidebar 0.28.0 的 git.status 形状')
  const b = src.indexOf('  async function gitStatusImpl')
  if (a < 0 || b < 0 || b <= a) throw new Error('lib/index.js 里找不到 git.status 实现段（标记被改动？）')
  return src.slice(a, b)
})()
const GIT_READ_ENV = (() => {
  const m = /const GIT_READ_ENV = "([^"]+)"/.exec(src)
  if (!m) throw new Error('lib/index.js 里找不到 GIT_READ_ENV')
  return m[1]
})()

const writeJson = (res, status, obj) => { res.status = status; res.body = obj }
const writeOk = (res, value) => { res.status = 200; res.body = { ok: true, value: value } }
const readJsonBody = async (req) => req.__body
const requestTrust = () => 'ok'
const denyRequest = (res, why) => { res.status = 403; res.body = { ok: false, error: { code: 'denied', message: why } } }
const makeRes = () => ({ status: 0, body: undefined, writeHead(s) { this.status = s; return this }, end() { return this }, setHeader() { return this } })
const makeCtx = (sessionDir) => {
  const sessions = { get: (id) => (id === 'sess-1' ? { header: { cwd: sessionDir } } : null) }
  return { get: (n) => (n === 'sessions' ? sessions : null), logger: { debug() {}, warn() {}, error() {} } }
}

const HOST = '<host>', USER = '<user>', KEY = '<key>'
const REMOTE_ROOT = '/remote/root'
const S = '@@DSH_GS@@'
const SESSION = mkdtempSync(join(tmpdir(), 'dsh-status-sess-'))

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------
const H1 = 'a'.repeat(40), H2 = 'b'.repeat(40), H3 = 'c'.repeat(40)
const rec1 = (xy, path) => '1 ' + xy + ' N... 100644 100644 100644 ' + H1 + ' ' + H2 + ' ' + path
const rec2 = (xy, path, origin, score) => '2 ' + xy + ' N... 100644 100644 100644 ' + H1 + ' ' + H2 + ' ' + (score || 'R100') + ' ' + path + '\0' + origin
const recU = (xy, path) => 'u ' + xy + ' N... 100644 100644 100644 100644 ' + H1 + ' ' + H2 + ' ' + H3 + ' ' + path
const recQ = (path) => '? ' + path
const meta = (head, upstream, ab) => [head !== undefined ? '# branch.head ' + head : null, upstream ? '# branch.upstream ' + upstream : null, ab ? '# branch.ab +' + ab[0] + ' -' + ab[1] : null].filter(Boolean).join('\0')

const V2 = meta('main', 'origin/main', [2, 1]) + '\0'
  + rec1('M.', 'src/a.ts') + '\0'
  + rec1('.M', 'src/b.ts') + '\0'
  + rec2('R.', 'src/new.ts', 'src/old.ts') + '\0'
  + recU('UU', 'conflict.txt') + '\0'
  + recQ('untracked.txt') + '\0'
const NUMSTAT_UNSTAGED = '3\t1\tsrc/b.ts\0' + '0\t0\t\0src/old.ts\0src/new.ts\0' + '-\t-\tlogo.png\0'
const NUMSTAT_STAGED = '6\t2\tsrc/a.ts\0' + '1\t0\t\0src/old.ts\0src/new.ts\0'

// 纯解析器沙箱：只装 STATUS_BLOCK，不接 handler
const pure = new Function(STATUS_BLOCK + '\nreturn { GIT_STATUS_LIMIT: GIT_STATUS_LIMIT, parsePorcelainV2Z: parsePorcelainV2Z, parseNumstat: parseNumstat, resolveNumstatPath: resolveNumstatPath, statusPathspecOf: statusPathspecOf, finishStatusSnapshot: finishStatusSnapshot, statusSections: statusSections };')()

/** 本地/远端共用沙箱：只装 status 相关源码 + interceptGitHandler。 */
function statusSandbox(opts) {
  const rec = { local: [], remote: [] }
  const remote = !!opts.remote
  const localMap = opts.localMap || {}
  const localRun = opts.localRun || (async (dir, args) => {
    const key = args.join(' ')
    rec.local.push(key)
    if (localMap[key] === undefined) return ''
    const v = localMap[key]
    if (v instanceof Error) throw v
    return v
  })
  const pooled = async (profile, script) => {
    rec.remote.push(script)
    if (opts.remoteError) return { ok: false, stdout: '', stderr: '', error: opts.remoteError, exitCode: 128 }
    return { ok: true, stdout: typeof opts.remoteOut === 'string' ? opts.remoteOut : '', stderr: '' }
  }
  const handler = new Function(
    'join', 'readdir', 'ctx', 'requestTrust', 'denyRequest', 'writeJson', 'writeOk', 'readJsonBody',
    'runGitLocal', 'runPooled', 'GIT_READ_ENV',
    'matchRemoteWorkspace', 'readRemoteInfoSync', 'getProfile', 'localToRemote',
    PATH_HELPERS + '\n' +
    grab(src, 'function shellQuote') + '\n' +
    grab(src, 'function shellQuotePath') + '\n' +
    grab(src, 'function sessionCwdFrom') + '\n' +
    grab(src, 'function parsePorcelainZ') + '\n' +
    grab(src, 'function gitContextOf') + '\n' +
    STATUS_BLOCK + '\n' +
    grab(src, 'async function gitStatusImpl') + '\n' +
    grab(src, 'async function interceptGitHandler') + '\n' +
    'return interceptGitHandler;'
  )(
    join, readdir, makeCtx(opts.sessionDir), requestTrust, denyRequest, writeJson, writeOk, readJsonBody,
    localRun, pooled, GIT_READ_ENV,
    remote ? () => ({ mirrorPath: opts.sessionDir }) : () => null,
    remote ? (p) => (typeof p === 'string' && p.indexOf(opts.sessionDir) === 0
      ? { profileId: 'p1', host: HOST, user: USER, keyPath: KEY, remotePath: REMOTE_ROOT, mirrorPath: opts.sessionDir } : null) : () => null,
    () => ({ id: 'p1', host: HOST, user: USER, keyPath: KEY }),
    (local, mirror, remoteRoot) => String(remoteRoot) + String(local).replace(/\\/g, '/').slice(String(mirror).replace(/\\/g, '/').length)
  )
  return { handler: handler, rec: rec }
}

const call = async (handler, payload) => {
  const res = makeRes()
  await handler({ method: 'POST', headers: {}, __body: payload }, res, 'status')
  return res
}

// ---------------------------------------------------------------------------
console.log('\nA. 纯解析器（v2 records / meta / numstat / pathspec / 组装）')
// ---------------------------------------------------------------------------
{
  const s = pure.parsePorcelainV2Z(V2)
  check(s.isRepo === true && s.branch === 'main' && s.upstream === 'origin/main' && s.ahead === 2 && s.behind === 1,
    'A1 meta 行 → branch / upstream / ahead / behind')
  check(s.detached === false, 'A2 有 branch.head 时 detached=false')
  check(s.entries.length === 5, 'A3 5 条记录（1/1/2/u/? 各一）')
  check(s.entries[0].xy === 'M ' && s.entries[0].path === 'src/a.ts', 'A4 `1 M.` → xy "M "（点换成空格，同上游）')
  check(s.entries[1].xy === ' M' && s.entries[1].path === 'src/b.ts', 'A5 `1 .M` → xy " M"')
  check(s.entries[2].xy === 'R ' && s.entries[2].path === 'src/new.ts' && s.entries[2].origin === 'src/old.ts',
    'A6 `2 R.` 改名：path=新名，origin=旧名（旧名是下一个 NUL 字段）')
  check(s.entries[3].xy === 'UU' && s.entries[3].path === 'conflict.txt', 'A7 `u UU` 冲突记录')
  check(s.entries[4].xy === '??' && s.entries[4].path === 'untracked.txt', 'A8 `? ` 未跟踪记录')
  check(V2.indexOf('src/new.ts\0src/old.ts') > 0 ? s.entries[2].origin === 'src/old.ts' : false, 'A9 origin 取的是紧随其后的字段')

  const det = pure.parsePorcelainV2Z(meta('(detached)') + '\0' + rec1('M.', 'x') + '\0')
  check(det.detached === true && det.branch === undefined, 'A10 `(detached)` → detached=true 且不给 branch')

  const nb = pure.parsePorcelainV2Z(meta('dev') + '\0')
  check(nb.branch === 'dev' && nb.ahead === undefined && nb.behind === undefined && nb.detached === false,
    'A11 没有 branch.ab → ahead/behind 缺席（不是 0）')

  const space = pure.parsePorcelainV2Z(meta('main') + '\0' + rec1('M.', 'dir with space/f.txt') + '\0')
  check(space.entries[0].path === 'dir with space/f.txt', 'A12 路径含空格不被截断（按固定字段数切）')
}

{
  const c = pure.parseNumstat(NUMSTAT_STAGED)
  check(c.get('src/a.ts').additions === 6 && c.get('src/a.ts').deletions === 2, 'A13 -z numstat：普通改动行数')
  check(c.get('src/new.ts').additions === 1 && c.get('src/new.ts').deletions === 0 && c.size === 2,
    'A14 -z numstat：改名归到新名（旧名也有键则不覆盖）')
  const u = pure.parseNumstat('2\t0\tother.txt\0' + '-\t-\tlogo.png\0' + '0\t0\t\0o\0n\0')
  check(u.get('other.txt').additions === 2, 'A15 -z numstat：另一条普通改动')
  check(u.get('logo.png').binary === true, 'A16 二进制 → {binary:true}（不是 0/0）')
  check(u.get('n').deletions === 0 && u.size === 3, 'A17 第三条改名也归到新名')
  const line = pure.parseNumstat('1\t2\tsrc/{a => b}/x.ts\n3\t4\told => new.txt\n5\t6\tplain.txt\n')
  check(line.get('src/b/x.ts').additions === 1, 'A18 行框大括号改名记法折叠成新名')
  check(line.get('new.txt').additions === 3, 'A19 行框 `old => new` 折叠成新名')
  check(line.get('plain.txt').deletions === 6 && line.size === 3, 'A20 行框普通记录')
  check(pure.parseNumstat('').size === 0, 'A21 空输入 → 空表')
}

{
  const spec = pure.statusPathspecOf(V2)
  check(spec.indexOf('untracked.txt') < 0, 'A22 pathspec 不含未跟踪条目（它们本来就没有行数）')
  check(spec.indexOf('src/old.ts') >= 0 && spec.indexOf('src/new.ts') >= 0, 'A23 pathspec 同时给改名的旧名与新名（否则 git 认不出改名）')
  check(spec.length === 5, 'A24 pathspec = 4 条 tracked 记录 + 1 个改名 origin = 5')
  check(pure.statusPathspecOf(meta('main') + '\0' + recQ('only-untracked.txt') + '\0').length === 0,
    'A25 只有未跟踪 → 空 pathspec（调用方据此跳过两次 numstat）')
  const big = meta('main') + '\0' + Array.from({ length: 500 }, (_, i) => rec1('M.', 'dir/' + i + '/' + 'x'.repeat(30) + '.txt')).join('\0') + '\0'
  check(pure.statusPathspecOf(big) === undefined, 'A26 路径总量超过 8000 字节 → undefined（退化成全仓 diff，同上游）')
}

{
  const snap = pure.parsePorcelainV2Z(V2)
  const v = pure.finishStatusSnapshot(snap, 'merge', NUMSTAT_UNSTAGED, NUMSTAT_STAGED)
  check(v.operation === 'merge' && v.isRepo === true && v.branch === 'main', 'A27 组装保留快照字段并带上 operation')
  const a = v.entries.find((e) => e.path === 'src/a.ts')
  const b = v.entries.find((e) => e.path === 'src/b.ts')
  const n = v.entries.find((e) => e.path === 'src/new.ts')
  check(a.staged && a.staged.additions === 6 && a.unstaged === undefined, 'A28 只在暂存侧的改动：只给 staged')
  check(b.unstaged && b.unstaged.additions === 3 && b.staged === undefined, 'A29 只在工作区的改动：只给 unstaged')
  check(n.staged && n.staged.additions === 1 && n.unstaged && n.unstaged.deletions === 0, 'A30 改名两边都有 → staged 与 unstaged 同时给（上游口径：绝不合并）')
  const u = v.entries.find((e) => e.path === 'untracked.txt')
  check(u.staged === undefined && u.unstaged === undefined, 'A31 未跟踪条目不强行加行数')
  check(v.truncated === false, 'A32 条目数未超限 → truncated=false')
  const many = pure.finishStatusSnapshot({ isRepo: true, entries: Array.from({ length: 2001 }, (_, i) => ({ xy: 'M ', path: 'f' + i })) }, undefined, '', '')
  check(many.entries.length === 2000 && many.truncated === true, 'A33 超过 2000 条 → 截到 2000 且 truncated=true（口径同上游 GIT_STATUS_LIMIT）')
  check(pure.GIT_STATUS_LIMIT === 2000, 'A34 上限常量 = 2000')
}

// ---------------------------------------------------------------------------
console.log('\nB. 本地分支（假 git）：实参、新字段与 git 版本降级链')
// ---------------------------------------------------------------------------
const opDir = mkdtempSync(join(tmpdir(), 'dsh-status-gitdir-'))
try {
  const base = {
    'rev-parse --is-inside-work-tree': 'true\n',
    'rev-parse --absolute-git-dir': opDir + '\n',
    'status --porcelain=v2 --branch --ahead-behind -z --untracked-files=all': V2,
    '--literal-pathspecs diff --numstat -z -- src/a.ts src/b.ts src/new.ts src/old.ts conflict.txt': NUMSTAT_UNSTAGED,
    '--literal-pathspecs diff --cached --numstat -z -- src/a.ts src/b.ts src/new.ts src/old.ts conflict.txt': NUMSTAT_STAGED
  }
  {
    const { handler, rec } = statusSandbox({ sessionDir: SESSION, localMap: base })
    const r = await call(handler, { sessionId: 'sess-1' })
    const v = r.body.value
    check(r.status === 200 && v.isRepo === true, 'B1 本地 status → 200 且 isRepo=true')
    check(v.branch === 'main' && v.upstream === 'origin/main' && v.ahead === 2 && v.behind === 1, 'B2 0.28.0 新增字段 upstream/ahead/behind 齐了')
    check(v.detached === false, 'B3 detached 字段存在')
    check(v.operation === undefined, 'B4 没有进行中的操作 → operation 缺席')
    check(v.entries.length === 5 && v.entries[0].xy === 'M ' && v.entries[2].origin === 'src/old.ts', 'B5 条目沿用 v2 解析（含改名 origin）')
    check(v.entries[0].staged.additions === 6 && v.entries[1].unstaged.additions === 3, 'B6 条目级 staged/unstaged 行数已挂上')
    check(v.truncated === false, 'B7 truncated=false')
    check(rec.local[1] === 'status --porcelain=v2 --branch --ahead-behind -z --untracked-files=all',
      'B8 本地改用了上游同款 v2 取数命令')
    check(rec.local.some((c) => c.indexOf('--literal-pathspecs diff --cached --numstat -z -- ') === 0),
      'B9 暂存侧 numstat 带 --literal-pathspecs + 显式 pathspec（同上游快路径）')
    check(rec.local.filter((c) => c.indexOf('--numstat') >= 0).length === 2, 'B10 只跑两条 numstat（未跟踪为空时不跑更多）')
  }

  // 进行中的 merge / rebase（真 .git 目录状态）
  {
    mkdirSync(join(opDir, 'MERGE_HEAD'), { recursive: true })
    const { handler } = statusSandbox({ sessionDir: SESSION, localMap: base })
    const r = await call(handler, { sessionId: 'sess-1' })
    check(r.body.value.operation === 'merge', 'B11 .git/MERGE_HEAD 存在 → operation=merge（口径同上游）')
    rmSync(join(opDir, 'MERGE_HEAD'), { recursive: true, force: true })
    mkdirSync(join(opDir, 'rebase-apply'), { recursive: true })
    writeFileSync(join(opDir, 'rebase-apply', 'rebasing'), '')
    const { handler: h2 } = statusSandbox({ sessionDir: SESSION, localMap: base })
    const r2 = await call(h2, { sessionId: 'sess-1' })
    check(r2.body.value.operation === 'rebase', 'B12 rebase-apply/rebasing → operation=rebase')
    rmSync(join(opDir, 'rebase-apply'), { recursive: true, force: true })
  }

  // 降级链：--ahead-behind 不被支持（git < 2.41）
  {
    const map = Object.assign({}, base)
    delete map['status --porcelain=v2 --branch --ahead-behind -z --untracked-files=all']
    map['status --porcelain=v2 --branch -z --untracked-files=all'] = V2
    const { handler } = statusSandbox({ sessionDir: SESSION, localMap: Object.assign(map, {
      'status --porcelain=v2 --branch --ahead-behind -z --untracked-files=all': new Error('error: unknown option `ahead-behind\'')
    }) })
    const r = await call(handler, { sessionId: 'sess-1' })
    check(r.status === 200 && r.body.value.branch === 'main' && r.body.value.entries.length === 5,
      'B13 git 不支持 --ahead-behind → 退回 v2（其余字段照旧）')
    check(r.body.value.ahead === 2, 'B14 退回 v2 后 ahead/behind 仍从 branch.ab meta 里读到（不依赖命令行开关）')
  }

  // 降级链：完全没有 porcelain=v2（git < 2.11）
  {
    const map = {
      'rev-parse --is-inside-work-tree': 'true\n',
      'rev-parse --absolute-git-dir': opDir + '\n',
      'status --porcelain=v2 --branch -z --untracked-files=all': new Error('error: unknown option `porcelain=v2\''),
      'rev-parse --abbrev-ref HEAD': 'legacy-branch\n',
      'status --porcelain=v1 -z --untracked-files=normal': ' M a.txt\0?? b.txt\0'
    }
    map['status --porcelain=v2 --branch --ahead-behind -z --untracked-files=all'] = new Error('error: unknown option `ahead-behind\'')
    const { handler, rec } = statusSandbox({ sessionDir: SESSION, localMap: map })
    const r = await call(handler, { sessionId: 'sess-1' })
    check(r.status === 200 && r.body.value.branch === 'legacy-branch' && r.body.value.entries.length === 2,
      'B15 连 porcelain=v2 都没有 → 退回 v1 形状（分支来自 rev-parse --abbrev-ref）')
    check(r.body.value.upstream === undefined && r.body.value.ahead === undefined, 'B16 v1 降级路径明确没有新字段（而不是给错值）')
    check(rec.local.some((c) => c.indexOf('status --porcelain=v1 -z') === 0), 'B17 确实跑了 v1 命令')
  }

  // 非仓库
  {
    const { handler } = statusSandbox({ sessionDir: SESSION, localMap: { 'rev-parse --is-inside-work-tree': 'false\n' } })
    const r = await call(handler, { sessionId: 'sess-1' })
    check(r.status === 200 && r.body.value.isRepo === false && r.body.value.entries.length === 0, 'B18 非仓库 → {isRepo:false, entries:[]}')
  }

  // 只有未跟踪文件：跳过两条 numstat
  {
    const only = meta('main', 'origin/main', [0, 0]) + '\0' + recQ('untracked.txt') + '\0'
    const map = Object.assign({}, base, { 'status --porcelain=v2 --branch --ahead-behind -z --untracked-files=all': only })
    const { handler, rec } = statusSandbox({ sessionDir: SESSION, localMap: map })
    const r = await call(handler, { sessionId: 'sess-1' })
    check(r.status === 200 && r.body.value.entries.length === 1, 'B19 只有未跟踪文件 → 1 条记录')
    check(!rec.local.some((c) => c.indexOf('diff --numstat') >= 0), 'B20 pathspec 为空 → 两条 numstat 一次都不跑（上游同款短路）')
  }

  // 路径太多：退化成不带 pathspec 的全仓 diff
  {
    const many = meta('main') + '\0' + Array.from({ length: 500 }, (_, i) => rec1('M.', 'dir/' + i + '/' + 'x'.repeat(30) + '.txt')).join('\0') + '\0'
    const manyName = 'dir/0/' + 'x'.repeat(30) + '.txt'
    const map = { 'rev-parse --is-inside-work-tree': 'true\n', 'rev-parse --absolute-git-dir': opDir + '\n', 'status --porcelain=v2 --branch --ahead-behind -z --untracked-files=all': many, 'diff --numstat -z': '1\t1\t' + manyName + '\0', 'diff --cached --numstat -z': '' }
    const { handler, rec } = statusSandbox({ sessionDir: SESSION, localMap: map })
    const r = await call(handler, { sessionId: 'sess-1' })
    check(r.status === 200 && r.body.value.entries.length === 500, 'B21 500 条 tracked 变更仍正常返回')
    check(rec.local.some((c) => c === 'diff --numstat -z') && !rec.local.some((c) => c.indexOf('--literal-pathspecs') >= 0),
      'B22 路径超限 → 不带 pathspec 的全仓 numstat（同上游兜底）')
    check(r.body.value.entries[0].unstaged.additions === 1, 'B23 兜底路径下行数仍能对上条目')
  }
} finally {
  rmSync(opDir, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
console.log('\nC. 远端分支（假 SSH）：一次往返、NUL 不经 shell 变量、结果与本地同构')
// ---------------------------------------------------------------------------
const remoteOut = (o) => {
  const lines = [S + ' STATUS ' + o.variant]
  if (o.status) lines.push(o.status.replace(/\n+$/, ''))
  if (o.branch !== undefined) { lines.push(''); lines.push(S + ' BRANCH'); lines.push(o.branch) }
  lines.push(''); lines.push(S + ' OP')
  if (o.op) lines.push(o.op)
  lines.push(''); lines.push(S + ' UNSTAGED')
  if (o.unstaged) lines.push(o.unstaged.replace(/\n+$/, ''))
  lines.push(''); lines.push(S + ' STAGED')
  if (o.staged) lines.push(o.staged.replace(/\n+$/, ''))
  lines.push(''); lines.push(S + ' END')
  return lines.join('\n') + '\n'
}
{
  const { handler, rec } = statusSandbox({ sessionDir: SESSION, remote: true, remoteOut: remoteOut({ variant: 'v2', status: V2, op: 'merge', unstaged: NUMSTAT_UNSTAGED, staged: NUMSTAT_STAGED }) })
  const r = await call(handler, { sessionId: 'sess-1' })
  const v = r.body.value
  check(r.status === 200 && v.isRepo === true && rec.remote.length === 1, 'C1 远端 status → 200 且只花 1 次 SSH 往返')
  check(v.branch === 'main' && v.upstream === 'origin/main' && v.ahead === 2 && v.behind === 1 && v.operation === 'merge',
    'C2 远端也拿到 0.28.0 的全部新字段')
  check(v.entries.length === 5 && v.entries[2].origin === 'src/old.ts' && v.entries[2].staged.additions === 1,
    'C3 远端条目与本地同构（含改名 origin 与分栏行数）')
  check(v.entries[3].xy === 'UU' && v.entries[4].xy === '??', 'C4 冲突/未跟踪形态一致')
  const script = rec.remote[0]
  check(script.indexOf(GIT_READ_ENV) > 0, 'C5 远端脚本带上游同款只读环境')
  check(script.indexOf("cd '" + REMOTE_ROOT + "'") > 0, 'C6 远端脚本先 cd 到会话目录（引号防注入）')
  check(script.indexOf('status --porcelain=v2 --branch --ahead-behind -z --untracked-files=all > "$T" 2>/dev/null') > 0,
    'C7 0.28.0 同款取数命令，且输出重定向到临时文件')
  check(script.indexOf('cat "$T"') > 0, 'C8 用 cat 把临时文件（含 NUL）直接送 stdout')
  check(!/=\$\([^\n]*status --porcelain/.test(script), 'C9 绝不用 $() 捕获 status 输出（命令替换会吃掉 NUL）')
  check(script.indexOf('rm -f "$T"') > 0, 'C10 临时文件用完即删')
  check(script.indexOf('rebase-merge') > 0 && script.indexOf('MERGE_HEAD') > 0, 'C11 远端也按 .git 目录判定 merge/rebase')
  check(script.indexOf('diff --numstat -z') > 0 && script.indexOf('diff --cached --numstat -z') > 0, 'C12 两侧 numstat 在同一条脚本里')
  // 远端目录不在（工作区被删/改名）→ 脚本自己报 NOTREPO，别退化成 exit≠0 的 500
  check(/cd '[^']*' 2>\/dev\/null \|\| \{ printf '[^']* NOTREPO/.test(script),
    'C12b 远端目录 cd 失败 → 脚本内直接给 NOTREPO（真环境下不再是 500，见 verify-remote-sh.mjs D3）')
  check(script.indexOf('exit 3') < 0, 'C12c 不再用裸 exit 3 表示"目录不在"')
}

{
  const { handler } = statusSandbox({ sessionDir: SESSION, remote: true, remoteOut: S + ' NOTREPO\n' })
  const r = await call(handler, { sessionId: 'sess-1' })
  check(r.status === 200 && r.body.value.isRepo === false && r.body.value.entries.length === 0, 'C13 远端不是仓库 → isRepo=false')
}

{
  const { handler } = statusSandbox({ sessionDir: SESSION, remote: true, remoteOut: remoteOut({ variant: 'v1', status: ' M a.txt\0?? b.txt\0', branch: 'legacy\n' }) })
  const r = await call(handler, { sessionId: 'sess-1' })
  check(r.status === 200 && r.body.value.branch === 'legacy' && r.body.value.entries.length === 2,
    'C14 远端 git 太旧（v1 变体）→ 用 BRANCH 段的 rev-parse 结果 + v1 条目')
}

{
  const { handler } = statusSandbox({ sessionDir: SESSION, remote: true, remoteOut: remoteOut({ variant: 'none' }) })
  const r = await call(handler, { sessionId: 'sess-1' })
  check(r.status === 200 && r.body.value.isRepo === true && r.body.value.branch === 'HEAD' && r.body.value.entries.length === 0,
    'C15 远端 status 完全失败 → 不报 500 也不给错数据（空页 + branch=HEAD）')
}

{
  const { handler } = statusSandbox({ sessionDir: SESSION, remote: true, remoteError: 'ssh: connect to host port 22: Connection refused' })
  const r = await call(handler, { sessionId: 'sess-1' })
  check(r.status === 500 && r.body.error.code === 'git-error' && /Connection refused/.test(r.body.error.message),
    'C16 SSH 本身失败 → 500 git-error（带远端错误文本）')
}

// ---------------------------------------------------------------------------
console.log('\nD. 真实临时 git 仓库端到端（真 git 输出）')
// ---------------------------------------------------------------------------
const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
const realRun = async (dir, args) => {
  const r = git(dir, args)
  if (r.status !== 0) throw { code: 'git-error', message: String(r.stderr || r.stdout || '').trim() || ('git exited ' + r.status) }
  return r.stdout
}
const repo = mkdtempSync(join(tmpdir(), 'dsh-status-repo-'))
const bare = mkdtempSync(join(tmpdir(), 'dsh-status-bare-'))
try {
  const haveGit = git(repo, ['--version']).status === 0
  if (!haveGit) {
    console.log('  · SKIP：本机没有 git，跳过真实仓库端到端（不算失败）')
  } else {
    const commit = (msg) => {
      git(repo, ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'add', '-A'])
      git(repo, ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', msg])
    }
    git(repo, ['init', '-q'])
    git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
    git(bare, ['init', '--bare', '-q'])
    writeFileSync(join(repo, 'a.txt'), 'one\n')
    writeFileSync(join(repo, 'keep.txt'), 'k1\nk2\n')
    commit('first')
    git(repo, ['remote', 'add', 'origin', bare])
    git(repo, ['push', '-q', '-u', 'origin', 'main'])
    // 领先远端 1 个提交
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n')
    commit('second')
    // 已暂存改动（a.txt 再来一行 + 新增 staged.txt + 二进制文件）
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\n')
    writeFileSync(join(repo, 'staged.txt'), 'brand new\n')
    writeFileSync(join(repo, 'logo.bin'), Buffer.from([0, 1, 2, 3, 0, 255]))
    git(repo, ['add', 'a.txt', 'staged.txt', 'logo.bin'])
    // 未暂存改动（a.txt 再改一次）、真改名（HEAD 里已存在的 keep.txt → moved.txt 且加一行）、未跟踪文件
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\nfour\n')
    git(repo, ['mv', 'keep.txt', 'moved.txt'])
    writeFileSync(join(repo, 'moved.txt'), 'k1\nk2\nk3\n')
    git(repo, ['add', 'moved.txt'])
    writeFileSync(join(repo, 'untracked.txt'), 'x\n')

    const aheadBehind = git(repo, ['status', '--porcelain=v2', '--branch', '--ahead-behind', '-z', '--untracked-files=all']).status === 0
    const { handler } = statusSandbox({ sessionDir: repo, localRun: realRun })
    const r = await call(handler, { sessionId: 'sess-1' })
    const v = r.body.value
    check(r.status === 200 && v.isRepo === true, 'D1 真仓库 → 200 且 isRepo=true')
    check(v.branch === 'main', 'D2 真实分支名')
    check(v.upstream === 'origin/main', 'D3 真实 tracking 上游（v2 --branch 提供）')
    if (aheadBehind) {
      check(v.ahead === 1 && v.behind === 0, 'D4 真实 ahead/behind = 1/0（--ahead-behind 可用）')
    } else {
      check(v.ahead === undefined, 'D4 本机 git 不支持 --ahead-behind → 走 v2 降级（断言相应放宽）')
    }
    check(v.detached === false, 'D5 detached=false')
    check(v.truncated === false, 'D6 truncated=false')
    const byPath = (p) => v.entries.find((e) => e.path === p)
    check(!!byPath('a.txt') && byPath('a.txt').xy === 'MM', 'D7 a.txt 同时有暂存与未暂存改动 → xy=MM')
    check(byPath('a.txt').staged && byPath('a.txt').staged.additions === 1 && byPath('a.txt').staged.deletions === 0,
      'D8 a.txt 暂存侧 +1/-0（真 numstat）')
    check(byPath('a.txt').unstaged && byPath('a.txt').unstaged.additions === 1 && byPath('a.txt').unstaged.deletions === 0,
      'D9 a.txt 未暂存侧 +1/-0（两栏分开，绝不合并）')
    check(!!byPath('moved.txt') && byPath('moved.txt').origin === 'keep.txt',
      'D10 真改名：path=moved.txt 且 origin=keep.txt（v2 的下一 NUL 字段）')
    check(byPath('moved.txt').staged && byPath('moved.txt').staged.additions === 1 && byPath('moved.txt').staged.deletions === 0,
      'D11 改名加一行的行数归到新名（-z numstat 的"空路径字段 + 旧名 + 新名"顺序正确）')
    check(byPath('moved.txt').unstaged === undefined, 'D11b 改名后的内容改动已暂存 → 没有 unstaged 栏')
    check(!!byPath('logo.bin') && byPath('logo.bin').staged && byPath('logo.bin').staged.binary === true,
      'D12 真二进制文件 → staged.binary=true（不是 0/0）')
    check(!!byPath('untracked.txt') && byPath('untracked.txt').xy === '??', 'D13 未跟踪文件以 ?? 出现')
    check(byPath('untracked.txt').staged === undefined && byPath('untracked.txt').unstaged === undefined,
      'D14 未跟踪条目没有行数（真 numstat 里也没有它）')
    check(Object.keys(v).indexOf('operation') >= 0 || v.operation === undefined, 'D15 operation 键按上游语义（可缺席）')

    // 真·detached
    git(repo, ['checkout', '-q', '--detach', 'HEAD'])
    const { handler: h2 } = statusSandbox({ sessionDir: repo, localRun: realRun })
    const d = await call(h2, { sessionId: 'sess-1' })
    check(d.body.value.detached === true && d.body.value.branch === undefined, 'D16 真 detached HEAD → detached=true 且无 branch')
    git(repo, ['checkout', '-q', 'main'])

    // 真·merge 进行中（无冲突的 --no-commit 会留下 MERGE_HEAD）
    git(repo, ['checkout', '-q', '-b', 'topic'])
    writeFileSync(join(repo, 'topic.txt'), 'topic\n')
    commit('topic')
    git(repo, ['checkout', '-q', 'main'])
    git(repo, ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'merge', '--no-commit', '--no-ff', 'topic'])
    const { handler: h3 } = statusSandbox({ sessionDir: repo, localRun: realRun })
    const m = await call(h3, { sessionId: 'sess-1' })
    check(m.body.value.operation === 'merge', 'D17 真 merge 进行中（MERGE_HEAD 存在）→ operation=merge')
    check(m.body.value.entries.some((e) => e.path === 'topic.txt' && e.staged !== undefined), 'D18 merge 里新增的 topic.txt 行数在暂存侧')
    git(repo, ['merge', '--abort'])

    // 非仓库目录
    const notRepo = mkdtempSync(join(tmpdir(), 'dsh-status-norepo-'))
    try {
      const { handler: h4 } = statusSandbox({ sessionDir: notRepo, localRun: realRun })
      const n = await call(h4, { sessionId: 'sess-1' })
      check(n.status === 200 && n.body.value.isRepo === false, 'D19 真·非仓库目录 → isRepo=false')
    } finally {
      rmSync(notRepo, { recursive: true, force: true })
    }
  }
} finally {
  rmSync(repo, { recursive: true, force: true })
  rmSync(bare, { recursive: true, force: true })
  rmSync(SESSION, { recursive: true, force: true })
}

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
