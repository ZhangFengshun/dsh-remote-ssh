#!/usr/bin/env node
/**
 * 真机验证：取消 / kill 时给**远端进程组**发 SIGHUP 是否真的终止远端命令（2.4.44）。
 *
 * 为什么需要这个脚本：单元测试只能证明「插件写了 kill -HUP -<pgid>」，
 * 证明不了「PGID 取对了、HUP 真能收掉远端进程」。这条链路依赖真实 sshd 的会话/进程组语义，
 * 只能在真机上跑（issue #35 的复测结论也是这么得出的）。
 *
 * 复现的三段对照（全部在目标机上实测）：
 *   1) 池化 shell 的 PID = PGID = SID（插件据此把 $$ 当进程组号）；
 *   2) 直接杀掉本地 ssh 后，远端前台命令**继续跑**（旧「取消」为什么杀不掉它）；
 *   3) `kill -HUP -<pgid>` 后前台命令结束，而 `nohup` 起的后台任务存活（关终端语义）。
 *
 * 用法（不要把真实主机写进仓库）：
 *   node scripts/verify-remote-hup-group.mjs --host <host> --user <user> --key <path> [--port 22]
 * 依赖：本机 OpenSSH 客户端；目标机为 POSIX shell（bash），且能跑 sleep / pgrep / ps。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

const argv = process.argv.slice(2)
function arg(name, def) {
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
  console.error('用法: node scripts/verify-remote-hup-group.mjs --host <host> --user <user> --key <keyPath> [--port 22]')
  process.exit(2)
}
if (!existsSync(KEY)) {
  console.error('密钥不存在: ' + KEY)
  process.exit(2)
}

const TARGET = USER + '@' + HOST
const base = ['-i', KEY, '-p', String(PORT), '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=15']
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const ok = (cond, label) => {
  console.log((cond ? '  ✓ ' : '  ✗ FAIL: ') + label)
  if (!cond) failed++
}

function oneShot(cmd) {
  const h = spawn(SSH, [...base, TARGET, cmd], { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  h.stdout.on('data', (c) => { out += c.toString('utf8') })
  h.stderr.on('data', (c) => { out += c.toString('utf8') })
  return new Promise((resolve) => h.on('close', (code) => resolve({ out: out.trim(), code })))
}
function openSession() {
  const h = spawn(SSH, [...base, TARGET, 'bash'], { stdio: ['pipe', 'pipe', 'pipe'] })
  let buf = ''
  h.stdout.on('data', (c) => { buf += c.toString('utf8') })
  h.stderr.on('data', (c) => { buf += c.toString('utf8') })
  return { h, read: () => buf }
}

// 0) 清掉可能残留的探针进程（脚本可重复跑）
await oneShot('pkill -f "sleep 12345" ; pkill -f "sleep 12346" ; true')

// 1) 建会话 + 探针：命令与 lib/index.js 的 _doConnect 完全同形
const s = openSession()
await wait(1200)
s.h.stdin.write("printf '\\002RSSHPID%s\\002\\n' \"$$\"\n")
let pid = 0
for (let i = 0; i < 50 && !pid; i++) {
  await wait(100)
  const m = /\u0002RSSHPID(\d+)\u0002/.exec(s.read())
  if (m) pid = Number(m[1])
}
ok(pid > 1, 'PID 探针返回远端 shell pid=' + pid)
if (!pid) {
  console.log('  探针拿不到 pid（远端不是 bash？）→ 后续跳过')
  process.exit(1)
}

// 2) PID = PGID = SID ？（插件把 $$ 当进程组号的前提）
{
  const r = await oneShot('ps -o pid,ppid,pgid,sid,comm -p ' + pid)
  const cols = (r.out.split('\n')[1] || '').trim().split(/\s+/)
  ok(cols[0] === String(pid) && cols[2] === String(pid) && cols[3] === String(pid),
    '池化 shell 是会话首进程（PID=PGID=SID=' + pid + '，实际 ' + JSON.stringify(cols) + '）')
}

// 3) 起两条长命令：一条前台（会被 HUP 收掉）、一条 nohup 后台（按设计应存活）
s.h.stdin.write('nohup sleep 12346 >/dev/null 2>&1 &\n')
s.h.stdin.write('echo START; sleep 12345; echo END\n')
await wait(2500)
const before = await oneShot('pgrep -a -f "sleep 1234[56]" | head -5')
ok(before.out.includes('sleep 12345') && before.out.includes('sleep 12346'), '断开前两条长命令都在跑')

// 4) 只杀本地 ssh（旧「取消」的全部动作）→ 远端前台命令应仍然存活
s.h.kill('SIGKILL')
await wait(2500)
const afterDrop = await oneShot('pgrep -a -f "sleep 1234[56]" | head -5')
ok(afterDrop.out.includes('sleep 12345'), '仅断开本地 ssh 时远端命令继续跑（这就是 issue #35 复测的现象）')

// 5) 独立短连接给进程组发 HUP（2.4.44 的取消 / kill 收尾动作）
const hup = await oneShot('kill -HUP -' + pid + ' 2>&1; echo exit=$?')
await wait(2500)
const afterHup = await oneShot('pgrep -a -f "sleep 1234[56]" | head -5')
ok(hup.out.includes('exit=0'), 'HUP 命令执行成功（' + JSON.stringify(hup.out) + '）')
ok(!afterHup.out.includes('sleep 12345'), 'HUP 后远端前台命令已终止')
ok(afterHup.out.includes('sleep 12346'), 'nohup 后台任务不受影响（与「关终端」语义一致）')

// 6) 清理
await oneShot('pkill -9 -f "sleep 1234[56]" ; true')
console.log('')
console.log(failed ? '  结果: ' + failed + ' 项失败' : '  结果: 全部通过（取消=终止；本地断连不终止）')
process.exit(failed ? 1 : 0)