// 非 ASCII 文件名的真实端到端测试（issue #22）。
//
// 背景：Windows 自带的 bsdtar 读 ustar 名时按**本地 ANSI 代码页**解码（中文机器 = CP936），而
// 远端 GNU tar 对短的非 ASCII 名写出的是**裸 UTF-8 字节的 ustar 头**（typeflag='0'、无 PAX、
// 无字符集声明）→ 拉下来就变成 `鎶ュ憡_2026Q1.csv`（exit 0、stderr 为空，完全静默），再 push
// 一次就把乱码名固化到远端。修法是让**远端**改用 PAX（`path=` 记录携带 UTF-8 名，bsdtar 优先采用）。
//
// 本测试不用任何假 tar：WSL 里的真实 GNU tar 扮演"远端"（与举报人的 Ubuntu 24.04 / GNU tar 1.35
// 同版本），Windows 自带的真实 bsdtar 做本地解包，中间跑的是插件**真实的** remoteSyncDown ——
// 于是"插件生成了什么命令" → "真实归档是什么形状" → "Windows 上落盘是什么名字"这条链路整体被验证。
// 一条负向控制把 PAX 关掉（DSH_REMOTE_SSH_SYNC_PAX=off）：同一个远端树必须复现出乱码名，
// 以此证明本测试真的能抓到回归。
//
// 没有 WSL / WSL 里没有 GNU tar 时整体跳过（打印一行说明，不计失败）。
import { spawnSync, spawn } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
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
const skip = (why) => { console.log('  … 跳过：' + why); console.log('\n结果: 0 通过, 0 失败'); process.exit(0) }

// ---- 环境探测：WSL + 里面的 GNU tar，以及本机 tar ----
const WSL = process.env.DSH_TEST_WSL || 'wsl'
const TAR = process.env.DSH_TEST_TAR || 'tar'
function run(cmd, args, opts) {
  const r = spawnSync(cmd, args, Object.assign({ encoding: 'utf8' }, opts || {}))
  if (r.error) return { ok: false, out: '', err: String(r.error.message) }
  return { ok: r.status === 0, out: String(r.stdout || ''), err: String(r.stderr || ''), status: r.status }
}
const wslTar = run(WSL, ['bash', '-lc', 'tar --version | head -1'])
if (!wslTar.ok || wslTar.out.indexOf('GNU tar') < 0) skip('本机没有可用的 WSL + GNU tar（' + (wslTar.err || wslTar.out || '').trim().slice(0, 80) + '）')
const localTar = run(TAR, ['--version'])
if (!localTar.ok) skip('本机没有可用的 tar')
console.log('远端（WSL）: ' + wslTar.out.trim())
console.log('本地（Windows）: ' + localTar.out.split('\n')[0].trim())

// ---- 抽出同步实现区（与 sync-safety.test.mjs 同一套切片）----
const constStart = src.indexOf('const SYNC_MAX_BYTES_DEFAULT')
const constEnd = src.indexOf('\n', src.indexOf('const MIRROR_README_SENTINEL')) + 1
const paxConstStart = src.indexOf('const SYNC_PAX_MIN_ARGS')
const paxConstEnd = src.indexOf('\n', src.indexOf('const syncPaxCache')) + 1
const regionStart = src.indexOf('function syncErrText(')
const upSrc = grab('async function remoteSyncUp')
const upIdx = src.indexOf('async function remoteSyncUp(')
const regionEnd = src.indexOf(upSrc, upIdx) + upSrc.length
const syncRegion = src.slice(constStart, constEnd) + '\n' + src.slice(paxConstStart, paxConstEnd) + '\n' +
  grab('function resolveSyncPaxPref') + '\n' + src.slice(regionStart, regionEnd)
if (constStart < 0 || paxConstStart < 0 || regionStart < 0 || regionEnd <= regionStart) {
  console.log('  ✗ FAIL: 未能抽出同步实现区'); process.exit(1)
}

const PROFILE = { id: 'cjk-p1', name: 'wsl-remote', host: 'wsl', port: 22, user: 'u', keyPath: '/k' }

// ---- Windows ↔ WSL 路径互转（WSL2 把盘符挂在 /mnt/<盘>）----
function toWslPath(p) {
  const s = String(p).replace(/\\/g, '/')
  return '/mnt/' + s[0].toLowerCase() + s.slice(2)
}
if (!run(WSL, ['bash', '-lc', 'test -d ' + JSON.stringify(toWslPath(root))]).ok) {
  skip('WSL 访问不到本项目目录（' + toWslPath(root) + '）')
}

/** 真实进程版的 spawnOne：ssh 角色 = 用 WSL 真跑插件生成的那条远端命令；
 *  tar 角色 = 本机真实 bsdtar。句柄形状与插件 runTarPipe 的要求一致。 */
