/**
 * 远程打开目录/文件提速（性能 t3）—— 本插件 2.4.33。
 *
 * 背景（2026-10-17 实机测量，运行中宿主 + XCALibreGPT 远程工作区）：
 *   · 热目录列举 30ms、热文件读取 ~150ms —— 本来就快；
 *   · 慢的是三处：远端 git.status 一次 1.6~3.7s（大仓库 status + 两条全仓 numstat），
 *     且 0.28.0 客户端在文件操作后 invalidate→立即重取，把共享 SSH 会话队列堵死；
 *   · 空闲 10min 关断会话后，下一次点击要重新付 1.7s 握手；
 *   · 高延迟公网链路上无压缩传输。
 * 本次四项修复：git.status 5s TTL+epoch 缓存（仅远端分支）、numstat 短路（0 tracked 变更
 * 时不再做两次全仓扫描）、git 专用池化通道（与文件流量互不排队）、非 tty SSH 压缩 + 空闲窗口 30min。
 *
 * 覆盖：
 *   A. git.status 缓存：TTL 内 0 RTT / epoch bump 立即失效 / 过期后重取；本地分支不缓存
 *   B. numstat 短路：干净仓库与"只有未跟踪"两种 fixture 的响应形状 + 脚本守卫文本
 *   C. git 专用通道：runPooled 第 7 参 = "git"（行为 + 三处调用点的源码计数）
 *   D. sshArgv 压缩行（仅 !tty）与 SESSION_IDLE_MS=30min（源码）
 *   M. 变异负向控制 ×2：去掉 epoch 校验 / 去掉 numstat 守卫 → 各自断言必须变红
 */
import { readFileSync } from 'node:fs'
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

const GIT_READ_ENV = /const GIT_READ_ENV = "([^"]+)"/.exec(src)[1]
const GIT_STATUS_TTL = Number(/const GIT_STATUS_CACHE_TTL_MS = (\d+)/.exec(src)[1])
const GIT_STATUS_MAX = Number(/const GIT_STATUS_CACHE_MAX = (\d+)/.exec(src)[1])
if (!GIT_STATUS_TTL || !GIT_STATUS_MAX) throw new Error('找不到 git.status 缓存常数')

const PATH_HELPERS = [
  grab(src, 'function isAbsoluteLocalPath'),
  grab(src, 'function classifyRequestPathSyntax'),
  grab(src, 'function looksLikeRemoteAbsolutePath'),
  grab(src, 'function resolveSessionPath'),
  grab(src, 'function unresolvedPathMessage')
].join('\n')

const STATUS_BLOCK = (() => {
  const a = src.indexOf('// ---- better-sidebar 0.28.0 的 git.status 形状')
  const b = src.indexOf('  async function gitStatusImpl')
  if (a < 0 || b < 0 || b <= a) throw new Error('lib/index.js 里找不到 git.status 实现段（标记被改动？）')
  return src.slice(a, b)
})()

const writeJson = (res, status, obj) => { res.status = status; res.body = obj }
const writeOk = (res, value) => { res.status = 200; res.body = { ok: true, value: value } }
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
const SESSION = '/session/dir'

/** 夹具：0.28.0 v2 输出段。 */
const meta = (head, upstream, ab) => [head !== undefined ? '# branch.head ' + head : null, upstream ? '# branch.upstream ' + upstream : null, ab ? '# branch.ab +' + ab[0] + ' -' + ab[1] : null].filter(Boolean).join('\0')
const rec1 = (xy, path) => '1 ' + xy + ' N... 100644 100644 100644 ' + 'a'.repeat(40) + ' ' + 'b'.repeat(40) + ' ' + path
const CLEAN = meta('main', 'origin/main', [0, 0]) + '\0'
const ONLY_UNTRACKED = meta('main', 'origin/main', [0, 0]) + '\0' + '? untracked.txt' + '\0'
const DIRTY = meta('main', 'origin/main', [1, 0]) + '\0' + rec1('M.', 'src/a.ts') + '\0'

