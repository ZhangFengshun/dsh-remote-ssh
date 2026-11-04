/**
 * 2.4.44 —— 取消 / kill 时给**远端进程组**发 SIGHUP（issue #35 复测建议）。
 *
 * 背景（报告者真机实测，本机复现一致）：旧实现「取消」只丢弃本地池化会话，
 * 远端命令会继续跑完（`sleep 60` 的 END 在 turn 结束后才写日志），`ps` 里还能看到孤儿进程。
 * 语义上「按停止」≈「关终端」，所以应当终止远端。
 *
 * 分四段：
 *   A. CommandSession 的 PID 探测：建连即写探针、解析并剥离 \002RSSHPID<pid>\002、只做一次、
 *      远端非 bash 时不纠缠（超长缓冲即放弃）。
 *   B. hupRemoteGroup：非法/缺失 PGID 直接短路（不发 SSH）；合法 PGID 走独立一次性通道
 *      `kill -HUP -<pgid>`，短超时，失败吞掉（best-effort，不能拖住取消）。
 *   C. runPooled / kill 工具接线：取消分支调用收尾助手；kill 在 close/delete 之前取 PGID。
 *   D. 文档语义：取消 = 终止；timeoutMs 超时 / 断连 = 仅放弃等待。
 *   E. 真机 E2E 脚本存在且仍按 HUP 语义写。
 *   F. 变异负向控制：改坏源码后上面的断言必须变红。
 */
import fs from 'node:fs'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '')
const src = fs.readFileSync(ROOT + '/lib/index.js', 'utf8')
let passed = 0
let failed = 0
function check(cond, label) {
  if (cond) { passed++; console.log('    ✓ ' + label) }
  else { failed++; console.log('    ✗ FAIL: ' + label) }
}
function grab(text, marker) {
  const start = text.indexOf(marker)
  if (start < 0) throw new Error('源码里找不到: ' + marker)
  let depth = 0
  let i = text.indexOf('{', start)
  const from = i
  for (; i < text.length; i++) {
    const c = text[i]
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) break }
  }
  return text.slice(start, i + 1)
}
const D = String.fromCharCode(36)

