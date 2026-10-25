// 同步安全回归测试（issue #20）。
//
// 背景（issue #20 用真实函数 + 真实子进程在有界 fixture 上观测到）：
//   1. `remoteSyncDown` **先 `rm -rf` 镜像、再全树 tar** —— 拉取一旦失败，镜像里那批
//      「只存在于本地」的文件（>4 MiB 的写入被 MAX_BYTES 守卫拦下、宿主只打了一行 warn）
//      就被永久销毁，且没有任何提示；
//   2. 两个方向都只 tar 一个 `.`：没有 exclude、没有子路径、没有体积上限；
//   3. `remoteSyncUp` 会把镜像根里由插件自己写的 `README.md` / `.remote-ssh.json`
//      一并解到**远端根目录**。
//
// 本测试抽出真实的实现区（helpers + remoteSyncDown + remoteSyncUp），注入真实 fs 与
// 可编排的假 spawnOne / 假 runner，逐条验证：体积哨兵早于任何删除、失败不毁镜像、
// 「仅存在于镜像」保护、原子替换与占位文件恢复、push 排除插件自有文件、范围控制的
// 越界丢弃、以及四处入口/工具 schema 的静态防线。
import { readFileSync, mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { mkdir, rm, rename, cp, readdir, stat, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const src = readFileSync(root + '/lib/index.js', 'utf8')

function grab(name) {
  const start = src.indexOf(name)
  if (start < 0) throw new Error(name + ' not found')
  const declStart = src.lastIndexOf('\n', start)
  let i = src.indexOf('{', start)
  let depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) break }
  }
  return src.slice(declStart + 1, i + 1)
}

let pass = 0, fail = 0
const check = (cond, label) => { if (cond) { pass++; console.log('  ✓ ' + label) } else { fail++; console.log('  ✗ FAIL: ' + label) } }

// ---- 抽出同步实现区：常量块 + `function syncErrText` … `remoteSyncUp` 结束 ----
const constStart = src.indexOf('const SYNC_MAX_BYTES_DEFAULT')
const constEnd = src.indexOf('\n', src.indexOf('const MIRROR_README_SENTINEL')) + 1
const paxConstStart = src.indexOf('const SYNC_PAX_MIN_ARGS')
const paxConstEnd = src.indexOf('\n', src.indexOf('const syncPaxCache')) + 1
const paxPrefSrc = grab('function resolveSyncPaxPref')
const regionStart = src.indexOf('function syncErrText(')
const upIdx = src.indexOf('async function remoteSyncUp(')
const upSrc = grab('async function remoteSyncUp')
const regionEnd = upIdx >= 0 ? src.indexOf(upSrc, upIdx) + upSrc.length : -1
if (constStart < 0 || regionStart < 0 || regionEnd <= regionStart) {
  console.log('  ✗ FAIL: 未能抽出同步实现区（常量 + syncErrText … remoteSyncUp）')
  process.exit(1)
}
const syncRegion = src.slice(constStart, constEnd) + '\n' + src.slice(paxConstStart, paxConstEnd) + '\n' + paxPrefSrc + '\n' + src.slice(regionStart, regionEnd)
const downSrc = grab('async function remoteSyncDown')
const upSrcOnly = upSrc
// 用**真实**的 shellQuote（而不是测试自己的近似实现）：issue #22 恰恰是"引号该不该加"的问题，
// 用桩去断言桩没有意义。
const realShellQuote = new Function('return ' + grab('function shellQuote'))()
// 同理：乱码名预测也用真实实现（它决定"哪些文件算旧版本乱码"，用桩断言桩没有意义）
const h0Moji = new Function('return ' + grab('function mojibakeName'))()

const PROFILE = { id: 'p1', name: 'hpc-a', host: 'hpc-a.example.com', port: 22, user: 'user', keyPath: '/k' }
const PLACEHOLDER_README = '# 🌐 Remote Workspace / 远程工作区\n\n- Profile: hpc-a\n'

