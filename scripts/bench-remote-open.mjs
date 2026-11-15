#!/usr/bin/env node
/**
 * 远程文件打开速度基准（用于「优化远程文件打开速度」的前后对比）。
 *
 * 测的是**真实链路**：一条持久 ssh 通道（等价插件的池化会话）上执行插件实际会发的命令，
 * 外加运行中宿主的两条 HTTP 路由（/sidebar/api/fs.read 与 /sidebar/file）。
 *
 * 用法（不要把真实主机写进仓库）：
 *   node scripts/bench-remote-open.mjs --host <host> --user <user> --key <path> --port 22 \
 *        --remote-root <远端工作区根> --file <相对文件> [--gui http://127.0.0.1:<port> --mirror <镜像根>]
 *
 * 输出：各阶段耗时（ms，多次采样的中位数/最小值）。
 */
import { spawn } from 'node:child_process'

const argv = process.argv.slice(2)
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }
const HOST = arg('host'), USER = arg('user'), KEY = arg('key'), PORT = arg('port', '22')
const ROOT = arg('remote-root', ''), FILE = arg('file', ''), GUI = arg('gui', ''), MIRROR = arg('mirror', '')
if (!HOST || !USER || !KEY) {
  console.error('用法: node scripts/bench-remote-open.mjs --host <host> --user <user> --key <path> [--port 22] [--remote-root <dir>] [--file <rel>] [--gui <url> --mirror <mirror>]')
  process.exit(2)
}
const SSH = process.env.DSH_REMOTE_SSH_VERIFY_SSH || (process.platform === 'win32'
  ? 'C:\\Windows\\System32\\OpenSSH\\ssh.exe'
  : 'ssh')
const TARGET = USER + '@' + HOST
const SSH_ARGS = ['-i', KEY, '-p', String(PORT), '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3',
  '-o', 'ClearAllForwardings=yes', '-o', 'Compression=yes']
const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'"
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 一条持久通道：等价插件的池化会话（bash + 每命令一个哨兵）。 */
class Channel {
  constructor() { this.seq = 0; this.buf = ''; this.waiters = []; this.closed = false }
  async connect() {
    const t0 = Date.now()
    this.proc = spawn(SSH, [...SSH_ARGS, '-T', TARGET, 'bash'], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.proc.stdout.on('data', (c) => { this.buf += c.toString('utf8'); this.pump() })
    this.proc.stderr.on('data', () => {})
    this.proc.on('close', () => { this.closed = true; this.pump() })
    // 等 bash 就绪（发一个探针）
    await this.send('true')
    return Date.now() - t0
  }
  pump() {
    while (this.waiters.length) {
      const w = this.waiters[0]
      const idx = this.buf.indexOf(w.marker)
      if (idx < 0) return
      const payload = this.buf.slice(0, idx)
      this.buf = this.buf.slice(idx + w.marker.length)
      this.waiters.shift()
      w.resolve(payload)
    }
  }
  send(cmd) {
    const id = ++this.seq
    const marker = '__DSHBENCH' + id + '__'
    const t0 = Date.now()
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error('channel closed'))
      const timer = setTimeout(() => reject(new Error('command timeout: ' + cmd.slice(0, 60))), 60000)
      this.waiters.push({ marker, resolve: (payload) => { clearTimeout(timer); resolve({ payload, ms: Date.now() - t0 }) } })
      this.proc.stdin.write(cmd + '\necho ' + marker + '\n')
    })
  }
  close() { try { this.proc.stdin.end() } catch (e) {} try { this.proc.kill() } catch (e) {} }
}

const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  const med = s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2)
  return { min: s[0], med, max: s[s.length - 1] }
}
const fmt = (s) => `min=${s.min}ms  p50=${s.med}ms  max=${s.max}ms`

async function httpJson(url, body) {
  const t0 = Date.now()
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const text = await r.text()
  return { ms: Date.now() - t0, status: r.status, bytes: text.length }
}
async function httpGetBytes(url) {
  const t0 = Date.now()
  const r = await fetch(url)
  const buf = Buffer.from(await r.arrayBuffer())
  return { ms: Date.now() - t0, status: r.status, bytes: buf.length }
}

const ch = new Channel()
const cold = await ch.connect()
console.log('  冷连接（含 bash 就绪） = ' + cold + ' ms')