// ---------------------------------------------------------------- A. PID 探测
{
  console.log('A. CommandSession PID 探测（建连即记录远端 PGID）')
  const code = grab(src, 'class CommandSession')
  const factory = new Function('sshArgv', 'stripPqBanner', 'SESSION_MAX_STDOUT',
    code + '\nreturn { CommandSession };')
  const make = () => {
    const rec = { writes: [], spawned: 0, terminated: 0 }
    const handle = {
      stdin: { write(chunk) { rec.writes.push(String(chunk)); return true } },
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      done: new Promise(() => {}),
      terminate() { rec.terminated++ }
    }
    const subprocess = { spawn() { rec.spawned++; return handle } }
    return { rec, handle, subprocess }
  }
  const { CommandSession } = factory(
    () => ({ argv: ['ssh'], env: {} }),
    (t) => t,
    8 * 1024 * 1024
  )
  const expectedProbe = "printf '\\002RSSHPID%s\\002\\n' \"" + D + D + "\"\n"

  // A1 建连后第一条 stdin 写入就是探针（必须先于任何用户命令）
  {
    const { rec, subprocess } = make()
    rec.writes.length = 0
    const s = new CommandSession(subprocess, { id: 'p1' })
    await s.connect()
    check(rec.writes.length >= 1 && rec.writes[0] === expectedProbe, 'A1 建连即写 PID 探针（逐字节等于 printf ' + "''" + ' 形式 + 双美元符）')
    check(!rec.writes[0].includes('\\n"') && rec.writes[0].endsWith('\n'), 'A2 探针以换行结尾（bash 才能执行）')
  }

  // A3 标记到达 → remotePid 有值，且从缓冲里剥掉（不污染下一条命令的 stdout）
  {
    const { handle, subprocess } = make()
    const s = new CommandSession(subprocess, { id: 'p1' })
    await s.connect()
    handle.stdout.emit('data', '\u0002RSSHPID4242\u0002\n')
    check(s.remotePid === 4242, 'A3 剥出远端 PID = 4242')
    check(s.buf === '', 'A4 标记已从 stdout 缓冲剥离（实际 ' + JSON.stringify(s.buf) + '）')
    const p = s.exec('echo hi')
    await new Promise((r) => setTimeout(r, 0))
    handle.stdout.emit('data', 'hi\n')
    handle.stdout.emit('data', s.sentinel + '0\n')
    const r = await p
    check(r.stdout === 'hi\n' && r.exitCode === 0, 'A5 剥离后普通命令输出解析不受影响')
  }

  // A6 标记只解析一次（后续命令里偶然出现同样字节也不认）
  {
    const { handle, subprocess } = make()
    const s = new CommandSession(subprocess, { id: 'p1' })
    await s.connect()
    handle.stdout.emit('data', '\u0002RSSHPID1111\u0002\n')
    handle.stdout.emit('data', '\u0002RSSHPID2222\u0002\n')
    check(s.remotePid === 1111 && s.pidSettled === true, 'A6 只认第一次探测结果（不被后续输出覆盖）')
  }

  // A7 远端不是 bash / 探针被吞：缓冲变大后放弃扫描，不抛错、不误判
  {
    const { handle, subprocess } = make()
    const s = new CommandSession(subprocess, { id: 'p1' })
    await s.connect()
    handle.stdout.emit('data', 'x'.repeat(9000))
    check(s.pidSettled === true && s.remotePid === 0, 'A7 无标记时超长缓冲即放弃探测（PGID=0，退化旧行为）')
  }

  // A8 重连后重置（会话作废重建时不能沿用旧 PGID）
  {
    const { handle, subprocess } = make()
    const s = new CommandSession(subprocess, { id: 'p1' })
    await s.connect()
    handle.stdout.emit('data', '\u0002RSSHPID777\u0002\n')
    s.close()
    await s.connect()
    check(s.remotePid === 0 && s.pidSettled === false, 'A8 重连清空旧 PGID（新会话重新探测）')
  }
}

// ---------------------------------------------------------------- B. hupRemoteGroup
{
  console.log('B. hupRemoteGroup（独立一次性通道 + 非法 PGID 短路）')
  const code = grab(src, 'async function hupRemoteGroup')
  const factory = new Function('runRemote', 'subprocess', code + '\nreturn { hupRemoteGroup };')
  const mk = () => {
    const rec = { calls: [] }
    const runRemote = async function (subprocess, p, cmd, stdinData, maxBytes, extraOpts, timeoutMs, signal) {
      rec.calls.push({ p, cmd, timeoutMs, signal })
      if (rec.throw) throw new Error('ssh down')
      return rec.bad ? { ok: false, exitCode: 255, error: 'boom' } : { ok: true, exitCode: 0 }
    }
    return { rec, runRemote }
  }

  {
    const { rec, runRemote } = mk()
    const { hupRemoteGroup } = factory(runRemote, {})
    check((await hupRemoteGroup({ id: 'p1' }, 0)) === false && rec.calls.length === 0, 'B1 PGID=0 直接短路（老会话不额外开 SSH）')
    check((await hupRemoteGroup({ id: 'p1' }, 1)) === false && rec.calls.length === 0, 'B2 PGID=1 / 非法值也短路')
    check((await hupRemoteGroup({ id: 'p1' }, '4294967296x')) === false && rec.calls.length === 0, 'B3 非数字 PGID 短路（不拼出奇怪命令）')
  }

  {
    const { rec, runRemote } = mk()
    const { hupRemoteGroup } = factory(runRemote, {})
    const ok = await hupRemoteGroup({ id: 'p1' }, 4242)
    check(ok === true && rec.calls.length === 1, 'B4 合法 PGID → 发一次独立 SSH')
    check(rec.calls[0].cmd === 'kill -HUP -4242 2>/dev/null; true', 'B5 命令是 kill -HUP -<pgid>（负号 = 进程组），并吞掉 stderr')
    check(rec.calls[0].timeoutMs === 4000, 'B6 独立短超时 4s（best-effort 收尾，不能拖住取消）')
    check(rec.calls[0].signal === undefined, 'B7 **不复用已取消的 exec.signal**（否则这条收尾命令会立刻被取消）')
  }

  {
    const { rec, runRemote } = mk()
    rec.bad = true
    const { hupRemoteGroup } = factory(runRemote, {})
    check((await hupRemoteGroup({ id: 'p1' }, 4242)) === false, 'B8 远端 kill 失败 → 返回 false（不抛）')
    const { rec: rec2, runRemote: runRemote2 } = mk()
    rec2.throw = true
    const f2 = factory(runRemote2, {})
    check((await f2.hupRemoteGroup({ id: 'p1' }, 4242)) === false, 'B9 连不上远端也不抛（best-effort）')
  }
}