/** 临时镜像目录（父目录下再放一个 mirror/，便于检查 tmp/old 残留）。 */
async function withMirror(files, fn) {
  const parent = mkdtempSync(join(tmpdir(), 'rssh-sync-'))
  const mirror = join(parent, 'mirror')
  mkdirSync(mirror, { recursive: true })
  for (const [rel, content] of Object.entries(files || {})) {
    const full = join(mirror, rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
  try { return await fn(mirror, parent) } finally { rmSync(parent, { recursive: true, force: true }) }
}

async function materialize(root0, tree) {
  for (const [rel, content] of Object.entries(tree || {})) {
    const full = join(root0, rel)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, content, 'utf8')
  }
}

function leftovers(parent) {
  return readdirSync(parent).filter((n) => n.indexOf('.dsh-sync-tmp-') === 0 || n.indexOf('.dsh-sync-old-') === 0)
}

/** 只看体积探测那一类 runner 调用（PAX 能力探针也走 runner，issue #22）。 */
const duCalls = (x) => x.runnerCalls.filter((c) => /du -sb -c --/.test(c.cmd))
const paxCalls = (x) => x.runnerCalls.filter((c) => /^tar /.test(c.cmd))

/** 构造被测函数：注入真实 fs + 可编排的假 spawnOne / 假 runner。 */
function build(opts) {
  const o = opts || {}
  const spawns = []          // 每次 spawn 的 { role, argv, remoteCmd }
  const rmCalls = []         // rm 的目标（顺序 = 调用顺序；哨兵测试断言它是空的）
  const runnerCalls = []     // 体积探测命令
  const cleared = []         // clearCachesForProfile 调用
  const terminated = []      // 被超时终止的进程角色
  const errText = {}
  const loggedRm = async (target, opt2) => { rmCalls.push(String(target)); return rm(target, opt2) }

  const spawnOne = (subprocess, argv, stdio) => {
    const role = argv[0] === 'ssh' ? 'ssh' : (argv[1] === 'xf' ? 'extract' : 'localTar')
    spawns.push({ role, argv, remoteCmd: role === 'ssh' ? argv[argv.length - 1] : '' })
    const isFail = o.failRole === role
    const isHang = o.hangRole === role
    let resolveDone
    const done = new Promise((res) => { resolveDone = res })
    const handle = {
      __role: role,
      stdout: { pipe: () => {} },
      stdin: {},
      terminate: () => { terminated.push(role); resolveDone({ exitCode: 143 }) },
      done: done,
    }
    if (isHang) return handle
    const run = async () => {
      if (role === 'extract') {
        if (isFail) { errText.extract = 'tar: unexpected EOF in archive'; return { exitCode: o.failCode || 2 } }
        await materialize(argv[argv.length - 1], o.remoteTree || {})
        return { exitCode: 0 }
      }
      if (isFail) {
        errText[role] = role === 'ssh' ? 'ssh: connect to host hpc-a.example.com port 22: Connection refused' : 'tar: ./x: Cannot open: Permission denied'
        return { exitCode: o.failCode || (role === 'ssh' ? 255 : 2) }
      }
      return { exitCode: 0 }
    }
    run().then(resolveDone)
    return handle
  }

  const runner = async (p, cmd, stdinData, maxBytes, split, timeoutMs) => {
    runnerCalls.push({ cmd, timeoutMs })
    // PAX 能力探针（issue #22）：两条阶梯命令都走这里；o.pax === false 表示远端 tar 不支持
    if (/^tar /.test(String(cmd))) {
      const ok = o.pax !== false
      return { ok: ok, stdout: "", stderr: ok ? "" : "tar: unrecognized option '--format=pax'", exitCode: ok ? 0 : 2 }
    }
    if (o.probe) return o.probe
    return { ok: true, stdout: String(o.probeBytes === undefined ? 2048 : o.probeBytes) + '\n', exitCode: 0 }
  }

  const readCollected = (h) => errText[h && h.__role] || ''
  const fns = new Function(
    'process', 'rm', 'mkdir', 'rename', 'cp', 'readdir', 'stat', 'readFile', 'writeFile', 'existsSync',
    'join', 'dirname', 'basename', 'spawnOne', 'readCollected', 'sshArgv', 'shellQuote', 'shellQuotePath',
    'clearCachesForProfile', 'remoteWorkspaceReadme',
    syncRegion + '\nreturn { remoteSyncDown: remoteSyncDown, remoteSyncUp: remoteSyncUp, scanMirrorOnly: scanMirrorOnly, formatSyncBytes: formatSyncBytes, syncOptsFrom: syncOptsFrom, syncTarExcludes: syncTarExcludes, syncTarPaths: syncTarPaths, mojibakeName: mojibakeName, scanMojibakePairs: scanMojibakePairs, probeRemotePax: probeRemotePax, syncPaxPrefix: syncPaxPrefix, resolveSyncPaxPref: resolveSyncPaxPref, syncPaxCache: syncPaxCache };'
  )(
    process, loggedRm, mkdir, rename, cp, readdir, stat, readFile, writeFile, existsSync,
    join, dirname, basename, spawnOne, readCollected,
    (p, cmd) => ({ argv: ['ssh', '-o', 'BatchMode=yes', p.user + '@' + p.host, cmd], env: undefined }),
    realShellQuote, (s) => "'" + String(s) + "'",
    (p) => { cleared.push(p.id) },
    (n, rp) => '# 🌐 Remote Workspace / 远程工作区\n\n- Profile: ' + n + '\n- Root: ' + rp + '\n'
  )
  fns.syncPaxCache.clear()   // 探针结果按 profile 缓存 —— 每个 build 从干净状态开始
  return { spawns, rmCalls, runnerCalls, cleared, terminated, runner, fns }
}

console.log('A · 体积哨兵严格早于任何删除动作')
{
  await withMirror({ 'only-local.txt': 'x' }, async (mirror) => {
    const h = build({ probeBytes: 5 * 1024 * 1024 * 1024 })
    const r = await h.fns.remoteSyncDown(null, h.runner, PROFILE, '~/proj-root', mirror, {})
    check(r.ok === false, '远端超过上限 → 拒绝')
    check(/超过同步上限/.test(r.error), '拒绝理由说明上限（实际：' + String(r.error).slice(0, 60) + '…）')
    check(duCalls(h).length === 1 && /du -sb -c --/.test(duCalls(h)[0].cmd), '先探测体积（du -sb -c）')
    check(h.rmCalls.length === 0, '哨兵阶段**没有任何 rm 调用**（旧实现这时已经 rm -rf 过镜像了）')
    check(h.spawns.length === 0, '被拒时连 tar 都没有启动')
    check(existsSync(join(mirror, 'only-local.txt')), '镜像内容原样保留')
  })
}
{
  await withMirror({ 'only-local.txt': 'x' }, async (mirror) => {
    const h = build({ probe: { ok: false, isTimeout: true } })
    const r = await h.fns.remoteSyncDown(null, h.runner, PROFILE, '~/proj-root', mirror, {})
    check(r.ok === false && /探测超时/.test(r.error), '探测超时 → 保守拒绝（措辞：' + String(r.error).slice(0, 40) + '…）')
    check(h.rmCalls.length === 0, '探测超时同样不删任何东西')
  })
}
{
  await withMirror({}, async (mirror) => {
    const h = build({ probe: { ok: true, stdout: 'du: cannot access /x\n' } })
    const r = await h.fns.remoteSyncDown(null, h.runner, PROFILE, '~/proj-root', mirror, {})
    check(r.ok === false && /du 输出无法解析/.test(r.error), 'du 输出不可解析 → 拒绝')
    const h2 = build({ probe: { ok: false, reason: 'failed', detail: 'du: command not found' } })
    const r2 = await h2.fns.remoteSyncDown(null, h2.runner, PROFILE, '~/proj-root', mirror, {})
    check(r2.ok === false && /du 不可用/.test(r2.error), '远端无 du → 拒绝（说明原因）')
  })
}
{
  await withMirror({}, async (mirror) => {
    const h = build({ probeBytes: 5 * 1024 * 1024 * 1024, remoteTree: { 'src/a.txt': 'A' } })
    const r = await h.fns.remoteSyncDown(null, h.runner, PROFILE, '~/proj-root', mirror, { force: true })
    check(h.runnerCalls.filter((c) => /du -sb/.test(c.cmd)).length === 0, 'force: true → 跳过体积探测')
    check(r.ok === true, 'force: true → 继续执行并成功（用户显式承担全量复制）')
    check(existsSync(join(mirror, 'src', 'a.txt')), 'force 时镜像被替换为远端内容')
  })
}
{
  await withMirror({}, async (mirror) => {
    const h = build({ probeBytes: 2048, remoteTree: { 'a.txt': 'A' } })
    const r = await h.fns.remoteSyncDown(null, h.runner, PROFILE, '~/proj-root', mirror, {})
    check(r.ok === true && r.bytes === 2048, '正常路径回传 bytes（供 render 显示体积）')
    const h2 = build({ probeBytes: 1000 })
    const r2 = await h2.fns.remoteSyncDown(null, h2.runner, PROFILE, '~/proj-root', mirror, { maxBytes: 999 })
    check(r2.ok === false && /超过同步上限/.test(r2.error), 'maxBytes 逐次覆盖生效（1000 > 999）')
  })
}
{
  await withMirror({}, async (mirror) => {
    const h = build({ probeBytes: 1024, remoteTree: { 'src/a.txt': 'A' } })
    const r = await h.fns.remoteSyncDown(null, h.runner, PROFILE, '~/proj-root', mirror, { paths: ['src'] })
    check(duCalls(h).length === 1 && /proj-root\/src/.test(duCalls(h)[0].cmd), '有 paths 时只探测这些子路径，而不是整根（避免 46G 误伤）')
    check(r.ok === true && Array.isArray(r.paths) && r.paths[0] === 'src', '局部同步回传 paths')
    check(existsSync(join(mirror, 'src', 'a.txt')), '局部同步把子路径写进镜像')
  })
}

console.log('B · 失败不毁镜像（临时目录 + 原子替换）')
{
  await withMirror({ 'keep.txt': 'K', '.remote-ssh.json': '{}' }, async (mirror, parent) => {
    const h = build({ failRole: 'ssh', failCode: 255 })
    const r = await h.fns.remoteSyncDown(null, h.runner, PROFILE, '~/proj-root', mirror, {})
    check(r.ok === false, 'ssh 失败 → ok:false')
    check(/本地镜像未改动/.test(r.error), '错误里明确"本地镜像未改动"')
    check(/ssh 退出码 255/.test(r.error), '错误里带 ssh 退出码与 stderr 摘要')
    check(existsSync(join(mirror, 'keep.txt')), '旧镜像文件**仍在**（旧实现此时已被 rm -rf 销毁）')
    check(existsSync(join(mirror, '.remote-ssh.json')), '旧镜像的 .remote-ssh.json 也仍在')
    check(leftovers(parent).length === 0, '失败的临时目录已清理（无 .dsh-sync-tmp-* 残留）')
  })
}
{
  await withMirror({ 'keep.txt': 'K' }, async (mirror, parent) => {
    const h = build({ failRole: 'extract', failCode: 2 })
    const r = await h.fns.remoteSyncDown(null, h.runner, PROFILE, '~/proj-root', mirror, {})
    check(r.ok === false && /tar 退出码 2/.test(r.error), '本地解包失败 → 明确报 tar 退出码')
    check(existsSync(join(mirror, 'keep.txt')), '解包失败也不动旧镜像')
    check(leftovers(parent).length === 0, '解包失败的临时目录已清理')
  })
}
{
  await withMirror({ 'keep.txt': 'K' }, async (mirror, parent) => {
    const h = build({ hangRole: 'ssh' })
    const r = await h.fns.remoteSyncDown(null, h.runner, PROFILE, '~/proj-root', mirror, { timeoutMs: 40 })
    check(r.ok === false && /超过墙钟预算/.test(r.error), '超过墙钟预算 → 失败（旧实现没有超时，46G 拉取无法取消）')
    check(h.terminated.length >= 1, '超时后终止了两端进程')
    check(existsSync(join(mirror, 'keep.txt')), '超时也不动旧镜像')
    check(leftovers(parent).length === 0, '超时的临时目录已清理')
  })
}
{
  await withMirror(
    { '.remote-ssh.json': '{"old":true}', 'README.md': PLACEHOLDER_README, 'stale.txt': 'will-be-gone' },
    async (mirror, parent) => {
      const h = build({ remoteTree: { 'src/a.txt': 'A', 'src/b.txt': 'B' }, probeBytes: 4096 })
      const r = await h.fns.remoteSyncDown(null, h.runner, PROFILE, '~/proj-root', mirror, { force: true })
      check(r.ok === true, '整树同步成功')
      check(existsSync(join(mirror, 'src', 'a.txt')) && existsSync(join(mirror, 'src', 'b.txt')), '镜像内容 = 远端树')
      const conn = JSON.parse(readFileSync(join(mirror, '.remote-ssh.json'), 'utf8'))
      check(conn.remotePath === '~/proj-root' && conn.host === 'hpc-a.example.com', '替换后恢复 .remote-ssh.json（wrapper/拦截器要读它）')
      check(readFileSync(join(mirror, 'README.md'), 'utf8').indexOf('# 🌐 Remote Workspace') === 0, '替换后恢复占位 README')
      check(leftovers(parent).length === 0, '成功路径不留 tmp/old 残留')
      const down = h.spawns.find((s) => s.role === 'extract')
      check(down && down.argv[down.argv.length - 1] !== mirror, '解包目标是临时目录，不是镜像本身')
      const ssh = h.spawns.find((s) => s.role === 'ssh')
      check(/^tar( --format=pax( --pax-option=[^ ]+)?)? -cf - -C '~\/proj-root' \.$/.test(ssh.remoteCmd), '整树命令仍是 `tar -cf - -C <root> .`（远端语义不变，PAX 前缀可选）')
    }
  )
}
{
  await withMirror({ 'README.md': PLACEHOLDER_README }, async (mirror) => {
    const h = build({ remoteTree: { 'README.md': '# 远端自己的 README\n' }, probeBytes: 100 })
    const r = await h.fns.remoteSyncDown(null, h.runner, PROFILE, '~/proj-root', mirror, {})
    check(r.ok === true, '远端自带 README.md 时同步成功')
    check(readFileSync(join(mirror, 'README.md'), 'utf8') === '# 远端自己的 README\n', '不覆盖远端自己的 README.md（只补写插件占位文件）')
  })
}

console.log('C · 「仅存在于镜像」保护（默认拒绝，force 显式放弃）')
{
  await withMirror(
    { 'only-local.bin': 'big', 'src/keep.txt': 'K', '.remote-ssh.json': '{}', 'README.md': PLACEHOLDER_README },
    async (mirror, parent) => {
      const h = build({ remoteTree: { 'src/keep.txt': 'K' }, probeBytes: 800 })
      const r = await h.fns.remoteSyncDown(null, h.runner, PROFILE, '~/proj-root', mirror, {})
      check(r.ok === false && /只存在于镜像/.test(r.error), '存在镜像独有文件 → 拒绝整树替换')
      check(r.onlyMirrorTotal === 1 && r.onlyMirror && r.onlyMirror[0] === 'only-local.bin', '拒绝时回传清单（onlyMirror/onlyMirrorTotal）')
      check(/remote_ssh_push/.test(r.error) && /force: true/.test(r.error), '拒绝理由给出两条出路：先 push / 或 force')
      check(existsSync(join(mirror, 'only-local.bin')), '本地独有文件仍在（这是数据丢失防线的核心）')
      check(leftovers(parent).length === 0, '被拒时临时目录已清理')
      check(!existsSync(join(mirror, '.dsh-sync-old-1')), '没有留下"旧镜像"目录')
    }
  )
}
{
  await withMirror(
    { 'only-local.bin': 'big', '.remote-ssh.json': '{}', 'README.md': PLACEHOLDER_README },
    async (mirror) => {
      const h = build({ remoteTree: { 'src/keep.txt': 'K' }, probeBytes: 800 })
      const r = await h.fns.remoteSyncDown(null, h.runner, PROFILE, '~/proj-root', mirror, { force: true })
      check(r.ok === true, 'force: true → 允许替换（用户显式放弃本地副本）')
      check(!existsSync(join(mirror, 'only-local.bin')), 'force 时本地独有文件确实被替换掉')
    }
  )
}
{
  await withMirror({ '.remote-ssh.json': '{}', 'README.md': PLACEHOLDER_README }, async (mirror) => {
    const h = build({ remoteTree: { 'src/a.txt': 'A' }, probeBytes: 100 })
    const r = await h.fns.remoteSyncDown(null, h.runner, PROFILE, '~/proj-root', mirror, {})
    check(r.ok === true, '插件自有占位文件不算"镜像独有文件"（不误报、不阻塞日常同步）')
  })
}

console.log('D · push 护栏（不污染远端根）')
{
  await withMirror({ '.remote-ssh.json': '{}', 'README.md': PLACEHOLDER_README, 'src/a.txt': 'A' }, async (mirror) => {
    const h = build({})
    const r = await h.fns.remoteSyncUp(null, PROFILE, '~/proj-root', mirror, {})
    check(r.ok === true && r.remotePath === '~/proj-root', 'push 成功回传 remotePath')
    check(h.cleared.length === 1, 'push 成功后清空该 profile 的读/列举缓存')
    const argv = h.spawns.find((s) => s.role === 'localTar').argv.join(' ')
    check(/--exclude=\.\/\.remote-ssh\.json(\s|$)/.test(argv), 'push 始终排除 .remote-ssh.json（argv 语境 → 裸模式）')
    check(/--exclude=\.\/README\.md(\s|$)/.test(argv), 'push 排除插件占位 README（按指纹判定，裸模式）')
    check(!/--exclude=[^ ]*['"]/.test(argv), 'push 的每一条 --exclude 都不带引号（带引号=模式不匹配=静默失效，issue #22）')
    check(argv.indexOf('--exclude') < argv.indexOf('-C'), 'tar 选项在操作数之前（GNU/BSD tar 都可移植）')
    const ssh = h.spawns.find((s) => s.role === 'ssh')
    check(!/exclude/.test(ssh.remoteCmd), '排除规则只在本地打包侧生效，远端命令保持简单')
  })
}
{
  await withMirror({ 'README.md': '# 我自己的项目说明\n', 'a.txt': 'A' }, async (mirror) => {
    const h = build({})
    await h.fns.remoteSyncUp(null, PROFILE, '~/proj-root', mirror, {})
    const argv = h.spawns.find((s) => s.role === 'localTar').argv.join(' ')
    check(!/README\.md/.test(argv), '用户自己的 README.md 不被排除（指纹不匹配时不误伤）')
    check(/--exclude=\.\/\.remote-ssh\.json(\s|$)/.test(argv), '无论镜像内容如何，.remote-ssh.json 始终被排除（裸模式）')
  })
}
{
  await withMirror({ 'a.txt': 'A' }, async (mirror) => {
    const h = build({ failRole: 'ssh', failCode: 255 })
    const r = await h.fns.remoteSyncUp(null, PROFILE, '~/proj-root', mirror, {})
    check(r.ok === false && /推送失败/.test(r.error), 'push 失败 → 明确报错')
    check(h.cleared.length === 0, 'push 失败时不清缓存（远端并未改变）')
  })
}

console.log('E · 范围控制与越界丢弃')
{
  await withMirror({}, async (mirror) => {
    const h = build({ remoteTree: { 'src/a.txt': 'A' }, probeBytes: 100 })
    const r = await h.fns.remoteSyncDown(null, h.runner, PROFILE, '~/proj-root', mirror, {
      paths: ['src', '../etc', '/etc', '~/x', 'src', '.'], exclude: ['data', '*.log', '../up', '']
    })
    const ssh = h.spawns.find((s) => s.role === 'ssh')
    check(r.ok === true && r.paths.length === 1 && r.paths[0] === 'src', 'paths 归一化：去重 + 丢弃 ../ /绝对路径/~ 与 "."')
    check(/'src'/.test(ssh.remoteCmd) && !/\betc\b/.test(ssh.remoteCmd), '远端命令只用合法子路径')
    check(/--exclude='\.\/data'/.test(ssh.remoteCmd) && /--exclude='\.\/\*\.log'/.test(ssh.remoteCmd), '合法 exclude 下推为 --exclude=./x')
    check(!/--exclude='\.\.\//.test(ssh.remoteCmd) && !/--exclude='\/etc'/.test(ssh.remoteCmd), '越界 exclude 规则被丢弃，不进 tar 参数')
  })
}
{
  await withMirror({}, async (mirror) => {
    const h = build({ remoteTree: { 'src/a.txt': 'A' }, probeBytes: 100 })
    await h.fns.remoteSyncDown(null, h.runner, PROFILE, '~/proj-root', mirror, { exclude: ['data'] })
    const ssh = h.spawns.find((s) => s.role === 'ssh')
    check(/^tar( --format=pax( --pax-option=[^ ]+)?)? -cf - --exclude='\.\/data' -C '~\/proj-root' \.$/.test(ssh.remoteCmd), '排除规则出现在 -C 之前、操作数仍是 "."（PAX 前缀可选，见 I 段）；-cf 带横线（长选项后不能再用旧式 cf）')
  })
}

console.log('F · 静态防线（源码级不变式）')
{
  check(!/rm\(mirrorPath/.test(downSrc), 'remoteSyncDown 里没有任何 rm(mirrorPath)（旧实现在拉取前先清空镜像）')
  check(downSrc.indexOf('probeRemoteBytes') < downSrc.indexOf('sweepStaleSyncDirs'), '哨兵在其它文件系统动作之前')
  check(downSrc.indexOf('mkdir(tmpDir') < downSrc.indexOf('scanMirrorOnly'), '解包到临时目录早于"镜像独有文件"比对')
  check(downSrc.indexOf('scanMirrorOnly') < downSrc.indexOf('swapMirrorDir'), '比对早于原子替换（拒绝时不产生任何破坏）')
  check(/swapMirrorDir\(mirrorPath, tmpDir\)/.test(downSrc), '整树同步走 swapMirrorDir（原子替换 + 失败回滚）')
  check(/cp\(from, join\(mirrorPath, rel\)/.test(downSrc), '局部同步只 cp 子路径，不删除镜像里的其它文件')
  check(/syncTarExcludes\(o\.exclude, true\)/.test(downSrc), 'sync 方向 forShell=true（结果拼进远端命令字符串，必须带 shell 引号）')
  check(/syncTarExcludes\(o\.exclude\)/.test(upSrcOnly), 'push 方向裸模式（结果进本地 tar 的 argv）')
  check(!/\bshellQuote\(/.test(upSrcOnly), 'remoteSyncUp 里不再出现 shellQuote（argv 语境不允许引号，issue #22）')
  check(/excludes\.push\("--exclude=\.\/\.remote-ssh\.json"\)/.test(upSrcOnly), 'remoteSyncUp 始终排除 .remote-ssh.json（裸模式）')
  check(/excludes\.push\("--exclude=\.\/README\.md"\)/.test(upSrcOnly), 'remoteSyncUp 用内容指纹判定占位 README（裸模式）')

  const wsSchema = src.slice(src.indexOf('const WorkspaceSchema'), src.indexOf('const PrefsSchema'))
  check(/syncExclude: z\.array/.test(wsSchema) && /syncPaths: z\.array/.test(wsSchema) && /syncMaxBytes: z\.number/.test(wsSchema), 'WorkspaceSchema 持久化 syncExclude / syncPaths / syncMaxBytes')

  const params = src.slice(src.indexOf('const syncParams = {'), src.indexOf('const syncOutput = {'))
  check(/paths: \{ type: "array"/.test(params) && /exclude: \{ type: "array"/.test(params), '工具参数暴露 paths / exclude')
  check(/force: \{ type: "boolean"/.test(params) && /maxBytes: \{ type: "number"/.test(params) && /timeoutMs: \{ type: "number"/.test(params), '工具参数暴露 force / maxBytes / timeoutMs')

  const out = src.slice(src.indexOf('const syncOutput = {'), src.indexOf('register({', src.indexOf('const syncOutput = {')))
  check(/bytes: \{ type: "number" \}/.test(out) && /onlyMirrorTotal: \{ type: "number" \}/.test(out), '输出 schema 声明 bytes / onlyMirrorTotal（additionalProperties:false 会拒未声明字段）')
  check(/onlyMirror: \{ type: "array"/.test(out) && /paths: \{ type: "array"/.test(out), '输出 schema 声明 onlyMirror / paths')

  const desc = src.slice(src.indexOf('const syncDesc = '), src.indexOf('const syncParams = {'))
  check(/整树/.test(desc) && /paths/.test(desc), '工具描述写清"整树"语义与 paths 收窄手段')
  check(/不要用 sync/.test(desc), '工具描述明确"读远端文件不要用 sync"')

  const entryCount = (src.match(/syncOptsFrom\(ws, (?:a|args)\)\)/g) || []).length
  check(entryCount === 4, '四处入口（2 工具 + 2 HTTP）都走 syncOptsFrom（实际 ' + entryCount + '）')
  const downCount = (src.match(/remoteSyncDown\(subprocess, runPooled, /g) || []).length
  check(downCount === 2, '两处 sync 入口都把 runPooled 作为体积探测 runner 传入（实际 ' + downCount + '）')
  check(!/remoteSyncDown\(subprocess, p, ws\.remotePath/.test(src), '没有任何入口还在用旧签名调用 remoteSyncDown')
}

console.log('H · 两个引用语境（issue #22）：push 走 argv 必须裸模式，sync 走远端 shell 必须带引号')
{
  const { spawnSync } = await import('node:child_process')
  const TAR = process.env.DSH_TEST_TAR || 'tar'
  const probe = spawnSync(TAR, ['--version'], { encoding: 'utf8' })
  const tarOk = !probe.error && probe.status === 0
  const tarVer = tarOk ? String(probe.stdout).split('\n')[0].trim() : ''
  const BASH = process.env.DSH_TEST_BASH || 'bash'
  const bashProbe = spawnSync(BASH, ['-lc', 'printf ok'], { encoding: 'utf8' })
  const bashOk = !bashProbe.error && String(bashProbe.stdout).indexOf('ok') >= 0

  // 单元级：同一个 helper 的两种形态
  const h0 = build({})
  check(h0.fns.syncTarExcludes(['a', 'b'], true).join(' ') === "--exclude='./a' --exclude='./b'", 'forShell=true → 带 POSIX 单引号（shell 语境）')
  check(h0.fns.syncTarExcludes(['a', 'b']).join(' ') === '--exclude=./a --exclude=./b', 'forShell 缺省 → 裸模式（argv 语境）')
  check(h0.fns.syncTarExcludes(['../x', '/etc', '~', '.'], false).length === 0, '两种形态都先过越界归一化（../ /绝对 /~ /"." 丢弃）')

  // 端到端 A：push 用**实际生成**的 argv 喂真实 tar —— 归档里到底有没有那些文件
  await withMirror(
    {
      '.remote-ssh.json': '{"host":"hpc-a.example.com","user":"user","keyPath":"/k"}',
      'README.md': PLACEHOLDER_README,
      'keep.txt': 'K',
      '_patch/a.txt': 'P',
      'data/big.bin': 'D'
    },
    async (mirror, parent) => {
      const h = build({})
      const r = await h.fns.remoteSyncUp(null, PROFILE, '~/proj-root', mirror, { exclude: ['_patch', 'data'] })
      check(r.ok === true, 'H-A push 调用成功（假 ssh 消费掉管道）')
      const tarSpawn = h.spawns.find((s) => s.role === 'localTar')
      const excludes = tarSpawn.argv.filter((a) => a.indexOf('--exclude=') === 0)
      check(excludes.length === 4, 'H-A 生成 4 条排除（用户 2 条 + 写死 2 条），实际 ' + excludes.length)
      if (!tarOk) {
        console.log('  … 跳过真实 tar 断言（本机没有可用的 tar）')
      } else {
        const arc = join(parent, 'push.tar')
        const run = spawnSync(TAR, ['cf', arc].concat(excludes, ['-C', mirror, '.']), { encoding: 'utf8' })
        check(run.status === 0, 'H-A 真实 tar 用生成的 argv 打包成功（' + tarVer + '）')
        const listing = String(spawnSync(TAR, ['tf', arc], { encoding: 'utf8' }).stdout)
        check(!/\.remote-ssh\.json/.test(listing), 'H-A 真实归档里没有 .remote-ssh.json（连接信息不泄漏到远端根）')
        check(!/^\.\/README\.md$/m.test(listing), 'H-A 真实归档里没有插件占位 README.md')
        check(!/_patch|data\//.test(listing), 'H-A 真实归档里没有用户 exclude 的 _patch/ 与 data/')
        check(/\.\/keep\.txt/.test(listing), 'H-A 真实归档里仍有 keep.txt（排除没把内容一起干掉）')

        // 负向控制：带引号的旧形状必须被同一判据判为"泄漏"（证明这条判据能抓到 issue #22）
        const arcBad = join(parent, 'push-bad.tar')
        const badExcludes = excludes.map((e) => "--exclude='" + e.slice('--exclude='.length) + "'")
        spawnSync(TAR, ['cf', arcBad].concat(badExcludes, ['-C', mirror, '.']), { encoding: 'utf8' })
        const badListing = String(spawnSync(TAR, ['tf', arcBad], { encoding: 'utf8' }).stdout)
        check(/\.remote-ssh\.json/.test(badListing) && /_patch/.test(badListing),
          'H-A 负向控制：带引号时这些文件确实漏进归档（= 2.4.20 的实际行为）')
      }
    }
  )

  // 端到端 B：sync 方向生成的远端命令 —— 引号必须能被 POSIX shell 正确剥离成裸模式
  await withMirror({}, async (mirror) => {
    const h = build({ remoteTree: { 'src/a.txt': 'A' }, probeBytes: 100 })
    await h.fns.remoteSyncDown(null, h.runner, PROFILE, '~/proj-root', mirror, { exclude: ['data', '*.log'] })
    const ssh = h.spawns.find((s) => s.role === 'ssh')
    check(/--exclude='\.\/data'/.test(ssh.remoteCmd) && /--exclude='\.\/\*\.log'/.test(ssh.remoteCmd),
      'H-B sync 侧排除带 shell 引号（远端 shell 语境，防注入/防通配）')
    if (!bashOk) {
      console.log('  … 跳过 shell 剥离断言（本机没有可用的 bash）')
    } else {
      // 把生成的那两条 --exclude=… 交给真实 POSIX shell，看它解析后的实参是什么
      const pats = ssh.remoteCmd.match(/--exclude=('[^']*'|\S+)/g) || []
      const out = String(spawnSync(BASH, ['-lc', 'printf "%s\\n" ' + pats.join(' ')], { encoding: 'utf8' }).stdout)
      const got = out.trim().split('\n')
      check(got.join(' ') === '--exclude=./data --exclude=./*.log',
        'H-B 经真实 POSIX shell 解析后正好退化成裸模式（与 H-A 证明可用的形态一致）')
    }
  })
}

console.log('I · 远端 tar 的字符集方案 + 乱码名迁移（issue #22）')
{
  const MOJI = '鎶ュ憡_2026Q1.csv'          // 报告_2026Q1.csv 被 GBK 解码后的样子
  check(h0Moji('报告_2026Q1.csv') === MOJI, 'I-1 乱码预测与举报人实测一致（报告_2026Q1.csv → ' + MOJI + '）')
  const mp = h0Moji('实验数据/批次2.csv')
  check(mp !== null && mp.length === 15 && mp.indexOf('/') === 6 && mp.endsWith('2.csv'),
    'I-1 整条相对路径一起解码（子目录也参与；"/" 与扩展名照旧，故可整路径配对）')
  check(h0Moji('plain-ascii.csv') === null, 'I-1 纯 ASCII 不参与（null）')
  const weird = h0Moji('a\uFFFDb')
  check(weird === null || typeof weird === 'string', 'I-1 含替换字符的名字不抛异常（返回 null 或字符串）')

  // I-2 探针阶梯与缓存
  const hA = build({})
  check(await hA.fns.probeRemotePax(hA.runner, PROFILE, 1000) === 'min', 'I-2 阶梯第一级通过 → "min"（pax + 裁剪记录，零体积代价）')
  check(paxCalls(hA).length === 1, 'I-2 第一级即成功 → 只探测一次（实际 ' + paxCalls(hA).length + '）')
  check(hA.fns.syncPaxPrefix('min') === '--format=pax --pax-option=delete=atime,delete=ctime,delete=mtime ', 'I-2 min 前缀拼进远端命令')
  await hA.fns.probeRemotePax(hA.runner, PROFILE, 1000)
  check(paxCalls(hA).length === 1, 'I-2 结果按 profile 缓存（第二次不再探测）')

  const hB = build({ pax: false })
  check(await hB.fns.probeRemotePax(hB.runner, PROFILE, 1000) === 'none', 'I-3 远端 tar 不支持 --format=pax → "none"')
  check(paxCalls(hB).length === 2, 'I-3 走完两级阶梯才放弃（实际 ' + paxCalls(hB).length + ' 次）')
  check(hB.fns.syncPaxPrefix('none') === '', 'I-3 none → 前缀为空（退回原命令形状）')

  // I-4 开关：off 完全不探测；强制 min 不看探针结果
  await withMirror({}, async (mirror) => {
    process.env.DSH_REMOTE_SSH_SYNC_PAX = 'off'
    try {
      const h = build({})
      await h.fns.remoteSyncDown(null, h.runner, PROFILE, '~/proj-root', mirror, { force: true })
      const ssh = h.spawns.find((s) => s.role === 'ssh')
      check(paxCalls(h).length === 0, 'I-4 DSH_REMOTE_SSH_SYNC_PAX=off → 一次探针都不发')
      check(/^tar -cf - /.test(ssh.remoteCmd), 'I-4 off → 远端命令保持旧形状（仅 -cf 带横线）')
    } finally { delete process.env.DSH_REMOTE_SSH_SYNC_PAX }
  })
  await withMirror({}, async (mirror) => {
    process.env.DSH_REMOTE_SSH_SYNC_PAX = 'min'
    try {
      const h = build({ pax: false })
      await h.fns.remoteSyncDown(null, h.runner, PROFILE, '~/proj-root', mirror, { force: true })
      const ssh = h.spawns.find((s) => s.role === 'ssh')
      check(paxCalls(h).length === 0, 'I-4 强制 min → 不探测')
      check(/^tar --format=pax --pax-option=delete=atime,delete=ctime,delete=mtime -cf - /.test(ssh.remoteCmd), 'I-4 强制 min → 命令带 PAX 前缀')
    } finally { delete process.env.DSH_REMOTE_SSH_SYNC_PAX }
  })

  // I-5 整树：镜像里是乱码名、新树里是正确名 → 默认拒绝并说明，repairNames 放行
  const mojiPath = h0Moji('实验数据/批次2.csv')
  await withMirror({ [mojiPath]: 'DATA-B' }, async (mirror) => {
    const h = build({ remoteTree: { '实验数据/批次2.csv': 'DATA-B' }, probeBytes: 100 })
    const r = await h.fns.remoteSyncDown(null, h.runner, PROFILE, '~/proj-root', mirror, {})
    check(r.ok === false, 'I-5 默认拒绝（不静默删掉看起来"本地独有"的文件）')
    check(/乱码文件名/.test(r.error) && r.error.indexOf(mojiPath) >= 0 && r.error.indexOf('实验数据/批次2.csv') >= 0,
      'I-5 拒绝理由点名「乱码名 → 正确名」的对应关系')
    check(Array.isArray(r.mojibakeNames) && r.mojibakeNames[0] === mojiPath, 'I-5 回传 mojibakeNames（供宿主展示）')
    check(existsSync(join(mirror, mojiPath)), 'I-5 被拒时镜像原样不动')
  })
  await withMirror({ [mojiPath]: 'DATA-B' }, async (mirror) => {
    const h = build({ remoteTree: { '实验数据/批次2.csv': 'DATA-B' }, probeBytes: 100 })
    const r = await h.fns.remoteSyncDown(null, h.runner, PROFILE, '~/proj-root', mirror, { repairNames: true })
    check(r.ok === true && r.repairedNames === 1, 'I-5 repairNames: true → 放行并回传 repairedNames=1')
    check(existsSync(join(mirror, '实验数据', '批次2.csv')), 'I-5 替换后镜像里是正确名')
    check(!existsSync(join(mirror, mojiPath)), 'I-5 乱码名已随原子替换消失')
  })

  // I-6 混合场景：乱码名 + 真正本地独有的文件 → 仍然拒绝（不能借修复之名删掉真文件）
  await withMirror({ [mojiPath]: 'DATA-B', 'only-local.txt': 'L' }, async (mirror) => {
    const h = build({ remoteTree: { '实验数据/批次2.csv': 'DATA-B' }, probeBytes: 100 })
    const r = await h.fns.remoteSyncDown(null, h.runner, PROFILE, '~/proj-root', mirror, { repairNames: true })
    check(r.ok === false && r.onlyMirrorTotal === 2, 'I-6 真·本地独有文件仍在 → 即使带 repairNames 也拒绝')
    check(/repairNames: true/.test(r.error), 'I-6 拒绝理由提示乱码名可一并清理')
    check(existsSync(join(mirror, 'only-local.txt')), 'I-6 真文件没有被删')
  })

  // I-7 局部同步：不替换镜像 → repairNames 显式清理；否则只提示
  await withMirror({ [mojiPath]: 'DATA-B' }, async (mirror) => {
    const h = build({ remoteTree: { '实验数据/批次2.csv': 'DATA-B' }, probeBytes: 100 })
    const r = await h.fns.remoteSyncDown(null, h.runner, PROFILE, '~/proj-root', mirror, { paths: ['实验数据'] })
    check(r.ok === true && !r.repairedNames, 'I-7 局部同步默认不删任何东西')
    check(/乱码文件名/.test(String(r.notice || '')), 'I-7 但会在结果里提示存在乱码名')
    check(existsSync(join(mirror, mojiPath)), 'I-7 乱码名还在（需要显式 repairNames）')
  })
  await withMirror({ [mojiPath]: 'DATA-B' }, async (mirror) => {
    const h = build({ remoteTree: { '实验数据/批次2.csv': 'DATA-B' }, probeBytes: 100 })
    const r = await h.fns.remoteSyncDown(null, h.runner, PROFILE, '~/proj-root', mirror, { paths: ['实验数据'], repairNames: true })
    check(r.ok === true && r.repairedNames === 1, 'I-7 显式 repairNames → 局部同步也清理乱码名')
    check(!existsSync(join(mirror, mojiPath)), 'I-7 乱码名已删除')
    check(existsSync(join(mirror, '实验数据', '批次2.csv')), 'I-7 正确名已写入')
    check(!existsSync(join(mirror, '瀹為獙鏁版嵁')), 'I-7 空的乱码目录也被清掉')
  })

  // I-8 静态防线：开关/参数/输出 schema 都接上了
  check(/repairNames: src\.repairNames === true/.test(src), 'I-8 syncOptsFrom 透传 repairNames')
  check(/repairNames: \{ type: "boolean"/.test(src), 'I-8 工具参数暴露 repairNames')
  const out = src.slice(src.indexOf('const syncOutput = {'), src.indexOf('register({', src.indexOf('const syncOutput = {')))
  check(/mojibakeNames: \{ type: "array"/.test(out) && /repairedNames: \{ type: "number"/.test(out) && /notice: \{ type: "string"/.test(out),
    'I-8 输出 schema 声明 mojibakeNames / repairedNames / notice')
}

console.log('G · 选项组装与持久化')
{
  const h = build({})
  const s1 = h.fns.syncOptsFrom({ syncPaths: ['a'], syncExclude: ['b'], syncMaxBytes: 10 }, {})
  check(s1.paths[0] === 'a' && s1.exclude[0] === 'b' && s1.maxBytes === 10 && s1.force === false, '无逐次参数时用工作区持久化字段')
  const s2 = h.fns.syncOptsFrom({ syncPaths: ['a'], syncExclude: ['b'], syncMaxBytes: 10 }, { paths: ['c'], exclude: ['d'], force: true })
  check(s2.paths[0] === 'c' && s2.exclude[0] === 'd' && s2.force === true && s2.maxBytes === 10, '逐次参数覆盖 paths/exclude，force 只看本次调用')
  const s3 = h.fns.syncOptsFrom(undefined, { maxBytes: 0 })
  check(s3.maxBytes === 0 && s3.paths === undefined, '0 是合法上限（不会被当成"未设置"）；工作区缺失也不炸')
  const upd = src.slice(src.indexOf('updateWorkspace: async (args) => {'), src.indexOf('remoteExec: async (args) => {'))
  check(/ws\.syncExclude = /.test(upd) && /ws\.syncPaths = /.test(upd) && /ws\.syncMaxBytes = /.test(upd), 'updateWorkspace 能写入三个同步字段（否则持久化只能手改 settings.json）')
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
