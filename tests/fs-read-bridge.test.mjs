// agent 文件工具 / 内置预览读回远端 回归测试（issue #29）。
//
// 背景：远程工作区里「文件」页签能列远端、右键下载也正常，点「预览」却报「文件不存在，
// 可能已被移动或删除」—— 因为内置 documentpreview 取内容走的是进程内的
// workspace-file RPC → ctx.fs（不是 /sidebar/* HTTP 路由），而 ctx.fs 的 workspaceRoot
// 是**本地镜像**。这正是 #15 已知限制（read 仍读镜像）在内置预览上的另一面。
//
// 修法：给 ctx.fs 的读方法加一层影子 —— **本地优先，本地缺失才回远端**；远端也没有时
// 原样返回原实现的结果/抛原实现的错。本地会话与镜像里已有的文件必须零回归。
//
// 四层：
//   A. buildRemoteEntryCommand / parseRemoteEntry（纯函数：命令形状、六种标记）
//   B. makeMirrorFsReader（假 runner：file/dir/absent/error/连接抛错、整读、区间读、列举）
//   C. installFsReadBridge（假 fs 服务：本地优先、远端兜底、合成 target、错误码、恢复）
//   D. 接线断言（软注入、清理、依赖注入、不新增路由）
import { readFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'

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

/** 从 `const FS_ENTRY_MARK` 到终端段注释之间的整块（读影子层的全部实现）。 */
const bridgeBlock = src.slice(
  src.indexOf('const FS_ENTRY_MARK'),
  src.indexOf('// 终端 wrapper 的 node 解析')
)
if (!bridgeBlock || bridgeBlock.length < 4000) throw new Error('读影子层代码块未找到（FS_ENTRY_MARK … 终端段）')

const DSH_ST_MARK = /const DSH_ST_MARK = "([^"]*)"/.exec(src)[1]

