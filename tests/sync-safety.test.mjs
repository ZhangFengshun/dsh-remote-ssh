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
const regionStart = src.indexOf('function syncErrText(')
const upIdx = src.indexOf('async function remoteSyncUp(')
const upSrc = grab('async function remoteSyncUp')
const regionEnd = upIdx >= 0 ? src.indexOf(upSrc, upIdx) + upSrc.length : -1
if (constStart < 0 || regionStart < 0 || regionEnd <= regionStart) {
  console.log('  ✗ FAIL: 未能抽出同步实现区（常量 + syncErrText … remoteSyncUp）')
  process.exit(1)
}
const syncRegion = src.slice(constStart, constEnd) + '\n' + src.slice(regionStart, regionEnd)
const downSrc = grab('async function remoteSyncDown')
const upSrcOnly = upSrc

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
    if (o.probe) return o.probe
    return { ok: true, stdout: String(o.probeBytes === undefined ? 2048 : o.probeBytes) + '\n', exitCode: 0 }
  }

  const readCollected = (h) => errText[h && h.__role] || ''
  const fns = new Function(
    'process', 'rm', 'mkdir', 'rename', 'cp', 'readdir', 'stat', 'readFile', 'writeFile', 'existsSync',
    'join', 'dirname', 'basename', 'spawnOne', 'readCollected', 'sshArgv', 'shellQuote', 'shellQuotePath',
    'clearCachesForProfile', 'remoteWorkspaceReadme',
    syncRegion + '\nreturn { remoteSyncDown: remoteSyncDown, remoteSyncUp: remoteSyncUp, scanMirrorOnly: scanMirrorOnly, formatSyncBytes: formatSyncBytes, syncOptsFrom: syncOptsFrom };'
  )(
    process, loggedRm, mkdir, rename, cp, readdir, stat, readFile, writeFile, existsSync,
    join, dirname, basename, spawnOne, readCollected,
    (p, cmd) => ['ssh', '-o', 'BatchMode=yes', p.user + '@' + p.host, cmd],
    (s) => "'" + String(s) + "'", (s) => "'" + String(s) + "'",
    (p) => { cleared.push(p.id) },
    (n, rp) => '# 🌐 Remote Workspace / 远程工作区\n\n- Profile: ' + n + '\n- Root: ' + rp + '\n'
  )
  return { spawns, rmCalls, runnerCalls, cleared, terminated, runner, fns }
}

console.log('A · 体积哨兵严格早于任何删除动作')
{
  await withMirror({ 'only-local.txt': 'x' }, async (mirror) => {
    const h = build({ probeBytes: 5 * 1024 * 1024 * 1024 })
    const r = await h.fns.remoteSyncDown(null, h.runner, PROFILE, '~/proj-root', mirror, {})
    check(r.ok === false, '远端超过上限 → 拒绝')
    check(/超过同步上限/.test(r.error), '拒绝理由说明上限（实际：' + String(r.error).slice(0, 60) + '…）')
    check(h.runnerCalls.length === 1 && /du -sb -c --/.test(h.runnerCalls[0].cmd), '先探测体积（du -sb -c）')
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
    check(h.runnerCalls.length === 0, 'force: true → 跳过探测')
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
    check(h.runnerCalls.length === 1 && /proj-root\/src/.test(h.runnerCalls[0].cmd), '有 paths 时只探测这些子路径，而不是整根（避免 46G 误伤）')
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
      check(/tar cf - -C '~\/proj-root' \.$/.test(ssh.remoteCmd), '整树命令仍是 `tar cf - -C <root> .`（远端语义不变）')
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
    check(/--exclude='\.\/\.remote-ssh\.json'/.test(argv), 'push 始终排除 .remote-ssh.json（连接信息不进远端）')
    check(/--exclude='\.\/README\.md'/.test(argv), 'push 排除插件占位 README（按指纹判定）')
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
    check(/--exclude='\.\/\.remote-ssh\.json'/.test(argv), '无论镜像内容如何，.remote-ssh.json 始终被排除')
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
    check(/^tar cf - --exclude='\.\/data' -C '~\/proj-root' \.$/.test(ssh.remoteCmd), '排除规则出现在 -C 之前、操作数仍是 "."')
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
  check(/--exclude=" \+ shellQuote\("\.\/\.remote-ssh\.json"\)/.test(upSrcOnly), 'remoteSyncUp 始终排除 .remote-ssh.json')
  check(/isMirrorPlaceholderReadme\(head\)/.test(upSrcOnly), 'remoteSyncUp 用内容指纹判定占位 README')

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