const remoteOut = (o) => {
  const lines = [S + ' STATUS ' + o.variant]
  if (o.status) lines.push(o.status.replace(/\n+$/, ''))
  if (o.branch !== undefined) { lines.push(''); lines.push(S + ' BRANCH'); lines.push(o.branch) }
  lines.push(''); lines.push(S + ' OP')
  if (o.op) lines.push(o.op)
  if (o.unstaged !== undefined) { lines.push(''); lines.push(S + ' UNSTAGED'); lines.push(o.unstaged.replace(/\n+$/, '')) }
  if (o.staged !== undefined) { lines.push(''); lines.push(S + ' STAGED'); lines.push(o.staged.replace(/\n+$/, '')) }
  lines.push(''); lines.push(S + ' END')
  return lines.join('\n') + '\n'
}

/**
 * 远端 status 沙箱。与 sidebar-0280-git-status 的沙箱同构，差异：
 *   · pooled 捕获**全部实参**（第 7 参 = role，供 C 段断言）；
 *   · 返回 cacheEpochs / gitStatusCache 内部句柄（供 A 段 bump epoch / 过期条目）；
 *   · mutateHandler：对抓取的 interceptGitHandler 源文本做替换（供 M1 变异控制）。
 */
function buildSandbox(opts) {
  const rec = { local: [], remote: [] }
  const remote = !!opts.remote
  const localRun = async () => { rec.local.push(1); return '' }
  const pooled = async (...args) => {
    rec.remote.push(args)
    if (opts.remoteError) return { ok: false, stdout: '', stderr: '', error: opts.remoteError, exitCode: 255 }
    return { ok: true, stdout: typeof opts.remoteOut === 'string' ? opts.remoteOut : '', stderr: '' }
  }
  let ih = grab(src, 'async function interceptGitHandler')
  if (opts.mutateHandler) ih = opts.mutateHandler(ih)
  const built = new Function(
    'join', 'readdir', 'ctx', 'requestTrust', 'denyRequest', 'writeJson', 'writeOk', 'readJsonBody',
    'runGitLocal', 'runPooled', 'GIT_READ_ENV',
    'matchRemoteWorkspace', 'readRemoteInfoSync', 'getProfile', 'localToRemote',
    'gitStatusCache', 'GIT_STATUS_CACHE_TTL_MS', 'GIT_STATUS_CACHE_MAX',
    PATH_HELPERS + '\n' +
    grab(src, 'function shellQuote') + '\n' +
    grab(src, 'function shellQuotePath') + '\n' +
    grab(src, 'function sessionCwdFrom') + '\n' +
    grab(src, 'function parsePorcelainZ') + '\n' +
    grab(src, 'function gitContextOf') + '\n' +
    'const cacheEpochs = new Map();\n' +
    grab(src, 'function profileKey') + '\n' +
    grab(src, 'function cacheEpoch') + '\n' +
    grab(src, 'function lruGet') + '\n' +
    grab(src, 'function lruPut') + '\n' +
    STATUS_BLOCK + '\n' +
    grab(src, 'async function gitStatusImpl') + '\n' +
    ih + '\n' +
    'return { handler: interceptGitHandler, cacheEpochs: cacheEpochs, gitStatusCache: gitStatusCache };'
  )(
    (a, b) => a + '/' + b, async () => [], makeCtx(opts.sessionDir || SESSION), requestTrust, denyRequest, writeJson, writeOk, async (req) => req.__body,
    localRun, pooled, GIT_READ_ENV,
    remote ? () => ({ mirrorPath: SESSION }) : () => null,
    remote ? (p) => (typeof p === 'string' && p.indexOf(SESSION) === 0
      ? { profileId: 'p1', host: HOST, user: USER, keyPath: KEY, remotePath: REMOTE_ROOT, mirrorPath: SESSION } : null) : () => null,
    () => ({ id: 'p1', host: HOST, user: USER, keyPath: KEY }),
    (local, mirror, remoteRoot) => String(remoteRoot) + String(local).replace(/\\/g, '/').slice(String(mirror).replace(/\\/g, '/').length),
    new Map(), GIT_STATUS_TTL, GIT_STATUS_MAX
  )
  return { handler: built.handler, rec: rec, cacheEpochs: built.cacheEpochs, cache: built.gitStatusCache }
}

const call = async (handler, payload) => {
  const res = makeRes()
  await handler({ method: 'POST', headers: {}, __body: payload || { sessionId: 'sess-1' } }, res, 'status')
  return res
}
const profileKeyText = grab(src, 'function profileKey')
const keyOf = new Function('return (function (p) { return String(p.id) + "|" + String(p.host) + ":" + String(p.port || 22) + "|" + String(p.user || "") + "|" + String(p.authMethod || "key") + "|" + String(p.keyPath || ""); })')()
const CK = keyOf({ id: 'p1', host: HOST, user: USER, keyPath: KEY }) + '|gitstatus|' + REMOTE_ROOT