const api = new Function(
  'shellQuotePath', 'MAX_BYTES', 'sanitizeErrLine', 'DSH_ST_MARK', 'resolvePath', 'Buffer', 'TextDecoder',
  grab('function shellQuote') + '\n' +
  grab('function shellQuotePath') + '\n' +
  grab('function sanitizeErrLine') + '\n' +
  grab('function parseStatFrame') + '\n' +
  grab('function statFrameSnippet') + '\n' +
  grab('function errSnippet') + '\n' +
  grab('function buildReadCommand') + '\n' +
  grab('function buildReadPageCommand') + '\n' +
  bridgeBlock +
  '\nreturn { FS_ENTRY_MARK, buildRemoteEntryCommand, parseRemoteEntry, makeMirrorFsReader, installFsReadBridge };'
)(
  (s) => "'" + String(s).replace(/'/g, "'\\''") + "'",
  4 * 1024 * 1024,
  (e) => String(e || '').trim(),
  DSH_ST_MARK,
  resolvePath,
  Buffer,
  TextDecoder,
)

let pass = 0, fail = 0
const check = (cond, label) => { if (cond) { pass++; console.log('  ✓ ' + label) } else { fail++; console.log('  ✗ FAIL: ' + label) } }
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// ---------------------------------------------------------------------------
console.log('A · 远端条目探测命令与解析')
{
  const cmd = api.buildRemoteEntryCommand("/data/项目/图 1.png")
  check(cmd.includes("__DSH_FSENTRY__"), '命令带本层专用标记行（与 DSH_ST_MARK 分开）')
  check(cmd.includes("if [ -L \"$f\" ]") && cmd.includes("elif [ -d \"$f\" ]") && cmd.includes("elif [ -f \"$f\" ]"),
    '先判符号链接，再目录、常规文件（顺序决定 symlink 归到 lstat 语义）')
  check(cmd.includes("else printf '__DSH_FSENTRY__ABSENT"), '末尾给出"不存在"标记（不需要靠退出码猜）')
  check(cmd.includes("'/data/项目/图 1.png'"), '路径按 shell 单引号转义（含空格与中文）')
  check(!/\bgrep\b/.test(cmd) && !/\bfind\b/.test(cmd), '只用 stat / test，不引入额外依赖')

  const parse = (out) => api.parseRemoteEntry(out)
  const file = parse('__DSH_FSENTRY__FILE:1234 1791796084\n')
  check(file.framed === true && file.kind === 'file' && file.size === 1234 && file.mtime === 1791796084, 'FILE: 解析出 size 与 mtime')
  check(parse('__DSH_FSENTRY__DIR\n').kind === 'directory', 'DIR 标记')
  check(parse('__DSH_FSENTRY__LINK\n').kind === 'symlink', 'LINK 标记（lstat 语义要能报 symlink）')
  check(parse('__DSH_FSENTRY__OTHER\n').kind === 'other', 'OTHER 标记（设备/管道等）')
  check(parse('__DSH_FSENTRY__ABSENT\n').kind === 'absent', 'ABSENT 标记')
  const err = parse('__DSH_FSENTRY__ERR:stat: cannot statx: Permission denied\n')
  check(err.kind === 'error' && /Permission denied/.test(err.err), 'ERR: 标记带回远端错误原文')
  check(parse('garbage without marker').framed === false, '没有标记 → framed:false（调用方保持原行为）')
  check(parse('__DSH_FSENTRY__FILE:abc 1\n').kind === 'error', 'size 非数字 → 归 error（不伪造 size）')
  check(parse('__DSH_FSENTRY__FILE:12\n').size === 12, '只有 size 没有 mtime 也能解析（mtime 归 null）')
  const withNoise = parse('some login banner\n__DSH_FSENTRY__FILE:7 99\ntrailing\n')
  check(withNoise.kind === 'file' && withNoise.size === 7, '标记前后的噪声（登录横幅/提示）被忽略')
}

// ---------------------------------------------------------------------------
console.log('B · makeMirrorFsReader（假 runner）')
{
  /** 假 runner：按命令里的标记脚本应答，并记录调用。 */
  function fakeRunner(handlers) {
    const calls = []
    const fn = async (p, cmd, stdin, cap) => {
      calls.push({ cmd, cap })
      for (const h of handlers) {
        if (h.test(cmd)) return h.reply(cmd)
      }
      return { ok: true, stdout: '', stderr: '' }
    }
    fn.calls = calls
    return fn
  }
  const mirror = (absPath) => (/^\/mirror\/w1(\/|$)/.test(String(absPath)) ? { profile: { id: 'p1' }, remotePath: String(absPath).replace('/mirror/w1', '~/proj') } : null)

  // B1 · stat 三态
  {
    const runner = fakeRunner([
      { test: (c) => c.includes('__DSH_FSENTRY__'), reply: () => ({ ok: true, stdout: '__DSH_FSENTRY__FILE:2048 1791796084\n' }) },
    ])
    const reader = api.makeMirrorFsReader({ runner, resolveMirror: mirror })
    const info = await reader.stat('/mirror/w1/docs/a.md')
    check(info.ok === true && info.kind === 'file' && info.size === 2048 && info.mtime === 1791796084, 'stat：常规文件带回 size/mtime')
    check(runner.calls.length === 1 && runner.calls[0].cmd.includes("proj/docs/a.md") && runner.calls[0].cmd.includes("~"),
      '命令里用的是**远端路径**（镜像路径已按 .remote-ssh.json 映射回去，~ 保留给远端 shell 展开）')

    const absent = api.makeMirrorFsReader({
      runner: fakeRunner([{ test: (c) => c.includes('__DSH_FSENTRY__'), reply: () => ({ ok: true, stdout: '__DSH_FSENTRY__ABSENT\n' }) }]),
      resolveMirror: mirror,
    })
    const gone = await absent.stat('/mirror/w1/nope.txt')
    check(gone.ok === true && gone.kind === 'absent', 'stat：远端也没有 → kind:"absent"（调用方据此保持 not-found）')

    const dirReader = api.makeMirrorFsReader({
      runner: fakeRunner([{ test: (c) => c.includes('__DSH_FSENTRY__'), reply: () => ({ ok: true, stdout: '__DSH_FSENTRY__DIR\n' }) }]),
      resolveMirror: mirror,
    })
    check((await dirReader.stat('/mirror/w1/docs')).kind === 'directory', 'stat：目录')

    const errReader = api.makeMirrorFsReader({
      runner: fakeRunner([{ test: (c) => c.includes('__DSH_FSENTRY__'), reply: () => ({ ok: true, stdout: '__DSH_FSENTRY__ERR:Permission denied\n' }) }]),
      resolveMirror: mirror,
    })
    const bad = await errReader.stat('/mirror/w1/secret')
    check(bad.ok === false && bad.code === 'FS_IO_ERROR' && /Permission denied/.test(bad.error), 'stat：远端报错 → FS_IO_ERROR + 原文')

    const boom = api.makeMirrorFsReader({
      runner: async () => { throw new Error('socket hang up') },
      resolveMirror: mirror,
    })
    const b2 = await boom.stat('/mirror/w1/a')
    check(b2.ok === false && /socket hang up/.test(b2.error), 'runner 抛错 → 归 FS_IO_ERROR，不崩')

    const outsider = api.makeMirrorFsReader({ runner: fakeRunner([]), resolveMirror: mirror })
    const o = await outsider.stat('/elsewhere/a.md')
    check(o.ok === false && o.code === 'FS_IO_ERROR', '不在已注册镜像里 → 失败（调用方保持原行为）')
  }

  // B2 · readWhole / readRange
  {
    const payload = Buffer.from('你好，远端\n', 'utf8').toString('base64')
    const runner = fakeRunner([
      { test: (c) => /tail -c \+/.test(c), reply: () => ({ ok: true, stdout: '__DSH_ST__8:1791796084\n' + Buffer.from('远端').toString('base64') + '\n' }) },
      { test: (c) => /base64 -w0/.test(c), reply: () => ({ ok: true, stdout: '__DSH_ST__' + Buffer.from('你好，远端\n', 'utf8').length + ':1791796084\n' + payload + '\n' }) },
    ])
    const reader = api.makeMirrorFsReader({ runner, resolveMirror: mirror })
    const whole = await reader.readWhole('/mirror/w1/docs/a.md')
    check(whole.ok === true && Buffer.from(whole.bytes).toString('utf8') === '你好，远端\n', 'readWhole：base64 解码回原字节（多字节字符未损）')
    check(whole.size === Buffer.byteLength('你好，远端\n'), 'readWhole：size 取自 stat 帧（不是解码后长度）')

    const range = await reader.readRange('/mirror/w1/docs/a.md', 3, 6)
    check(range.ok === true && Buffer.from(range.bytes).toString('utf8') === '远端', 'readRange：按 offset/length 取窗口字节')
    const rangeCall = runner.calls.filter((c) => /tail -c \+4/.test(c.cmd))
    check(rangeCall.length === 1, 'readRange 用 tail -c +<offset+1> 只取该窗口（1-based）')

    const missing = api.makeMirrorFsReader({
      runner: fakeRunner([{ test: (c) => /base64 -w0/.test(c), reply: () => ({ ok: false, stdout: '__DSH_ST__ERR:No such file or directory\n' }) }]),
      resolveMirror: mirror,
    })
    const m = await missing.readWhole('/mirror/w1/nope')
    check(m.ok === false && m.code === 'FS_NOT_FOUND', '远端文件不存在 → FS_NOT_FOUND（由 stat 帧 ERR 判定）')
  }

  // B3 · list
  {
    const listDir = async (runner, profile, remotePath) => ({
      ok: true,
      entries: [
        { name: 'docs', type: 'directory', size: 0 },
        { name: 'a.md', type: 'file', size: 12 },
      ],
    })
    const reader = api.makeMirrorFsReader({ runner: async () => ({ ok: true, stdout: '' }), resolveMirror: mirror, listDir })
    const r = await reader.list('/mirror/w1')
    check(r.ok === true && eq(r.entries.map((e) => e.name), ['docs', 'a.md']), 'list：复用 remoteListDir 的条目顺序')
    const broken = api.makeMirrorFsReader({ runner: async () => ({ ok: false, error: 'cannot cd' }), resolveMirror: mirror, listDir: async () => ({ ok: false, error: 'cannot cd' }) })
    const br = await broken.list('/mirror/w1')
    check(br.ok === false && /cannot cd/.test(br.error), 'list：远端列举失败 → 带回原因')

    check(api.makeMirrorFsReader({}) === null, '依赖不全 → null（插件照常工作）')
    check(api.makeMirrorFsReader({ runner: () => {} }) === null, '缺 resolveMirror → null')
  }
}

// ---------------------------------------------------------------------------
console.log('C · installFsReadBridge（假 fs 服务）')
{
  /**
   * 假 ctx.fs：`local` 里登记了内容的路径才算"镜像里有"；其余一律按本地不存在处理。
   * 合成 target（targetKey 以 remote-ssh: 开头）会被原实现一律抛"未知 target" —— 真实后端
   * 也不认识别人合成的 target，这里刻意复刻这一点，用来验证本层不会把合成 target 递下去。
   */
  function fakeFs(opts = {}) {
    const calls = []
    const local = opts.local || {}
    const known = (t) => t && (t.targetKey in local || t.targetKey === opts.targetKey)
    const svc = {
      processPath: (t) => (t && t.processPath) || t.displayPath,
      stat: async (t) => { calls.push(['stat', t]); if (!known(t)) { if (String(t.targetKey).startsWith('remote-ssh:')) throw new Error('unknown target key'); return undefined } return { version: 'local-v', type: 'file', size: 1 } },
      lstat: async (path, o) => { calls.push(['lstat', path]); return local[path] ? { version: 'local-v', type: 'file', size: 1 } : undefined },
      resolve: async (path) => { calls.push(['resolve', path]); if (String(path).includes('missing')) { const e = new Error('not found'); e.code = 'FS_NOT_FOUND'; throw e } return { targetKey: path, displayPath: path } },
      readText: async (t) => { calls.push(['readText', t]); if (!known(t)) { const e = new Error('ENOENT'); e.code = 'FS_NOT_FOUND'; throw e } return 'LOCAL' },
      streamText: async (t) => { calls.push(['streamText', t]); if (!known(t)) { const e = new Error('ENOENT'); e.code = 'FS_NOT_FOUND'; throw e } return (async function* () { yield 'LOCAL' })() },
      readBytes: async (t, s, max) => { calls.push(['readBytes', t, max]); if (!known(t)) { const e = new Error('ENOENT'); e.code = 'FS_NOT_FOUND'; throw e } return new Uint8Array([1]) },
      readByteRange: async (t, r) => { calls.push(['readByteRange', t, r]); if (!known(t)) { const e = new Error('ENOENT'); e.code = 'FS_NOT_FOUND'; throw e } return new Uint8Array([1]) },
      listDir: async (t) => { calls.push(['listDir', t]); if (!known(t)) { const e = new Error('ENOENT'); e.code = 'FS_NOT_FOUND'; throw e } return [] },
      contains: (p, c) => { calls.push(['contains', p, c]); return String(c && c.displayPath).indexOf(String(p && p.displayPath)) === 0 },
      fileUrl: (t) => 'local://' + t.displayPath,
      watch: async (t) => { calls.push(['watch', t]); if (!known(t)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e } return async () => {} },
    }
    return { svc, calls, local }
  }

  /** 假读取器：按 absPath 登记远端内容。 */
  function fakeReader(table = {}) {
    const seen = []
    return {
      seen,
      async stat(absPath) {
        seen.push(['stat', absPath])
        const e = table[absPath]
        if (!e) return { ok: true, kind: 'absent', size: null, mtime: null }
        return { ok: true, kind: e.kind || 'file', size: e.size === undefined ? 5 : e.size, mtime: 1791796084 }
      },
      async readWhole(absPath) {
        seen.push(['readWhole', absPath])
        const e = table[absPath]
        if (!e) return { ok: false, code: 'FS_NOT_FOUND', error: 'no such file' }
        const bytes = e.bytes !== undefined ? e.bytes : new Uint8Array(Buffer.from(e.text === undefined ? 'REMOTE' : e.text, 'utf8'))
        return { ok: true, bytes, size: e.size === undefined ? bytes.length : e.size }
      },
      async readRange(absPath, offset, length) {
        seen.push(['readRange', absPath, offset, length])
        const e = table[absPath]
        if (!e) return { ok: false, code: 'FS_NOT_FOUND', error: 'no such file' }
        return { ok: true, bytes: new Uint8Array(Buffer.from('RANGE')), size: 100 }
      },
      async list(absPath) {
        seen.push(['list', absPath])
        if (!table[absPath]) return { ok: false, code: 'FS_NOT_FOUND', error: 'no such file' }
        return { ok: true, entries: [{ name: 'fig', type: 'directory', size: 0 }, { name: 'x.png', type: 'file', size: 9 }] }
      },
    }
  }

  const MISSING = 'D:\\mirror\\w1\\figures\\x.png'
  const PRESENT = 'D:\\mirror\\w1\\docs\\a.md'

  // C1 · 本地有 → 完全不动（零回归）
  {
    const { svc, calls } = fakeFs({ local: { [PRESENT]: true }, targetKey: PRESENT })
    const reader = fakeReader({ [MISSING]: { text: 'REMOTE' } })
    const restore = api.installFsReadBridge(svc, { reader })
    check(typeof restore === 'function', '安装成功返回恢复函数')

    const target = { targetKey: PRESENT, displayPath: PRESENT }
    const info = await svc.stat(target)
    check(info.version === 'local-v', 'stat：本地有 → 原实现的元数据原样返回')
    check((await svc.readText(target)) === 'LOCAL', 'readText：本地有 → 原实现的内容原样返回')
    check((await svc.readBytes(target, undefined, 4096))[0] === 1, 'readBytes：本地有 → 原实现字节原样返回')
    check(reader.seen.length === 0, '本地有 → **一次远端调用都没有**（本地会话零影响）')
    check(calls.some((c) => c[0] === 'stat') && calls.some((c) => c[0] === 'readText'), '原方法确实被调用（不是本层直接答）')
    restore()
  }

  // C2 · 本地缺失 → 远端兜底（issue #29 主线）
  {
    const { svc, calls } = fakeFs({ local: {} })
    const reader = fakeReader({ [MISSING]: { text: 'REMOTE-CONTENT', size: 14 }, 'D:\\mirror\\w1\\figures': { kind: 'directory' } })
    api.installFsReadBridge(svc, { reader })

    const target = { targetKey: 'missing-key', displayPath: MISSING }
    const info = await svc.stat(target)
    check(info && info.type === 'file' && info.size === 14 && /^remote:/.test(info.version),
      'stat：本地没有 → 远端元数据（type/size/version）')
    check((await svc.lstat(MISSING)) !== undefined, 'lstat：本地没有 → 远端条目（预览的第一道门就是它）')
    check((await svc.readText(target)) === 'REMOTE-CONTENT', 'readText：本地没有 → 远端内容（内置预览的正文来源）')
    const bytes = await svc.readBytes(target, undefined, 4096)
    check(bytes instanceof Uint8Array && Buffer.from(bytes).toString('utf8') === 'REMOTE-CONTENT', 'readBytes：本地没有 → 远端字节')
    const streamed = []
    for await (const chunk of await svc.streamText(target)) streamed.push(chunk)
    check(streamed.join('') === 'REMOTE-CONTENT', 'streamText：本地没有 → 远端文本流')
    const win = await svc.readByteRange(target, { offset: 10, length: 32 })
    check(Buffer.from(win).toString('utf8') === 'RANGE', 'readByteRange：本地没有 → 远端窗口字节')
    check(reader.seen.some((s) => s[0] === 'readRange' && s[2] === 10 && s[3] === 32), '区间参数原样传到远端（offset/length）')
    const entries = await svc.listDir({ targetKey: 'missing-dir', displayPath: 'D:\\mirror\\w1\\figures' })
    check(entries.length === 2 && entries[0].type === 'directory', 'listDir：本地没有 → 远端列举')
    check(entries.every((e) => e.target && String(e.target.targetKey).startsWith('remote-ssh:')),
      'listDir 返回的每个子项带**合成 target**（后续读操作可继续走远端）')
  }

  // C3 · resolve 的兜底与"远端也没有"
  {
    const REMOTE_ONLY = 'D:\\mirror\\w1\\missing\\x.png'
    const { svc } = fakeFs({ local: {} })
    const reader = fakeReader({ [REMOTE_ONLY]: { text: 'X' } })
    api.installFsReadBridge(svc, { reader })
    const t = await svc.resolve(REMOTE_ONLY)
    check(t && t.displayPath === REMOTE_ONLY && String(t.targetKey).startsWith('remote-ssh:'),
      'resolve：原实现报 not-found + 远端有 → 合成 target')

    const reader2 = fakeReader({})
    const { svc: svc2 } = fakeFs({ local: {} })
    api.installFsReadBridge(svc2, { reader: reader2 })
    let caught = null
    try { await svc2.resolve('D:\\mirror\\w1\\missing\\gone.png') } catch (e) { caught = e }
    check(caught && caught.code === 'FS_NOT_FOUND', 'resolve：远端也没有 → **抛原实现的错**（不伪造存在）')

    // 合成 target 上的 processPath / contains / fileUrl / watch（用上面 resolve 真造出来的那个）
    const target = t
    check(svc.processPath(target) === REMOTE_ONLY, 'processPath：合成 target → displayPath（不把伪造 key 递给原生后端）')
    check(svc.contains({ targetKey: 'r', displayPath: 'D:\\mirror\\w1' }, target) === true,
      'contains：合成 target 按 displayPath 前缀判包含（workspace-file 的围栏检查不会误杀）')
    check(svc.contains({ targetKey: 'r', displayPath: 'D:\\mirror\\w1' }, { targetKey: 'x', displayPath: 'D:\\other\\y' }) === false,
      'contains：普通 target 仍走原实现（负向控制）')
    check(/^file:\/\//.test(svc.fileUrl(target)), 'fileUrl：合成 target 给出 file:// URI（不让原实现抛）')
    const closer = await svc.watch(target);
    check(typeof closer === 'function', 'watch：合成 target → 返回空关闭函数（远端影子不提供 watch）')
    let caughtWatch = null
    try { await svc.watch({ targetKey: 'zz', displayPath: 'D:\\mirror\\w1\\ghost' }) } catch (e) { caughtWatch = e }
    check(caughtWatch === null, 'watch：本地缺失的普通路径 → 也退化为空关闭函数（不把预览的 changes 通道打断）')
  }

  // C4 · 错误码与二进制拒绝
  {
    const { svc } = fakeFs({ local: {} })
    const binaryPath = 'D:\\mirror\\w1\\img\\x.png'
    const reader = fakeReader({ [binaryPath]: { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x00, 0x01]), size: 5 } })
    api.installFsReadBridge(svc, { reader })
    let txtErr = null
    try { await svc.readText({ targetKey: 'k', displayPath: binaryPath }) } catch (e) { txtErr = e }
    check(txtErr && txtErr.code === 'FS_NOT_TEXT', 'readText：远端二进制（含 NUL）→ FS_NOT_TEXT（与后端同一套码）')

    let bigErr = null
    try { await svc.readBytes({ targetKey: 'k', displayPath: binaryPath }, undefined, 4) } catch (e) { bigErr = e }
    check(bigErr && bigErr.code === 'FS_TOO_LARGE', 'readBytes：超过 maxBytes → FS_TOO_LARGE（不静默截断）')

    const abort = new AbortController(); abort.abort()
    let abortErr = null
    try { await svc.readText({ targetKey: 'k', displayPath: binaryPath }, abort.signal) } catch (e) { abortErr = e }
    check(abortErr && abortErr.code === 'FS_ABORTED', '已取消的 signal → FS_ABORTED（不继续跑远端）')

    const { svc: svc3 } = fakeFs({ local: {} })
    api.installFsReadBridge(svc3, { reader: fakeReader({}) })
    let nf = null
    try { await svc3.readText({ targetKey: 'k', displayPath: 'D:\\mirror\\w1\\gone.txt' }) } catch (e) { nf = e }
    check(nf && nf.code === 'FS_NOT_FOUND', '远端也没有 → FS_NOT_FOUND（预览因此显示"文件不存在"，与旧行为一致）')
  }

  // C5 · 安装/恢复的健壮性
  {
    check(api.installFsReadBridge(undefined, { reader: {} }) === null, '服务缺失 → null')
    check(api.installFsReadBridge({}, { reader: fakeReader({}) }) === null, '不是 fs 服务（没有 stat/lstat/readText）→ null')
    check(api.installFsReadBridge(fakeFs({}).svc, {}) === null, '未提供 reader → null')

    // 恢复：身份不符时不覆盖别人的包装器
    const { svc } = fakeFs({ local: {} })
    const restore = api.installFsReadBridge(svc, { reader: fakeReader({}) })
    const foreign = async () => 'FOREIGN'
    svc.readText = foreign
    restore()
    check(svc.readText === foreign, '恢复时做身份校验：别人换掉的实现不被覆盖')
    check(typeof svc.stat === 'function' && !/return await orig/.test(String(svc.stat)), '其余方法已恢复成原实现')
  }
}

