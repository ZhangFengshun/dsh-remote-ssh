// agent 文件工具写回远端 回归测试（issue #15）。
//
// 背景：远程工作区会话里 agent 的 write / edit 走**进程内** ctx.fs（base bundle 挂的是本地
// fs-sandbox），只落本地镜像 —— 用户在远端机器上找不到文件，只能人工 push/scp。
// 修法：包装 ctx.fs 的 writeText / editText —— **原方法照旧调用**（镜像内容、沙箱围栏、
// 写意图语义全不变），成功后把 outcome.after 的同一份内容定向推回远端那个文件。
//
// 三层：
//   A. installFsWriteBridge 行为（假 fs 服务）：委托、参数透传、回调内容、错误隔离、恢复
//   B. findMirrorRoot（真实文件系统）：镜像根识别、嵌套、边界
//   C. 接线断言（软注入 ctx.fs、清理恢复、定向推送而非整镜像）
import { readFileSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

const api = new Function(
  'dirname', 'join', 'existsSync', 'readFileSync',
  grab('function findMirrorRoot') + '\n' + grab('function installFsWriteBridge') +
  '\nreturn { findMirrorRoot, installFsWriteBridge };'
)(
  (await import('node:path')).dirname,
  (await import('node:path')).join,
  (await import('node:fs')).existsSync,
  (await import('node:fs')).readFileSync,
)

let pass = 0, fail = 0
const check = (cond, label) => { if (cond) { pass++; console.log('  ✓ ' + label) } else { fail++; console.log('  ✗ FAIL: ' + label) } }

/** 假 ctx.fs：记录调用，返回可控 outcome。 */
function fakeFs(opts = {}) {
  const calls = []
  const svc = {
    writeText: async (target, content, expected, signal, policy) => {
      calls.push({ method: 'writeText', target, content, expected, signal, policy })
      if (opts.writeThrows) throw new Error('FS_DENIED')
      return { operation: 'create', version: 'v1', before: null, after: opts.after !== undefined ? opts.after : content }
    },
    editText: async (target, edit, expected, signal, policy) => {
      calls.push({ method: 'editText', target, edit, expected, signal, policy })
      return { version: 'v2', before: 'old', after: opts.after !== undefined ? opts.after : 'new' }
    },
    processPath: (t) => t.processPath,
    readText: async () => 'untouched',
  }
  return { svc, calls }
}

console.log('A · installFsWriteBridge 行为')
{
  const { svc, calls } = fakeFs()
  const written = []
  const restore = api.installFsWriteBridge(svc, { onWritten: (p, c) => { written.push([p, c]) } })
  check(typeof restore === 'function', '安装成功返回恢复函数')

  const target = { targetKey: 'k1', displayPath: 'rel/a.md', processPath: '/mirror/w1/docs/a.md' }
  const out = await svc.writeText(target, 'hello', { kind: 'createIfAbsent' }, 'sig', { mode: 'workspace-write', workspaceRoot: '/mirror/w1' })
  check(out && out.after === 'hello', '原 writeText 的返回值原样透传')
  check(calls.length === 1 && calls[0].content === 'hello', '原方法被调用一次且内容一致')
  check(calls[0].expected && calls[0].expected.kind === 'createIfAbsent' && calls[0].signal === 'sig' && calls[0].policy.mode === 'workspace-write',
    '写意图 / signal / sandboxPolicy 原样透传（沙箱语义不变）')
  check(written.length === 1 && written[0][0] === '/mirror/w1/docs/a.md' && written[0][1] === 'hello',
    '回调收到（processPath 规范路径, 写入后的内容）')
  check(calls[0].target === target, 'target 未被伪造（原对象直接传给原方法）')

  written.length = 0
  await svc.editText(target, { oldString: 'a', newString: 'b', replaceAll: false }, { version: 'v1' }, 'sig', { mode: 'workspace-write', workspaceRoot: '/mirror/w1' })
  check(written.length === 1 && written[0][1] === 'new', 'editText 用 outcome.after 回调（编辑后的完整内容）')

  restore()
  const afterRestore = await svc.writeText(target, 'again')
  check(written.length === 1, '恢复后不再回调')
  check(afterRestore.after === 'again', '恢复后原实现仍可用')
  check(svc.readText !== undefined, '其它方法未被触碰')
}

console.log('A2 · 边界与错误隔离')
{
  // 写入失败 → 不回调
  const { svc } = fakeFs({ writeThrows: true })
  const written = []
  api.installFsWriteBridge(svc, { onWritten: (p, c) => written.push([p, c]) })
  let threw = false
  try { await svc.writeText({ targetKey: 'k', processPath: '/m/a' }, 'x') } catch (e) { threw = true }
  check(threw === true, '原写入抛错时异常照旧抛出（不吞）')
  check(written.length === 0, '原写入失败 → 不回调（不会把失败当成功推）')

  // 回调抛错 → 不影响写入结果，只告警
  const { svc: svc2 } = fakeFs()
  const warns = []
  api.installFsWriteBridge(svc2, { onWritten: () => { throw new Error('ssh down') }, log: { warn: (m) => warns.push(m) } })
  const out2 = await svc2.writeText({ targetKey: 'k', processPath: '/m/a' }, 'y')
  check(out2.after === 'y', '回调失败不影响写入结果（本地写入已成功）')
  check(warns.length === 1 && /本地镜像已写入/.test(warns[0]), '回调失败只记一条 warn，且说明本地已写入')

  // 无 processPath 时退回 displayPath
  const { svc: svc3 } = fakeFs()
  const seen = []
  api.installFsWriteBridge(svc3, { onWritten: (p) => seen.push(p) })
  await svc3.writeText({ targetKey: 'k', displayPath: 'D:\\m\\a.md' }, 'z')
  check(seen[0] === 'D:\\m\\a.md', '无 processPath 时退回 displayPath')

  // 非法服务 → 安全返回 null
  check(api.installFsWriteBridge({}, { onWritten: () => {} }) === null, '缺少 writeText → 返回 null（不抛）')
  check(api.installFsWriteBridge(undefined, { onWritten: () => {} }) === null, '服务缺失 → 返回 null')
  check(api.installFsWriteBridge(fakeFs().svc, {}) === null, '未提供 onWritten → 返回 null')
}

console.log('B · findMirrorRoot（真实文件系统）')
{
  const base = mkdtempSync(join(tmpdir(), 'rssh-mirror-'))
  try {
    const mirror = join(base, 'wmirror1')
    mkdirSync(join(mirror, 'docs', 'deep'), { recursive: true })
    writeFileSync(join(mirror, '.remote-ssh.json'), JSON.stringify({ profileId: 'p1', host: 'hpc-a.example.com', user: 'u', remotePath: '~/proj' }))
    const hit = api.findMirrorRoot(join(mirror, 'docs', 'deep', 'a.md'))
    check(hit && hit.root === mirror, '嵌套深层文件能找到镜像根')
    check(hit && hit.info.remotePath === '~/proj', '带回 .remote-ssh.json 的内容')
    check(api.findMirrorRoot(join(base, 'elsewhere', 'x.md')) === null, '非镜像路径 → null')
    // 标记文件缺少必需字段 → 不算镜像根
    const bad = join(base, 'wmirror2')
    mkdirSync(bad, { recursive: true })
    writeFileSync(join(bad, '.remote-ssh.json'), JSON.stringify({ profileId: 'p1' }))
    check(api.findMirrorRoot(join(bad, 'a.md')) === null, '标记缺 host/user/remotePath → null（不误判）')
    check(api.findMirrorRoot('') === null && api.findMirrorRoot(undefined) === null, '空路径安全')
    // 越界深度（镜像根在 9 层以上）→ null（有界，避免病态遍历）
    let deep = join(base, 'wmirror3')
    mkdirSync(deep, { recursive: true })
    writeFileSync(join(deep, '.remote-ssh.json'), JSON.stringify({ host: 'h', user: 'u', remotePath: '~/p' }))
    let nested = deep
    for (let i = 0; i < 9; i++) { nested = join(nested, 'd' + i); mkdirSync(nested, { recursive: true }) }
    check(api.findMirrorRoot(join(nested, 'a.md')) === null, '超过 8 层 → null（有界）')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

console.log('C · 接线')
{
  check(/ctx\.inject\(\["fs"\]/.test(src), '软注入 ctx.fs（缺失时不阻塞插件挂载）')
  check(/installFsWriteBridge\(svc, \{ onWritten: mirrorWriteToRemote, log: ctx\.logger \}\)/.test(src), '桥接到 mirrorWriteToRemote')
  check(/if \(restoreFsWrite\) \{ try \{ restoreFsWrite\(\); \}/.test(src), '清理时恢复原方法')
  check(/const hit = findMirrorRoot\(absPath\);\s*\n\s*if \(!hit\) return;/.test(src), '非镜像路径直接返回（本地工作区零影响）')
  check(/await remoteWriteFileChunked\(runPooled, p, remoteFile, content\)/.test(src), '走 remoteWriteFileChunked 定向写该文件（小文件内部仍走 remoteWriteFile，>4 MiB 分块）')
  check(/"mkdir -p " \+ shellQuotePath\(remoteDir\)/.test(src), '写前 mkdir -p 远端父目录（新目录里的新文件）')
  check(/await runPooled\(p, "mkdir -p/.test(src) && /await remoteWriteFileChunked/.test(src), '两步都在同一池化会话（连接复用）')
  check(/本地镜像已写入/.test(src), '推送失败时的告警文案说明本地已写入')
  check(!/remoteSyncUp\(/.test(grab('async function mirrorWriteToRemote')), '不调用整镜像 push（避免用旧镜像覆盖远端其它文件）')
}

// ---------------------------------------------------------------------------
// issue #24：写回桥的失败可见性与护栏
//   ① >4 MiB 的内容不再确定性失败（分块 base64 追加 + 远端字节数校验）
//   ② 每个工作区可关掉写回或排除路径（writeBack / writeBackExclude）
//   ③ 推送失败默认抛错让模型看见（工具报错是本版 DSH 上唯一的模型可见通道）
// ---------------------------------------------------------------------------
const chunkApi = new Function(
  'dirname', 'join', 'existsSync', 'readFileSync', 'MAX_BYTES', 'shellQuotePath', 'invalidateRemoteCaches', 'syncErrText', 'remoteWriteFile',
  grab('function remoteWriteFileChunked') + '\n' + grab('function globToRegExp') + '\n' + grab('function matchAnyGlob') +
  '\nreturn { remoteWriteFileChunked, globToRegExp, matchAnyGlob };'
)(
  (await import('node:path')).dirname,
  (await import('node:path')).join,
  (await import('node:fs')).existsSync,
  (await import('node:fs')).readFileSync,
  4 * 1024 * 1024,                                   // 与 lib 里的 MAX_BYTES 一致（下面的载荷要越过它）
  (s) => "'" + String(s) + "'",
  () => {},
  (e) => String((e && e.message) || e),
  // 真实的 remoteWriteFile 语义（4 MiB 守卫 + base64 -d 单发）——负向控制要用它
  async (runner, p, path, content) => {
    const c = content !== undefined ? String(content) : ''
    if (c.length > 4 * 1024 * 1024) return { ok: false, exitCode: -1, stdout: '', stderr: '', error: '写入内容超过 ' + 4 * 1024 * 1024 + ' 字节上限', truncated: false }
    return runner(p, 'base64 -d > ' + "'" + path + "'", Buffer.from(c, 'utf8').toString('base64'), 4 * 1024 * 1024, true)
  }
)

/** 假 runner：把每次调用的命令与 stdin 记下来，按脚本应答。 */
function fakeRunner(opts = {}) {
  const calls = []
  const fn = async (p, cmd, stdinData) => {
    calls.push({ cmd, stdin: stdinData === undefined ? '' : String(stdinData) })
    if (opts.failAt !== undefined && calls.length === opts.failAt) return { ok: false, exitCode: 1, stdout: '', stderr: 'disk full', error: 'disk full' }
    if (/^wc -c </.test(cmd)) return { ok: true, exitCode: 0, stdout: String(opts.reportBytes !== undefined ? opts.reportBytes : opts.expectBytes) + '\n', stderr: '' }
    return { ok: true, exitCode: 0, stdout: '', stderr: '' }
  }
  fn.calls = calls
  return fn
}

console.log('D1 · 分块上传：>4 MiB 不再确定性失败（issue #24 主线）')
{
  // 7 MiB 载荷，含多字节字符：中文 + emoji + 末尾不足 3 字节的尾巴
  const base = '数据📊 line\n'
  const payload = base.repeat(Math.ceil((7 * 1024 * 1024) / base.length)).slice(0, 7 * 1024 * 1024)
  const bytes = Buffer.byteLength(payload, 'utf8')
  check(bytes > 4 * 1024 * 1024, '测试载荷确实越过 4 MiB（' + bytes + ' 字节）')

  // 负向控制：旧的 remoteWriteFile 对同一内容是确定性失败（issue #24 报的就是这个）
  const legacyRunner = fakeRunner({})
  const legacyCall = await (async () => {
    // 注入的 remoteWriteFile 语义（4 MiB 守卫 + base64 -d 单发）
    const fn = new Function('runner', 'p', 'path', 'content', 'return (async () => { const c = String(content); if (c.length > 4 * 1024 * 1024) return { ok: false, error: "写入内容超过 " + 4 * 1024 * 1024 + " 字节上限" }; return runner(p, "base64 -d > " + path, Buffer.from(c, "utf8").toString("base64")); })()')
    return fn(legacyRunner, {}, '/r/big.txt', payload)
  })()
  check(legacyCall.ok === false && /4 MiB|上限/.test(String(legacyCall.error) || ''),
    '负向控制：旧路径对 7 MiB 内容是确定性失败（只落日志，模型看不见）')

  const runner = fakeRunner({ expectBytes: bytes })
  const r = await chunkApi.remoteWriteFileChunked(runner, {}, '/remote/big.txt', payload)
  check(r.ok === true, '新路径成功（不再因体积失败）')
  const writes = runner.calls.filter((c) => /^base64 -d /.test(c.cmd))
  const expectChunks = Math.ceil(bytes / (3 * 1024 * 1024))
  check(writes.length === expectChunks, '分块数 = ceil(字节数 / 3 MiB) = ' + expectChunks + '（按字节切，不是按字符）')
  check(/^base64 -d > /.test(writes[0].cmd) && writes.slice(1).every((c) => /^base64 -d >> /.test(c.cmd)),
    '首块用 > 覆盖、后续用 >> 追加')
  // 关键性质：块大小是 3 的倍数 → 非末块 base64 不带 padding，可直接拼接
  check(writes.slice(0, -1).every((c) => !c.stdin.includes('=')), '非末块 base64 无 padding（可直接拼接）')
  const joined = Buffer.concat(writes.map((c) => Buffer.from(c.stdin, 'base64')))
  check(joined.equals(Buffer.from(payload, 'utf8')), '各块解码后拼接的字节与原内容逐字节相同（多字节字符未被劈开）')
  check(runner.calls.some((c) => /^wc -c </.test(c.cmd)), '写后用 wc -c 校验远端字节数')
  check(r.bytes === bytes, '返回值带回实际字节数（日志用）')

  // 中途失败 → 明确报出第几块，并提示可能截断
  const bad = fakeRunner({ failAt: 2 })
  const rb = await chunkApi.remoteWriteFileChunked(bad, {}, '/remote/big.txt', payload)
  check(rb.ok === false && new RegExp('第 2/' + expectChunks + ' 块').test(String(rb.error)) && /截断/.test(String(rb.error)),
    '中途失败 → 报出块序号并提示远端文件可能被截断')

  // 字节数不一致 → 失败（防"命令都成功但文件少一截"）
  const wrong = fakeRunner({ reportBytes: bytes - 1 })
  const rw = await chunkApi.remoteWriteFileChunked(wrong, {}, '/remote/big.txt', payload)
  check(rw.ok === false && /不一致/.test(String(rw.error)), '远端字节数与本地不一致 → 判失败（完整性校验生效）')

  // 小文件仍走原路径（一次 base64 -d >，无分块、无 wc）
  const small = fakeRunner({})
  const rs = await chunkApi.remoteWriteFileChunked(small, {}, '/remote/small.txt', '你好')
  check(rs.ok === true && small.calls.length === 1 && /^base64 -d > /.test(small.calls[0].cmd),
    '小文件仍是一次 base64 -d >（行为与 2.4.23 相同，无额外往返）')
}

console.log('D2 · writeBackExclude 的 glob 语义')
{
  const m = (pats, rel) => chunkApi.matchAnyGlob(pats, rel)
  check(m(['_patch/**'], '_patch/draft.md') === true, '** 跨目录：_patch/** 命中 _patch/draft.md')
  check(m(['_patch/**'], '_patch/a/b/c.txt') === true, '** 跨多层目录')
  check(m(['_patch/**'], 'src/_patch.md') === false, '整路径锚定，不是子串匹配')
  check(m(['**/*.tmp'], 'a/b/x.tmp') === true && m(['**/*.tmp'], 'x.tmp') === true, '**/*.tmp 命中任意层级（含根层）')
  check(m(['*.log'], 'run.log') === true && m(['*.log'], 'a/run.log') === false, '* 不跨目录')
  check(m(['docs/*.md'], 'docs/a.md') === true && m(['docs/*.md'], 'docs/sub/a.md') === false, 'docs/*.md 只匹配一层')
  check(m(['a/b.txt'], 'a/b.txt') === true && m(['a/b.txt'], 'a/b.txt.bak') === false, '精确路径匹配')
  check(m(['_patch/'], '_patch/x') === true && m(['_patch/'], '_patch') === true, '结尾带 / 视为目录前缀')
  check(m(['_patch/'], '_patch2/x') === false, '目录前缀不误伤同名前缀目录（_patch2）')
  check(m(['?.md'], 'a.md') === true && m(['?.md'], 'ab.md') === false, '? 匹配单个字符')
  check(m([], 'anything') === false && m(['', '  '], 'x') === false, '空规则不排除任何东西')
  check(m(['a+b.md'], 'a+b.md') === true && m(['a+b.md'], 'aab.md') === false, '正则元字符按字面处理')
}

console.log('D3 · 推送失败对模型可见（工具报错）')
{
  // 真实 installFsWriteBridge：标记过的失败必须继续上抛
  const { svc } = fakeFs()
  api.installFsWriteBridge(svc, {
    onWritten: () => { const e = new Error('本地镜像已写入成功，但同步到远端失败：/r/x.txt — ssh 断开'); e.dshRemoteSshWriteBack = true; throw e },
  })
  let caught = null
  try { await svc.writeText({ targetKey: 'k', processPath: '/mirror/w1/a.md' }, 'data') } catch (e) { caught = e }
  check(caught !== null, '标记过的写回失败会让 writeText 抛错（→ 工具报错 → 模型看得见）')
  check(caught && /本地镜像已写入成功/.test(caught.message), '错误消息点明本地写入是成功的（模型不会以为本地也没写成）')
  // 真实文案在源码里（断言实现，而不是断言测试自造的文本）
  check(/remote_ssh_push 补推/.test(grab('async function mirrorWriteToRemote')), '真实错误文案给出补救路径（remote_ssh_push）')

  // 未标记的异常仍然只告警（不改变工具行为）
  const { svc: svc2 } = fakeFs()
  const warns = []
  api.installFsWriteBridge(svc2, { onWritten: () => { throw new Error('别的错') }, log: { warn: (m) => warns.push(m) } })
  const ok = await svc2.writeText({ targetKey: 'k', processPath: '/m/a' }, 'y')
  check(ok.after === 'y' && warns.length === 1, '未标记的异常仍只告警，写入结果照常返回')

  // 接线：模式开关 + 护栏
  check(/writeBackFailure: z\.string\(\)\.default\("error"\)/.test(src), '设置项 writeBackFailure 默认 "error"（可见）')
  check(/DSH_REMOTE_SSH_WRITEBACK_FAILURE/.test(src), '环境变量可覆盖（现场应急用）')
  check(/writeBack: z\.boolean\(\)\.default\(true\)/.test(src) && /writeBackExclude: z\.array\(z\.string\(\)\)\.default\(\[\]\)/.test(src),
    '每个工作区有 writeBack / writeBackExclude（默认不改变旧行为）')
  const body = grab('async function mirrorWriteToRemote')
  check(/w\.writeBack === false/.test(body) && /matchAnyGlob\(w\.writeBackExclude, relPath\)/.test(body),
    '写回前按工作区设置判断开关与排除（命中就完全不推送）')
  check(/err\.dshRemoteSshWriteBack = true/.test(body) && /writeBackFailureMode\(\) !== "error"/.test(body),
    '失败默认抛标记错误，可退回只记日志')
  check(/settingsFace\.read\(\)\.workspaces/.test(body), '按镜像目录匹配工作区设置（不是全局一刀切）')
}

// ---------------------------------------------------------------------------
// E · 护栏 B：写回之前的远端新鲜度检查（issue #24 第二轮验收）
//
// 举报人的现场：共享集群上最常见的"另一个写入者"是**你自己刚跑完的作业** —— 作业改了远端，
// 镜像还是旧版，agent 再写一次就把远端内容静默覆盖了。判据按他的建议**只在远端自己的时间轴上
// 自比**（不与本地 mtime 比，避开跨机时钟偏移与 tar/base64 重写），这里把该判据抽成纯函数验证。
// ---------------------------------------------------------------------------
const { existsSync } = await import('node:fs')
const guardSrc = src.slice(
  src.indexOf('function freshnessFile(stateDir)'),
  src.indexOf('/**\n * 把 glob 模式转成锚定')
)
if (!guardSrc) throw new Error('护栏 B 的代码未找到（freshnessFile … freshnessVerdict）')
const guardApi = new Function(
  'join', 'readFileSync', 'writeFileSync', 'mkdirSync', 'shellQuotePath', 'syncErrText',
  guardSrc + '\nreturn { freshnessGet, freshnessSet, freshnessForget, freshnessForgetProfile, remoteMtimeInfo, freshnessVerdict };'
)(
  (await import('node:path')).join,
  readFileSync,
  writeFileSync,
  mkdirSync,
  (s) => "'" + String(s) + "'",
  (e) => String((e && e.message) || e)
)

console.log('E · 护栏 B 判据：三态（没变 / 被改过 / 读不到）')
{
  const same = guardApi.freshnessVerdict('100:200', { ok: true, exists: true, stamp: '100:200' })
  check(same.changed === false && same.unknown === false, '记录一致 → 没被改过（照常推送）')
  const diff = guardApi.freshnessVerdict('100:200', { ok: true, exists: true, stamp: '120:260' })
  check(diff.changed === true && /已变/.test(diff.why), 'size:mtime 变了 → 判定"远端被改过"（不推送）')
  const sizeOnly = guardApi.freshnessVerdict('100:200', { ok: true, exists: true, stamp: '101:200' })
  check(sizeOnly.changed === true, '只有 size 变了也算（同秒内改动的兜底；举报人只提了 mtime，size 是白拿的）')
  const gone = guardApi.freshnessVerdict('100:200', { ok: true, exists: false })
  check(gone.changed === true && /不存在/.test(gone.why), '远端这份已消失 → 也算被改过（不静默重建）')
  const unknown = guardApi.freshnessVerdict('100:200', { ok: false, exists: false, err: 'connection reset' })
  check(unknown.changed === false && unknown.unknown === true,
    '读失败 → 状态未知，**不能**当成被改过（把 flaky 连接变成"拦住写入"是错的）')
  check(guardApi.freshnessVerdict('', null).changed === false, '没有记录 → 放行（首次推这个路径）')
}

console.log('E2 · 状态文件（~/.dsh/remote-ssh/writeback-mtimes.json）')
{
  const stateDir = mkdtempSync(join(tmpdir(), 'rssh-fresh-'))
  try {
    check(guardApi.freshnessGet(stateDir, 'p1', '/r/a.txt') === '', '没有记录时返回空串')
    guardApi.freshnessSet(stateDir, 'p1', '/r/a.txt', '100:200')
    check(guardApi.freshnessGet(stateDir, 'p1', '/r/a.txt') === '100:200', '写入后能读回')
    check(existsSync(join(stateDir, 'writeback-mtimes.json')), '落在 writeback-mtimes.json（用户可人工检查/删除）')
    guardApi.freshnessForget(stateDir, 'p1', '/r/a.txt')
    check(guardApi.freshnessGet(stateDir, 'p1', '/r/a.txt') === '', 'forget 之后该路径没有记录')
    guardApi.freshnessSet(stateDir, 'p1', '/r/a.txt', '1:2')
    guardApi.freshnessSet(stateDir, 'p1', '/r/b.txt', '1:3')
    guardApi.freshnessSet(stateDir, 'p2', '/r/c.txt', '1:4')
    guardApi.freshnessForgetProfile(stateDir, 'p1')
    check(guardApi.freshnessGet(stateDir, 'p1', '/r/a.txt') === '' && guardApi.freshnessGet(stateDir, 'p1', '/r/b.txt') === '',
      'forgetProfile 清掉该连接的全部记录（push / sync 成功之后用）')
    check(guardApi.freshnessGet(stateDir, 'p2', '/r/c.txt') === '1:4', '不碰别的连接的记录（负向控制）')
    writeFileSync(join(stateDir, 'writeback-mtimes.json'), '{ not json', 'utf8')
    check(guardApi.freshnessGet(stateDir, 'p1', '/r/a.txt') === '', '状态文件损坏 → 当作没有记录（不抛、不挡写入）')
    check(guardApi.freshnessGet(join(stateDir, 'no-such-dir'), 'p9', '/r/x') === '', '状态目录不存在 → 空串（不抛）')
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
}

console.log('E3 · remoteMtimeInfo：三态由真实 stat 输出决定')
{
  const runnerOf = (out) => async () => ({ ok: out.ok, exitCode: out.ok ? 0 : 1, stdout: out.stdout || '', stderr: out.stderr || '', error: out.error || '' })
  const good = await guardApi.remoteMtimeInfo(runnerOf({ ok: true, stdout: '5242919 1760000000\n' }), {}, '/r/big.bin')
  check(good.ok === true && good.exists === true && good.stamp === '5242919:1760000000', '正常输出 → size:mtime 解析正确')
  const miss = await guardApi.remoteMtimeInfo(runnerOf({ ok: false, stderr: "stat: cannot statx '/r/gone': No such file or directory" }), {}, '/r/gone')
  check(miss.ok === true && miss.exists === false, '远端没有这个文件 → exists:false（这才是"被改过"，不是"读不到"）')
  const err = await guardApi.remoteMtimeInfo(runnerOf({ ok: false, stderr: 'ssh: connect to host x port 22: Connection refused' }), {}, '/r/a')
  check(err.ok === false && err.exists === false, '连接失败 → ok:false（状态未知 → 调用方放行）')
  const boom = await guardApi.remoteMtimeInfo(async () => { throw new Error('socket hang up') }, {}, '/r/a')
  check(boom.ok === false && /socket hang up/.test(boom.err), 'runner 抛错 → 也归为"状态未知"，不崩')
  let seen = ''
  await guardApi.remoteMtimeInfo(async (p, cmd) => { seen = cmd; return { ok: true, stdout: '1 2' } }, {}, '/r/big.bin')
  check(seen === "stat -c'%s %Y' '/r/big.bin'", '命令形状与本插件既有的 stat 一致：' + seen)
}

console.log('E4 · 接线：查→推→记，且 push/sync/显式写之后忘掉记录')
{
  const iCheck = src.indexOf('freshnessGet(wrapperDir, p.id, remoteFile)')
  const iWrite = src.indexOf('remoteWriteFileChunked(runPooled, p, remoteFile, content)')
  const iRecord = src.indexOf('freshnessSet(wrapperDir, p.id, remoteFile, after.stamp)')
  check(iCheck > 0 && iCheck < iWrite, '推送**之前**先查（顺序：查 → 推）')
  check(iRecord > iWrite, '推送**成功之后**才记录（顺序：推 → 记）')
  check(/if \(verdict\.changed\)/.test(src), '被改过时走"不推送"分支')
  check((src.match(/freshnessForgetProfile\(wrapperDir, p\.id\)/g) || []).length === 4,
    'push/sync 成功后都清记录（工具 + API 两条路各两处 = 4）')
  check(/freshnessForget\(wrapperDir, p\.id, args\.path\)/.test(src), 'API writeFile 成功 → 忘掉该路径的记录')
  check(/freshnessForget\(wrapperDir, tc\.profile\.id, rp\)/.test(src), 'remote_ssh_write 成功 → 忘掉该路径的记录')
  check(/freshnessForget\(wrapperDir, profile\.id, rp\)/.test(src), '文件面板保存成功 → 忘掉该路径的记录')
  check(/else freshnessForget\(wrapperDir, p\.id, remoteFile\)/.test(src), '推送成功但读不到状态 → 不留陈旧记录')
  check(/writeBackFreshness: z\.boolean\(\)\.default\(true\)/.test(src), '设置项 writeBackFreshness 默认**开**')
  check(/DSH_REMOTE_SSH_WRITEBACK_FRESHNESS/.test(src), '环境变量可强制开关')
  const body = grab('async function mirrorWriteToRemote')
  check(/没有推送到远端/.test(body) && /remote_ssh_sync 把远端拉下来比对/.test(body),
    '真实文案说明"没推送"，并给出 sync / push 两条出路')
  check(/staleErr\.dshRemoteSshWriteBack = true/.test(body), '拦截用同一套标记错误（否则会被写入桥当普通错误吞掉）')
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
