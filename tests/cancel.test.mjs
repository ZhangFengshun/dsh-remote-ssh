/**
 * 协作式取消（issue #35）—— 本插件 2.4.43。
 *
 * 背景：DSH 的取消是**协作式**的（`exec.signal` 必填、注册表不与工具 promise 竞速、
 * 工具必须在自有工作停稳后才完成）。2.4.42 及以前本插件全文件 `exec.signal` 出现 0 次：
 * 「停止键」只会把 turn 标记为取消，实际仍要等远端命令自己结束；`timeoutMs: 0` 时没有
 * 上限，而唯一的手动兜底 `remote_ssh_kill` 本身是一次工具调用 —— 同一 turn 卡住时按不到。
 *
 * 覆盖：
 *   A. withTimeout：取消/超时/正常/ms=0 四种形态 + 监听器必须摘掉
 *   B. runPooled：预取消不建连、取消中丢弃会话、**取消绝不回退重跑**、超时仍不回退、
 *      真失败仍回退、signal 透传给一次性连接
 *   C. runTarPipe（sync/push 的 tar 管道）：取消时两端 terminate 并返回 isAbort
 *   D. signalRunner / toolContext 的信号透传
 *   E. 源码接线：13 个工具里 11 个走 SSH 的都接了信号；顺序不变量（abort 分支在回退之前）
 *   M. 变异负向控制：删掉 abort 分支 / 删掉工具接线 → 断言必须变红
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const src = readFileSync(root + '/lib/index.js', 'utf8')

let pass = 0, fail = 0
const check = (cond, label) => { if (cond) { pass++; console.log('  ✓ ' + label) } else { fail++; console.log('  ✗ FAIL: ' + label) } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function grab(text, name) {
  const start = text.indexOf(name)
  if (start < 0) throw new Error(name + ' not found')
  const declStart = text.lastIndexOf('\n', start)
  let i = text.indexOf('{', start)
  let depth = 0
  for (; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') { depth--; if (depth === 0) break }
  }
  return text.slice(declStart + 1, i + 1)
}

// ---------------------------------------------------------------- A. withTimeout
{
  const code = [grab(src, 'function abortError'), grab(src, 'function withTimeout')].join('\n')
  const { withTimeout, abortError } = new Function(code + '\nreturn { withTimeout, abortError };')()

  console.log('A. withTimeout（取消 / 超时 / 正常）')

  // A1 无 signal、ms<=0 → 原样返回（既有语义不能被取消功能改掉）
  const p0 = Promise.resolve('x')
  check(withTimeout(p0, 0, 't') === p0, 'A1 ms=0 且无 signal → 原样返回同一 promise')

  // A2 正常完成 → 值透传 + 监听器摘干净
  {
    const ac = new AbortController()
    let added = 0, removed = 0
    const origAdd = ac.signal.addEventListener.bind(ac.signal)
    const origRemove = ac.signal.removeEventListener.bind(ac.signal)
    ac.signal.addEventListener = function (t, f, o) { if (t === 'abort') added++; return origAdd(t, f, o) }
    ac.signal.removeEventListener = function (t, f, o) { if (t === 'abort') removed++; return origRemove(t, f, o) }
    const v = await withTimeout(Promise.resolve('ok'), 1000, 't2', null, ac.signal)
    check(v === 'ok', 'A2 正常 promise 原样透传')
    check(added === 1 && removed === 1, 'A3 signal 监听器 settle 后摘掉（added=' + added + ' removed=' + removed + '）')
  }

  // A4 已取消 → 立即 reject isAbort，且 onTimeout 被调用（丢弃会话）
  {
    const ac = new AbortController()
    ac.abort()
    let cleaned = 0
    let err = null
    try { await withTimeout(new Promise(() => {}), 1000, '已取消', () => { cleaned++ }, ac.signal) } catch (e) { err = e }
    check(!!err && err.isAbort === true, 'A4 预取消 → isAbort（不等远端）')
    check(/已取消/.test(err.message) && cleaned === 1, 'A5 预取消也调用 onTimeout（丢弃会话）一次')
  }

  // A6 挂起中取消 → 立刻 reject isAbort（不等 ms 到点），onTimeout 被调用
  {
    const ac = new AbortController()
    let cleaned = 0
    const t0 = Date.now()
    const prom = withTimeout(new Promise(() => {}), 60000, '挂起命令', () => { cleaned++ }, ac.signal)
    setTimeout(() => ac.abort(), 30)
    let err = null
    try { await prom } catch (e) { err = e }
    const dt = Date.now() - t0
    check(!!err && err.isAbort === true, 'A6 挂起中取消 → isAbort')
    check(dt < 1000, 'A7 不等 60s 超时，' + dt + 'ms 返回')
    check(cleaned === 1, 'A8 onTimeout（丢弃会话）被调用')
    check(err && err.isTimeout !== true, 'A9 取消不会被误标成超时')
  }

  // A10 取消后 ms 到点不应再产生第二个 reject（监听器/定时器都摘掉了）
  {
    const ac = new AbortController()
    const prom = withTimeout(new Promise(() => {}), 80, 't3', null, ac.signal)
    setTimeout(() => ac.abort(), 10)
    let err = null
    try { await prom } catch (e) { err = e }
    await sleep(150)
    check(!!err && err.isAbort === true, 'A10 取消优先于超时（先取消 → isAbort）')
  }

  // A11 超时语义不变
  {
    let err = null
    try { await withTimeout(new Promise(() => {}), 40, '超时命令', null) } catch (e) { err = e }
    check(!!err && err.isTimeout === true && !err.isAbort, 'A11 超时仍带 isTimeout（且不是 isAbort）')
  }

  // A12 abortError 形态
  {
    const e = abortError('池化命令')
    check(e.isAbort === true && /池化命令/.test(e.message), 'A12 abortError 带 isAbort 与标签')
  }
}

// ---------------------------------------------------------------- B. runPooled
{
  console.log('B. runPooled（取消 / 超时 / 回退不变量）')
  const code = [
    grab(src, 'function abortError'),
    grab(src, 'function withTimeout'),
    grab(src, 'async function runPooled'),
    grab(src, 'function settleWithin')
  ].join('\n')

  function makeHarness(opts) {
    const rec = { calls: [], sessions: new Map(), closed: 0, created: 0, runRemote: [], hups: [] }
    const o = opts || {}
    const factory = new Function('resolveTimeoutMs', 'sessions', 'getSession', 'sessionKeyOf', 'sshErrorHint', 'subprocess', 'runRemote', 'hupRemoteGroup',
      code + '\nreturn { runPooled };')
    const { runPooled } = factory(
      (ms) => (ms === 0 ? 0 : (ms > 0 ? ms : 120000)),
      rec.sessions,
      (p, role) => {
        rec.created++
        const s = {
          remotePid: o.pgid || 0,
          close() { rec.closed++; if (o.onClose) o.onClose() },
          exec(cmd, stdin, split) { rec.calls.push({ cmd, split }); return o.exec(cmd, stdin, split) }
        }
        rec.session = s
        // 与真实现一致：getSession 会把会话登记进 sessions（runPooled 的 dropSession 靠它找）
        rec.sessions.set('key:' + (role || ''), s)
        return s
      },
      (p, role) => 'key:' + (role || ''),
      (t) => 'hint:' + t,
      { spawn: () => { throw new Error('不应真的 spawn') } },
      async function (subprocess, p, cmd, stdinData, maxBytes, extraOpts, timeoutMs, signal) {
        rec.runRemote.push({ cmd, timeoutMs, signal })
        return { ok: true, exitCode: 0, stdout: 'oneshot', stderr: '', truncated: false, error: '' }
      },
      async function (p, pgid) {
        rec.hups.push({ p, pgid })
        if (o.hup) return o.hup(p, pgid)
        return true
      }
    )
    return { runPooled, rec }
  }

  // B1 正常成功
  {
    const h = makeHarness({ exec: async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }) })
    const r = await h.runPooled({ id: 'p1' }, 'echo ok', undefined, undefined, true, undefined)
    check(r.ok === true && r.stdout === 'ok', 'B1 正常成功路径不变')
    check(h.rec.runRemote.length === 0, 'B2 成功时不走一次性连接')
  }

  // B3 预取消：不建连、不发命令
  {
    const ac = new AbortController()
    ac.abort()
    const h = makeHarness({ exec: async () => ({ exitCode: 0, stdout: 'should-not-run' }) })
    const r = await h.runPooled({ id: 'p1' }, 'sleep 600', undefined, undefined, true, 0, undefined, ac.signal)
    check(r.ok === false && r.isAbort === true, 'B3 预取消 → isAbort')
    check(h.rec.created === 0, 'B4 预取消不建连（getSession 未被调用）')
    check(h.rec.calls.length === 0, 'B5 预取消不发命令')
    check(h.rec.runRemote.length === 0, 'B6 预取消不回退到一次性连接')
  }

  // B7 取消中：丢弃会话 + 不回退重跑（issue #35 的关键不变量）
  {
    const ac = new AbortController()
    const h = makeHarness({
      exec: () => new Promise((resolve) => { h.pendingResolve = resolve }),
      onClose: () => { /* 真实会话 close 会杀掉 ssh，exec 随之 settle */ }
    })
    const t0 = Date.now()
    const p = h.runPooled({ id: 'p1' }, 'sleep 600', undefined, undefined, true, 0, undefined, ac.signal)
    setTimeout(() => ac.abort(), 30)
    setTimeout(() => { if (h.pendingResolve) h.pendingResolve({ exitCode: 255, stdout: '', stderr: '' }) }, 60)
    const r = await p
    const dt = Date.now() - t0
    check(r.ok === false && r.isAbort === true, 'B7 取消中 → isAbort')
    check(dt < 1500, 'B8 timeoutMs=0 也能被取消（' + dt + 'ms 返回，不再无上限等待）')
    check(h.rec.closed >= 1, 'B9 取消丢弃该池化会话（close 被调用）')
    check(h.rec.runRemote.length === 0, 'B10 **取消绝不回退重跑**（runRemote 未被调用）')
  }

  // B11 超时：仍是 isTimeout 且不回退（issue #5 的既有不变量）
  {
    const h = makeHarness({ exec: () => new Promise(() => {}) })
    const r = await h.runPooled({ id: 'p1' }, 'sleep 600', undefined, undefined, true, 30)
    check(r.ok === false && r.isTimeout === true, 'B11 超时 → isTimeout')
    check(h.rec.closed >= 1, 'B12 超时丢弃会话')
    check(h.rec.runRemote.length === 0, 'B13 超时仍然不回退（issue #5）')
  }

  // B14 真失败（会话异常）→ 仍回退一次性连接，且信号透传
  {
    const ac = new AbortController()
    const h = makeHarness({ exec: async () => { throw new Error('channel broken') } })
    const r = await h.runPooled({ id: 'p1' }, 'echo ok', undefined, undefined, true, undefined, undefined, ac.signal)
    check(r.ok === true && r.stdout === 'oneshot', 'B14 会话异常仍回退一次性连接（自动重连）')
    check(h.rec.runRemote.length === 1, 'B15 回退只发生一次')
    check(h.rec.runRemote[0].signal === ac.signal, 'B16 回退调用也带上 signal（取消能穿透到一次性连接）')
  }

  // B17 取消后底层 promise 迟到的 reject/resolve 不产生 unhandledRejection
  {
    const ac = new AbortController()
    const h = makeHarness({ exec: () => new Promise((_, reject) => { h.pendingReject = reject }) })
    const unhandled = []
    const onUnhandled = (e) => unhandled.push(e)
    process.on('unhandledRejection', onUnhandled)
    const p = h.runPooled({ id: 'p1' }, 'sleep 600', undefined, undefined, true, 0, undefined, ac.signal)
    setTimeout(() => ac.abort(), 20)
    setTimeout(() => { if (h.pendingReject) h.pendingReject(new Error('late')) }, 40)
    const r = await p
    await sleep(120)
    process.off('unhandledRejection', onUnhandled)
    check(r.isAbort === true, 'B17 取消返回 isAbort')
    check(unhandled.length === 0, 'B18 被放弃的 exec promise 没有 unhandledRejection')
  }

  // B19 取消 → 给远端进程组发 HUP（issue #35 复测建议：只断本地 ssh，远端命令会继续跑完）
  {
    const ac = new AbortController()
    const h = makeHarness({
      pgid: 4242,
      exec: () => new Promise((resolve) => { h.pendingResolve = resolve }),
      onClose: () => { if (h.pendingResolve) h.pendingResolve({ exitCode: 255, stdout: '', stderr: '' }) }
    })
    const p = h.runPooled({ id: 'p1' }, 'sleep 45', undefined, undefined, true, 0, undefined, ac.signal)
    setTimeout(() => ac.abort(), 30)
    const r = await p
    check(r.isAbort === true, 'B19 取消仍返回 isAbort')
    check(h.rec.hups.length === 1 && h.rec.hups[0].pgid === 4242, 'B20 取消时用会话记录的 PGID 发 HUP（实际 ' + JSON.stringify(h.rec.hups) + '）')
    check(h.rec.hups[0].p && h.rec.hups[0].p.id === 'p1', 'B21 HUP 用的是该连接的 profile')
  }

  // B22 老会话 / 非 bash 远端：PGID 未知（0）→ 传 0 给收尾助手（由 hupRemoteGroup 自身短路，不发 SSH）
  {
    const ac = new AbortController()
    const h = makeHarness({
      exec: () => new Promise((resolve) => { h.pendingResolve = resolve }),
      onClose: () => { if (h.pendingResolve) h.pendingResolve({ exitCode: 255, stdout: '', stderr: '' }) }
    })
    const p = h.runPooled({ id: 'p1' }, 'sleep 45', undefined, undefined, true, 0, undefined, ac.signal)
    setTimeout(() => ac.abort(), 30)
    const r = await p
    check(r.isAbort === true && h.rec.hups.length === 1 && h.rec.hups[0].pgid === 0, 'B22 PGID 未知时传 0（收尾助手短路，不发 SSH）')
  }

  // B23 超时**不**杀远端：文档语义是「取消 = 终止；超时 = 仅放弃等待」
  {
    const h = makeHarness({ pgid: 4242, exec: () => new Promise(() => {}) })
    const r = await h.runPooled({ id: 'p1' }, 'sleep 45', undefined, undefined, true, 30)
    check(r.isTimeout === true, 'B23 超时仍是 isTimeout')
    check(h.rec.hups.length === 0, 'B24 超时不发 HUP（远端命令可能继续运行，文档已写明）')
  }

  // B25 HUP 很慢也不拖住取消返回（内部有独立短超时，且与停稳并行）
  {
    const ac = new AbortController()
    const h = makeHarness({
      pgid: 4242,
      exec: () => new Promise((resolve) => { h.pendingResolve = resolve }),
      onClose: () => { if (h.pendingResolve) h.pendingResolve({ exitCode: 255, stdout: '', stderr: '' }) },
      hup: async () => { await sleep(400); return true }
    })
    const t0 = Date.now()
    const p = h.runPooled({ id: 'p1' }, 'sleep 45', undefined, undefined, true, 0, undefined, ac.signal)
    setTimeout(() => ac.abort(), 30)
    const r = await p
    const dt = Date.now() - t0
    check(r.isAbort === true, 'B25 HUP 慢时取消仍返回 isAbort')
    check(dt < 1500, 'B26 HUP 与本地停稳并行，取消返回不被拖长（' + dt + 'ms）')
  }
}