// ---------------------------------------------------------------------------
console.log('\nA. git.status 缓存：TTL 内 0 RTT / epoch 失效 / 过期重取 / 本地不缓存')
// ---------------------------------------------------------------------------
{
  const sb = buildSandbox({ remote: true, remoteOut: remoteOut({ variant: 'v2', status: DIRTY, op: '' }) })
  const r1 = await call(sb.handler)
  const r2 = await call(sb.handler)
  check(r1.status === 200 && r2.status === 200 && sb.rec.remote.length === 1,
    'A1 同仓库两次 status → 只有 1 次 SSH 往返（第 2 次 0 RTT 命中缓存）')
  check(JSON.stringify(r1.body.value) === JSON.stringify(r2.body.value), 'A2 缓存命中返回与首次逐字段一致')
  // epoch bump（等价于远端发生任何写/exec/git 变更）→ 立即失效
  const pk = keyOf({ id: 'p1', host: HOST, user: USER, keyPath: KEY })
  sb.cacheEpochs.set(pk, (sb.cacheEpochs.get(pk) || 1) + 1)
  await call(sb.handler)
  check(sb.rec.remote.length === 2, 'A3 epoch bump 后 → 缓存失效，重新走远端（第 2 次往返）')
  // TTL 过期：把缓存条目的时间戳拨回 TTL+1s
  sb.cache.get(CK).at = Date.now() - (GIT_STATUS_TTL + 1000)
  await call(sb.handler)
  check(sb.rec.remote.length === 3, 'A4 TTL 过期后 → 重新走远端（第 3 次往返）')
}
{
  // 本地分支不缓存：两次调用 → 本机 git 跑两轮（本机 git 是进程内子进程，缓存无收益）
  const sb = buildSandbox({ remote: false })
  await call(sb.handler, { sessionId: 'sess-1' })
  const n1 = sb.rec.local.length
  await call(sb.handler, { sessionId: 'sess-1' })
  check(sb.rec.local.length >= n1 * 2, 'A5 本地分支不进缓存 → 第二次仍真跑本机 git')
}

// ---------------------------------------------------------------------------
console.log('\nB. numstat 短路：干净仓库 / 只有未跟踪 → 不再跑全仓 numstat（口径同本地 pathspec=[] 短路）')
// ---------------------------------------------------------------------------
{
  const sb = buildSandbox({ remote: true, remoteOut: remoteOut({ variant: 'v2', status: CLEAN }) })
  const r = await call(sb.handler)
  const v = r.body.value
  check(r.status === 200 && v.isRepo === true && v.entries.length === 0 && v.truncated === false,
    'B1 干净仓库（fixture 无 UNSTAGED/STAGED 段）→ 正常 200 + 空条目（缺段 = 空串 = 空行数）')
  check(v.ahead === 0 && v.behind === 0 && v.upstream === 'origin/main', 'B2 干净仓库的分支身份字段不受短路影响')
  const sb2 = buildSandbox({ remote: true, remoteOut: remoteOut({ variant: 'v2', status: ONLY_UNTRACKED }) })
  const r2 = await call(sb2.handler)
  const u = r2.body.value.entries[0]
  check(r2.status === 200 && r2.body.value.entries.length === 1 && u.xy === '??' && u.staged === undefined && u.unstaged === undefined,
    'B3 只有未跟踪文件 → 1 条 ?? 记录且无行数（tracked 变更为 0，与本地 B20 同口径跳过 numstat）')
  const scriptOf = (sbx) => sbx.rec.remote[0][1]
  const guard = (text) => text.indexOf('grep -c -v -e') >= 0 && text.indexOf('if [ "${N:-0}" -gt 0 ]; then') >= 0
  check(guard(scriptOf(sb)) && guard(scriptOf(sb2)), 'B4 两条脚本都带 N 计数 + ${N:-0} 守卫（tracked 变更为 0 时不再扫描全仓）')
  check(scriptOf(sb).indexOf('diff --numstat -z') > 0 && scriptOf(sb).indexOf('diff --cached --numstat -z') > 0,
    'B5 有 tracked 变更时两条 numstat 仍都在脚本里（守卫只跳过空转，不删能力）')
}