function makeHarness(work) {
  const spawns = []
  const runnerCalls = []
  function spawnReal(role, cmd, args, stdio) {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const box = { err: '' }
    child.stderr.on('data', (d) => { box.err += d.toString() })
    const done = new Promise((res) => {
      child.on('close', (code) => res({ exitCode: code === null ? -1 : code }))
      child.on('error', (e) => { box.err += String((e && e.message) || e); res({ exitCode: -1 }) })
    })
    return { role: role, stdout: child.stdout, stdin: child.stdin, stderr: child.stderr, done: done, __box: box,
      terminate: () => { try { child.kill() } catch (e) {} } }
  }
  const spawnOne = (subprocess, argv, stdio) => {
    if (argv[0] === 'ssh') {
      const remoteCmd = argv[argv.length - 1]           // 插件生成的远端命令（含 PAX 前缀与否）
      spawns.push({ role: 'ssh', remoteCmd: remoteCmd, argv: argv })
      return spawnReal('ssh', WSL, ['bash', '-lc', remoteCmd], stdio)
    }
    spawns.push({ role: 'localTar', argv: argv })
    return spawnReal('localTar', argv[0], argv.slice(1), stdio)
  }
  const runner = async (p, cmd, stdinData, maxBytes, split, timeoutMs) => {
    runnerCalls.push({ cmd: cmd })
    const r = spawnSync(WSL, ['bash', '-lc', cmd], { encoding: 'utf8', timeout: timeoutMs || 20000 })
    if (r.error) return { ok: false, error: String(r.error.message), exitCode: -1 }
    return { ok: r.status === 0, stdout: String(r.stdout || ''), stderr: String(r.stderr || ''), exitCode: r.status }
  }
  const readCollected = (h) => String((h && h.__box && h.__box.err) || '')
  const fns = new Function(
    'process', 'rm', 'mkdir', 'rename', 'cp', 'readdir', 'stat', 'readFile', 'writeFile', 'existsSync',
    'join', 'dirname', 'basename', 'spawnOne', 'readCollected', 'sshArgv', 'shellQuote', 'shellQuotePath',
    'clearCachesForProfile', 'remoteWorkspaceReadme',
    syncRegion + '\nreturn { remoteSyncDown: remoteSyncDown, remoteSyncUp: remoteSyncUp, syncPaxCache: syncPaxCache, mojibakeName: mojibakeName };'
  )(
    process, rm, mkdir, rename, cp, readdir, stat, readFile, writeFile, existsSync,
    join, dirname, basename, spawnOne, readCollected,
    (p, cmd) => ({ argv: ['ssh', '-o', 'BatchMode=yes', p.user + '@' + p.host, cmd], env: undefined }),
    new Function('return ' + grab('function shellQuote'))(),
    new Function('shellQuote', 'return ' + grab('function shellQuotePath'))(new Function('return ' + grab('function shellQuote'))()),
    () => {}, (n, rp) => '# 🌐 Remote Workspace / 远程工作区\n\n- Profile: ' + n + '\n- Root: ' + rp + '\n'
  )
  fns.syncPaxCache.clear()
  return { spawns, runnerCalls, runner, fns }
}

const MIRROR_FILES = { '实验数据/批次2.csv': 'DATA-B\n', 'ascii/plain.csv': 'PLAIN\n', '报告_2026Q1.csv': 'REPORT\n' }

const work = mkdtempSync(join(tmpdir(), 'rssh-cjk-'))
const remoteSrc = join(work, 'remote-src')
const mirror = join(work, 'mirror')
mkdirSync(remoteSrc, { recursive: true })
for (const [rel, body] of Object.entries(MIRROR_FILES)) {
  mkdirSync(dirname(join(remoteSrc, rel)), { recursive: true })
  writeFileSync(join(remoteSrc, rel), body)
}
mkdirSync(mirror, { recursive: true })
const wslSrc = toWslPath(remoteSrc)

