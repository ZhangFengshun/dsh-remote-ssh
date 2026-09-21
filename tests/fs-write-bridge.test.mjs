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
  check(/await remoteWriteFile\(runPooled, p, remoteFile, content\)/.test(src), '用既有 remoteWriteFile 定向写该文件（不是整镜像 tar）')
  check(/"mkdir -p " \+ shellQuotePath\(remoteDir\)/.test(src), '写前 mkdir -p 远端父目录（新目录里的新文件）')
  check(/await runPooled\(p, "mkdir -p/.test(src) && /await remoteWriteFile/.test(src), '两步都在同一池化会话（连接复用）')
  check(/本地镜像已写入/.test(src), '推送失败时的告警文案说明本地已写入')
  check(!/remoteSyncUp\(/.test(grab('async function mirrorWriteToRemote')), '不调用整镜像 push（避免用旧镜像覆盖远端其它文件）')
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
