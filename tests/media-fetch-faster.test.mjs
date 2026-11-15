/**
 * 远程文件打开速度优化（2.4.48）回归测试。
 *
 * 背景（本机真机实测，RTT≈70ms）：
 *   · 文本打开走 `fs.read`：1 个 RTT + 5s 内容缓存 → 热路径 ~1.3ms（已够快）；
 *   · 媒体/预览走 `/sidebar/file`：旧实现 stat、base64 **两条命令 = 2 个 RTT**（实测 190ms），
 *     且**没有缓存** —— 同一张图每次重开/重渲染都要再付 2 个 RTT。
 *   · 首次打开还要付一次 SSH 握手（实测 ~1.3s）。
 *
 * 本版修法：
 *   A. `buildFetchBytesCommand`：一次往返同时拿 size/mtime + base64（190ms → 84ms）；
 *   B. `bytesCache` 字节 LRU（TTL 30s、单条 ≤8MiB、总量 ≤64MiB、epoch 感知）→ 重复打开 0 RTT；
 *   C. `/sidebar/file` 加 ETag（size:mtime）+ `cache-control: must-revalidate` → 命中时 304；
 *   D. `warmConnections`（默认开）：插件挂载 2s 后预热每个有远程工作区的 profile，消掉首次 1.3s。
 *
 * 分五段：A 命令形状；B bytesCache + remoteFetchBytes 行为；C /sidebar/file 的 ETag/304；
 *        D 接线与配置；E 变异负向控制。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const src = readFileSync(join(root, 'lib', 'index.js'), 'utf8')

function grab(marker) {
  const start = src.indexOf(marker)
  if (start < 0) throw new Error('源码里找不到: ' + marker)
  let depth = 0
  let i = src.indexOf('{', start)
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) break }
  }
  return src.slice(start, i + 1)
}

let pass = 0
let fail = 0
const check = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label) } else { fail++; console.log('  ✗ FAIL: ' + label) }
}

const DSH_MARK = '__DSH_ST__'

// ─────────────────────── A. 命令形状 ───────────────────────
function cmdSandbox() {
  const bytesBlock = src.slice(src.indexOf('const BYTES_CACHE_TTL_MS'), src.indexOf('function normalizeCachePath'))
  const code = [
    bytesBlock,
    grab('function normalizeCachePath'),
    grab('function lruGet'),
    grab('function lruPut'),
    grab('function shellQuote'), grab('function shellQuotePath'),
    grab('function statFrameSnippet'),
    grab('function errSnippet'),
    grab('function buildFetchBytesCommand'),
    'const DSH_ST_MARK = ' + JSON.stringify(DSH_MARK) + ';',
    'return { buildFetchBytesCommand };'
  ].join('\n')
  return new Function('MAX_BYTES', code)(4 * 1024 * 1024)
}

{
  console.log('A. buildFetchBytesCommand（一次往返 + 超限拒绝）')
  const { buildFetchBytesCommand } = cmdSandbox()
  const cmd = buildFetchBytesCommand('/tmp/图 1.png', 8 * 1024 * 1024)
  check(cmd.includes("stat -c'%s %Y'"), 'A1 内联 stat（不再单独一条命令）')
  check(cmd.includes('base64 -w0 --'), 'A2 内联 base64（与 stat 同一条命令）')
  check(cmd.includes(DSH_MARK + '%s:%s'), 'A3 打印 size:mtime 帧标记')
  check(cmd.includes('file too large (%s bytes)') && cmd.includes('"$sz"'), 'A4 超限走 ERR 帧并带上实际字节数')
  check(!/;\s*base64 -w0 -- "\$f"\s*$/.test(cmd) || cmd.split('base64').length === 2, 'A5 只有一处 base64（不会退化成两趟）')
  check((cmd.match(/stat -c'%s %Y'/g) || []).length === 1, 'A6 只有一处 stat')
  const weird = buildFetchBytesCommand("/tmp/it's here.png", 1024)
  check(weird.startsWith("f='/tmp/it'\\''s here.png'"), 'A7 路径含单引号被正确转义（' + weird.slice(0, 30) + '…）')
}

// ─────────────────────── B. bytesCache + remoteFetchBytes ───────────────────────
function fetchSandbox() {
  const bytesBlock = src.slice(src.indexOf('const BYTES_CACHE_TTL_MS'), src.indexOf('function normalizeCachePath'))
  const code = [
    bytesBlock,
    grab('function normalizeCachePath'),
    grab('function lruGet'),
    grab('function lruPut'),
    grab('function profileKey'),
    'const cacheEpochs = new Map();',
    grab('function cacheEpoch'),
    grab('function bumpCacheEpoch'),
    'const DSH_ST_MARK = ' + JSON.stringify(DSH_MARK) + ';',
    grab('function sanitizeErrLine'),
    grab('function parseStatFrame'),
    grab('function shellQuote'), grab('function shellQuotePath'),
    grab('function statFrameSnippet'),
    grab('function errSnippet'),
    grab('function buildFetchBytesCommand'),
    grab('async function remoteFetchBytes'),
    'return { remoteFetchBytes, bytesCache, bumpCacheEpoch, profileKey };'
  ].join('\n')
  return new Function('MAX_BYTES', 'runPooled', 'Buffer', code)(4 * 1024 * 1024, undefined, Buffer)
}

function makeRunner(payload, opts) {
  const o = opts || {}
  const rec = { calls: 0, cmds: [] }
  const size = o.size !== undefined ? o.size : payload.length
  const mtime = o.mtime !== undefined ? o.mtime : 1770000000
  const frame = o.frame || ('__DSH_ST__' + size + ':' + mtime + '\n' + payload.toString('base64'))
  rec.run = async (profile, cmd) => {
    rec.calls++
    rec.cmds.push(String(cmd))
    if (o.fail) return { ok: false, stdout: '', stderr: 'boom', error: 'boom' }
    return { ok: true, stdout: frame, truncated: false }
  }
  return rec
}

{
  console.log('B. remoteFetchBytes（字节缓存 + 单趟）')
  const payload = Buffer.from('PNGDATA-' + 'x'.repeat(200))
  const box = fetchSandbox()
  const p = { id: 'p1', host: 'h', user: 'u', authMethod: 'key', keyPath: 'k' }
  const runner = makeRunner(payload)
  box.runPooled = runner.run
  const sandbox = new Function('MAX_BYTES', 'runPooled', 'Buffer', [
    src.slice(src.indexOf('const BYTES_CACHE_TTL_MS'), src.indexOf('function normalizeCachePath')),
    grab('function normalizeCachePath'), grab('function lruGet'), grab('function lruPut'),
    grab('function profileKey'), 'const cacheEpochs = new Map();', grab('function cacheEpoch'), grab('function bumpCacheEpoch'),
    'const DSH_ST_MARK = ' + JSON.stringify(DSH_MARK) + ';',
    grab('function sanitizeErrLine'), grab('function parseStatFrame'),
    grab('function shellQuote'), grab('function shellQuotePath'), grab('function statFrameSnippet'), grab('function errSnippet'),
    grab('function buildFetchBytesCommand'), grab('async function remoteFetchBytes'),
    'return { remoteFetchBytes, bytesCache, bumpCacheEpoch, profileKey };'
  ].join('\n'))(4 * 1024 * 1024, runner.run, Buffer)

  const r1 = await sandbox.remoteFetchBytes(p, '/data/a.png', 1024 * 1024)
  check(r1.ok && r1.buffer.equals(payload) && r1.size === payload.length, 'B1 冷读：1 次命令拿到正确字节（size=' + r1.size + '）')
  check(runner.calls === 1 && r1.fromCache === false, 'B2 冷读只发 1 条命令（旧实现是 2 条）')
  const r2 = await sandbox.remoteFetchBytes(p, '/data/a.png', 1024 * 1024)
  check(runner.calls === 1 && r2.fromCache === true, 'B3 第二次同文件：0 次命令（字节缓存命中）')
  check(sandbox.bytesCache.size === 1, 'B4 缓存只留 1 条')
  sandbox.bumpCacheEpoch(p)
  const r3 = await sandbox.remoteFetchBytes(p, '/data/a.png', 1024 * 1024)
  check(runner.calls === 2 && r3.fromCache === false, 'B5 epoch 递增（任意写/exec）→ 立即重取，不吃旧缓存')
  // TTL 过期
  const entry = sandbox.bytesCache.values().next().value
  entry.at = Date.now() - 60 * 1000
  await sandbox.remoteFetchBytes(p, '/data/a.png', 1024 * 1024)
  check(runner.calls === 3, 'B6 TTL 30s 过期 → 重新取一次')
  // 超限
  const big = makeRunner(Buffer.from('x'), { size: 5 * 1024 * 1024 })
  const box2 = new Function('MAX_BYTES', 'runPooled', 'Buffer', [
    src.slice(src.indexOf('const BYTES_CACHE_TTL_MS'), src.indexOf('function normalizeCachePath')),
    grab('function normalizeCachePath'), grab('function lruGet'), grab('function lruPut'),
    grab('function profileKey'), 'const cacheEpochs = new Map();', grab('function cacheEpoch'), grab('function bumpCacheEpoch'),
    'const DSH_ST_MARK = ' + JSON.stringify(DSH_MARK) + ';',
    grab('function sanitizeErrLine'), grab('function parseStatFrame'),
    grab('function shellQuote'), grab('function shellQuotePath'), grab('function statFrameSnippet'), grab('function errSnippet'),
    grab('function buildFetchBytesCommand'), grab('async function remoteFetchBytes'),
    'return { remoteFetchBytes };'
  ].join('\n'))(4 * 1024 * 1024, big.run, Buffer)
  const rb = await box2.remoteFetchBytes(p, '/data/huge.bin', 1024 * 1024)
  check(!rb.ok && /file too large/.test(rb.error), 'B7 超限文件 → 明确报错（不把大文件读进内存）')
  // ERR 帧
  const errRunner = makeRunner(Buffer.alloc(0), { frame: '__DSH_ST__ERR:stat: cannot statx /a.png: No such file or directory' })
  const box3 = new Function('MAX_BYTES', 'runPooled', 'Buffer', [
    src.slice(src.indexOf('const BYTES_CACHE_TTL_MS'), src.indexOf('function normalizeCachePath')),
    grab('function normalizeCachePath'), grab('function lruGet'), grab('function lruPut'),
    grab('function profileKey'), 'const cacheEpochs = new Map();', grab('function cacheEpoch'), grab('function bumpCacheEpoch'),
    'const DSH_ST_MARK = ' + JSON.stringify(DSH_MARK) + ';',
    grab('function sanitizeErrLine'), grab('function parseStatFrame'),
    grab('function shellQuote'), grab('function shellQuotePath'), grab('function statFrameSnippet'), grab('function errSnippet'),
    grab('function buildFetchBytesCommand'), grab('async function remoteFetchBytes'),
    'return { remoteFetchBytes };'
  ].join('\n'))(4 * 1024 * 1024, errRunner.run, Buffer)
  const re = await box3.remoteFetchBytes(p, '/data/none.png', 1024 * 1024)
  check(!re.ok && /No such file/.test(re.error), 'B8 远端 stat 失败 → 原样报错（不吞成空内容）')
  // size 与载荷不符
  const badRunner = makeRunner(Buffer.from('abc'), { size: 999 })
  const box4 = new Function('MAX_BYTES', 'runPooled', 'Buffer', [
    src.slice(src.indexOf('const BYTES_CACHE_TTL_MS'), src.indexOf('function normalizeCachePath')),
    grab('function normalizeCachePath'), grab('function lruGet'), grab('function lruPut'),
    grab('function profileKey'), 'const cacheEpochs = new Map();', grab('function cacheEpoch'), grab('function bumpCacheEpoch'),
    'const DSH_ST_MARK = ' + JSON.stringify(DSH_MARK) + ';',
    grab('function sanitizeErrLine'), grab('function parseStatFrame'),
    grab('function shellQuote'), grab('function shellQuotePath'), grab('function statFrameSnippet'), grab('function errSnippet'),
    grab('function buildFetchBytesCommand'), grab('async function remoteFetchBytes'),
    'return { remoteFetchBytes };'
  ].join('\n'))(4 * 1024 * 1024, badRunner.run, Buffer)
  const rm = await box4.remoteFetchBytes(p, '/data/bad.png', 1024 * 1024)
  check(!rm.ok && /长度不符/.test(rm.error), 'B9 长度与载荷不符 → 报错（防止截断的图片静默渲染）')
}

// ─────────────────────── C. /sidebar/file 的 ETag / 304 ───────────────────────
function fileHandlerSandbox(fetchImpl) {
  const rec = { fetched: [], bodies: [] }
  const ctx = { logger: { debug() {}, warn() {} } }
  const handler = new Function(
    'ctx', 'requestTrust', 'trustErrorMessage', 'writeJson', 'matchRemoteWorkspace', 'readRemoteInfoSync',
    'getProfile', 'localToRemote', 'remoteFetchBytes', 'REMOTE_DOWNLOAD_LIMIT', 'mediaTypeForPath',
    'sessionCwdFrom', 'resolveSessionPath', 'unresolvedPathMessage', 'stat', 'readFile', 'Buffer',
    grab('async function handleSidebarFile') + '\nreturn handleSidebarFile;'
  )(
    ctx, () => 'ok', () => 'denied',
    (res, status, body) => { res.status = status; res.body = JSON.stringify(body) },
    () => ({ id: 'w1', mirrorPath: 'C:/m/w1' }),
    () => ({ profileId: 'p1', remotePath: '/home/u/app' }),
    () => ({ id: 'p1' }),
    (local, mirror, remote) => String(local).replace(mirror, remote).replace(/\\/g, '/'),
    fetchImpl, 64 * 1024 * 1024,
    () => 'image/png',
    () => 'C:/m/w1', () => ({ resolved: true, path: 'C:/m/w1' }), () => '',
    async () => ({ isFile: () => true, size: 1 }), async () => Buffer.from(''), Buffer
  )
  rec.call = async (headers) => {
    const res = { status: 0, body: null, headers: {}, writeHead(s, h) { this.status = s; this.headers = h || {} }, end(b) { this.raw = b } }
    await handler({ method: 'GET', url: '/sidebar/file?sessionId=s1&path=' + encodeURIComponent('C:/m/w1/a.png') + '&cwd=' + encodeURIComponent('C:/m/w1'), headers: headers || {} }, res)
    return res
  }
  return rec
}

{
  console.log('C. /sidebar/file：ETag + 304')
  const payload = Buffer.from('IMGBYTES')
  const h = fileHandlerSandbox(async () => ({ ok: true, buffer: payload, size: payload.length, mtime: 1770000000, fromCache: false }))
  const res1 = await h.call({})
  check(res1.status === 200 && res1.raw && res1.raw.length === payload.length, 'C1 首次 200 + 正确字节')
  check(res1.headers.etag === '"' + payload.length + '-1770000000"', 'C2 ETag = "size-mtime"（' + res1.headers.etag + '）')
  check(/must-revalidate/.test(res1.headers['cache-control']), 'C3 cache-control 允许浏览器缓存校验')
  check(res1.headers['content-length'] === String(payload.length), 'C4 带 content-length')
  const res2 = await h.call({ 'if-none-match': res1.headers.etag })
  check(res2.status === 304 && !res2.raw, 'C5 相同 ETag → 304 且无正文（0 字节传输）')
  const res3 = await h.call({ 'if-none-match': '"999-1"' })
  check(res3.status === 200, 'C6 ETag 不匹配 → 仍返回 200')
}

// ─────────────────────── D. 接线 / 配置 ───────────────────────
{
  console.log('D. 接线与配置')
  check(/warmConnections: z\.boolean\(\)\.default\(true\)/.test(src), 'D1 设置项 warmConnections（默认开）')
  check(/warmConnections: prefsScalar\(true/.test(src), 'D2 prefs 读取回 warmConnections')
  check(/const warmTimer = setTimeout\(/.test(src) && /warmConnections === false/.test(src), 'D3 预热逻辑存在且可关闭')
  check(/warmTimer\.unref/.test(src), 'D4 预热定时器 unref（不阻止宿主退出）')
  check(/DSH_REMOTE_SSH_WARM === "0"/.test(src), 'D4b 预热可用环境变量 DSH_REMOTE_SSH_WARM=0 关闭')
  check(/buildFetchBytesCommand\(remotePath, limit\)/.test(src), 'D5 remoteFetchBytes 用合并命令')
  check(!/stat -c%s " \+ shellQuotePath/.test(src), 'D6 旧的「先 stat 再 base64」两趟实现已移除')
  check(/bytesCacheDrop\(pk, target/.test(src), 'D7 写/删/移时同步失效字节缓存')
  check(/for \(const k of Array\.from\(bytesCache\.keys\(\)\)\)/.test(src), 'D8 整 profile 清理时清字节缓存')
  check(/etag/.test(grab('async function handleSidebarFile')), 'D9 handleSidebarFile 发送 ETag')
}

// ─────────────────────── E. 变异负向控制 ───────────────────────
{
  console.log('E. 变异控制')
  // 同一个沙箱构建器：允许从任意源码文本（含变异版）里取函数
  const grabIn = (text, marker) => {
    const s = text.indexOf(marker)
    if (s < 0) throw new Error('变异源码里找不到: ' + marker)
    let depth = 0
    let k = text.indexOf('{', s)
    for (; k < text.length; k++) {
      if (text[k] === '{') depth++
      else if (text[k] === '}') { depth--; if (depth === 0) break }
    }
    return text.slice(s, k + 1)
  }
  const build = (text, runner) => new Function('MAX_BYTES', 'runPooled', 'Buffer', [
    text.slice(text.indexOf('const BYTES_CACHE_TTL_MS'), text.indexOf('function normalizeCachePath')),
    grabIn(text, 'function normalizeCachePath'), grabIn(text, 'function lruGet'), grabIn(text, 'function lruPut'),
    grabIn(text, 'function profileKey'), 'const cacheEpochs = new Map();', grabIn(text, 'function cacheEpoch'), grabIn(text, 'function bumpCacheEpoch'),
    'const DSH_ST_MARK = ' + JSON.stringify(DSH_MARK) + ';',
    grabIn(text, 'function sanitizeErrLine'), grabIn(text, 'function parseStatFrame'),
    grabIn(text, 'function shellQuote'), grabIn(text, 'function shellQuotePath'),
    grabIn(text, 'function statFrameSnippet'), grabIn(text, 'function errSnippet'),
    grabIn(text, 'function buildFetchBytesCommand'), grabIn(text, 'async function remoteFetchBytes'),
    'return { remoteFetchBytes, bytesCache };'
  ].join('\n'))(4 * 1024 * 1024, runner.run, Buffer)

  const payload = Buffer.from('Y'.repeat(16))
  const p0 = { id: 'p1', host: 'h', user: 'u', authMethod: 'key', keyPath: 'k' }

  // 健康版本：第二次 0 命令
  {
    const r = makeRunner(payload)
    const box = build(src, r)
    await box.remoteFetchBytes(p0, '/m/a.png', 1024 * 1024)
    await box.remoteFetchBytes(p0, '/m/a.png', 1024 * 1024)
    check(r.calls === 1, 'E1 健康版本：两次读只发 1 条命令（对照组）')
  }
  // 变异：去掉 bytesCachePut → 第二次仍发命令（说明 B3 的「0 命令」断言能抓到回归）
  {
    const brokenSrc = src.replace('bytesCachePut(pk, remotePath, { buffer: buf, size: fr.size, mtime: fr.mtime, epoch: epoch, at: Date.now() });', 'void 0;')
    check(brokenSrc !== src, 'E2 变异：删掉 bytesCachePut 写入')
    const r = makeRunner(payload)
    const box = build(brokenSrc, r)
    await box.remoteFetchBytes(p0, '/m/a.png', 1024 * 1024)
    await box.remoteFetchBytes(p0, '/m/a.png', 1024 * 1024)
    check(r.calls >= 2, 'E3 变异版第二次仍发命令（缓存断言确实有效，' + r.calls + ' 次）')
  }
}

console.log('')
console.log('  结果: ' + pass + ' 通过, ' + fail + ' 失败')
if (fail > 0) process.exitCode = 1