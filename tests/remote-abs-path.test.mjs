/**
 * 远端绝对路径回归（issue #39）："/sidebar/file 把远端根拼了两次"。
 *
 * 报告者的最小复现：远程工作区会话里打开一条**远端绝对路径**（/home/dev/app/docs/file.md），
 * /sidebar/file 命中远程工作区后无条件 `localToRemote(rawPath, mirror, remoteRoot)`，
 * 而 localToRemote 的契约是「入参必须是本地镜像路径」：不在镜像前缀下就当成相对路径再拼一次远端根
 * → `/home/dev/app` + `/home/dev/app/docs/file.md` → `stat: cannot statx '<root><root>/…'`。
 * 同一类问题还波及 /remote-ssh/write、/remote-ssh/upload（都直接调 localToRemote）。
 *
 * 修法（单一汇合点）：localToRemote 先归一反斜杠，若入参本身是远端绝对路径（单 "/" 开头、
 * 非 UNC、且不在镜像根下）→ **原样下发**。另修 sidebarEntriesFrom：POSIX 根用 POSIX 拼接，
 * 否则 Windows 宿主上 tree 条目会变成 `\home\dev\app\sub`，客户端回传后认不出是远端绝对路径。
 *
 * 分五段：
 *   A. localToRemote 真值表（镜像成员 / 镜像根 / 远端绝对 / win32 归一形态 / Linux 镜像 / UNC / 盘符越界）
 *   B. sidebarEntriesFrom 的 POSIX 拼接（含 Windows 根不回归）
 *   C. 真实 handleSidebarFile：远端绝对路径只拼一次（posix 形态 + win32 归一形态）
 *   D. 真实 handleRemoteWrite：同样只拼一次（报告者点名的同族入口）
 *   E. 接线断言 + 变异负向控制
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

const MIRROR = 'C:\\Users\\dev\\.dsh\\remote-workspaces\\wm1234abcd'
const REMOTE_ROOT = '/home/dev/app'

// ───────────────────── A. localToRemote ─────────────────────
const l2rFactory = new Function(
  'ctx', 'isUnderMirrorBase',
  grab('function localToRemote') + '\nreturn { localToRemote };'
)
const l2r = (p, m, r) => l2rFactory({ logger: { debug() {}, warn() {} } }, (x) => String(x).replace(/\\/g, '/').toLowerCase().startsWith('/home/u/.dsh/remote-workspaces/')).localToRemote(p, m, r)

{
  console.log('A. localToRemote（远端绝对路径原样下发，镜像路径仍按前缀剥离）')
  check(l2r(MIRROR + '\\docs\\a.md', MIRROR, REMOTE_ROOT) === REMOTE_ROOT + '/docs/a.md', 'A1 镜像成员 → 剥前缀拼远端根')
  check(l2r(MIRROR, MIRROR, REMOTE_ROOT) === REMOTE_ROOT, 'A2 镜像根本身 → 远端根')
  check(l2r('/home/dev/app/docs/file.md', MIRROR, REMOTE_ROOT) === '/home/dev/app/docs/file.md', 'A3 远端绝对路径 → 原样下发（不再拼一次）')
  check(l2r('/tmp/x.log', MIRROR, REMOTE_ROOT) === '/tmp/x.log', 'A4 远端 /tmp 路径 → 原样下发')
  check(l2r('\\home\\dev\\app\\docs\\file.md', MIRROR, REMOTE_ROOT) === '/home/dev/app/docs/file.md', 'A5 win32 归一形态（单前导反斜杠、无盘符）→ 归一后原样下发')
  check(l2r('/home/u/.dsh/remote-workspaces/wm9/sub/f.md', '/home/u/.dsh/remote-workspaces/wm9', REMOTE_ROOT) === REMOTE_ROOT + '/sub/f.md', 'A6 Linux 镜像路径（也以 / 开头）→ 仍先剥镜像前缀，不误判为远端绝对路径')
  check(l2r('//server/share/f', MIRROR, REMOTE_ROOT) === REMOTE_ROOT + '/server/share/f', 'A7 UNC 不当成远端绝对路径（保持旧兜底行为）')
  check(l2r('C:\\other\\x.txt', MIRROR, REMOTE_ROOT) === REMOTE_ROOT + '/other/x.txt', 'A8 镜像之外的盘符路径 → 旧兜底行为不变（保守）')
}

// ───────────────────── B. sidebarEntriesFrom ─────────────────────
const entriesFactory = new Function('join', grab('function sidebarEntriesFrom') + '\nreturn { sidebarEntriesFrom };')
const { sidebarEntriesFrom } = entriesFactory(join)

{
  console.log('B. sidebarEntriesFrom（POSIX 根用 POSIX 拼接）')
  const remote = [{ name: 'sub', type: 'directory' }, { name: 'a.md', type: 'file' }]
  const posix = sidebarEntriesFrom(remote, '/home/dev/app')
  check(posix[0].path === '/home/dev/app/sub' && posix[1].path === '/home/dev/app/a.md', 'B1 POSIX 根 → /home/dev/app/sub（不再是 \\home\\dev\\app\\sub）')
  const trail = sidebarEntriesFrom(remote, '/home/dev/app/')
  check(trail[0].path === '/home/dev/app/sub', 'B2 根带尾斜杠也归一（不出现双斜杠）')
  const win = sidebarEntriesFrom(remote, MIRROR)
  check(win[1].path === join(MIRROR, 'a.md'), 'B3 Windows 根仍用 path.join（不回归）')
  const empty = sidebarEntriesFrom([{ name: 'x', type: 'file' }], '')
  check(empty[0].path === 'x', 'B4 空根 → 只返回名字（与 path.join 一致）')
  check(posix[0].isDir === true && posix[1].isDir === false, 'B5 目录标记与排序不受影响')
}

// ───────────────────── C. handleSidebarFile ─────────────────────
function sidebarFileHarness() {
  const rec = { fetched: [], bodies: [] }
  const ctx = { logger: { debug() {}, warn() {} } }
  const isUnder = (x) => String(x).replace(/\\/g, '/').toLowerCase().startsWith('/home/u/.dsh/remote-workspaces/')
  const fn = new Function(
    'ctx', 'isUnderMirrorBase', 'requestTrust', 'trustErrorMessage', 'writeJson', 'matchRemoteWorkspace',
    'readRemoteInfoSync', 'getProfile', 'localToRemote', 'remoteFetchBytes', 'REMOTE_DOWNLOAD_LIMIT',
    'mediaTypeForPath', 'sessionCwdFrom', 'resolveSessionPath', 'unresolvedPathMessage', 'stat', 'readFile', 'Buffer',
    grab('async function handleSidebarFile') + '\nreturn handleSidebarFile;'
  )
  const handler = fn(
    ctx, isUnder,
    () => 'ok', () => 'denied',
    (res, status, body) => { res.status = status; res.body = JSON.stringify(body) },
    () => ({ id: 'w1', mirrorPath: 'C:/Users/dev/.dsh/remote-workspaces/wm1234abcd' }),
    () => ({ profileId: 'p1', remotePath: '/home/dev/app' }),
    () => ({ id: 'p1' }),
    l2rFactory(ctx, isUnder).localToRemote,
    async (profile, remotePath) => { rec.fetched.push(remotePath); return { ok: true, buffer: Buffer.from('CONTENT') } },
    65536,
    () => 'text/plain',
    () => MIRROR, () => ({ resolved: true, path: MIRROR }), () => '',
    async () => ({ isFile: () => true, size: 1 }), async () => Buffer.from('LOCAL'),
    Buffer
  )
  rec.call = async (rawPath) => {
    const res = { status: 0, body: null, headers: {}, writeHead(s) { this.status = s }, end() {} }
    const url = '/sidebar/file?sessionId=s1&path=' + encodeURIComponent(rawPath) + '&cwd=' + encodeURIComponent(MIRROR)
    await handler({ method: 'GET', url, headers: {} }, res)
    return res
  }
  return rec
}

{
  console.log('C. handleSidebarFile（真实处理器 + 假远端）：远端绝对路径只拼一次')
  const h = sidebarFileHarness()
  const r1 = await h.call('/home/dev/app/docs/file.md')
  check(r1.status === 200 && h.fetched[0] === '/home/dev/app/docs/file.md', 'C1 posix 远端绝对路径 → 只拼一次（' + h.fetched[0] + '）')
  const h2 = sidebarFileHarness()
  await h2.call('\\home\\dev\\app\\docs\\file.md')
  check(h2.fetched[0] === '/home/dev/app/docs/file.md', 'C2 win32 归一形态 → 归一后只拼一次（' + h2.fetched[0] + '）')
  const h3 = sidebarFileHarness()
  await h3.call(MIRROR + '\\docs\\file.md')
  check(h3.fetched[0] === '/home/dev/app/docs/file.md', 'C3 镜像路径 → 照旧映射（无回归）')
  const h4 = sidebarFileHarness()
  await h4.call('/tmp/x.log')
  check(h4.fetched[0] === '/tmp/x.log', 'C4 /tmp/x.log → 原样下发')
}

// ───────────────────── D. handleRemoteWrite ─────────────────────
{
  console.log('D. handleRemoteWrite（报告者点名的同族入口）：远端绝对路径只拼一次')
  const rec = { cmds: [] }
  const ctx = { logger: { debug() {}, warn() {} } }
  const isUnder = (x) => String(x).replace(/\\/g, '/').toLowerCase().startsWith('/home/u/.dsh/remote-workspaces/')
  const handler = new Function(
    'ctx', 'isUnderMirrorBase', 'requestTrust', 'denyRequest', 'readJsonBody', 'writeJson', 'writeOk',
    'matchRemoteWorkspace', 'readRemoteInfoSync', 'getProfile', 'localToRemote', 'runPooled',
    'buildReadPageCommand', 'parseStatFrame', 'shellQuotePath', 'invalidateRemoteCaches', 'freshnessForget',
    'wrapperDir', 'writeFileSync', 'remoteMtimeInfo', 'REMOTE_WRITE_LIMIT', 'Buffer',
    grab('function detectRemoteTextFormat') + '\n' + grab('function encodeRemoteText') + '\n' +
    grab('async function handleRemoteWrite') + '\nreturn handleRemoteWrite;'
  )(
    ctx, isUnder,
    () => 'ok', () => {},
    async () => ({ path: '/home/dev/app/docs/file.md', content: 'x\n' }),
    (res, status, body) => { res.status = status; res.body = JSON.stringify(body) },
    (res, value) => { res.status = 200; res.body = JSON.stringify({ ok: true, value }) },
    () => ({ id: 'w1', mirrorPath: 'C:/Users/dev/.dsh/remote-workspaces/wm1234abcd' }),
    () => ({ profileId: 'p1', remotePath: '/home/dev/app' }),
    () => ({ id: 'p1' }),
    l2rFactory(ctx, isUnder).localToRemote,
    async (p, cmd) => { rec.cmds.push(String(cmd)); return { ok: true, stdout: 'X' } },
    () => 'CMD',
    () => ({ framed: true, err: null, size: 2, mtime: 1700000000, rest: Buffer.from('x\n').toString('base64') }),
    (p) => "'" + p + "'",
    () => {}, () => {}, '/wrapper', () => {},
    async () => ({ ok: true, exists: true, stamp: '2:1700000001' }),
    32 * 1024 * 1024, Buffer
  )
  const res = { status: 0, body: null }
  await handler({ method: 'POST' }, res)
  const writeCmd = rec.cmds.find((c) => c.startsWith('base64 -d > ')) || ''
  check(res.status === 200 && writeCmd.includes("'/home/dev/app/docs/file.md'"), 'D1 写入路径只拼一次（' + writeCmd.slice(0, 80) + '）')
  check(!writeCmd.includes('/home/dev/app/home/dev/app'), 'D2 不再出现双拼远端根')
}

// ───────────────────── E. 接线 + 变异 ─────────────────────
{
  console.log('E. 接线断言 + 变异负向控制')
  check(/function localToRemote\(localPath, mirrorCwd, remoteBase\)/.test(src), 'E1 修复点在 localToRemote（唯一汇合点）')
  check(/isUnderMirrorBase\(rel\)/.test(grab('function localToRemote')), 'E2 用 isUnderMirrorBase 排除 Linux 镜像路径')
  check(/const remotePath = localToRemote\(rawPath, ws\.mirrorPath/.test(grab('async function handleSidebarFile')), 'E3 /sidebar/file 走同一映射（修复自动覆盖）')
  check(/localToRemote\(dir, ws\.mirrorPath/.test(src) && /localToRemote\(rawPath, ws\.mirrorPath/.test(grab('async function handleRemoteWrite')), 'E4 /remote-ssh/upload 与 /remote-ssh/write 也走同一映射')
  check(/posixJoin \? posixRoot \+ "\/" \+ name : join\(localCwd, name\)/.test(grab('function sidebarEntriesFrom')), 'E5 tree 条目按根形态选择拼接')

  // 变异 1：去掉远端绝对路径分支 → C1/C2/D1 的断言会红
  const mutatedL2r = grab('function localToRemote').replace(/} else if \(rel\.startsWith\("\/"\) && !rel\.startsWith\("\/\/"\) && !isUnderMirrorBase\(rel\)\) \{[\s\S]*?\n        return rel;\n      \} else \{/, '} else {')
  check(mutatedL2r !== grab('function localToRemote'), 'E6 变异 1：删掉远端绝对路径分支（C1/C2/D1 会红）')
  const mutated = new Function('ctx', 'isUnderMirrorBase', mutatedL2r + '\nreturn localToRemote;')({ logger: { debug() {}, warn() {} } }, () => false)
  check(mutated('/home/dev/app/x', MIRROR, REMOTE_ROOT) === REMOTE_ROOT + '/home/dev/app/x', 'E7 变异 1 复现旧 bug（双拼远端根）')

  // 变异 2：sidebarEntriesFrom 回退成 path.join → B1 会红
  const mutatedEntries = new Function('join', grab('function sidebarEntriesFrom').replace(/posixJoin \? posixRoot \+ "\/" \+ name : join\(localCwd, name\)/, 'join(localCwd, name)') + '\nreturn sidebarEntriesFrom;')(join)
  check(mutatedEntries([{ name: 'sub', type: 'directory' }], '/home/dev/app')[0].path !== '/home/dev/app/sub', 'E8 变异 2：POSIX 根用 path.join → B1 会红')
}

console.log('')
console.log('  结果: ' + pass + ' 通过, ' + fail + ' 失败')
if (fail > 0) process.exitCode = 1