// ---------------------------------------------------------------- C. runTarPipe
{
  console.log('C. runTarPipe（sync / push 的 tar 管道）')
  const code = grab(src, 'async function runTarPipe')
  const factory = new Function('armPipeTimeout', 'resolveSyncTimeoutMs', 'readCollected', 'syncErrText',
    code + '\nreturn { runTarPipe };')
  const makePipe = (budgetMs) => {
    const rec = { terminated: 0 }
    const armPipeTimeout = (handles, ms) => {
      const state = { timedOut: false }
      if (!(ms > 0)) return { state, clear() {} }
      const t = setTimeout(() => { state.timedOut = true; handles.forEach((h) => { try { h.terminate() } catch (e) {} }) }, ms)
      return { state, clear() { clearTimeout(t) } }
    }
    const { runTarPipe } = factory(armPipeTimeout, (ms) => (ms > 0 ? ms : 7200000), () => '', (e) => String(e))
    const mk = () => {
      let resolveDone
      const done = new Promise((r) => { resolveDone = r })
      return {
        stdout: null, stdin: null, done,
        terminate() { rec.terminated++; resolveDone({ exitCode: -1, signal: 'TERM' }) },
        settle(code2) { resolveDone({ exitCode: code2 === undefined ? 0 : code2, signal: '' }) }
      }
    }
    const a = mk(), b = mk()
    return { runTarPipe, a, b, rec, budgetMs }
  }

  // C1 正常
  {
    const { runTarPipe, a, b } = makePipe(5000)
    a.settle(0); b.settle(0)
    const r = await runTarPipe(a, b, 5000, { label: '同步', a: 'ssh', b: 'tar' })
    check(r.ok === true, 'C1 两端 exit 0 → ok')
  }

  // C2 预取消：两端 terminate，返回 isAbort
  {
    const { runTarPipe, a, b, rec } = makePipe(5000)
    const ac = new AbortController()
    ac.abort()
    const r = await runTarPipe(a, b, 5000, { label: '推送', a: 'tar', b: 'ssh' }, ac.signal)
    check(r.ok === false && r.isAbort === true, 'C2 预取消 → isAbort')
    check(rec.terminated === 2, 'C3 预取消两端都 terminate（' + rec.terminated + '/2）')
  }

  // C4 传输中取消：立刻返回、两端 terminate、不误标超时
  {
    const { runTarPipe, a, b, rec } = makePipe(0)
    const ac = new AbortController()
    const t0 = Date.now()
    const p = runTarPipe(a, b, 0, { label: '同步', a: 'ssh', b: 'tar' }, ac.signal)
    setTimeout(() => ac.abort(), 25)
    const r = await p
    const dt = Date.now() - t0
    check(r.ok === false && r.isAbort === true, 'C4 传输中取消 → isAbort')
    check(rec.terminated === 2, 'C5 传输中取消两端 terminate')
    check(dt < 1500, 'C6 取消后不用等默认墙钟预算（' + dt + 'ms）')
    check(/已取消/.test(r.error), 'C7 错误文案说明是取消')
  }

  // C8 非取消失败路径的文案不变
  {
    const { runTarPipe, a, b } = makePipe(5000)
    a.settle(2); b.settle(0)
    const r = await runTarPipe(a, b, 5000, { label: '同步', a: 'ssh', b: 'tar' })
    check(r.ok === false && r.isAbort !== true && /同步失败/.test(r.error), 'C8 真实失败仍是「同步失败」（不被当成取消）')
  }
}