// ---------------------------------------------------------------------------
console.log('D · 接线')
{
  check(/ctx\.inject\(\["fs"\]/.test(src), '仍用软注入 ctx.fs（缺失时不阻塞插件挂载）')
  check(/installFsReadBridge\(svc, \{ reader: fsReader, log: ctx\.logger \}\)/.test(src), '读桥接到 fsReader')
  check(/const fsReader = makeMirrorFsReader\(\{/.test(src), 'fsReader 由 makeMirrorFsReader 建（依赖可注入）')
  check(/runner: runPooled/.test(src), 'runner 用池化会话（连接复用，不额外开连接）')
  check(/const hit = findMirrorRoot\(absPath\);/.test(src) && /const remotePath = localToRemote\(absPath, hit\.root, hit\.info\.remotePath\)/.test(src),
    '镜像路径 → 远端路径用既有的 findMirrorRoot + localToRemote（不另造映射）')
  check(/listDir: remoteListDir/.test(src), '远端列举复用 remoteListDir（命中 treeCache，不多花往返）')
  check(/if \(restoreFsRead\) \{ try \{ restoreFsRead\(\); \}/.test(src), '清理时恢复读方法')
  check(/读方法不可包装/.test(src), '不可包装时留一条 warn（可诊断）')
  check(!/webServer\.(get|post)\([^)]*preview/i.test(src), '没有为预览新增 HTTP 路由（问题在进程内服务，加路由无用）')
  check(/const FS_ENTRY_MARK = "__DSH_FSENTRY__"/.test(src), '标记常量与 DSH_ST_MARK 分开（避免两个协议互解析）')
  // 线上契约：包装的方法集合必须覆盖 workspace-files 实际调用的读方法
  const body = grab('function installFsReadBridge')
  for (const m of ['stat', 'lstat', 'resolve', 'readText', 'streamText', 'readBytes', 'readByteRange', 'listDir', 'contains', 'processPath', 'fileUrl', 'watch']) {
    check(new RegExp('"' + m + '"').test(body), '包装集合包含 ' + m + '（workspace-files 会调它）')
  }
  check(/if \(out !== undefined\) return out;/.test(body), '本地有 → 原样透传（零回归的核心判断）')
  check(/if \(!info\.ok \|\| info\.kind === "absent"\) return out;/.test(body), '远端也没有 → 返回原实现的结果（不伪造存在）')
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
