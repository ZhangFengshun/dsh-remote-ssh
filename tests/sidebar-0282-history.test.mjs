/**
 * better-sidebar 0.28.2 新增端点 `git.history`（提交图超分支上限时的分页历史兜底）的接管 —— 本插件 2.4.42。
 *
 * 为什么必须有这个文件：upstream-drift 流水线（每周一对拍上游 @latest）在 2026-11-02 报红 ——
 * 上游 0.28.2 多了 `git.history`，本插件只接管到 0.28.0 的 `git.graph`，于是**远程工作区**里客户端
 * 在提交图分支数超上限、回落到 history 翻页时，会拿本地镜像里的仓库列历史（与 2.4.32 的 git.graph、
 * 2.4.28 的 0.25.0 一批端点同源的静默失效）。
 *
 * 上游口径（0.28.2 lib/index.js 的 gitHistory）：
 *   · 入参 { count = 50, cursor? }；count 安全整数 ≥1，内部上限 200；cursor = base64url(JSON{version:1,fingerprint,offset})。
 *   · 返回 { isRepo, root, entries[{hash,hashFull,parents,author,date,subject,message,refs:[]}], hasMore, snapshot, nextCursor? }。
 *   · 前后各取一次「全量 refs + HEAD + shallow 边界」快照算 sha256；期间变了 → graph-stale(409)；
 *     refs > 100000 / shallow > 1 MiB / 翻页越过 10000 → graph-limit(400)。
 *
 * 覆盖：
 *   A. 本地分支（假 git）：契约、参数形状、快照指纹、分页游标、全部错误码
 *   B. 远端分支（假 SSH）：每页 2 次往返、脚本标记、根路径回映射、NOREPO / 过期 / 超限 / 失败
 *   C. 真实临时 git 仓库端到端（真 git 输出，防"只对着假夹具自证"）
 *   D. 接线与上游对拍（GIT_METHODS 含 history、分发走 gitHistoryPage、与已装上游 handler 键集合对拍）
 */
import { readFileSync, mkdtempSync, rmSync, writeFileSync, realpathSync, mkdirSync } from 'node:fs'
import { stat as statAsync, readFile as readFileAsync } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir, homedir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { existsSync, readdirSync } from 'node:fs'
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

// git.graph + git.history 两段（history 段插在 graph 段之后、interceptGitHandler 之前，
// 且复用 graph 段的 OID/分页常量与日志解析器，所以整段一起装进沙箱）
const GIT_BLOCK = (() => {
  const a = src.indexOf('// ---- better-sidebar 0.28.0 新增 git.graph')
  const b = src.indexOf('  async function interceptGitHandler')
  if (a < 0 || b < 0 || b <= a) throw new Error('lib/index.js 里找不到 git.graph/git.history 实现段（标记被改动？）')
  return src.slice(a, b)
})()
if (GIT_BLOCK.indexOf('// ---- better-sidebar 0.28.2 新增 git.history') < 0) {
  throw new Error('git.history 实现段不在 graph 段与 interceptGitHandler 之间（测试切片假设被破坏）')
}

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
  return { status: 0, body: undefined, writeHead(s) { this.status = s; return this }, end() { return this }, setHeader() { return this } }
}
function makeCtx(sessionDir) {
  const sessions = { get: (id) => (id === 'sess-1' ? { header: { cwd: sessionDir } } : null) }
  return { get: (n) => (n === 'sessions' ? sessions : null), logger: { debug() {}, warn() {}, error() {} } }
}

const HOST = '<host>'
const USER = '<user>'
const KEY = '<key>'
const REMOTE_ROOT = '/remote/root'
const M = '@@DSH_GH@@'
const OID1 = '1'.repeat(40)
const OID2 = '2'.repeat(40)
const OID3 = '3'.repeat(40)

/**
 * 沙箱：装 graph/history 两段源码 + interceptGitHandler，git 与远端执行全部外部提供。
 * localRun(dir,args) / pooled(profile,cmd) 分别模拟本机 git 与远端一次 SSH 往返。
 */