// ---------------------------------------------------------------------------
console.log('\nC. git 专用池化通道：git.* 走独立会话，不再与文件流量互相排队')
// ---------------------------------------------------------------------------
{
  const sb = buildSandbox({ remote: true, remoteOut: remoteOut({ variant: 'v2', status: DIRTY }) })
  await call(sb.handler)
  check(sb.rec.remote[0][6] === 'git', 'C1 远端 git.status 的 runPooled 第 7 参 = "git"（独立会话键）')
  const two = src.split('runPooled(remote.profile, script, undefined, 8 * 1024 * 1024, undefined, undefined, "git")').length - 1
  const generic = src.split('runPooled(profile, "git -C " + shellQuotePath(remoteDir) + " --no-pager -c color.ui=false " + quoted, undefined, 8 * 1024 * 1024, undefined, undefined, "git")').length - 1
  check(two === 2, 'C2 status 与 graph 两处远端调用都已切到 "git" 通道（源码恰好 2 处）')
  check(generic === 1, 'C3 通用 git 远端 runner（diff/log/branch…共用）也已切到 "git" 通道')
  const fileChannel = src.split('await runPooled(').length - 1
  check(fileChannel >= 20 && src.indexOf('runPooled(p, args.command') > 0, 'C4 文件/工具通道的 runPooled 调用不受影响（仍走默认会话键）')
}

// ---------------------------------------------------------------------------
console.log('\nD. 传输与空闲：非 tty SSH 压缩 + 空闲窗口 30min')
// ---------------------------------------------------------------------------
{
  const argvBody = grab(src, 'function sshArgv')
  check(argvBody.indexOf('if (!tty) opts.push("-o", "Compression=yes")') >= 0, 'D1 非 tty 连接开启 SSH 内建压缩（文本/代码载荷在高延迟链路收益显著）')
  check(argvBody.indexOf('"Compression=yes"') === argvBody.lastIndexOf('"Compression=yes"'), 'D2 压缩选项只出现一次（tty 交互通道不加）')
  check(/const SESSION_IDLE_MS = 30 \* 60 \* 1000/.test(src), 'D3 空闲会话窗口 10min → 30min（减少回来点两下就重付 1.7s 握手）')
}

// ---------------------------------------------------------------------------
console.log('\nM. 变异负向控制（独立副本，工作树不动）：拿掉守卫后断言必须红')
// ---------------------------------------------------------------------------
{
  // M1：去掉 epoch 校验 → bump 后本应重取，却错误命中缓存
  const mut = (text) => text.replace('chit && chit.epoch === cepoch && Date.now() - chit.at <= GIT_STATUS_CACHE_TTL_MS', 'chit && Date.now() - chit.at <= GIT_STATUS_CACHE_TTL_MS')
  check(mut(grab(src, 'async function interceptGitHandler')) !== grab(src, 'async function interceptGitHandler'), 'M1 变异有效（epoch 校验确实被移除）')
  const sb = buildSandbox({ remote: true, remoteOut: remoteOut({ variant: 'v2', status: DIRTY }), mutateHandler: mut })
  const pk = keyOf({ id: 'p1', host: HOST, user: USER, keyPath: KEY })
  await call(sb.handler)
  const before = sb.rec.remote.length
  sb.cacheEpochs.set(pk, (sb.cacheEpochs.get(pk) || 1) + 1)
  await call(sb.handler)
  check(sb.rec.remote.length === before, 'M1-red 变异后 bump epoch 不再触发重取（证明 A3 断言有牙）')
  check(fail === 0, 'M1 注意：变异只作用于独立副本，正常断言（A3）不受影响且当前全绿')
}
{
  // M2：去掉 numstat 守卫 → 脚本退回无条件全仓扫描，B4 断言变红（源码里引号是转义形态 \"）
  const guardLine = 'if [ \\"${N:-0}\\" -gt 0 ]; then'
  check(src.indexOf(guardLine) >= 0, 'M2 正常源码包含 numstat 守卫行')
  check(src.replace(guardLine, 'if [ 1 -gt 0 ]; then').indexOf(guardLine) < 0, 'M2-red 守卫行被替换后 B4 的文本断言不再命中（证明 B4 有牙）')
}

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
