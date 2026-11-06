#!/usr/bin/env node
/**
 * 真机验证：远程工作区「编辑器保存」落到远端（issue #37）。
 *
 * 为什么需要单独跑真机：单测只能证明处理器"该写什么字节"，证明不了
 * 「远端 stat 帧 / base64 写 / mtime 乐观锁 / 行尾与 BOM 还原」在真实 sshd + 真实 bash 上成立。
 *
 * 做法：把 lib/index.js 里的**真实函数**（shellQuotePath / statFrameSnippet / errSnippet /
 * parseStatFrame / sanitizeErrLine / buildReadPageCommand / remoteMtimeInfo / detectRemoteTextFormat /
 * encodeRemoteText / handleRemoteWrite）切片出来，只把 ctx 相关的依赖换成假对象，
 * runPooled 换成"真 ssh 子进程"—— 于是走的就是线上那条代码路径。
 *
 * 用法（不要把真实主机写进仓库）：
 *   node scripts/verify-remote-write-route.mjs --host <host> --user <user> --key <path> [--port 22]
 * 依赖：本机 OpenSSH 客户端；目标机 POSIX shell + GNU coreutils（stat -c / base64）。
 */
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const arg = (name, def) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def
}
const HOST = arg('host')
const USER = arg('user')
const KEY = arg('key')
const PORT = arg('port', '22')
const SSH = process.env.DSH_REMOTE_SSH_VERIFY_SSH || (process.platform === 'win32'
  ? 'C:\\Windows\\System32\\OpenSSH\\ssh.exe'
  : 'ssh')
if (!HOST || !USER || !KEY) {
  console.error('用法: node scripts/verify-remote-write-route.mjs --host <host> --user <user> --key <keyPath> [--port 22]')
  process.exit(2)
}

let pass = 0
let fail = 0
const check = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label) } else { fail++; console.log('  ✗ FAIL: ' + label) }
}
const TARGET = USER + '@' + HOST
const SSH_ARGS = ['-i', KEY, '-p', String(PORT), '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=15']

/** 真 ssh：一条命令 + stdin，返回与插件 runPooled 同形的结果。 */
function sshRun(cmd, stdinData) {
  return new Promise((resolve) => {
    const h = spawn(SSH, [...SSH_ARGS, TARGET, cmd], { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    h.stdout.on('data', (c) => { out += c.toString('utf8') })
    h.stderr.on('data', (c) => { err += c.toString('utf8') })
    h.on('close', (code) => resolve({ ok: code === 0, exitCode: code, stdout: out, stderr: err, truncated: false }))
    if (stdinData !== undefined && stdinData !== null) h.stdin.write(String(stdinData))
    h.stdin.end()
  })
}

// ── 从插件源码里切真实函数 ──
const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
function grab(marker) {
  const start = src.indexOf(marker)
  if (start < 0) throw new Error('源码里找不到: ' + marker)
  const braceStart = src.indexOf('{', start)
  let depth = 0
  let i = braceStart
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) break }
  }
  // 带上前面的 `function`/`async function` 声明行（marker 已从 function 起）
  return src.slice(start, i + 1)
}

const stMark = src.split('\n').find((l) => l.includes('const DSH_ST_MARK ='))
if (!stMark) throw new Error('源码里找不到 DSH_ST_MARK 常量')
const code = [
  stMark.trim(),
  grab('function shellQuote'),
  grab('function shellQuotePath'),
  grab('function statFrameSnippet'),
  grab('function errSnippet'),
  grab('function parseStatFrame'),
  grab('function sanitizeErrLine'),
  grab('function buildReadPageCommand'),
  grab('function syncErrText'),
  grab('async function remoteMtimeInfo'),
  grab('function detectRemoteTextFormat'),
  grab('function encodeRemoteText'),
  grab('async function handleRemoteWrite')
].join('\n\n')

const mirrorDir = mkdtempSync(join(tmpdir(), 'dsh-verify-write-'))
const ws = { id: 'verify-ws', mirrorPath: mirrorDir.replace(/\\/g, '/'), remotePath: '/tmp/dsh-verify-write' }
const profile = { id: 'verify-profile', host: HOST, user: USER, port: Number(PORT), authMethod: 'key', keyPath: KEY }
let scripted = null // 由每个用例设置

const api = new Function(
  'requestTrust', 'denyRequest', 'readJsonBody', 'writeJson', 'writeOk',
  'matchRemoteWorkspace', 'readRemoteInfoSync', 'getProfile', 'localToRemote',
  'runPooled', 'invalidateRemoteCaches', 'freshnessForget', 'wrapperDir', 'writeFileSync',
  'REMOTE_WRITE_LIMIT', 'Buffer',
  code + '\nreturn { handleRemoteWrite, detectRemoteTextFormat, encodeRemoteText };'
)(
  () => 'ok',
  (res) => { res.status = 403 },
  async () => scripted,
  (res, status, body) => { res.status = status; res.body = JSON.stringify(body) },
  (res, value) => { res.status = 200; res.body = JSON.stringify({ ok: true, value }) },
  () => ws,
  () => ({ profileId: profile.id, remotePath: ws.remotePath }),
  () => profile,
  (local, mirror, remote) => {
    const rel = String(local).replace(/\\/g, '/').slice(mirror.length).replace(/^\/+/, '')
    return remote.replace(/\/+$/, '') + (rel ? '/' + rel : '')
  },
  (p, cmd, stdinData) => sshRun(cmd, stdinData),
  () => {},
  () => {},
  mirrorDir,
  writeFileSync,
  32 * 1024 * 1024,
  Buffer
)