// ---------------------------------------------------------------- C. 接线
{
  console.log('C. runPooled / kill 接线')
  const rp = grab(src, 'async function runPooled')
  check(/remotePid/.test(rp) && rp.includes('const remotePgid = sess ? sess.remotePid : 0'), 'C1 runPooled 在 close 之前从会话取远端 PGID')
  check(rp.indexOf('dropSession();') < rp.indexOf('const remotePgid'), 'C2 取 PGID 发生在 dropSession 之前（onTimeout 已经关过一次会话）')
  check(/await Promise\.all\(\[settleWithin\(execP, 3000\), hupRemoteGroup\(p, remotePgid\)\]\)/.test(rp), 'C3 取消分支：本地停稳与远端 HUP 并行')
  check(rp.indexOf('hupRemoteGroup(p, remotePgid)') > 0 && rp.indexOf('e.isAbort') < rp.indexOf('hupRemoteGroup(p, remotePgid)'), 'C4 HUP 只在 abort 分支（超时不杀远端）')
  check(!/hupRemoteGroup/.test(rp.slice(rp.indexOf('if (e && e.isTimeout)'), rp.indexOf('if (e && e.isAbort)'))), 'C5 超时分支不含 HUP')

  const kill = src.slice(src.indexOf('name: "remote_ssh_kill"'), src.indexOf('name: "remote_ssh_exec"'))
  check(/if \(s\.remotePid\) pgs\.push\(hupRemoteGroup\(s\.profile, s\.remotePid\)\)/.test(kill), 'C6 kill all：逐个会话发 HUP')
  check(kill.indexOf('hupRemoteGroup(s.profile') < kill.indexOf('s.close()'), 'C7 kill all：HUP 在 close 之前发起（并行收尾）')
  check(/if \(s\.remotePid\) hup = hupRemoteGroup\(tc\.profile, s\.remotePid\)/.test(kill), 'C8 kill 单连接：发 HUP')
  check(kill.indexOf('hup = hupRemoteGroup') < kill.indexOf('sessions.delete(key)'), 'C9 kill 单连接：HUP 在 delete 之前（会话对象还在）')
  check(kill.includes('await Promise.all(hup ? [hup] : [])'), 'C10 kill 单连接等收尾完成（仍受内部 4s 上限约束）')

  const cs = grab(src, 'class CommandSession')
  check(cs.includes('RSSHPID') && cs.includes('remotePid'), 'C11 CommandSession 写探针并保存 remotePid')
  check(/this\.buf = this\.buf\.replace\(m\[0\], ""\)/.test(cs), 'C12 标记会被从缓冲剥离（不污染命令输出）')
}