// ---------------------------------------------------------------- D. 信号透传
{
  console.log('D. signalRunner / toolContext')
  const runnerCode = grab(src, 'function signalRunner')
  const f = new Function('runPooled', runnerCode + '\nreturn signalRunner;')(function () { return Array.prototype.slice.call(arguments) })
  const ac = new AbortController()
  const runner = f(ac.signal)
  const args = runner({ id: 'p' }, 'cmd', 'stdin', 1024, true, 5000, 'git')
  check(args.length === 8, 'D1 signalRunner 把 8 个参数原样转发给 runPooled')
  check(args[7] === ac.signal, 'D2 第 8 参就是 exec.signal')
  check(args[0].id === 'p' && args[1] === 'cmd' && args[4] === true && args[5] === 5000 && args[6] === 'git', 'D3 其余参数未被改写')

  const tcBlock = grab(src, 'function toolContext')
  check(/signal:\s*signal/.test(tcBlock) && /exec && exec\.signal/.test(tcBlock), 'D4 toolContext 把 exec.signal 带进工具上下文')
}

// ---------------------------------------------------------------- E. 源码接线
{
  console.log('E. 源码接线（11 个走 SSH 的工具都要接信号）')
  const SSH_TOOLS = ['remote_ssh_exec', 'remote_ssh_ls', 'remote_ssh_cat', 'remote_ssh_write', 'remote_ssh_grep',
    'remote_ssh_glob', 'remote_ssh_mkdir', 'remote_ssh_delete', 'remote_ssh_move', 'remote_ssh_sync', 'remote_ssh_push']
  const regions = {}
  for (const name of SSH_TOOLS) {
    const start = src.indexOf('name: "' + name + '"')
    const next = src.indexOf('\n  register({', start + 10)
    regions[name] = start < 0 ? '' : src.slice(start, next < 0 ? src.length : next)
  }
  for (const name of SSH_TOOLS) {
    check(/\bsignal\b/.test(regions[name]), 'E ' + name + ' 的 execute 引用了 signal')
  }
  const srUses = (src.match(/signalRunner\(/g) || []).length
  check(srUses >= 6, 'E signalRunner 覆盖 runner 型 helper（' + srUses + ' 处：定义 1 + ls/cat/write/grep/glob/sync 各 1）')
  check(/tc\.signal\)/.test(src) || /signalRunner\(tc\.signal\)/.test(src), 'E 工具侧通过 tc.signal 取信号')

  // 顺序不变量：runPooled 里 isAbort 判断必须在「一次性连接回退」之前
  const rp = grab(src, 'async function runPooled')
  check(rp.indexOf('isAbort') > 0 && rp.indexOf('isTimeout') > 0, 'E runPooled 同时区分 isAbort 与 isTimeout')
  check(rp.indexOf('e.isAbort') < rp.indexOf('runRemote(subprocess'), 'E runPooled 的 abort 分支在 runRemote 回退之前（否则会重跑取消掉的命令）')
  check(rp.indexOf('signal && signal.aborted') > 0, 'E runPooled 入口先判预取消（不建连）')

  // runRemote：abort 分支 + terminate 后停稳
  const rr = grab(src, 'async function runRemote')
  check(/signal\)/.test(rr.split('\n')[0]), 'E runRemote 签名带 signal')
  check(rr.indexOf('e.isAbort') > 0, 'E runRemote 有 abort 分支')
  check(rr.indexOf('handle.terminate()') < rr.indexOf('e.isAbort'), 'E runRemote 先 terminate 再返回 abort')

  // withTimeout：监听器摘除
  const wt = grab(src, 'function withTimeout')
  check(wt.indexOf('removeEventListener') > 0, 'E withTimeout 摘掉 abort 监听器（否则泄漏并误触发）')

  // sync / push 的 tar 管道透传
  check(/runTarPipe\(sshH, tarH, o\.timeoutMs, \{ label: "同步", a: "ssh", b: "tar" \}, signal\)/.test(src), 'E 同步的 tar 管道透传 signal')
  check(/runTarPipe\(tarH, sshH, o\.timeoutMs, \{ label: "推送", a: "tar", b: "ssh" \}, signal\)/.test(src), 'E 推送的 tar 管道透传 signal')
  check(/remoteSyncDown\(subprocess, signalRunner\(sig\)/.test(src) && /remoteSyncUp\(subprocess, p, ws\.remotePath, ws\.mirrorPath, syncOptsFrom\(ws, args\), sig\)/.test(src),
    'E sync / push 工具把 signal 交给底下两层')

  // 13 个工具：profiles / kill 不需要信号（一个读设置、一个关会话）
  const allTools = [...src.matchAll(/name: "(remote_ssh_[a-z_]+)"/g)].map((m) => m[1])
  check(allTools.length === 13, 'E 工具总数仍是 13（' + allTools.length + '）')
  check(allTools.filter((t) => SSH_TOOLS.indexOf(t) >= 0).length === 11, 'E 其中 11 个走 SSH')

  // M. 变异负向控制：断言必须有牙
  const mutated1 = src.replace(/if \(e && e\.isAbort\) \{[\s\S]*?return aborted\(\);\n      \}/, '')
  check(mutated1 !== src && !/e\.isAbort/.test(grab(mutated1, 'async function runPooled')), 'M1 变异：删掉 abort 分支后 runPooled 里不再有 isAbort（断言可检出这种回归）')
  const mutated2 = src.replace('remoteListDir(signalRunner(tc.signal), tc.profile', 'remoteListDir(runPooled, tc.profile')
  check(mutated2 !== src && !/remoteListDir\(signalRunner/.test(mutated2), 'M2 变异：把 ls 改回裸 runPooled 后接线断言会变红')
  const mutated3 = src.replace('const r = await runPooled(tc.profile, cmd, args.stdin, undefined, true, args.timeoutMs, undefined, tc.signal);',
    'const r = await runPooled(tc.profile, cmd, args.stdin, undefined, true, args.timeoutMs);')
  check(mutated3 !== src, 'M3 变异：exec 掉信号的存在性可被检出')
}

// ---------------------------------------------------------------- F. runRemote（一次性连接）
{
  console.log('F. runRemote（一次性连接也能被取消）')
  const code = [grab(src, 'function abortError'), grab(src, 'function withTimeout'), grab(src, 'async function runRemote')].join('\n')
  function makeRemote(opts) {
    const rec = { terminated: 0, argv: null }
    const o = opts || {}
    const factory = new Function('subprocess', 'sshArgv', 'stripPqBanner', 'resolveTimeoutMs', 'MAX_BYTES', 'withTimeout',
      code + '\nreturn { runRemote };')
    const sub = {
        spawn(cfg) {
          rec.argv = cfg.argv
          let resolveDone, rejectDone
          const done = new Promise((res, rej) => { resolveDone = res; rejectDone = rej })
          const handle = {
            done,
            collected: { stdout: { readFrom: () => ({ text: o.stdout || '', nextOffset: 0, lossy: false }) }, stderr: { readFrom: () => ({ text: o.stderr || '', nextOffset: 0, lossy: false }) } },
            terminate() { rec.terminated++; if (o.settleOnTerminate) resolveDone({ exitCode: -1, signal: 'TERM' }) }
          }
          rec.handle = handle
          setTimeout(() => { if (o.autoSettle) resolveDone({ exitCode: o.autoCode === undefined ? 0 : o.autoCode, signal: '' }) }, o.autoAfter || 10)
          return handle
        }
    }
    const { runRemote } = factory(
      sub,
      (profile, cmd) => ({ argv: ['ssh', cmd], env: {} }),
      (t) => t,
      (ms) => (ms === 0 ? 0 : (ms > 0 ? ms : 120000)),
      1024 * 1024,
      withTimeoutFromA
    )
    return { runRemote, rec, sub }
  }
  // 取 A 段已提取的真实 withTimeout（保持与生产同一份实现）
  const { withTimeout: withTimeoutFromA } = new Function([grab(src, 'function abortError'), grab(src, 'function withTimeout')].join('\n') + '\nreturn { withTimeout };')()

  // F1 正常完成
  {
    const { runRemote, sub } = makeRemote({ autoSettle: true, stdout: 'hello' })
    const r = await runRemote(sub, { id: 'p' }, 'echo hello', undefined, undefined, undefined, 5000)
    check(r.ok === true && r.stdout === 'hello', 'F1 正常路径不变（60s 前完成 → ok）')
  }

  // F2 取消：terminate 被调用、返回 isAbort、不误标超时
  {
    const ac = new AbortController()
    const { runRemote, rec, sub } = makeRemote({ settleOnTerminate: true })
    const t0 = Date.now()
    const prom = runRemote(sub, { id: 'p' }, 'sleep 600', undefined, undefined, undefined, 0, ac.signal)
    setTimeout(() => ac.abort(), 20)
    const r = await prom
    const dt = Date.now() - t0
    check(r.ok === false && r.isAbort === true, 'F2 取消 → isAbort')
    check(rec.terminated >= 1, 'F3 取消 terminate 子进程（不留孤儿 ssh）')
    check(dt < 1500, 'F4 timeoutMs=0 也能取消（' + dt + 'ms）')
    check(r.isTimeout !== true, 'F5 取消不被误标成超时')
  }

  // F6 预取消：立即返回、不 spawn
  {
    const ac = new AbortController()
    ac.abort()
    const { runRemote, rec, sub } = makeRemote({ settleOnTerminate: true })
    const r = await runRemote(sub, { id: 'p' }, 'sleep 600', undefined, undefined, undefined, 0, ac.signal)
    check(r.isAbort === true, 'F6 预取消 → isAbort')
    check(!rec.handle || rec.terminated >= 1, 'F7 预取消时子进程被 terminate（spawn 已发生也不会残留）')
  }

  // F8 超时仍是 isTimeout
  {
    const { runRemote, rec, sub } = makeRemote({ settleOnTerminate: true })
    const r = await runRemote(sub, { id: 'p' }, 'sleep 600', undefined, undefined, undefined, 40)
    check(r.ok === false && r.isTimeout === true, 'F8 超时仍带 isTimeout')
    check(rec.terminated >= 1, 'F9 超时也 terminate')
  }
}

// ---------------------------------------------------------------- G. 输出净化（不能让宿主判 invalid output）
{
  console.log('G. 取消结果必须匹配 output schema')
  const strip = new Function([grab(src, 'function stripAbort'), 'return stripAbort;'][0] + '\nreturn stripAbort;')()
  const r = strip({ ok: false, isAbort: true, error: '已取消' })
  check(r.ok === false && r.error === '已取消' && !('isAbort' in r), 'G1 stripAbort 摘掉内部标记、保留 ok/error')
  check(strip({ ok: true, bytes: 3 }).bytes === 3, 'G2 非取消结果原样返回')

  // sync / push 的 output schema 是 additionalProperties:false，所以必须净化
  check(/additionalProperties: false/.test(grab(src, 'const syncOutput = {')) || /additionalProperties: false/.test(src.slice(src.indexOf('const syncOutput'), src.indexOf('const syncOutput') + 900)),
    'G3 syncOutput 是 additionalProperties:false（多一个字段就会被宿主拒）')
  check((src.match(/return stripAbort\(/g) || []).length === 2, 'G4 sync 与 push 两个出口都净化了返回值')
  check(/pipe\.isAbort \? \{ ok: false, isAbort: true, error: pipe\.error \}/.test(src),
    'G5 runTarPipe 的取消会透到 sync/push 结果；普通失败不带 isAbort（否则 schema 校验会红）')

  // exec 型工具走 normExec：它只挑 schema 里的字段
  const norm = new Function([grab(src, 'function normExec'), 'return normExec;'].join('\n') + '\nreturn normExec;')()
  const out = norm({ ok: false, isAbort: true, error: '已取消', exitCode: -1, stdout: '', stderr: '', truncated: false })
  check(!('isAbort' in out), 'G6 normExec 不把 isAbort 漏给宿主')
  check(out.isTimeout === false && out.exitCode === -1 && out.error === '已取消', 'G7 normExec 仍保留 schema 必填字段')
}

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