// 素材自检：这台 GNU tar 的默认格式确实是"裸 UTF-8 名的 ustar"（本测试的前提）。
// 直接按 512 字节块解析归档，比用 od 猜偏移可靠（`.` 目录条目本身是 typeflag "5"）。
function tarBlocks(file) {
  const buf = readFileSync(file)
  const out = []
  for (let off = 0; off + 512 <= buf.length;) {
    const blk = buf.subarray(off, off + 512)
    if (blk.every((b) => b === 0)) break
    const name = blk.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const size = parseInt(blk.subarray(124, 136).toString('ascii').replace(/[^0-7]/g, '') || '0', 8)
    const type = String.fromCharCode(blk[156])
    const magic = blk.subarray(257, 263).toString('latin1')
    const payload = buf.subarray(off + 512, off + 512 + size)
    out.push({ name, type, magic, payload: payload.toString('utf8') })
    off += 512 + Math.ceil(size / 512) * 512
  }
  return out
}
const defTar = join(work, 'def.tar'), paxTar = join(work, 'pax.tar')
const mkDef = run(WSL, ['bash', '-lc', 'tar -cf ' + JSON.stringify(toWslPath(defTar)) + ' -C ' + JSON.stringify(wslSrc) + ' .'])
const mkPax = run(WSL, ['bash', '-lc', 'tar --format=pax -cf ' + JSON.stringify(toWslPath(paxTar)) + ' -C ' + JSON.stringify(wslSrc) + ' .'])
check(mkDef.ok && existsSync(defTar), '前提⓪：能用 WSL tar 造出默认格式归档（' + (mkDef.err || '').trim().slice(0, 100) + '）')
check(mkPax.ok && existsSync(paxTar), '前提⓪：能用 WSL tar 造出 PAX 归档')
if (!existsSync(defTar) || !existsSync(paxTar)) { console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败'); process.exit(1) }
{
  const def = tarBlocks(defTar), pax = tarBlocks(paxTar)
  const defFile = def.find((b) => b.type === '0' && /报告_2026Q1\.csv$/.test(b.name))
  check(!!defFile && defFile.magic === 'ustar ', '前提①：GNU 默认格式里非 ASCII 文件是纯 ustar 头 + GNU magic "ustar "（bsdtar 会按 ANSI 代码页静默转码）')
  check(!def.some((b) => b.type === 'x' && /path=/.test(b.payload)), '前提②：GNU 默认格式**没有** PAX path 记录')
  const paxX = pax.find((b) => b.type === 'x' && /path=\.\/报告_2026Q1\.csv/.test(b.payload))
  check(!!paxX, '前提③：--format=pax 会写出携带 UTF-8 名的 path 记录')
  const paxFile = pax.find((b) => b.type === '0' && /报告_2026Q1\.csv$/.test(b.name))
  check(!!paxFile && paxFile.magic === 'ustar\0', '前提④：PAX 归档用 POSIX magic "ustar\\0"（bsdtar 遇到它就改走 PAX 解码路径）')
}

console.log('A · PAX 打开（默认）→ Windows 上解出正确名字')
{
  const h = makeHarness(work)
  const r = await h.fns.remoteSyncDown(null, h.runner, PROFILE, wslSrc, mirror, {})
  check(r.ok === true, 'A 同步成功（' + (r.error || '') + '）')
  const wire = h.spawns.find((s) => s.role === 'ssh').remoteCmd
  check(/^tar --format=pax --pax-option=delete=atime,delete=ctime,delete=mtime -cf - /.test(wire),
    'A 远端命令带 PAX 前缀（探针问的是真实 GNU tar）')
  const names = []
  const walk = (rel) => { for (const e of readdirSync(join(mirror, rel), { withFileTypes: true })) {
    const c = rel ? rel + '/' + e.name : e.name
    if (e.isDirectory()) walk(c); else names.push(c)
  } }
  walk('')
  check(names.indexOf('实验数据/批次2.csv') >= 0, 'A 中文目录+文件名正确落盘（实际：' + names.filter((n) => /csv$/.test(n)).join(' | ') + '）')
  check(names.indexOf('报告_2026Q1.csv') >= 0, 'A 纯中文文件名正确落盘')
  check(names.indexOf('ascii/plain.csv') >= 0, 'A ASCII 名不受影响')
  check(!names.some((n) => n.indexOf('鎶ュ憡') >= 0 || n.indexOf('瀹為獙') >= 0), 'A 没有任何乱码名')
  const cjk = join(mirror, '实验数据', '批次2.csv')
  check(existsSync(cjk) && readFileSync(cjk, 'utf8') === 'DATA-B\n', 'A 内容完好')
}

console.log('B · 负向控制：关掉 PAX → 同一个远端树必须复现乱码名')
{
  const mirror2 = join(work, 'mirror2')
  mkdirSync(mirror2, { recursive: true })
  const h = makeHarness(work)
  process.env.DSH_REMOTE_SSH_SYNC_PAX = 'off'
  let r
  try { r = await h.fns.remoteSyncDown(null, h.runner, PROFILE, wslSrc, mirror2, {}) }
  finally { delete process.env.DSH_REMOTE_SSH_SYNC_PAX }
  check(r.ok === true, 'B 同步本身仍然成功（乱码是静默的，这也正是它危险的地方）')
  const names = []
  const walk = (rel) => { for (const e of readdirSync(join(mirror2, rel), { withFileTypes: true })) {
    const c = rel ? rel + '/' + e.name : e.name
    if (e.isDirectory()) walk(c); else names.push(c)
  } }
  walk('')
  const moji = h.fns.mojibakeName('报告_2026Q1.csv')
  check(names.indexOf('报告_2026Q1.csv') < 0, 'B 正确名不存在（说明确实是旧行为）')
  check(names.indexOf(moji) >= 0, 'B 复现出乱码名 ' + JSON.stringify(moji) + '（与举报人现象一致）')
  check(existsSync(join(mirror2, moji)) && readFileSync(join(mirror2, moji), 'utf8') === 'REPORT\n', 'B 内容完好 —— 只有名字被改写')
}

console.log('C · 旧乱码名的迁移：repairNames 端到端')
{
  // C1：镜像里只有乱码名（旧版本留下的唯一痕迹）→ 默认拒绝，repairNames 放行
  const mirror3 = join(work, 'mirror3')
  mkdirSync(mirror3, { recursive: true })
  const h0 = makeHarness(work)
  const mojiFile = h0.fns.mojibakeName('实验数据/批次2.csv')
  mkdirSync(dirname(join(mirror3, mojiFile)), { recursive: true })
  writeFileSync(join(mirror3, mojiFile), 'OLD-LOCAL-COPY\n')

  const h = makeHarness(work)
  const refused = await h.fns.remoteSyncDown(null, h.runner, PROFILE, wslSrc, mirror3, {})
  check(refused.ok === false && /乱码文件名/.test(refused.error), 'C1 默认拒绝，并说明是乱码名（而不是"本地独有文件"）')
  check(Array.isArray(refused.mojibakeNames) && refused.mojibakeNames.indexOf(mojiFile) >= 0, 'C1 回传乱码名清单')

  const h2 = makeHarness(work)
  const repaired = await h2.fns.remoteSyncDown(null, h.runner, PROFILE, wslSrc, mirror3, { repairNames: true })
  check(repaired.ok === true && repaired.repairedNames === 1, 'C1 repairNames: true → 放行并报告修复 1 个乱码名（实际 ' + JSON.stringify(repaired.repairedNames) + '）')
  check(existsSync(join(mirror3, '实验数据', '批次2.csv')), 'C1 正确名已在镜像里')
  check(!existsSync(join(mirror3, mojiFile)), 'C1 乱码名已消失')

  // C2：乱码名 + 真正本地独有的文件 → 即使带 repairNames 也必须拒绝（不能借修复之名删真文件）
  const mirror4 = join(work, 'mirror4')
  mkdirSync(mirror4, { recursive: true })
  mkdirSync(dirname(join(mirror4, mojiFile)), { recursive: true })
  writeFileSync(join(mirror4, mojiFile), 'OLD-LOCAL-COPY\n')
  writeFileSync(join(mirror4, 'only-local.txt'), 'MINE\n')
  const h3 = makeHarness(work)
  const mixed = await h3.fns.remoteSyncDown(null, h.runner, PROFILE, wslSrc, mirror4, { repairNames: true })
  check(mixed.ok === false && mixed.onlyMirrorTotal === 2, 'C2 真·本地独有文件在场 → 仍然拒绝（onlyMirrorTotal=2）')
  check(existsSync(join(mirror4, 'only-local.txt')), 'C2 真文件没被删')
}

console.log('D · 反方向：本地 bsdtar 打包 → 远端 GNU tar 解包（push 路径）')
{
  const remoteUp = join(work, 'remote-up')
  mkdirSync(remoteUp, { recursive: true })
  const h = makeHarness(work)
  const r = await h.fns.remoteSyncUp(null, PROFILE, toWslPath(remoteUp), mirror, {})
  check(r.ok === true, 'D push 成功（' + (r.error || '') + '）')
  const names = []
  const walk = (rel) => { const dir = join(remoteUp, rel)
    if (!existsSync(dir)) return
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const c = rel ? rel + '/' + e.name : e.name
      if (e.isDirectory()) walk(c); else names.push(c)
    } }
  walk('')
  check(names.indexOf('报告_2026Q1.csv') >= 0, 'D 本地 bsdtar 写出的中文名在远端被正确解开（实际：' + names.filter((n) => /csv$/.test(n)).join(' | ') + '）')
  check(names.indexOf('实验数据/批次2.csv') >= 0, 'D 中文目录名同样正确')
  check(!names.some((n) => n.indexOf('鎶ュ憡') >= 0 || n.indexOf('瀹為獙') >= 0), 'D 远端没有乱码名')
  check(names.indexOf('.remote-ssh.json') < 0, 'D 插件自有连接信息没有被推到远端（issue #20 修复仍然有效）')
  check(names.indexOf('README.md') < 0, 'D 占位 README 也没有被推上去')
  check(existsSync(join(remoteUp, '报告_2026Q1.csv')) && readFileSync(join(remoteUp, '报告_2026Q1.csv'), 'utf8') === 'REPORT\n', 'D 内容完好')
}

rmSync(work, { recursive: true, force: true })
console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败')
if (fail) process.exit(1)