// ---------------------------------------------------------------- D. 文档语义
{
  console.log('D. 工具描述 / 文档语义（取消=终止；超时=仅放弃等待）')
  check(src.includes('取消会丢弃池化会话、尽力给远端进程组发 SIGHUP'), 'D1 exec 工具描述写明取消会 SIGHUP 远端进程组')
  check(src.includes('到点只放弃等待、**不会终止远端命令**'), 'D2 exec 工具描述写明超时不终止远端命令')
  check(src.includes('本地等待预算（毫秒），默认 120000') && src.includes('按停止键才是取消：会尽力终止远端进程组'), 'D3 timeoutMs 参数描述改写（本地预算 vs 远端硬时限）')
  check(src.includes('关闭本地会话的同时会尽力（最多等 4s）给远端 shell 所在的进程组发 SIGHUP'), 'D4 kill 工具描述写明会 SIGHUP 远端进程组')
  {
    const zh = fs.readFileSync(ROOT + '/README.md', 'utf8')
    const en = fs.readFileSync(ROOT + '/README_EN.md', 'utf8')
    check(/SIGHUP/.test(zh) && /不会终止远端命令/.test(zh) && /本地等待预算/.test(zh), 'D5 README.md 写清取消 / 超时 / kill 的远端语义')
    check(/SIGHUP/.test(en) && /does not terminate the remote command/.test(en) && /local wait budget/.test(en), 'D6 README_EN.md 写清同样的语义')
  }
}

// ---------------------------------------------------------------- E. 真机 E2E 脚本
{
  console.log('E. 真机验证脚本')
  const p = ROOT + '/scripts/verify-remote-hup-group.mjs'
  const scriptsDir = fs.existsSync(ROOT + '/scripts')
  const exists = fs.existsSync(p)
  // issue #35 复测者指出：npm 包只发 package.json「files」里的文件，不含 scripts/ ——
  // 从发布包（无 scripts 目录）里跑本测试时 E1 不该变红；仓库内缺文件才必须红。
  if (!exists && !scriptsDir) {
    console.log('    · E1 跳过：发布包不含 scripts/（真机脚本只随仓库提供）')
  } else {
    check(exists, 'E1 scripts/verify-remote-hup-group.mjs 存在（真机复现路径可重跑）')
  }
  if (exists) {
    const t = fs.readFileSync(p, 'utf8')
    check(t.includes('kill -HUP -') && t.includes('RSSHPID'), 'E2 脚本按同一套假说验证（探针 + 进程组 HUP）')
    check(t.includes('--host') && t.includes('--key'), 'E3 脚本参数化（不把真实主机写进仓库）')
  }
}

// ---------------------------------------------------------------- F. 变异负向控制
{
  console.log('F. 变异控制（断言必须能变红）')
  const m1 = src.replace('hupRemoteGroup(p, remotePgid)', 'hupRemoteGroup(p, 0)')
  check(m1 !== src && !/hupRemoteGroup\(p, remotePgid\)/.test(grab(m1, 'async function runPooled')), 'F1 变异：取消分支改成不发真实 PGID → C3/C4 断言会红')
  const m2 = src.replace('if (s.remotePid) hup = hupRemoteGroup(tc.profile, s.remotePid)', '')
  check(m2 !== src && !/hupRemoteGroup\(tc\.profile/.test(m2), 'F2 变异：删掉 kill 单连接的 HUP → C8 断言会红')
  const m3 = src.replace('RSSHPID%s', 'RSHPID%s')
  check(m3 !== src && !grab(m3, 'class CommandSession').includes('RSSHPID%s'), 'F3 变异：改坏探针命令 → A1 断言会红')
  const m4 = src.replace('kill -HUP -', 'kill -TERM -')
  check(m4 !== src, 'F4 变异：把 HUP 换成 TERM → B5 断言会红（关终端语义必须用 HUP）')
}

console.log('')
console.log('  结果: ' + passed + ' 通过, ' + failed + ' 失败')
if (failed > 0) process.exitCode = 1