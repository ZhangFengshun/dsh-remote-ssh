/**
 * better-sidebar 0.28.0 新增端点 `git.graph`（提交图分页）的接管 —— 本插件 2.4.32。
 *
 * 为什么必须有这个文件：0.28.0 给 Git 面板加了 `git.graph`，本插件此前只接管到 0.25.0
 * 那一批端点，于是**远程工作区**里客户端会拿本地镜像里的仓库画提交图（与 2.4.18 / 2.4.28
 * 同源的 bug 类：没被拦截的端点静默作用在镜像上）。
 *
 * 覆盖：
 *   A. 上游契约（校验、分页、游标、过期、上限、错误码 → HTTP 码）
 *   B. 本地分支（假 git，逐条断言实参与返回形状）
 *   C. 远端分支（必须只发远端、每次分页 2 次 SSH 往返、根路径映射回镜像）
 *   D. 真实临时 git 仓库端到端（真 git 输出，防"只对着假夹具自证"）
 */
import { readFileSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
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

// 2.4.30（issue #26）的路径判定 helper：sessionCwdFrom 需要它们
const PATH_HELPERS = [
  grab(src, 'function isAbsoluteLocalPath'),
  grab(src, 'function classifyRequestPathSyntax'),
  grab(src, 'function looksLikeRemoteAbsolutePath'),
  grab(src, 'function resolveSessionPath'),
  grab(src, 'function unresolvedPathMessage')
].join('\n')

// git.graph 整段（含纯函数、本地 io、远端 io、镜像根映射）
const GRAPH_BLOCK = (() => {
  const a = src.indexOf('// ---- better-sidebar 0.28.0 新增 git.graph')
  const b = src.indexOf('  async function interceptGitHandler')
  if (a < 0 || b < 0 || b <= a) throw new Error('lib/index.js 里找不到 git.graph 实现段（标记被改动？）')
  return src.slice(a, b)
})()

// 模块级共享件（0.28.0 这一批接管共用）：只读环境常量与原样取出，避免测试里复制一份走样。
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
function makeRes() {
  return { status: 0, body: undefined, raw: undefined, writeHead(s) { this.status = s; return this }, end() { return this }, setHeader() { return this } }
}
function makeCtx(sessionDir) {
  const sessions = { get: (id) => (id === 'sess-1' ? { header: { cwd: sessionDir } } : null) }
  return { get: (n) => (n === 'sessions' ? sessions : null), logger: { debug() {}, warn() {}, error() {} } }
}

const HOST = '<host>'
const USER = '<user>'
const KEY = '<key>'
const REMOTE_ROOT = '/remote/root'
const M = '@@DSH_GG@@'
const OID1 = '1'.repeat(40)
const OID2 = '2'.repeat(40)
const OID3 = '3'.repeat(40)

/**
 * 沙箱：只装 git.graph 相关源码 + interceptGitHandler，git 执行与远端执行全部由外部提供。
 * localRun(dir,args) / pooled(profile,cmd) 分别模拟本机 git 与远端一次 SSH 往返。
 */
function graphSandbox(opts) {
  const rec = { local: [], remote: [] }
  const remote = !!opts.remote
  const localResponses = opts.localResponses || {}
  const localRun = opts.localRun || (async (dir, args) => {
    rec.local.push(args.join(' '))
    const key = args.filter((a) => a !== '--no-replace-objects').join(' ')
    if (localResponses[key] === undefined) return ''
    const v = localResponses[key]
    if (v instanceof Error) throw v
    return v
  })
  const remoteScripts = opts.remoteScripts || []
  const pooled = async (profile, cmd) => {
    rec.remote.push(cmd)
    const i = rec.remote.length - 1
    if (remoteScripts[i] === undefined) return { ok: true, stdout: '', stderr: '' }
    const v = remoteScripts[i]
    if (v instanceof Error) throw v
    if (v && v.ok === false) return { ok: false, stdout: '', stderr: '', error: v.error || 'boom', exitCode: 128 }
    return { ok: true, stdout: v, stderr: '' }
  }
  const handler = new Function(
    'join', 'createHash', 'ctx', 'requestTrust', 'denyRequest', 'writeJson', 'writeOk', 'readJsonBody',
    'runGitLocal', 'runPooled', 'GIT_READ_ENV',
    'matchRemoteWorkspace', 'readRemoteInfoSync', 'getProfile', 'localToRemote',
    PATH_HELPERS + '\n' +
    grab(src, 'function gitReplyFail') + '\n' +
    grab(src, 'function shellQuote') + '\n' +
    grab(src, 'function shellQuotePath') + '\n' +
    grab(src, 'function sessionCwdFrom') + '\n' +
    grab(src, 'function gitContextOf') + '\n' +
    GRAPH_BLOCK + '\n' +
    grab(src, 'async function interceptGitHandler') + '\n' +
    'return interceptGitHandler;'
  )(
    join, createHash, makeCtx(opts.sessionDir), requestTrust, denyRequest, writeJson, writeOk, readJsonBody,
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
  await handler({ method: 'POST', headers: {}, __body: payload }, res, 'graph')
  return res
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------
const REFS = ['refs/heads/main\u0000' + OID1, 'refs/heads/feature\u0000' + OID2, 'refs/remotes/origin/main\u0000' + OID1].join('\n') + '\n'
const REFS_OTHER = ['refs/heads/main\u0000' + OID3, 'refs/remotes/origin/main\u0000' + OID3].join('\n') + '\n'
/** git log --format=%H%x00%P%x00%an%x00%ai%x00%s%x00%B%x00 的输出形状 */
const logOut = (rows) => rows.map((r) => [r.h, r.p, r.an, r.ai, r.s, r.b].join('\u0000') + '\u0000').join('\n') + '\n'
const TWO_COMMITS = logOut([
  { h: OID1, p: OID2, an: 'Alice', ai: '2026-10-17 10:00:00 +0800', s: 'second commit', b: 'second commit\n\nbody two\n' },
  { h: OID2, p: '', an: 'Bob', ai: '2026-10-16 09:00:00 +0800', s: 'first commit', b: 'first commit\n' }
])
/** 远端第一次往返：toplevel + 前后快照 */
const remoteBegin = (repoRoot, refs, head, sym) => [M + ' ROOT ' + repoRoot, M + ' REFS', refs.trimEnd(), M + ' HEAD', head, '', M + ' SYM', sym, '', M + ' END'].join('\n') + '\n'
/** 远端第二次往返：log + 快照 */
const remoteLog = (log, refs, head, sym) => [M + ' LOG', String(log).trimEnd(), '', M + ' REFS', refs.trimEnd(), M + ' HEAD', head, '', M + ' SYM', sym, '', M + ' END'].join('\n') + '\n'

const ROOT_LOCAL = process.platform === 'win32' ? 'C:/work/repo' : '/work/repo'

// ---------------------------------------------------------------------------
console.log('\nA. 本地分支（假 git）：契约与校验')
// ---------------------------------------------------------------------------
const keepDir = mkdtempSync(join(tmpdir(), 'dsh-graph-a-'))
try {
  const okLocal = {
    'rev-parse --show-toplevel': ROOT_LOCAL,
    'for-each-ref --sort=refname --format=%(refname)%00%(objectname) refs/heads/ refs/remotes/': REFS,
    'rev-parse --verify --quiet HEAD': OID1 + '\n',
    'symbolic-ref --quiet HEAD': 'refs/heads/main\n'
  }
  {
    const { handler, rec } = graphSandbox({ sessionDir: keepDir, localResponses: Object.assign({}, okLocal, {
      ['log --topo-order --no-decorate --no-show-signature --encoding=UTF-8 --max-count=51 --skip=0 --format=%H%x00%P%x00%an%x00%ai%x00%s%x00%B%x00 ' + OID1 + ' ' + OID2 + ' --']: TWO_COMMITS
    }) })
    const r = await call(handler, { sessionId: 'sess-1' })
    check(r.status === 200 && r.body.ok === true, 'A1 正常分页 → 200')
    const v = r.body.value
    check(v.isRepo === true && v.root === ROOT_LOCAL, 'A2 isRepo + root = git rev-parse --show-toplevel')
    check(Array.isArray(v.entries) && v.entries.length === 2, 'A3 解析出 2 条提交')
    check(v.entries[0].hash === OID1.slice(0, 7) && v.entries[0].hashFull === OID1, 'A4 hash 取 7 位、hashFull 完整')
    check(v.entries[0].parents.length === 1 && v.entries[0].parents[0] === OID2, 'A5 parents 解析正确')
    check(v.entries[0].author === 'Alice' && v.entries[0].subject === 'second commit' && v.entries[0].date === '2026-10-17 10:00:00 +0800',
      'A6 author/subject/date 逐字段对齐 %an/%s/%ai')
    check(v.entries[0].message.indexOf('body two') > 0, 'A7 message 保留完整 %B')
    check(v.entries[0].refs.indexOf('HEAD') >= 0 && v.entries[0].refs.indexOf('main') >= 0 && v.entries[0].refs.indexOf('origin/main') >= 0,
      'A8 refs 装饰含 HEAD + 本地分支 + 远端跟踪分支')
    check(v.entries[1].parents.length === 0 && v.entries[1].refs.length === 1 && v.entries[1].refs[0] === 'feature',
      'A9 根提交无 parents；它的装饰只有 feature（OID2 正是 feature 的 tip）')
    check(v.branches.length === 3 && v.branches[2].ref === 'refs/remotes/origin/main' && v.branches[2].name === 'origin/main',
      'A10 branches 保序（--sort=refname）且 name 去掉 refs/ 前缀')
    check(/^[a-f0-9]{64}$/.test(v.snapshot), 'A11 snapshot 是 sha256 十六进制（游标校验要求 64 位）')
    check(v.hasMore === false && v.nextCursor === undefined, 'A12 一页装得下 → hasMore=false 且无 nextCursor')
    check(rec.local.length === 8, 'A13 本机路径共 8 次 git 调用（toplevel + 前后各一次 refs/HEAD/symbolic-ref + log）')
    check(rec.local.every((c) => c.indexOf('--no-replace-objects') >= 0 || c === 'rev-parse --show-toplevel'), 'A14 只读命令都带 --no-replace-objects')
  }

  // 分页 + 游标：上游取 limit+1 条来判断 hasMore，所以 count=1 时夹具要回 2 条
  {
    const { handler, rec } = graphSandbox({ sessionDir: keepDir, localResponses: Object.assign({}, okLocal, {
      ['log --topo-order --no-decorate --no-show-signature --encoding=UTF-8 --max-count=2 --skip=0 --format=%H%x00%P%x00%an%x00%ai%x00%s%x00%B%x00 ' + OID1 + ' ' + OID2 + ' --']: TWO_COMMITS
    }) })
    const r = await call(handler, { sessionId: 'sess-1', count: 1 })
    const v = r.body.value
    check(r.status === 200 && v.entries.length === 1 && v.hasMore === true, 'A15 count=1 + limit+1 条 → 截到 1 条且 hasMore=true')
    check(typeof v.nextCursor === 'string' && /^[A-Za-z0-9_-]+$/.test(v.nextCursor), 'A16 nextCursor 是 base64url')
    const cur = JSON.parse(Buffer.from(v.nextCursor, 'base64url').toString('utf8'))
    check(cur.version === 1 && cur.offset === 1 && cur.fingerprint === v.snapshot, 'A17 游标内容 = {version:1, fingerprint=snapshot, offset=limit}')
    check(rec.local.filter((c) => c.indexOf('--skip=') >= 0)[0].indexOf('--skip=0') > 0, 'A18 首页 --skip=0')
  }
  {
    const { handler, rec } = graphSandbox({ sessionDir: keepDir, localResponses: Object.assign({}, okLocal, {
      ['log --topo-order --no-decorate --no-show-signature --encoding=UTF-8 --max-count=2 --skip=1 --format=%H%x00%P%x00%an%x00%ai%x00%s%x00%B%x00 ' + OID1 + ' ' + OID2 + ' --']: logOut([
        { h: OID2, p: '', an: 'Bob', ai: '2026-10-16 09:00:00 +0800', s: 'first commit', b: 'first commit\n' }
      ])
    }) })
    const cur = Buffer.from(JSON.stringify({ version: 1, fingerprint: createHash('sha256').update(JSON.stringify({
      root: ROOT_LOCAL,
      branch: undefined,
      branches: [
        { ref: 'refs/heads/main', name: 'main', hashFull: OID1 },
        { ref: 'refs/heads/feature', name: 'feature', hashFull: OID2 },
        { ref: 'refs/remotes/origin/main', name: 'origin/main', hashFull: OID1 }
      ],
      head: OID1,
      symbolicHead: 'refs/heads/main'
    })).digest('hex'), offset: 1 })).toString('base64url')
    const r = await call(handler, { sessionId: 'sess-1', count: 1, cursor: cur })
    check(r.status === 200 && r.body.value.entries[0].hash === OID2.slice(0, 7), 'A19 指纹匹配的游标 → 第二页拿更老的提交')
    check(rec.local.some((c) => c.indexOf('--skip=1') > 0), 'A20 第二页 --skip=游标 offset')
  }

  // 过期游标：指纹不匹配 → 409，且**不跑 log**
  {
    const { handler, rec } = graphSandbox({ sessionDir: keepDir, localResponses: okLocal })
    const cur = Buffer.from(JSON.stringify({ version: 1, fingerprint: 'f'.repeat(64), offset: 1 })).toString('base64url')
    const r = await call(handler, { sessionId: 'sess-1', cursor: cur })
    check(r.status === 409 && r.body.error.code === 'graph-stale', 'A21 指纹不匹配 → 409 graph-stale（上游口径）')
    check(!rec.local.some((c) => c.indexOf('log --topo') >= 0), 'A22 过期游标不会跑 git log（先比指纹）')
  }

  // 分支过滤
  {
    const { handler, rec } = graphSandbox({ sessionDir: keepDir, localResponses: Object.assign({}, okLocal, {
      ['log --topo-order --no-decorate --no-show-signature --encoding=UTF-8 --max-count=51 --skip=0 --format=%H%x00%P%x00%an%x00%ai%x00%s%x00%B%x00 ' + OID2 + ' --']: logOut([
        { h: OID2, p: '', an: 'Bob', ai: '2026-10-16 09:00:00 +0800', s: 'first commit', b: 'first commit\n' }
      ])
    }) })
    const r = await call(handler, { sessionId: 'sess-1', branch: 'refs/heads/feature' })
    check(r.status === 200 && r.body.value.branches.length === 3, 'A23 指定分支仍返回全部分支列表（上游行为）')
    check(rec.local.some((c) => c.indexOf('log --topo') >= 0 && c.indexOf(OID1) < 0), 'A24 指定分支时 log 只喂该分支 tip（不含 main 的 tip）')
  }

  // 校验失败
  {
    const { handler, rec } = graphSandbox({ sessionDir: keepDir, localResponses: okLocal })
    const cases = [
      [{ sessionId: 'sess-1', branch: 'main' }, 'A25 branch 必须是 refs/heads|remotes 全名 → 400'],
      [{ sessionId: 'sess-1', count: 0 }, 'A26 count=0 → 400'],
      [{ sessionId: 'sess-1', count: 1.5 }, 'A27 count 非整数 → 400'],
      [{ sessionId: 'sess-1', count: '10' }, 'A28 count 非数字 → 400'],
      [{ sessionId: 'sess-1', cursor: '!!!' }, 'A29 游标字符集非法 → 400'],
      [{ sessionId: 'sess-1', cursor: Buffer.from(JSON.stringify({ version: 2, fingerprint: 'a'.repeat(64), offset: 1 })).toString('base64url') }, 'A30 游标 version≠1 → 400'],
      [{ sessionId: 'sess-1', cursor: Buffer.from(JSON.stringify({ version: 1, fingerprint: 'a'.repeat(64), offset: 0 })).toString('base64url') }, 'A31 游标 offset<1 → 400'],
      [{ sessionId: 'sess-1', cursor: Buffer.from('not json').toString('base64url') }, 'A32 游标不是 JSON → 400']
    ]
    for (const [payload, label] of cases) {
      const r = await call(handler, payload)
      check(r.status === 400 && r.body.error.code === 'bad-request' && /graph cursor|Invalid graph|full local or remote-tracking ref|Invalid graph count/.test(r.body.error.message), label)
    }
    check(rec.local.length === 0, 'A33 参数校验失败时不跑任何 git（校验在取快照之前）')
  }

  // 未知分支 / 上限 / 非法 OID / HEAD 解析失败
  {
    const { handler, rec } = graphSandbox({ sessionDir: keepDir, localResponses: okLocal })
    const r = await call(handler, { sessionId: 'sess-1', branch: 'refs/heads/nope' })
    check(r.status === 400 && /Unknown graph branch/.test(r.body.error.message), 'A34 分支不存在 → 400 Unknown graph branch')
    check(!rec.local.some((c) => c.indexOf('log --topo') >= 0), 'A35 分支不存在时不跑 log')
  }
  {
    const many = Array.from({ length: 1001 }, (_, i) => 'refs/heads/b' + i + '\u0000' + OID1).join('\n') + '\n'
    const { handler } = graphSandbox({ sessionDir: keepDir, localResponses: Object.assign({}, okLocal, { 'for-each-ref --sort=refname --format=%(refname)%00%(objectname) refs/heads/ refs/remotes/': many }) })
    const r = await call(handler, { sessionId: 'sess-1' })
    check(r.status === 400 && r.body.error.code === 'graph-limit' && /Too many branches/.test(r.body.error.message), 'A36 分支 >1000 → 400 graph-limit')
  }
  {
    const badRefs = 'refs/heads/main\u0000not-a-hash\n'
    const { handler } = graphSandbox({ sessionDir: keepDir, localResponses: Object.assign({}, okLocal, { 'for-each-ref --sort=refname --format=%(refname)%00%(objectname) refs/heads/ refs/remotes/': badRefs }) })
    const r = await call(handler, { sessionId: 'sess-1' })
    check(r.status === 500 && r.body.error.code === 'git-error', 'A37 refs 输出里不是 OID → 500 git-error（上游 fail 语义）')
  }
  {
    const { handler } = graphSandbox({ sessionDir: keepDir, localResponses: Object.assign({}, okLocal, { 'rev-parse --verify --quiet HEAD': '', 'symbolic-ref --quiet HEAD': '' }) })
    const r = await call(handler, { sessionId: 'sess-1' })
    check(r.status === 500 && r.body.error.code === 'git-error' && /Cannot resolve HEAD/.test(r.body.error.message),
      'A38 解不出 HEAD → 500 git-error（上游这个 fail 传的是 git-error，不是 bad-request）')
  }

  // 空仓库：isRepo=true、空页、不跑 log
  {
    const { handler, rec } = graphSandbox({ sessionDir: keepDir, localResponses: {
      'rev-parse --show-toplevel': ROOT_LOCAL,
      'for-each-ref --sort=refname --format=%(refname)%00%(objectname) refs/heads/ refs/remotes/': '',
      'rev-parse --verify --quiet HEAD': '',
      'symbolic-ref --quiet HEAD': 'refs/heads/main\n'
    } })
    const r = await call(handler, { sessionId: 'sess-1' })
    check(r.status === 200 && r.body.value.isRepo === true && r.body.value.entries.length === 0 && r.body.value.branches.length === 0 && r.body.value.hasMore === false,
      'A39 空仓库（无提交）→ isRepo=true + 空页')
    check(!rec.local.some((c) => c.indexOf('log --topo') >= 0), 'A40 空仓库不跑 git log（上游 tips 为空即跳过）')
  }

  // 不是仓库
  {
    const { handler } = graphSandbox({ sessionDir: keepDir, localResponses: {
      'rev-parse --show-toplevel': new Error('fatal: not a git repository (or any of the parent directories): .git')
    } })
    const r = await call(handler, { sessionId: 'sess-1' })
    check(r.status === 200 && r.body.value.isRepo === false && r.body.value.entries.length === 0 && r.body.value.snapshot === '',
      'A41 非仓库 → {isRepo:false, entries:[], branches:[], hasMore:false, snapshot:""}')
    const cur = Buffer.from(JSON.stringify({ version: 1, fingerprint: 'a'.repeat(64), offset: 1 })).toString('base64url')
    const r2 = await call(handler, { sessionId: 'sess-1', cursor: cur })
    check(r2.status === 409 && r2.body.error.code === 'graph-stale', 'A42 带游标却不是仓库 → 409（上游 graph-stale）')
  }

  // 翻页越过 10000 上限：offset=10000 + limit=1 → 10001 > 10000
  {
    const rows = Array.from({ length: 2 }, () => ({ h: OID1, p: '', an: 'A', ai: 'x', s: 's', b: 'b' }))
    const { handler } = graphSandbox({ sessionDir: keepDir, localResponses: Object.assign({}, okLocal, {
      ['log --topo-order --no-decorate --no-show-signature --encoding=UTF-8 --max-count=2 --skip=10000 --format=%H%x00%P%x00%an%x00%ai%x00%s%x00%B%x00 ' + OID1 + ' ' + OID2 + ' --']: logOut(rows)
    }) })
    const first = await call(handler, { sessionId: 'sess-1' })
    const realCur = Buffer.from(JSON.stringify({ version: 1, fingerprint: first.body.value.snapshot, offset: 10000 })).toString('base64url')
    const r = await call(handler, { sessionId: 'sess-1', count: 1, cursor: realCur })
    check(r.status === 400 && r.body.error.code === 'graph-limit' && /history limit reached/.test(r.body.error.message),
      'A43 offset+limit 越过 10000 → 400 graph-limit')
  }
} finally {
  rmSync(keepDir, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
console.log('\nB. 远端分支（假 SSH）：命令只发远端 + 两次往返 + 根路径回映射')
// ---------------------------------------------------------------------------
const keepDir2 = mkdtempSync(join(tmpdir(), 'dsh-graph-b-'))
try {
  {
    const { handler, rec } = graphSandbox({ sessionDir: keepDir2, remote: true, remoteScripts: [
      remoteBegin(REMOTE_ROOT, REFS, OID1, 'refs/heads/main'),
      remoteLog(TWO_COMMITS, REFS, OID1, 'refs/heads/main')
    ] })
    const r = await call(handler, { sessionId: 'sess-1' })
    const v = r.body.value
    check(r.status === 200 && v.isRepo === true && v.entries.length === 2, 'B1 远端分页 → 200 + 2 条提交')
    check(rec.remote.length === 2, 'B2 一次分页只花 2 次 SSH 往返（toplevel+快照、log+快照）')
    check(v.root === keepDir2, 'B3 root 回映射成本地镜像路径（客户端把它当 repoRoot 比较用）')
    check(rec.remote[0].indexOf("cd '" + REMOTE_ROOT + "'") > 0, 'B4 第一条命令先 cd 到远端会话目录（带引号防注入）')
    check(rec.remote[0].indexOf('--no-replace-objects') > 0 && rec.remote[0].indexOf('rev-parse --show-toplevel') > 0, 'B5 远端 toplevel 用只读口径')
    // 远端目录不在 → 脚本自己报 NOREPO（真环境下是 isRepo=false，不是 500）
    check(/cd '[^']*' 2>\/dev\/null \|\| \{ printf '[^']* NOREPO/.test(rec.remote[0]),
      'B5b 远端目录 cd 失败 → 脚本内直接给 NOREPO（真环境验证见 verify-remote-sh.mjs D4）')
    check(rec.remote[0].indexOf('export LC_ALL=C GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0 GIT_NO_LAZY_FETCH=1') >= 0,
      'B6 远端命令带上游同款只读环境（禁惰性抓取/终端提示）')
    check(rec.remote[0].indexOf('for-each-ref --sort=refname') > 0 && rec.remote[1].indexOf('for-each-ref --sort=refname') > 0,
      'B7 前后各取一次 refs 快照（指纹用于过期检测）')
    check(rec.remote[1].indexOf('--max-count=51') > 0 && rec.remote[1].indexOf('--skip=0') > 0, 'B8 log 参数默认 count=50（max-count=limit+1）')
    check(rec.remote[1].indexOf('--format=') > 0 && rec.remote[1].indexOf('%H%x00%P%x00%an%x00%ai%x00%s%x00%B%x00') > 0, 'B9 log 用上游同款 --format')
    check(rec.remote[1].indexOf(OID1) > 0 && rec.remote[1].indexOf(OID2) > 0 && rec.remote[1].indexOf("'--'") > 0,
      'B10 log 只喂快照算出的 tips，并以 -- 收尾')
    check(rec.remote.every((c) => c.indexOf('/sidebar/') < 0 && c.indexOf('git -C') > 0), 'B11 所有命令都是远端 git（没有本机 git 调用）')
    check(v.entries[0].refs.indexOf('HEAD') >= 0, 'B12 远端装饰同样来自远端 refs')
  }

  // 远端仓库根在工作区之下（子目录）
  {
    const { handler } = graphSandbox({ sessionDir: keepDir2, remote: true, remoteScripts: [
      remoteBegin(REMOTE_ROOT + '/sub', REFS, OID1, 'refs/heads/main'),
      remoteLog(TWO_COMMITS, REFS, OID1, 'refs/heads/main')
    ] })
    const r = await call(handler, { sessionId: 'sess-1' })
    check(r.body.value.root === join(keepDir2, 'sub'), 'B13 远端仓库根在子目录 → 映射成镜像子目录')
  }

  // 远端仓库根在工作区之上（工作区是仓库子目录）
  {
    const { handler } = graphSandbox({ sessionDir: keepDir2, remote: true, remoteScripts: [
      remoteBegin('/remote', REFS, OID1, 'refs/heads/main'),
      remoteLog(TWO_COMMITS, REFS, OID1, 'refs/heads/main')
    ] })
    const r = await call(handler, { sessionId: 'sess-1' })
    check(r.body.value.root === keepDir2, 'B14 远端仓库根在工作区之上 → 退化成镜像根（保证仍是本机路径且跨页稳定）')
  }

  // 远端不是仓库 / 远端失败 / 远端过期
  {
    const { handler } = graphSandbox({ sessionDir: keepDir2, remote: true, remoteScripts: [M + ' NOREPO\n'] })
    const r = await call(handler, { sessionId: 'sess-1' })
    check(r.status === 200 && r.body.value.isRepo === false, 'B15 远端不是仓库（NOREPO 标记）→ isRepo=false')
  }
  {
    const { handler } = graphSandbox({ sessionDir: keepDir2, remote: true, remoteScripts: [M + ' NOREPO\n'] })
    const cur = Buffer.from(JSON.stringify({ version: 1, fingerprint: 'b'.repeat(64), offset: 1 })).toString('base64url')
    const r = await call(handler, { sessionId: 'sess-1', cursor: cur })
    check(r.status === 409 && r.body.error.code === 'graph-stale', 'B16 远端不是仓库 + 游标 → 409')
  }
  {
    const { handler } = graphSandbox({ sessionDir: keepDir2, remote: true, remoteScripts: [{ ok: false, error: 'ssh: connect failed' }] })
    const r = await call(handler, { sessionId: 'sess-1' })
    check(r.status === 500 && r.body.error.code === 'git-error' && /connect failed/.test(r.body.error.message), 'B17 远端命令失败 → 500 git-error（带远端错误文本）')
  }
  {
    const { handler } = graphSandbox({ sessionDir: keepDir2, remote: true, remoteScripts: [
      remoteBegin(REMOTE_ROOT, REFS, OID1, 'refs/heads/main'),
      remoteLog(TWO_COMMITS, REFS_OTHER, OID3, 'refs/heads/main')
    ] })
    const r = await call(handler, { sessionId: 'sess-1' })
    check(r.status === 409 && r.body.error.code === 'graph-stale', 'B18 远端前后快照不一致（分页期间仓库变了）→ 409')
  }
} finally {
  rmSync(keepDir2, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
console.log('\nC. 真实临时 git 仓库端到端（真 git 输出）')
// ---------------------------------------------------------------------------
const realRepo = mkdtempSync(join(tmpdir(), 'dsh-graph-real-'))
const realEmpty = mkdtempSync(join(tmpdir(), 'dsh-graph-empty-'))
const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
/** Windows 下 os.tmpdir() 可能是 8.3 短路径（ADMINI~1），git 返回长路径 —— 比对前先归一。 */
const canonPath = (p) => {
  try { return realpathSync.native(String(p)).replace(/\\/g, '/').toLowerCase() } catch (e) { return String(p).replace(/\\/g, '/').toLowerCase() }
}
const realLocalRun = async (dir, args) => {
  const r = git(dir, args)
  if (r.status !== 0) throw { code: 'git-error', message: String(r.stderr || r.stdout || '').trim() || ('git exited ' + r.status) }
  return r.stdout
}
try {
  const haveGit = git(realRepo, ['--version']).status === 0
  if (!haveGit) {
    console.log('  · SKIP：本机没有 git，跳过真实仓库端到端（不算失败）')
  } else {
    git(realRepo, ['init', '-q'])
    git(realRepo, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
    const commit = (file, content, msg) => {
      writeFileSync(join(realRepo, file), content)
      git(realRepo, ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'add', '-A'])
      git(realRepo, ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', msg])
    }
    commit('a.txt', 'one\n', 'first commit')
    commit('a.txt', 'one\ntwo\n', 'second commit')

    const { handler } = graphSandbox({ sessionDir: realRepo, remote: false, localRun: realLocalRun })
    const r = await call(handler, { sessionId: 'sess-1', count: 10 })
    const v = r.body.value
    check(r.status === 200 && v.isRepo === true, 'C1 真仓库 → 200 且 isRepo=true')
    check(v.entries.length === 2, 'C2 真 git log 解析出 2 条（验证 %x00 分隔与字段顺序）')
    check(v.entries[0].subject === 'second commit' && v.entries[0].author === 'T', 'C3 首条 subject/author 正确')
    check(/^[0-9a-f]{40}$/.test(v.entries[0].hashFull) && v.entries[0].hash === v.entries[0].hashFull.slice(0, 7), 'C4 hash/hashFull 关系正确')
    check(v.entries[0].parents.length === 1 && v.entries[0].parents[0] === v.entries[1].hashFull, 'C5 第二条的 hashFull 是首条的 parent（拓扑正确）')
    check(v.entries[0].refs.indexOf('HEAD') >= 0 && v.entries[0].refs.indexOf('main') >= 0, 'C6 HEAD 与分支装饰来自真实 for-each-ref')
    check(v.entries[1].parents.length === 0, 'C7 根提交无 parent')
    check(v.entries[0].message.indexOf('second commit') >= 0, 'C8 %B 完整消息')
    check(/^[a-f0-9]{64}$/.test(v.snapshot) && v.hasMore === false, 'C9 真指纹 + 一页装得下')
    check(v.branches.some((b) => b.ref === 'refs/heads/main' && b.name === 'main'), 'C10 真实分支列表')
    check(canonPath(v.root) === canonPath(realRepo), 'C11 root = 真实仓库根（Windows 短路径 ADMINI~1 也归一）')

    const p1 = await call(handler, { sessionId: 'sess-1', count: 1 })
    check(p1.body.value.entries.length === 1 && p1.body.value.hasMore === true && typeof p1.body.value.nextCursor === 'string',
      'C12 count=1 → hasMore + nextCursor（真分页）')
    const p2 = await call(handler, { sessionId: 'sess-1', count: 1, cursor: p1.body.value.nextCursor })
    check(p2.status === 200 && p2.body.value.entries[0].subject === 'first commit', 'C13 第二页用游标拿到更老的提交（真实分页闭环）')
    check(p2.body.value.snapshot === p1.body.value.snapshot, 'C14 未变更时两页指纹一致')

    // 真·过期：游标之后仓库多了一个提交
    commit('b.txt', 'x\n', 'third commit')
    const stale = await call(handler, { sessionId: 'sess-1', count: 1, cursor: p1.body.value.nextCursor })
    check(stale.status === 409 && stale.body.error.code === 'graph-stale', 'C15 游标之后仓库变了 → 409（真实过期检测）')

    // 指定分支（refs/heads/main 全名）
    const byBranch = await call(handler, { sessionId: 'sess-1', branch: 'refs/heads/main', count: 5 })
    check(byBranch.status === 200 && byBranch.body.value.entries.length === 3, 'C16 指定 refs/heads/main → 3 条提交')

    // 空仓库（init 但无提交）
    git(realEmpty, ['init', '-q'])
    const { handler: h2 } = graphSandbox({ sessionDir: realEmpty, remote: false, localRun: realLocalRun })
    const e = await call(h2, { sessionId: 'sess-1' })
    check(e.status === 200 && e.body.value.isRepo === true && e.body.value.entries.length === 0 && e.body.value.branches.length === 0,
      'C17 真空仓库 → isRepo=true + 空页（不报错）')

    // 非仓库目录
    const notRepo = mkdtempSync(join(tmpdir(), 'dsh-graph-norepo-'))
    try {
      const { handler: h3 } = graphSandbox({ sessionDir: notRepo, remote: false, localRun: realLocalRun })
      const n = await call(h3, { sessionId: 'sess-1' })
      check(n.status === 200 && n.body.value.isRepo === false, 'C18 真·非仓库目录 → isRepo=false（识别 git 的 fatal 文案）')
    } finally {
      rmSync(notRepo, { recursive: true, force: true })
    }
  }
} finally {
  rmSync(realRepo, { recursive: true, force: true })
  rmSync(realEmpty, { recursive: true, force: true })
}

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
