#!/usr/bin/env node
/**
 * 真机验证：媒体/预览读取命令（性能 2.4.48）——一次往返、字节精确、超限/缺失正确报错。
 *
 * 背景：`/sidebar/file`（图片/PDF/曲线预览）旧实现 stat、base64 两条命令 = 2 个 RTT；
 * 新版 `buildFetchBytesCommand` 把 stat+base64 合成一条命令 = 1 个 RTT，并带 ERR 帧。
 * 本脚本把**插件里真实的函数**切片出来，直接跑在真实 ssh 会话上，和"另一次独立读取"逐字节对比。
 *
 * 用法（不要把真实主机写进仓库）：
 *   node scripts/verify-media-fetch-command.mjs --host <host> --user <user> --key <path> \
 *        [--port 22] [--remote-root <dir>] [--file <rel>]
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }
const HOST = arg('host'), USER = arg('user'), KEY = arg('key'), PORT = arg('port', '22')
const ROOT = arg('remote-root', ''), FILE = arg('file', '')
if (!HOST || !USER || !KEY) {
  console.error('用法: node scripts/verify-media-fetch-command.mjs --host <host> --user <user> --key <path> [--port 22] [--remote-root <dir>] [--file <rel>]')
  process.exit(2)
}
const SSH = process.env.DSH_REMOTE_SSH_VERIFY_SSH || (process.platform === 'win32'
  ? 'C:\\Windows\\System32\\OpenSSH\\ssh.exe'
  : 'ssh')
const TARGET = USER + '@' + HOST
const SSH_ARGS = ['-i', KEY, '-p', String(PORT), '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=30', '-o', 'ClearAllForwardings=yes', '-o', 'Compression=yes']

let pass = 0, fail = 0
const check = (c, l) => { if (c) { pass++; console.log('  ✓ ' + l) } else { fail++; console.log('  ✗ FAIL: ' + l) } }
const stats = (xs) => { const s = [...xs].sort((a, b) => a - b); const med = s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2); return 'min=' + s[0] + 'ms p50=' + med + 'ms max=' + s[s.length - 1] + 'ms' }

class Channel {
  constructor() { this.seq = 0; this.buf = ''; this.waiters = []; this.closed = false }
  async connect() {
    this.proc = spawn(SSH, [...SSH_ARGS, '-T', TARGET, 'bash'], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.proc.stdout.on('data', (c) => { this.buf += c.toString('utf8'); this.pump() })
    this.proc.stderr.on('data', () => {})
    this.proc.on('close', () => { this.closed = true })
    await this.send('true')
  }
  pump() {
    while (this.waiters.length) {
      const w = this.waiters[0]
      const idx = this.buf.indexOf(w.marker)
      if (idx < 0) return
      const payload = this.buf.slice(0, idx)
      this.buf = this.buf.slice(idx + w.marker.length)
      // echo 会在标记后补一个换行；不剥掉的话下一条输出会以空行开头，stat 帧解析会失败
      if (this.buf.startsWith('\r\n')) this.buf = this.buf.slice(2)
      else if (this.buf.startsWith('\n')) this.buf = this.buf.slice(1)
      this.waiters.shift()
      w.resolve(payload)
    }
  }
  send(cmd) {
    const id = ++this.seq
    const marker = '__DSHMEDIA' + id + '__'
    const t0 = Date.now()
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error('closed'))
      const timer = setTimeout(() => reject(new Error('timeout: ' + cmd.slice(0, 50))), 60000)
      this.waiters.push({ marker, resolve: (p) => { clearTimeout(timer); resolve({ payload: p, ms: Date.now() - t0 }) } })
      this.proc.stdin.write(cmd + '\necho ' + marker + '\n')
    })
  }
  close() { try { this.proc.stdin.end() } catch (e) {} try { this.proc.kill() } catch (e) {} }
}

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
const DSH_MARK = '__DSH_ST__'
const sandbox = new Function('MAX_BYTES', [
  'const DSH_ST_MARK = ' + JSON.stringify(DSH_MARK) + ';',
  grab('function shellQuote'),
  grab('function shellQuotePath'),
  grab('function buildFetchBytesCommand'),
  grab('function sanitizeErrLine'),
  grab('function parseStatFrame'),
  'return { buildFetchBytesCommand, parseStatFrame };'
].join('\n'))(4 * 1024 * 1024)

const ch = new Channel()
await ch.connect()

// 目标文件
let root = ROOT
if (root) { const r = await ch.send('cd "' + root.replace(/^~\//, '$HOME/') + '" 2>/dev/null && pwd'); root = String(r.payload).trim() }
let rel = FILE
if (!rel && root) { const r = await ch.send('cd ' + JSON.stringify(root) + ' && find . -maxdepth 3 -type f 2>/dev/null | head -1'); rel = String(r.payload).trim().replace(/^\.\//, '') }
const remoteFile = rel ? (root ? root.replace(/\/+$/, '') + '/' + rel : rel) : ''
if (!remoteFile) { console.error('没有目标文件（用 --file 指定）'); process.exit(2) }

// 参照字节（另一条独立命令）
const ref = await ch.send('base64 -w0 < ' + JSON.stringify(remoteFile))
const expect = Buffer.from(String(ref.payload).trim(), 'base64')
console.log('  目标：<remote-root>/' + rel + '（' + expect.length + ' 字节）')

// 1) 正确性：新命令一次拿回，与参照逐字节一致
const cmd = sandbox.buildFetchBytesCommand(remoteFile, 64 * 1024 * 1024)
const r1 = await ch.send(cmd)
const fr = sandbox.parseStatFrame(String(r1.payload))
const got = Buffer.from(String(fr.rest || '').replace(/\s+/g, ''), 'base64')
check(fr.framed && fr.err === null, '1a 输出是合法 stat 帧（size=' + fr.size + ', mtime=' + fr.mtime + '）')
check(fr.size === expect.length, '1b 帧内 size 与真实字节数一致')
check(got.equals(expect), '1c base64 载荷与独立读取逐字节一致')
console.log('  新命令单次耗时 = ' + r1.ms + 'ms')

// 2) 计时：新命令 vs 旧的"stat + base64"两趟
const times1 = []
for (let i = 0; i < 5; i++) {
  const r = await ch.send(cmd)
  const f = sandbox.parseStatFrame(String(r.payload))
  times1.push(r.ms)
  if (!f.framed || f.err) throw new Error('新命令偶发失败: ' + String(f.err))
}
const oldStat = 'stat -c%s ' + JSON.stringify(remoteFile)
const oldB64 = 'base64 -w0 ' + JSON.stringify(remoteFile)
const times2 = []
for (let i = 0; i < 5; i++) {
  const t0 = Date.now()
  await ch.send(oldStat)
  await ch.send(oldB64)
  times2.push(Date.now() - t0)
}
console.log('  2) 新实现 1 趟 ×5 : ' + stats(times1))
console.log('  3) 旧实现 2 趟 ×5 : ' + stats(times2))

// 3) 超限：limit 设成 4 字节 → ERR 帧
const small = sandbox.buildFetchBytesCommand(remoteFile, 4)
const rs = await ch.send(small)
const fs2 = sandbox.parseStatFrame(String(rs.payload))
check(fs2.framed && /file too large/.test(String(fs2.err)) && /\((\d+) bytes\)/.test(String(fs2.err)), '3a 超限 → ERR 帧且带真实字节数（' + fs2.err + '）')

// 4) 缺失文件：ERR 帧 + 非零退出
const missing = sandbox.buildFetchBytesCommand(remoteFile + '.no-such-file-xyz', 64 * 1024 * 1024)
const rm = await ch.send(missing)
const fm = sandbox.parseStatFrame(String(rm.payload))
check(fm.framed && /No such file|not found|cannot stat/i.test(String(fm.err)), '4 缺失文件 → ERR 帧（' + String(fm.err).slice(0, 60) + '…）')

ch.close()
console.log('')
console.log(fail ? '  结果: ' + fail + ' 项失败（' + pass + ' 项通过）' : '  结果: 全部通过（' + pass + ' 项）')
process.exit(fail ? 1 : 0)