const remoteAbs = (rel) => ws.remotePath + '/' + rel
async function writeRemoteBytes(rel, buf) {
  const r = await sshRun("mkdir -p " + JSON.stringify(ws.remotePath) + " && base64 -d > " + JSON.stringify(remoteAbs(rel)), Buffer.from(buf).toString('base64'))
  if (!r.ok) throw new Error('准备远端文件失败: ' + r.stderr)
}
async function readRemoteBytes(rel) {
  const r = await sshRun('base64 -w0 < ' + JSON.stringify(remoteAbs(rel)) + ' 2>/dev/null || true')
  return Buffer.from(r.stdout.trim(), 'base64')
}
async function remoteStat(rel) {
  const r = await sshRun("stat -c'%s %Y' " + JSON.stringify(remoteAbs(rel)))
  const m = /^(\d+)\s+(\d+)$/.exec(r.stdout.trim())
  return m ? { size: Number(m[1]), mtimeMs: Number(m[2]) * 1000 } : null
}
async function call(payload) {
  scripted = payload
  const res = { status: 0, body: null }
  await api.handleRemoteWrite({ method: 'POST' }, res)
  const body = res.body ? JSON.parse(res.body) : null
  if (process.env.DSH_VERIFY_DEBUG && res.status !== 200) console.log('    [debug] ' + res.status + ' ' + JSON.stringify(body))
  return { status: res.status, body }
}

console.log('  目标：' + ws.remotePath + '（镜像临时目录已建）')
await sshRun('rm -rf ' + JSON.stringify(ws.remotePath) + ' && mkdir -p ' + JSON.stringify(ws.remotePath))

try {
  // 1) CRLF 文件：编辑器送 LF，远端应保持 CRLF
  await writeRemoteBytes('crlf.txt', Buffer.from('old1\r\nold2\r\n', 'utf8'))
  let st = await remoteStat('crlf.txt')
  let r = await call({ path: mirrorDir + '/crlf.txt', content: 'new1\nnew2\n', expectedMtimeMs: st.mtimeMs })
  check(r.status === 200 && r.body.ok === true, 'CRLF：保存返回 200 且信封正确')
  check((await readRemoteBytes('crlf.txt')).toString('utf8') === 'new1\r\nnew2\r\n', 'CRLF：远端字节 = new1\\r\\nnew2\\r\\n（行尾被还原）')
  check(JSON.stringify(readFileSync(join(mirrorDir, 'crlf.txt')).toString('utf8')) === JSON.stringify('new1\r\nnew2\r\n'), 'CRLF：本地镜像同步成同一份字节')

  // 2) UTF-8 BOM：保存后 BOM 仍在
  await writeRemoteBytes('bom.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\r\n', 'utf8')]))
  st = await remoteStat('bom.txt')
  r = await call({ path: mirrorDir + '/bom.txt', content: 'b\n', expectedMtimeMs: st.mtimeMs })
  const bomBytes = await readRemoteBytes('bom.txt')
  check(r.status === 200, 'BOM：保存返回 200')
  check(bomBytes[0] === 0xef && bomBytes[1] === 0xbb && bomBytes[2] === 0xbf, 'BOM：远端开头仍是 EF BB BF')
  check(bomBytes.subarray(3).toString('utf8') === 'b\r\n', 'BOM：BOM 之后是 b\\r\\n')

  // 3) 乐观锁：基线过期 → 409，且文件不被改
  st = await remoteStat('crlf.txt')
  r = await call({ path: mirrorDir + '/crlf.txt', content: 'SHOULD-NOT-WRITE\n', expectedMtimeMs: st.mtimeMs + 1000 })
  check(r.status === 409 && r.body.error.code === 'fs-conflict', '乐观锁：基线不匹配 → 409 fs-conflict')
  check((await readRemoteBytes('crlf.txt')).toString('utf8') === 'new1\r\nnew2\r\n', '乐观锁：冲突时远端文件一字未改')

  // 4) 非 UTF-8（GBK）：明确拒绝，不覆盖
  await writeRemoteBytes('gbk.txt', Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a]))
  st = await remoteStat('gbk.txt')
  r = await call({ path: mirrorDir + '/gbk.txt', content: 'x\n' })
  check(r.status === 400 && /非 UTF-8/.test(r.body.error.message), 'GBK：明确拒绝（400 + 非 UTF-8 提示）')
  check((await readRemoteBytes('gbk.txt')).equals(Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a])), 'GBK：拒绝后远端字节原样未动')

  // 5) 新文件（无基线）：按 UTF-8 + LF 创建
  r = await call({ path: mirrorDir + '/new.txt', content: 'fresh\n' })
  check(r.status === 200, '新文件：保存返回 200')
  check((await readRemoteBytes('new.txt')).toString('utf8') === 'fresh\n', '新文件：远端内容 = fresh\\n')

  // 6) 带基线但远端文件不存在 → 409（不静默重建）
  r = await call({ path: mirrorDir + '/ghost.txt', content: 'x\n', expectedMtimeMs: 1700000000000 })
  check(r.status === 409 && /no longer exists/.test(r.body.error.message), '不存在：带基线 → 409（提示文件已不在）')
  const ghost = await remoteStat('ghost.txt')
  check(ghost === null, '不存在：没有凭空创建 ghost.txt')
} finally {
  await sshRun('rm -rf ' + JSON.stringify(ws.remotePath))
  try { rmSync(mirrorDir, { recursive: true, force: true }) } catch (e) {}
}

console.log('')
console.log(fail ? '  结果: ' + fail + ' 项失败（' + pass + ' 项通过）' : '  结果: 全部通过（' + pass + ' 项）')
process.exit(fail ? 1 : 0)