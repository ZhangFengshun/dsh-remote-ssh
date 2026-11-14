#!/usr/bin/env node
/**
 * 真机验证：远端绝对路径打开文件不再双拼远端根（issue #39）。
 *
 * 复现（旧行为）：远程工作区会话里打开 /home/<user>/app/docs/file.md 时，
 * /sidebar/file 会把它当相对路径再拼一次远端根 → `stat: cannot statx '<root><root>/…'`。
 *
 * 做法：把 lib/index.js 里的**真实函数**（localToRemote / handleSidebarFile）切片出来，
 * 只把 ctx 相关依赖换成假对象，remoteFetchBytes 换成"真 ssh 取字节"，于是走的就是线上代码路径。
 * 断言：posix 绝对路径、win32 归一形态（\home\…）、镜像路径三种入参都能拿到同一份远端内容；
 * 并把 localToRemote 的修复分支删掉做**负向控制**，确认旧行为确实会双拼（说明判据有效）。
 *
 * 用法（不要把真实主机写进仓库）：
 *   node scripts/verify-remote-abs-path.mjs --host <host> --user <user> --key <path> \
 *        [--port 22] [--remote-root ~/proj] [--file <相对文件>]
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const arg = (name, def) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def
}
const HOST = arg('host')
const USER = arg('user')
const KEY = arg('key')
const PORT = arg('port', '22')
const REMOTE_ROOT = arg('remote-root', '')
const FILE = arg('file', '')
const SSH = process.env.DSH_REMOTE_SSH_VERIFY_SSH || (process.platform === 'win32'
  ? 'C:\\Windows\\System32\\OpenSSH\\ssh.exe'
  : 'ssh')
if (!HOST || !USER || !KEY) {
  console.error('用法: node scripts/verify-remote-abs-path.mjs --host <host> --user <user> --key <path> [--port 22] [--remote-root <dir>] [--file <rel>]')
  process.exit(2)
}
const TARGET = USER + '@' + HOST
const SSH_ARGS = ['-i', KEY, '-p', String(PORT), '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=15']

let pass = 0
let fail = 0
const check = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label) } else { fail++; console.log('  ✗ FAIL: ' + label) }
}
function ssh(cmd) {
  return new Promise((resolve) => {
    const h = spawn(SSH, [...SSH_ARGS, TARGET, cmd], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    h.stdout.on('data', (c) => { out += c.toString('utf8') })
    h.stderr.on('data', (c) => { err += c.toString('utf8') })
    h.on('close', (code) => resolve({ ok: code === 0, stdout: out, stderr: err }))
  })
}
const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'"

// ── 远端根与目标文件 ──
// ~/ 不能被单引号包住（那样 shell 不展开）；用双引号让 $HOME 展开
const cdTarget = String(REMOTE_ROOT || '.').replace(/^~\//, '$HOME/')
const rootRes = await ssh('cd "' + cdTarget + '" >/dev/null 2>&1 && pwd')
if (!rootRes.ok) { console.error('远端根不可用: ' + (REMOTE_ROOT || '.')); process.exit(2) }
const remoteRoot = rootRes.stdout.trim()
let relFile = FILE
if (!relFile) {
  const f = await ssh('cd ' + shq(remoteRoot) + ' && find . -maxdepth 3 -type f 2>/dev/null | head -1')
  relFile = f.stdout.trim().replace(/^\.\//, '')
  if (!relFile) { console.error('远端根下找不到可用于验证的文件（可用 --file 指定）'); process.exit(2) }
}
const absFile = remoteRoot.replace(/\/+$/, '') + '/' + relFile
const contentRes = await ssh('base64 -w0 < ' + shq(absFile))
if (!contentRes.ok) { console.error('读不到目标文件: ' + absFile); process.exit(2) }
const expect = Buffer.from(contentRes.stdout.trim(), 'base64')
console.log('  目标：<remote-root>/' + relFile + '（' + expect.length + ' 字节）')

// ── 从插件源码切真实函数 ──
const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
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

const MIRROR = 'C:\\Users\\verify\\.dsh\\remote-workspaces\\wm-verify'
const l2rWith = (code) => new Function('ctx', 'isUnderMirrorBase', code + '\nreturn localToRemote;')(
  { logger: { debug() {}, warn() {} } },
  (x) => String(x).replace(/\\/g, '/').toLowerCase().startsWith('/home/u/.dsh/remote-workspaces/')
)

const realL2r = l2rWith(grab('function localToRemote'))

function makeHandler(l2r) {
  const fetched = []
  const handler = new Function(
    'ctx', 'isUnderMirrorBase', 'requestTrust', 'trustErrorMessage', 'writeJson', 'matchRemoteWorkspace',
    'readRemoteInfoSync', 'getProfile', 'localToRemote', 'remoteFetchBytes', 'REMOTE_DOWNLOAD_LIMIT',
    'mediaTypeForPath', 'sessionCwdFrom', 'resolveSessionPath', 'unresolvedPathMessage', 'stat', 'readFile', 'Buffer',
    grab('async function handleSidebarFile') + '\nreturn handleSidebarFile;'
  )(
    { logger: { debug() {}, warn() {} } },
    () => false,
    () => 'ok', () => 'denied',
    (res, status, body) => { res.status = status; res.body = JSON.stringify(body) },
    () => ({ id: 'w1', mirrorPath: MIRROR }),
    () => ({ profileId: 'p1', remotePath: remoteRoot }),
    () => ({ id: 'p1' }),
    l2r,
    async (profile, remotePath) => {
      fetched.push(remotePath)
      const r = await ssh('base64 -w0 < ' + shq(remotePath))
      if (!r.ok) return { ok: false, error: 'stat: cannot statx ' + shq(remotePath) + ': No such file or directory' }
      return { ok: true, buffer: Buffer.from(r.stdout.trim(), 'base64') }
    },
    64 * 1024 * 1024,
    () => 'text/plain',
    () => MIRROR, () => ({ resolved: true, path: MIRROR }), () => '',
    async () => ({ isFile: () => true, size: 1 }), async () => Buffer.from(''),
    Buffer
  )
  return { handler, fetched }
}

async function callAbs(handler, rawPath) {
  const res = { status: 0, body: null, headers: {}, writeHead(s) { this.status = s }, end(b) { this.raw = b } }
  const url = '/sidebar/file?sessionId=s1&path=' + encodeURIComponent(rawPath) + '&cwd=' + encodeURIComponent(MIRROR)
  await handler({ method: 'GET', url, headers: {} }, res)
  return res
}

// 1) posix 远端绝对路径
{
  const { handler, fetched } = makeHandler(realL2r)
  const r = await callAbs(handler, absFile)
  check(r.status === 200, '1a posix 绝对路径 → 200')
  check(fetched[0] === absFile, '1b 只请求了一次远端路径，且路径与远端一致')
  check(r.raw && Buffer.compare(Buffer.from(r.raw), expect) === 0, '1c 内容与远端逐字节一致')
}

// 2) win32 归一形态（单前导反斜杠、无盘符）
{
  const { handler, fetched } = makeHandler(realL2r)
  const winForm = '\\' + absFile.replace(/^\//, '').replace(/\//g, '\\')
  const r = await callAbs(handler, winForm)
  check(r.status === 200, '2a win32 归一形态 → 200')
  check(fetched[0] === absFile, '2b 归一后仍只请求一次（' + fetched[0] + '）')
}

// 3) 镜像路径（无回归）
{
  const { handler, fetched } = makeHandler(realL2r)
  const mirrorPath = MIRROR + '\\' + relFile.replace(/\//g, '\\')
  const r = await callAbs(handler, mirrorPath)
  check(r.status === 200 && fetched[0] === absFile, '3 镜像路径 → 映射到同一远端文件（无回归）')
}

// 4) 负向控制：删掉修复分支后必须复现"双拼远端根"
{
  const broken = grab('function localToRemote').replace(/} else if \(rel\.startsWith\("\/"\) && !rel\.startsWith\("\/\/"\) && !isUnderMirrorBase\(rel\)\) \{[\s\S]*?\n        return rel;\n      \} else \{/, '} else {')
  check(broken !== grab('function localToRemote'), '4a 负向控制：修复分支已被移除（用于复现旧 bug）')
  const { handler, fetched } = makeHandler(l2rWith(broken))
  const r = await callAbs(handler, absFile)
  check(r.status === 400, '4b 旧逻辑下同一请求 → 400')
  check(fetched[0] === remoteRoot.replace(/\/+$/, '') + absFile, '4c 旧逻辑确实把远端根拼了两次（' + fetched[0] + '）')
}

console.log('')
console.log(fail ? '  结果: ' + fail + ' 项失败（' + pass + ' 项通过）' : '  结果: 全部通过（' + pass + ' 项）')
process.exit(fail ? 1 : 0)