// 选一个真实文件
let root = ROOT
if (root) {
  const r = await ch.send('cd "' + root.replace(/^~\//, '$HOME/') + '" 2>/dev/null && pwd')
  root = String(r.payload).trim()
}
let rel = FILE
if (!rel && root) {
  const r = await ch.send('cd ' + shq(root) + ' && find . -maxdepth 3 -type f 2>/dev/null | head -1')
  rel = String(r.payload).trim().replace(/^\.\//, '')
}
const remoteFile = rel ? (root ? root.replace(/\/+$/, '') + '/' + rel : rel) : ''
console.log('  目标文件 = ' + (remoteFile || '(未指定)') + (remoteFile ? '' : '（只测 RTT 类项）'))

// 1) 空命令 RTT
const rtt = []
for (let i = 0; i < 8; i++) rtt.push((await ch.send('true')).ms)
console.log('  1) 空命令 RTT            : ' + fmt(stats(rtt)))

if (remoteFile) {
  // 2) 插件现状：stat 单独一次
  const statCmd = 'f=' + shq(remoteFile) + "; if st=$(stat -c'%s %Y' -- \"$f\" 2>&1); then printf '%s:%s\\n' \"${st%% *}\" \"${st#* }\"; fi"
  const statMs = []
  for (let i = 0; i < 6; i++) statMs.push((await ch.send(statCmd)).ms)
  console.log('  2) stat 单独一次         : ' + fmt(stats(statMs)))

  // 3) 插件现状：base64 单独一次（媒体/图片走这条）
  const b64Cmd = 'base64 -w0 ' + shq(remoteFile)
  const b64Ms = []
  for (let i = 0; i < 6; i++) b64Ms.push((await ch.send(b64Cmd)).ms)
  console.log('  3) base64 单独一次       : ' + fmt(stats(b64Ms)))

  // 4) 现状合计（/sidebar/file 的两趟）
  const two = []
  for (let i = 0; i < 6; i++) {
    const t0 = Date.now()
    await ch.send(statCmd)
    await ch.send(b64Cmd)
    two.push(Date.now() - t0)
  }
  console.log('  4) 现状 2 趟（媒体路由） : ' + fmt(stats(two)))

  // 5) 合并成一趟（stat + base64，帧标记同 buildReadCommand）
  const merged = "f=" + shq(remoteFile) + "; if st=$(stat -c'%s %Y' -- \"$f\" 2>&1); then printf '__ST__%s:%s\\n' \"${st%% *}\" \"${st#* }\"; if [ \"${st%% *}\" -gt 4194304 ] 2>/dev/null; then head -c 4194304 -- \"$f\" | base64 -w0; else base64 -w0 -- \"$f\"; fi; fi"
  const mergedMs = []
  for (let i = 0; i < 6; i++) mergedMs.push((await ch.send(merged)).ms)
  console.log('  5) 合并 1 趟（提议）     : ' + fmt(stats(mergedMs)))

  // 6) 文本快路径（raw cat，插件 fs.read 现状）
  const rawCmd = "f=" + shq(remoteFile) + "; if st=$(stat -c'%s %Y' -- \"$f\" 2>&1); then printf '__ST__%s:%s\\n' \"${st%% *}\" \"${st#* }\"; cat -- \"$f\"; fi"
  const rawMs = []
  for (let i = 0; i < 6; i++) rawMs.push((await ch.send(rawCmd)).ms)
  console.log('  6) 文本 raw 1 趟（fs.read）: ' + fmt(stats(rawMs)))
}
ch.close()

// 7) HTTP 路由基线（运行中的宿主）
if (GUI && MIRROR) {
  console.log('  --- 运行中宿主的路由基线 ---')
  if (remoteFile) {
    const q = new URLSearchParams({ sessionId: 'bench', cwd: MIRROR, path: MIRROR + '\\' + String(rel).replace(/\//g, '\\') })
    const fsRead = []
    for (let i = 0; i < 5; i++) fsRead.push((await httpJson(GUI + '/sidebar/api/fs.read', { sessionId: 'bench', cwd: MIRROR, path: MIRROR + '\\' + String(rel).replace(/\//g, '\\') })).ms)
    console.log('  7) HTTP fs.read（镜像路径）: ' + fmt(stats(fsRead)))
    const fileRoute = []
    for (let i = 0; i < 5; i++) fileRoute.push((await httpGetBytes(GUI + '/sidebar/file?' + q.toString())).ms)
    console.log('  8) HTTP /sidebar/file      : ' + fmt(stats(fileRoute)))
  }
}