function historySandbox(opts) {
  const rec = { local: [], localRaw: [], remote: [] }
  const remote = !!opts.remote
  const table = opts.localResponses || {}
  const localRun = opts.localRun || (async (dir, args) => {
    const key = args.filter((a) => a !== '--no-replace-objects').join(' ')
    rec.local.push(key)
    rec.localRaw.push(args.join(' '))
    if (table[key] === undefined) return ''
    const v = typeof table[key] === 'function' ? table[key]() : table[key]
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
    'stat', 'readFile', 'resolvePath',
    PATH_HELPERS + '\n' +
    grab(src, 'function gitReplyFail') + '\n' +
    grab(src, 'function shellQuote') + '\n' +
    grab(src, 'function shellQuotePath') + '\n' +
    grab(src, 'function sessionCwdFrom') + '\n' +
    grab(src, 'function gitContextOf') + '\n' +
    GIT_BLOCK + '\n' +
    grab(src, 'async function interceptGitHandler') + '\n' +
    'return interceptGitHandler;'
  )(
    join, createHash, makeCtx(opts.sessionDir), requestTrust, denyRequest, writeJson, writeOk, readJsonBody,
    localRun, pooled, GIT_READ_ENV,
    remote ? () => ({ mirrorPath: opts.sessionDir }) : () => null,
    remote ? (p) => (typeof p === 'string' && p.indexOf(opts.sessionDir) === 0
      ? { profileId: 'p1', host: HOST, user: USER, keyPath: KEY, remotePath: REMOTE_ROOT, mirrorPath: opts.sessionDir } : null) : () => null,
    () => ({ id: 'p1', host: HOST, user: USER, keyPath: KEY }),
    (local, mirror, remoteRoot) => String(remoteRoot) + String(local).replace(/\\/g, '/').slice(String(mirror).replace(/\\/g, '/').length),
    statAsync, readFileAsync, resolvePath
  )
  return { handler, rec }
}

const call = async (handler, payload) => {
  const res = makeRes()
  await handler({ method: 'POST', headers: {}, __body: payload }, res, 'history')
  return res
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------
const REFS_ALL = ['refs/heads/main\u0000' + OID1, 'refs/heads/feature\u0000' + OID2,
  'refs/remotes/origin/main\u0000' + OID1, 'refs/tags/v1\u0000' + OID2].join('\n') + '\n'
const REFS_ALL_OTHER = REFS_ALL + 'refs/heads/new\u0000' + OID3 + '\n'
const logOut = (rows) => rows.map((r) => [r.h, r.p, r.an, r.ai, r.s, r.b].join('\u0000') + '\u0000').join('\n') + '\n'
const TWO_COMMITS = logOut([
  { h: OID1, p: OID2, an: 'Alice', ai: '2026-10-17 10:00:00 +0800', s: 'second commit', b: 'second commit\n\nbody two\n' },
  { h: OID2, p: '', an: 'Bob', ai: '2026-10-16 09:00:00 +0800', s: 'first commit', b: 'first commit\n' }
])
const LOG_ARGS = (maxCount, skip) => 'log --branches --remotes HEAD --topo-order --no-decorate --no-show-signature --encoding=UTF-8 --max-count=' + maxCount + ' --skip=' + skip + ' --format=%H%x00%P%x00%an%x00%ai%x00%s%x00%B%x00 --'
const SNAP_CMDS = ['for-each-ref --sort=refname --format=%(refname)%00%(objectname)', 'rev-parse --verify --quiet HEAD', 'rev-parse --git-path shallow']
const ROOT_LOCAL = process.platform === 'win32' ? 'C:/work/repo' : '/work/repo'

/** 本地一次完整请求的 8 次 git 调用（toplevel + 快照 + log + 快照） */
const localFixture = (extra) => Object.assign({
  'rev-parse --show-toplevel': ROOT_LOCAL,
  [SNAP_CMDS[0]]: REFS_ALL,
  [SNAP_CMDS[1]]: OID1 + '\n',
  [SNAP_CMDS[2]]: '.git/shallow'
}, extra || {})

// ---------------------------------------------------------------------------
console.log('\nA. 本地分支（假 git）：契约、参数、指纹、分页、错误码')
// ---------------------------------------------------------------------------
const keepDir = mkdtempSync(join(tmpdir(), 'dsh-history-a-'))
try {
  {
    const { handler, rec } = historySandbox({ sessionDir: keepDir, localResponses: localFixture({ [LOG_ARGS(51, 0)]: TWO_COMMITS }) })
    const r = await call(handler, { sessionId: 'sess-1' })
    const v = r.body.value
    check(r.status === 200 && r.body.ok === true, 'A1 正常首页 → 200')
    check(v.isRepo === true && v.root === ROOT_LOCAL, 'A2 isRepo + root = rev-parse --show-toplevel')
    check(v.entries.length === 2, 'A3 解析出 2 条提交')
    check(v.entries[0].hash === OID1.slice(0, 7) && v.entries[0].hashFull === OID1 && v.entries[0].parents[0] === OID2,
      'A4 hash/hashFull/parents 与 graph 同形')
    check(v.entries[0].author === 'Alice' && v.entries[0].subject === 'second commit' && v.entries[0].message.indexOf('body two') > 0,
      'A5 author/subject/message 逐字段对齐 %an/%s/%B')
    check(Array.isArray(v.entries[0].refs) && v.entries[0].refs.length === 0, 'A6 history 不带引用装饰（refs 恒为 []，与上游一致）')
    check(/^[a-f0-9]{64}$/.test(v.snapshot), 'A7 snapshot 是 sha256 十六进制')
    check(v.hasMore === false && v.nextCursor === undefined, 'A8 一页装得下 → hasMore=false 且无 nextCursor')
    check(rec.local.length === 8, 'A9 一次请求共 8 次本机 git 调用（toplevel + 前后快照各 3 + log）')
    check(rec.local.filter((c) => c === LOG_ARGS(51, 0)).length === 1, 'A10 log 参数逐字符对齐上游（--branches --remotes HEAD … --）')
    check(rec.localRaw.filter((c) => c.indexOf('--no-replace-objects') < 0 && c !== '--no-replace-objects rev-parse --show-toplevel'
      && c !== 'rev-parse --show-toplevel').length === 0,
      'A11 除 toplevel 外的只读命令都带 --no-replace-objects')
    check(rec.local.filter((c) => c === SNAP_CMDS[0]).length === 2 && rec.local.filter((c) => c === SNAP_CMDS[2]).length === 2,
      'A12 前后各取一次全量 refs 与 shallow 路径（过期检测）')
  }

  {
    const { handler } = historySandbox({ sessionDir: keepDir, localResponses: localFixture({ [LOG_ARGS(2, 0)]: TWO_COMMITS }) })
    const r = await call(handler, { sessionId: 'sess-1', count: 1 })
    const v = r.body.value
    check(r.status === 200 && v.entries.length === 1 && v.hasMore === true, 'A13 count=1 + limit+1 条 → 截到 1 条且 hasMore=true')
    check(typeof v.nextCursor === 'string' && /^[A-Za-z0-9_-]+$/.test(v.nextCursor), 'A14 nextCursor 是 base64url')
    const cur = JSON.parse(Buffer.from(v.nextCursor, 'base64url').toString('utf8'))
    check(cur.version === 1 && cur.offset === 1 && cur.fingerprint === v.snapshot, 'A15 游标 = {version:1, fingerprint=snapshot, offset=limit}')
  }

  {
    const { handler } = historySandbox({ sessionDir: keepDir, localResponses: localFixture({
      [LOG_ARGS(2, 1)]: logOut([{ h: OID2, p: '', an: 'Bob', ai: '2026-10-16 09:00:00 +0800', s: 'first commit', b: 'first commit\n' }])
    }) })
    const fp = createHash('sha256').update(JSON.stringify({
      root: ROOT_LOCAL, refs: REFS_ALL.trimEnd().split('\n'), head: OID1, shallow: null
    })).digest('hex')
    const cursor = Buffer.from(JSON.stringify({ version: 1, fingerprint: fp, offset: 1 })).toString('base64url')
    const r = await call(handler, { sessionId: 'sess-1', count: 1, cursor: cursor })
    check(r.status === 200 && r.body.value.entries[0].subject === 'first commit', 'A16 第二页用游标 → 拿到更老的提交（--skip=1）')
    check(r.body.value.snapshot === fp, 'A17 指纹可被外部按同口径复算（refs+HEAD+shallow 的字符串 join 后 sha256）')
  }

  {
    const { handler } = historySandbox({ sessionDir: keepDir, localResponses: localFixture({ [LOG_ARGS(51, 0)]: TWO_COMMITS }) })
    const bad = Buffer.from(JSON.stringify({ version: 1, fingerprint: 'b'.repeat(64), offset: 1 })).toString('base64url')
    const r = await call(handler, { sessionId: 'sess-1', cursor: bad })
    check(r.status === 409 && r.body.error.code === 'graph-stale' && /History changed/.test(r.body.error.message),
      'A18 游标指纹不匹配 → 409 graph-stale「History changed; refresh」')
  }
  for (const [label, payload] of [
    ['A19 count=0 → 400', { sessionId: 'sess-1', count: 0 }],
    ['A20 count=-1 → 400', { sessionId: 'sess-1', count: -1 }],
    ['A21 count=1.5 → 400', { sessionId: 'sess-1', count: 1.5 }],
    ['A22 count="50" → 400', { sessionId: 'sess-1', count: '50' }]
  ]) {
    const { handler } = historySandbox({ sessionDir: keepDir, localResponses: localFixture({ [LOG_ARGS(51, 0)]: TWO_COMMITS }) })
    const r = await call(handler, payload)
    check(r.status === 400 && r.body.error.code === 'bad-request' && /Invalid history count/.test(r.body.error.message), label + '（Invalid history count）')
  }
  for (const [label, cursor] of [
    ['A23 非 base64url 字符 → 400', '###'],
    ['A24 坏 JSON → 400', Buffer.from('not json').toString('base64url')],
    ['A25 version≠1 → 400', Buffer.from(JSON.stringify({ version: 2, fingerprint: 'a'.repeat(64), offset: 1 })).toString('base64url')],
    ['A26 fingerprint 非 64 hex → 400', Buffer.from(JSON.stringify({ version: 1, fingerprint: 'xyz', offset: 1 })).toString('base64url')],
    ['A27 offset=0 → 400', Buffer.from(JSON.stringify({ version: 1, fingerprint: 'a'.repeat(64), offset: 0 })).toString('base64url')],
    ['A28 offset=10001 → 400', Buffer.from(JSON.stringify({ version: 1, fingerprint: 'a'.repeat(64), offset: 10001 })).toString('base64url')]
  ]) {
    const { handler } = historySandbox({ sessionDir: keepDir, localResponses: localFixture({ [LOG_ARGS(51, 0)]: TWO_COMMITS }) })
    const r = await call(handler, { sessionId: 'sess-1', cursor: cursor })
    check(r.status === 400 && r.body.error.code === 'bad-request' && /Invalid history cursor/.test(r.body.error.message), label)
  }

  {
    // count 超过内部上限 → 按 200 取数（max-count=201）
    const { handler, rec } = historySandbox({ sessionDir: keepDir, localResponses: localFixture({ [LOG_ARGS(201, 0)]: TWO_COMMITS }) })
    const r = await call(handler, { sessionId: 'sess-1', count: 500 })
    check(r.status === 200 && rec.local.indexOf(LOG_ARGS(201, 0)) >= 0, 'A29 count=500 → 内部上限 200（max-count=201）')
  }
  {
    // 非仓库
    const notRepo = Object.assign({}, localFixture(), { 'rev-parse --show-toplevel': new Error('fatal: not a git repository (or any of the parent directories): .git') })
    const { handler } = historySandbox({ sessionDir: keepDir, localResponses: notRepo })
    const r = await call(handler, { sessionId: 'sess-1' })
    check(r.status === 200 && r.body.value.isRepo === false && r.body.value.entries.length === 0, 'A30 非仓库（git fatal 文案）→ 200 isRepo=false 空页')
  }
  {
    const notRepo = Object.assign({}, localFixture(), { 'rev-parse --show-toplevel': new Error('fatal: not a git repository (or any of the parent directories): .git') })
    const { handler } = historySandbox({ sessionDir: keepDir, localResponses: notRepo })
    const cursor = Buffer.from(JSON.stringify({ version: 1, fingerprint: 'a'.repeat(64), offset: 1 })).toString('base64url')
    const r = await call(handler, { sessionId: 'sess-1', cursor: cursor })
    check(r.status === 409 && r.body.error.code === 'graph-stale', 'A31 非仓库 + 游标 → 409（不能静默返回首页）')
  }
  {
    // refs 超过 10 万 → graph-limit
    const many = []
    for (let i = 0; i < 100001; i++) many.push('refs/heads/b' + i + '\u0000' + OID1)
    const { handler } = historySandbox({ sessionDir: keepDir, localResponses: localFixture({ [SNAP_CMDS[0]]: many.join('\n') + '\n' }) })
    const r = await call(handler, { sessionId: 'sess-1' })
    check(r.status === 400 && r.body.error.code === 'graph-limit' && /Too many references/.test(r.body.error.message),
      'A32 refs > 100000 → 400 graph-limit（Too many references）')
  }
  {
    // shallow 边界文件超过 1 MiB → graph-limit
    const bigDir = mkdtempSync(join(tmpdir(), 'dsh-history-shallow-'))
    try {
      mkdirSync(join(bigDir, '.git'), { recursive: true })
      writeFileSync(join(bigDir, '.git', 'shallow'), Buffer.alloc(1048577, 0x61))
      const { handler } = historySandbox({ sessionDir: bigDir, localResponses: Object.assign({}, localFixture(), { 'rev-parse --show-toplevel': bigDir }) })
      const r = await call(handler, { sessionId: 'sess-1' })
      check(r.status === 400 && r.body.error.code === 'graph-limit' && /Shallow boundary metadata exceeds 1 MiB/.test(r.body.error.message),
        'A33 shallow 文件 > 1 MiB → 400 graph-limit')
    } finally {
      rmSync(bigDir, { recursive: true, force: true })
    }
  }
  {
    // shallow 内容参与指纹：同一仓库、只有 shallow 变了 → 指纹必须变
    const shDir = mkdtempSync(join(tmpdir(), 'dsh-history-shallow2-'))
    try {
      mkdirSync(join(shDir, '.git'), { recursive: true })
      writeFileSync(join(shDir, '.git', 'shallow'), 'aaa\n')
      const mk = async () => {
        const { handler } = historySandbox({ sessionDir: shDir, localResponses: Object.assign({}, localFixture(), { 'rev-parse --show-toplevel': shDir }) })
        return (await call(handler, { sessionId: 'sess-1' })).body.value.snapshot
      }
      const fp1 = await mk()
      writeFileSync(join(shDir, '.git', 'shallow'), 'bbb\n')
      const fp2 = await mk()
      check(fp1 !== fp2 && /^[a-f0-9]{64}$/.test(fp1), 'A34 shallow 内容进入指纹（改了 shallow → 指纹变，浅克隆可真过期）')
    } finally {
      rmSync(shDir, { recursive: true, force: true })
    }
  }
  {
    // 前后快照不一致（分页期间仓库变了）→ 409
    let n = 0
    const { handler } = historySandbox({ sessionDir: keepDir, localResponses: Object.assign({}, localFixture({ [LOG_ARGS(51, 0)]: TWO_COMMITS }), {
      [SNAP_CMDS[0]]: () => (n++ === 0 ? REFS_ALL : REFS_ALL_OTHER)
    }) })
    const r = await call(handler, { sessionId: 'sess-1' })
    check(r.status === 409 && r.body.error.code === 'graph-stale', 'A35 前后快照不一致（分页期间新分支）→ 409 graph-stale')
  }
  {
    // 翻页越过 10000 → graph-limit
    const { handler } = historySandbox({ sessionDir: keepDir, localResponses: localFixture({ [LOG_ARGS(2, 10000)]: TWO_COMMITS }) })
    const { handler: first } = historySandbox({ sessionDir: keepDir, localResponses: localFixture({ [LOG_ARGS(51, 0)]: TWO_COMMITS }) })
    const fp = (await call(first, { sessionId: 'sess-1' })).body.value.snapshot
    const cursor = Buffer.from(JSON.stringify({ version: 1, fingerprint: fp, offset: 10000 })).toString('base64url')
    const r = await call(handler, { sessionId: 'sess-1', count: 1, cursor: cursor })
    check(r.status === 400 && r.body.error.code === 'graph-limit' && /History limit reached \(10000\)/.test(r.body.error.message),
      'A36 offset+limit 越过 10000 → 400 graph-limit')
  }
  {
    // 本机 git 失败（非 not-a-repo）→ 500
    const { handler } = historySandbox({ sessionDir: keepDir, localResponses: Object.assign({}, localFixture(), {
      'rev-parse --show-toplevel': new Error('fatal: detected dubious ownership in repository')
    }) })
    const r = await call(handler, { sessionId: 'sess-1' })
    check(r.status === 500 && r.body.error.code === 'git-error' && /dubious ownership/.test(r.body.error.message),
      'A37 非「不是仓库」的 git 失败 → 500 git-error（带原文）')
  }
} finally {
  rmSync(keepDir, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
console.log('\nB. 远端分支（假 SSH）：脚本标记、一次往返取快照、根路径回映射')
// ---------------------------------------------------------------------------
const keepDir2 = mkdtempSync(join(tmpdir(), 'dsh-history-b-'))
const snapSections = (suffix, refs, head, shallow) => [
  M + ' REFS' + suffix, String(refs).trimEnd(), M + ' HEAD' + suffix, head, '', M + ' SHALLOW' + suffix, shallow, '', M + ' SHALLOW_END'
].join('\n')
const remoteBegin = (repoRoot, refs, head, shallow) => [M + ' ROOT ' + repoRoot].concat(snapSections('1', refs, head, shallow)).join('\n') + '\n'
const remoteLog = (log, refs, head, shallow) => [M + ' LOG', String(log).trimEnd(), ''].concat(snapSections('2', refs, head, shallow)).join('\n') + '\n'
try {
  {
    const { handler, rec } = historySandbox({ sessionDir: keepDir2, remote: true, remoteScripts: [
      remoteBegin(REMOTE_ROOT, REFS_ALL, OID1, ''),
      remoteLog(TWO_COMMITS, REFS_ALL, OID1, '')
    ] })
    const r = await call(handler, { sessionId: 'sess-1' })
    const v = r.body.value
    check(r.status === 200 && v.isRepo === true && v.entries.length === 2, 'B1 远端首页 → 200 + 2 条提交')
    check(rec.remote.length === 2, 'B2 每页只花 2 次 SSH 往返（toplevel+快照、log+快照）')
    check(v.root === keepDir2, 'B3 root 回映射成本地镜像路径')
    check(rec.remote[0].indexOf("cd '" + REMOTE_ROOT + "'") > 0, 'B4 第一条命令先 cd 到远端会话目录（带引号防注入）')
    check(/cd '[^']*' 2>\/dev\/null \|\| \{ printf '[^']* NOREPO/.test(rec.remote[0]), 'B5 远端目录不在 → 脚本内 NOREPO（不是 500）')
    check(rec.remote[0].indexOf('export LC_ALL=C GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0 GIT_NO_LAZY_FETCH=1') >= 0, 'B6 带上游同款只读环境')
    check(rec.remote[0].indexOf('for-each-ref --sort=refname') > 0 && rec.remote[0].indexOf('rev-parse --git-path shallow') > 0,
      'B7 远端快照含全量 refs 与 shallow 边界（不是 heads/remotes 子集）')
    check(rec.remote[0].indexOf('refs/heads/ refs/remotes/') < 0, 'B8 远端 for-each-ref 不带 heads/remotes 限定（history 要看全部 refs）')
    check(rec.remote[1].indexOf("'--branches' '--remotes' 'HEAD'") > 0 && rec.remote[1].indexOf('--max-count=51') > 0 && rec.remote[1].indexOf('--skip=0') > 0,
      'B9 远端 log 参数与本地一致（--branches --remotes HEAD，max-count=limit+1，逐个 shellQuote）')
    check(rec.remote.every((c) => c.indexOf('git -C') > 0), 'B10 全部是远端 git（没有本机 git 调用）')
    check(v.entries[0].refs.length === 0, 'B11 远端 entries 同样不带装饰')
  }
  {
    const { handler } = historySandbox({ sessionDir: keepDir2, remote: true, remoteScripts: [M + ' NOREPO\n'] })
    const r = await call(handler, { sessionId: 'sess-1' })
    check(r.status === 200 && r.body.value.isRepo === false, 'B12 远端不是仓库 → isRepo=false')
  }
  {
    const { handler } = historySandbox({ sessionDir: keepDir2, remote: true, remoteScripts: [M + ' NOREPO\n'] })
    const cursor = Buffer.from(JSON.stringify({ version: 1, fingerprint: 'a'.repeat(64), offset: 1 })).toString('base64url')
    const r = await call(handler, { sessionId: 'sess-1', cursor: cursor })
    check(r.status === 409 && r.body.error.code === 'graph-stale', 'B13 远端不是仓库 + 游标 → 409')
  }
  {
    const { handler } = historySandbox({ sessionDir: keepDir2, remote: true, remoteScripts: [
      remoteBegin(REMOTE_ROOT, REFS_ALL, OID1, ''),
      remoteLog(TWO_COMMITS, REFS_ALL_OTHER, OID1, '')
    ] })
    const r = await call(handler, { sessionId: 'sess-1' })
    check(r.status === 409 && r.body.error.code === 'graph-stale', 'B14 远端前后快照不一致 → 409')
  }
  {
    const { handler } = historySandbox({ sessionDir: keepDir2, remote: true, remoteScripts: [
      [M + ' ROOT ' + REMOTE_ROOT, M + ' SHALLOW_TOO_BIG'].join('\n') + '\n'
    ] })
    const r = await call(handler, { sessionId: 'sess-1' })
    check(r.status === 400 && r.body.error.code === 'graph-limit' && /Shallow boundary metadata exceeds 1 MiB/.test(r.body.error.message),
      'B15 远端 shallow 元数据超限 → 400 graph-limit')
  }
  {
    const { handler } = historySandbox({ sessionDir: keepDir2, remote: true, remoteScripts: [{ ok: false, error: 'ssh: connect failed' }] })
    const r = await call(handler, { sessionId: 'sess-1' })
    check(r.status === 500 && r.body.error.code === 'git-error' && /connect failed/.test(r.body.error.message),
      'B16 远端命令失败 → 500 git-error（保留远端错误文本）')
  }
  {
    // shallow 内容在远端也进指纹
    const { handler: h1 } = historySandbox({ sessionDir: keepDir2, remote: true, remoteScripts: [
      remoteBegin(REMOTE_ROOT, REFS_ALL, OID1, 'YWFh'), remoteLog(TWO_COMMITS, REFS_ALL, OID1, 'YWFh')
    ] })
    const { handler: h2 } = historySandbox({ sessionDir: keepDir2, remote: true, remoteScripts: [
      remoteBegin(REMOTE_ROOT, REFS_ALL, OID1, 'YmJi'), remoteLog(TWO_COMMITS, REFS_ALL, OID1, 'YmJi')
    ] })
    const fp1 = (await call(h1, { sessionId: 'sess-1' })).body.value.snapshot
    const fp2 = (await call(h2, { sessionId: 'sess-1' })).body.value.snapshot
    check(fp1 !== fp2, 'B17 远端 shallow 内容参与指纹（aaa 与 bbb 的 base64 应得到不同快照）')
  }
} finally {
  rmSync(keepDir2, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
console.log('\nC. 真实临时 git 仓库端到端（真 git 输出）')
// ---------------------------------------------------------------------------
const realRepo = mkdtempSync(join(tmpdir(), 'dsh-history-real-'))
const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
const canonPath = (p) => {
  try { return realpathSync.native(String(p)).replace(/\\/g, '/').toLowerCase() } catch (e) { return String(p).replace(/\\/g, '/').toLowerCase() }
}
const realLocalRunFactory = (rec) => async (dir, args) => {
  rec.push(args.filter((a) => a !== '--no-replace-objects').join(' '))
  const r = git(dir, args)
  if (r.status !== 0) throw { code: 'git-error', message: String(r.stderr || r.stdout || '').trim() || ('git exited ' + r.status) }
  return r.stdout
}
try {
  if (git(realRepo, ['--version']).status !== 0) {
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
    commit('a.txt', 'one\ntwo\nthree\n', 'third commit')

    const rec = []
    const { handler } = historySandbox({ sessionDir: realRepo, remote: false, localRun: realLocalRunFactory(rec) })
    const r = await call(handler, { sessionId: 'sess-1', count: 10 })
    const v = r.body.value
    check(r.status === 200 && v.isRepo === true, 'C1 真仓库 → 200 且 isRepo=true')
    check(v.entries.length === 3, 'C2 真 git log 解析出 3 条（验证 %x00 分隔与字段顺序）')
    check(v.entries[0].subject === 'third commit' && v.entries[0].author === 'T', 'C3 首条 subject/author 正确')
    check(/^[0-9a-f]{40}$/.test(v.entries[0].hashFull) && v.entries[0].hash === v.entries[0].hashFull.slice(0, 7), 'C4 hash/hashFull 关系正确')
    check(v.entries[0].parents.length === 1 && v.entries[0].parents[0] === v.entries[1].hashFull, 'C5 拓扑正确（首条的 parent 是第二条）')
    check(v.entries.every((e) => e.refs.length === 0), 'C6 history 全部条目无装饰（与上游 refs: [] 一致）')
    check(/^[a-f0-9]{64}$/.test(v.snapshot) && v.hasMore === false, 'C7 真指纹 + 一页装得下')
    check(canonPath(v.root) === canonPath(realRepo), 'C8 root = 真实仓库根（Windows 短路径也归一）')

    const p1 = await call(handler, { sessionId: 'sess-1', count: 2 })
    check(p1.body.value.entries.length === 2 && p1.body.value.hasMore === true && typeof p1.body.value.nextCursor === 'string',
      'C9 count=2 → hasMore + nextCursor（真分页）')
    const p2 = await call(handler, { sessionId: 'sess-1', count: 2, cursor: p1.body.value.nextCursor })
    check(p2.status === 200 && p2.body.value.entries.length === 1 && p2.body.value.entries[0].subject === 'first commit' && p2.body.value.hasMore === false,
      'C10 第二页拿到最后一条且 hasMore=false（真实分页闭环）')
    check(p2.body.value.snapshot === p1.body.value.snapshot, 'C11 未变更时两页指纹一致')

    // 真·过期：游标之后仓库多了一个提交
    commit('b.txt', 'x\n', 'fourth commit')
    const stale = await call(handler, { sessionId: 'sess-1', count: 2, cursor: p1.body.value.nextCursor })
    check(stale.status === 409 && stale.body.error.code === 'graph-stale', 'C12 游标之后仓库变了 → 409（真实过期检测）')

    // 多分支：history 的 log 用 --branches --remotes HEAD，分叉提交也应出现
    git(realRepo, ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'checkout', '-q', '-b', 'side'])
    commit('c.txt', 'side\n', 'side commit')
    git(realRepo, ['checkout', '-q', 'main'])
    const all = await call(handler, { sessionId: 'sess-1', count: 20 })
    const subjects = all.body.value.entries.map((e) => e.subject)
    check(subjects.indexOf('side commit') >= 0, 'C13 别的分支上的提交也出现在 history（--branches）')
  }
} finally {
  rmSync(realRepo, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
console.log('\nD. 接线与上游对拍')
// ---------------------------------------------------------------------------
{
  const m = /const GIT_METHODS = \[([^\]]+)\]/.exec(src)
  const methods = m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : []
  check(methods.indexOf('history') >= 0, 'D1 GIT_METHODS 注册了 history')
  check(methods.indexOf('graph') >= 0 && methods.indexOf('history') > methods.indexOf('graph'), 'D2 history 紧跟 graph（同一批分页端点）')
  check(/case "history":/.test(src) && /gitHistoryPage\(payload, historyRemoteIo\(remote\)\)/.test(src) && /gitHistoryPage\(payload, historyLocalIo\(cwd\)\)/.test(src),
    'D3 分发走 gitHistoryPage：远端 → historyRemoteIo，本地 → historyLocalIo')
  check(GIT_METHODS_REGISTERED(), 'D4 路由注册循环用 GIT_METHODS 逐个 register（新端点自动获得 /sidebar/api/git.history 路由）')
}
function GIT_METHODS_REGISTERED() {
  return /GIT_METHODS\.forEach\(function \(m\) \{[\s\S]{0,200}?path: "\/sidebar\/api\/git\." \+ m/.test(src)
}

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
  console.log('  · SKIP D5-D6：本机没有安装 dsh-better-sidebar，跳过上游对拍（不算失败）')
} else {
  const upKeys = [...new Set([...installed.src.matchAll(/"(fs|git)\.[a-zA-Z-]+"/g)].map((x) => x[0].slice(1, -1)))]
  const m = /const GIT_METHODS = \[([^\]]+)\]/.exec(src)
  const methods = m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : []
  const upGit = upKeys.filter((k) => k.startsWith('git.'))
  const needTakeover = upGit.filter((k) => ['git.models', 'git.commit-model', 'git.suggest-message'].indexOf(k) < 0)
  const missing = needTakeover.filter((k) => methods.indexOf(k.slice(4)) < 0)
  check(upKeys.indexOf('git.history') >= 0, 'D5 上游 better-sidebar@' + installed.version + ' 确实有 git.history（漂移信号成立）')
  check(missing.length === 0, 'D6 上游全部与仓库相关的 git.* 端点都已接管（缺: ' + (missing.join(', ') || '无') + '）')
  console.log('  · 对拍快照：上游 git.* ' + upGit.length + ' 个，其中模型类 3 个不接管')
}

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
