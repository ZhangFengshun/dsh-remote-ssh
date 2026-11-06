/**
 * 远程工作区「编辑器保存」——issue #37。
 *
 * 现象（报告者 v0.28.0）：远程文件在侧栏「文件」编辑器里改完，点 √ 或 Ctrl+S 都保存不上。
 *
 * 根因：better-sidebar 的保存走**原始路由** POST /sidebar/write（不是 /sidebar/api 里的方法 ——
 * 0.25 起 fs.write 就不在 API 表里了），而本插件此前只接管了 /sidebar/api/* 与 /sidebar/file。
 * 于是保存写进**本地镜像**那份：编辑器显示成功，下一次读（走 SSH）又拿回远端旧内容。
 *
 * 分五段：
 *   A. detectRemoteTextFormat 真值表：BOM / 行尾多数表决 / 非 UTF-8 拒绝（GBK / UTF-16 / UTF-32）
 *   B. encodeRemoteText：LF 归一 → 还原 CRLF → 补 BOM
 *   C. handleRemoteWrite 行为（真实处理器 + 假 ctx/req/res + 假远端）：乐观锁 409、BOM/CRLF 保留、
 *      镜像同步、缓存失效、护栏记录作废、非 UTF-8 拒绝、写失败/超限/信任/方法错误
 *   D. 接线断言：服务端注册 /remote-ssh/write、客户端把镜像路径的 /sidebar/write 改投过来
 *   E. 变异负向控制：改坏行尾还原 / 拆掉乐观锁，对应断言必须变红
 */
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const src = readFileSync(root + '/lib/index.js', 'utf8')
const client = readFileSync(root + '/lib/client.js', 'utf8')

function grab(text, marker) {
  const start = text.indexOf(marker)
  if (start < 0) throw new Error('源码里找不到: ' + marker)
  let depth = 0
  let i = text.indexOf('{', start)
  for (; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') { depth--; if (depth === 0) break }
  }
  return text.slice(start, i + 1)
}

let pass = 0
let fail = 0
const check = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label) } else { fail++; console.log('  ✗ FAIL: ' + label) }
}
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64')

// ───────────────────────────── A/B：纯函数 ─────────────────────────────
const pure = new Function(
  'Buffer', 'TextDecoder',
  grab(src, 'function detectRemoteTextFormat') + '\n' + grab(src, 'function encodeRemoteText') +
  '\nreturn { detectRemoteTextFormat, encodeRemoteText };'
)(Buffer, TextDecoder)

{
  console.log('A. detectRemoteTextFormat（BOM / 行尾 / 编码）')
  const { detectRemoteTextFormat } = pure
  const f = (s) => detectRemoteTextFormat(Buffer.from(s, 'utf8'))
  check(JSON.stringify(f('a\nb\n')) === JSON.stringify({ encoding: 'utf8', eol: 'lf' }), 'A1 纯 LF 无 BOM → utf8 + lf')
  check(f('a\r\nb\r\nc\r\n').eol === 'crlf', 'A2 CRLF 占多数 → crlf')
  check(f('a\nb\nc\nd\n').eol === 'lf', 'A3 LF 占多数（即便含一个尾部 CRLF）→ lf')
  const bom = detectRemoteTextFormat(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('x\r\n', 'utf8')]))
  check(bom.encoding === 'utf8-bom' && bom.eol === 'crlf', 'A4 UTF-8 BOM + CRLF 都识别')
  check(detectRemoteTextFormat(Buffer.alloc(0)).encoding === 'utf8', 'A5 空文件默认 utf8 / lf')
  check(!!detectRemoteTextFormat(Buffer.from([0xff, 0xfe, 0x61, 0x00])).unsupported, 'A6 UTF-16 LE BOM → unsupported')
  check(!!detectRemoteTextFormat(Buffer.from([0xfe, 0xff, 0x00, 0x61])).unsupported, 'A7 UTF-16 BE BOM → unsupported')
  check(!!detectRemoteTextFormat(Buffer.from([0xff, 0xfe, 0x00, 0x00, 0x61, 0x00])).unsupported, 'A8 UTF-32 LE BOM → unsupported')
  // GBK「中文」= D6 D0 CE C4，不是合法 UTF-8 序列
  check(!!detectRemoteTextFormat(Buffer.from([0xd6, 0xd0, 0xce, 0xc4])).unsupported, 'A9 非 UTF-8（GBK 字节）→ unsupported')
  check(/非 UTF-8/.test(detectRemoteTextFormat(Buffer.from([0xd6, 0xd0])).unsupported), 'A10 拒绝原因写明「非 UTF-8」')
}

{
  console.log('B. encodeRemoteText（LF 归一 → 还原行尾 → 补 BOM）')
  const { encodeRemoteText } = pure
  check(encodeRemoteText('a\nb\n', { encoding: 'utf8', eol: 'lf' }).toString('utf8') === 'a\nb\n', 'B1 LF 文件原样（不引入 \\r）')
  check(encodeRemoteText('a\nb\n', { encoding: 'utf8', eol: 'crlf' }).toString('utf8') === 'a\r\nb\r\n', 'B2 CRLF 文件还原 \\r\\n')
  check(encodeRemoteText('a\r\nb\r\n', { encoding: 'utf8', eol: 'lf' }).toString('utf8') === 'a\nb\n', 'B3 先归一（不出现 \\r\\r\\n）')
  const withBom = encodeRemoteText('x\n', { encoding: 'utf8-bom', eol: 'lf' })
  check(withBom[0] === 0xef && withBom[1] === 0xbb && withBom[2] === 0xbf && withBom.length === 5 && withBom.subarray(3).toString('utf8') === 'x\n', 'B4 BOM 重新补在开头')
  check(encodeRemoteText(undefined, { encoding: 'utf8', eol: 'lf' }).length === 0, 'B5 undefined → 空内容')
}

// ───────────────────────────── C：真实处理器行为 ─────────────────────────────
function makeEnv(overrides = {}) {
  const ws = { id: 'w1', mirrorPath: '/mirror/w1', remotePath: '/remote/docs' }
  const env = {
    ws,
    trust: 'ok',
    payload: { path: '/mirror/w1/docs/a.md', content: 'hello\n', expectedMtimeMs: undefined },
    frame: { framed: true, err: null, size: 12, mtime: 1700000000, rest: b64('old\r\ncontent\r\n') },
    wrOk: true,
    writes: [],
    mirrorWrites: [],
    invalidated: [],
    forgotten: [],
    resStatus: 0,
    resBody: null,
    afterSec: 1700000005,
    ...overrides
  }
  const handle = new Function(
    'requestTrust', 'denyRequest', 'readJsonBody', 'writeJson', 'writeOk',
    'matchRemoteWorkspace', 'readRemoteInfoSync', 'getProfile', 'localToRemote',
    'runPooled', 'buildReadPageCommand', 'parseStatFrame', 'shellQuotePath',
    'invalidateRemoteCaches', 'freshnessForget', 'wrapperDir', 'writeFileSync',
    'remoteMtimeInfo', 'REMOTE_WRITE_LIMIT', 'Buffer',
    grab(src, 'function detectRemoteTextFormat') + '\n' + grab(src, 'function encodeRemoteText') + '\n' +
    grab(src, 'async function handleRemoteWrite') + '\nreturn { handleRemoteWrite };'
  )(
    () => env.trust,
    (res, reason) => { res.status = 403; res.body = JSON.stringify({ ok: false, error: { code: reason, message: 'denied' } }) },
    async () => env.payload,
    (res, status, body) => { res.status = status; res.body = JSON.stringify(body) },
    (res, value) => { res.status = 200; res.body = JSON.stringify({ ok: true, value }) },
    () => env.ws || null,
    () => ({ profileId: 'p1', remotePath: '/remote/docs' }),
    () => env.profile === undefined ? { id: 'p1' } : env.profile,
    (local, mirror, remote) => String(local).replace(mirror, remote).replace(/\\/g, '/'),
    async (p, cmd, stdin) => {
      if (String(cmd).startsWith('base64 -d > ')) {
        env.writes.push({ cmd: String(cmd), stdin: String(stdin || ''), bytes: Buffer.from(String(stdin || ''), 'base64') })
        return { ok: env.wrOk, stdout: '', stderr: env.wrOk ? '' : 'disk full', error: env.wrOk ? '' : 'boom' }
      }
      return { ok: env.headOk !== false, stdout: 'ignored' }
    },
    () => 'CMD',
    () => env.frame,
    (p) => "'" + String(p).replace(/'/g, "'\\''") + "'",
    (p, path) => env.invalidated.push(path),
    (dir, pid, path) => env.forgotten.push(pid + '|' + path),
    '/wrapper',
    (path, bytes) => env.mirrorWrites.push({ path, bytes: Buffer.from(bytes) }),
    async () => ({ ok: true, exists: true, stamp: '9:' + env.afterSec }),
    undefined,
    Buffer
  )
  env.handle = handle.handleRemoteWrite
  return env
}

async function call(env, method = 'POST') {
  const res = { status: 0, body: null }
  await env.handle({ method, url: '/remote-ssh/write', headers: {} }, res)
  return { status: res.status, body: res.body ? JSON.parse(res.body) : null }
}

{
  console.log('C. handleRemoteWrite（乐观锁 / 格式保留 / 镜像与缓存）')
  {
    const env = makeEnv()
    const r = await call(env)
    check(r.status === 200 && r.body.ok === true && r.body.value.ok === true, 'C1 成功后返回 {ok:true,value:{ok:true,…}}（与 sidebar 信封同形）')
    check(env.writes.length === 1 && env.writes[0].cmd.includes('base64 -d > '), 'C2 远端写入走 base64 -d > <path>（字节级精确）')
    check(env.writes[0].bytes.toString('utf8') === 'hello\r\n', 'C3 远端原文件是 CRLF → 写回仍是 CRLF（' + JSON.stringify(env.writes[0].bytes.toString('utf8')) + '）')
    check(env.writes[0].bytes.toString('utf8').indexOf('\r\n') > 0, 'C4 内容里出现 \\r\\n')
    check(env.invalidated.length === 1 && env.invalidated[0] === '/remote/docs/docs/a.md', 'C5 远端读/树缓存失效（' + env.invalidated.join(',') + '）')
    check(env.forgotten.length === 1 && env.forgotten[0] === 'p1|/remote/docs/docs/a.md', 'C6 写回护栏 B 的记录作废')
    check(env.mirrorWrites.length === 1 && env.mirrorWrites[0].path === '/mirror/w1/docs/a.md', 'C7 本地镜像同步写入同一份字节')
    check(r.body.value.mtimeMs === 1700000005000, 'C8 返回写入后的远端 mtime（毫秒），供编辑器当下一个基线')
  }

  {
    const env = makeEnv({ payload: { path: '/mirror/w1/a.txt', content: 'x\n' } })
    env.frame = { framed: true, err: null, size: 3, mtime: 1700000001, rest: b64('a\r\nb\r\nc\r\n') }
    await call(env)
    check(env.writes[0].bytes.toString('utf8') === 'x\r\n', 'C9 CRLF 文件只写一行也保持 CRLF')
  }

  {
    const env = makeEnv({ payload: { path: '/mirror/w1/b.txt', content: 'y\n' } })
    env.frame = { framed: true, err: null, size: 5, mtime: 1700000002, rest: b64('abc\n') }
    await call(env)
    check(env.writes[0].bytes[0] !== 0xef, 'C10 无 BOM 文件不会凭空加 BOM')
  }

  {
    const env = makeEnv({ payload: { path: '/mirror/w1/c.txt', content: 'z\n' }, frame: null })
    env.frame = { framed: true, err: null, size: 6, mtime: 1700000003, rest: b64('x\r\ny\r\n') }
    await call(env)
    check(env.writes.length === 1, 'C11 正常写入')
  }

  {
    // BOM 文件：写回必须保留 BOM
    const bomHead = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\r\n')])
    const env = makeEnv({ payload: { path: '/mirror/w1/d.txt', content: 'q\n' } })
    env.frame = { framed: true, err: null, size: bomHead.length, mtime: 1700000004, rest: bomHead.toString('base64') }
    await call(env)
    const bytes = env.writes[0].bytes
    check(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf && bytes.subarray(3).toString('utf8') === 'q\r\n', 'C12 UTF-8 BOM 文件保存后 BOM 仍在且 CRLF 保留')
  }

  {
    console.log('C13-C18 乐观锁与错误分支')
    const env = makeEnv({ payload: { path: '/mirror/w1/docs/a.md', content: 'x', expectedMtimeMs: 1600000000000 } })
    const r = await call(env)
    check(r.status === 409 && r.body.error.code === 'fs-conflict', 'C13 基线不匹配 → 409 fs-conflict（编辑器会提示重载）')
    check(env.writes.length === 0, 'C14 冲突时绝不写远端')
    check(/changed on disk/.test(r.body.error.message), 'C15 冲突文案与上游同款（changed on disk …）')
  }
  {
    const env = makeEnv({ payload: { path: '/mirror/w1/docs/a.md', content: 'x', expectedMtimeMs: 1700000000000 } })
    const r = await call(env)
    check(r.status === 200 && env.writes.length === 1, 'C16 基线匹配（远端秒级 mtime×1000）→ 正常保存')
  }
  {
    const env = makeEnv({ payload: { path: '/mirror/w1/new.md', content: 'fresh', expectedMtimeMs: 1700000000000 } })
    env.frame = { framed: true, err: 'stat: cannot statx ...: No such file or directory', size: null, mtime: null, rest: '' }
    const r = await call(env)
    check(r.status === 409 && /no longer exists/.test(r.body.error.message), 'C17 带基线但远端文件已消失 → 409（不静默重建）')
  }
  {
    const env = makeEnv({ payload: { path: '/mirror/w1/new.md', content: 'fresh\n' } })
    env.frame = { framed: true, err: 'stat: cannot statx ...: No such file or directory', size: null, mtime: null, rest: '' }
    const r = await call(env)
    check(r.status === 200 && env.writes[0].bytes.toString('utf8') === 'fresh\n', 'C18 无基线的新文件 → 按 UTF-8 + LF 新建')
  }
  {
    // 真机上"文件不存在"就是 stat 非零退出 + ERR 帧：不能当成读失败
    const env = makeEnv({ payload: { path: '/mirror/w1/fresh2.md', content: 'ok\n' } })
    env.headOk = false
    env.frame = { framed: true, err: 'stat: cannot statx ...: No such file or directory', size: null, mtime: null, rest: '' }
    const r = await call(env)
    check(r.status === 200 && env.writes.length === 1, 'C26 stat 非零退出 + ERR 帧（文件不存在）→ 按新文件创建，不报读失败')
  }
  {
    const env = makeEnv({ payload: { path: '/mirror/w1/gbk.txt', content: 'x\n' } })
    env.frame = { framed: true, err: null, size: 4, mtime: 1, rest: Buffer.from([0xd6, 0xd0, 0xce, 0xc4]).toString('base64') }
    const r = await call(env)
    check(r.status === 400 && r.body.error.code === 'fs-error' && /非 UTF-8/.test(r.body.error.message), 'C19 GBK 文件明确拒绝（不用 UTF-8 覆盖）')
    check(env.writes.length === 0, 'C20 拒绝时一个字节都不写')
  }
  {
    const env = makeEnv({ payload: { path: '/mirror/w1/w.txt', content: 'x' } })
    env.wrOk = false
    const r = await call(env)
    check(r.status === 400 && r.body.error.code === 'fs-error' && /disk full/.test(r.body.error.message), 'C21 远端写失败 → 400 fs-error（带上游 stderr）')
  }
  {
    const env = makeEnv()
    env.payload = { path: '' }
    const r = await call(env)
    check(r.status === 400 && r.body.error.code === 'bad-request', 'C22 缺 path → 400 bad-request')
  }
  {
    const env = makeEnv()
    env.trust = 'forbidden'
    const r = await call(env)
    check(r.status === 403, 'C23 信任校验失败 → 403')
  }
  {
    const env = makeEnv()
    const r = await call(env, 'GET')
    check(r.status === 405, 'C24 非 POST → 405')
  }
  {
    const env = makeEnv()
    env.payload = { path: '/local/somewhere/a.md', content: 'x' }
    env.ws = null
    const r = await call(env)
    check(r.status === 400 && r.body.error.code === 'fs-error', 'C25 非镜像路径 → 400（不接管本地工作区）')
  }
}

// ───────────────────────────── D：接线断言 ─────────────────────────────
{
  console.log('D. 接线（服务端注册 + 客户端改投）')
  check(/path: "\/remote-ssh\/write"/.test(src), 'D1 服务端注册 exact 路由 /remote-ssh/write')
  check(/"dsh-remote-ssh: \/remote-ssh\/write route"/.test(src), 'D2 注册带 effect 名（便于排查）')
  check(/if \(u\.pathname === "\/sidebar\/write"\)/.test(client), 'D3 客户端识别 /sidebar/write')
  check(/wpath\.indexOf\(wm \+ "\/"\) === 0/.test(client) && /wpath === wm/.test(client), 'D4 只在**镜像路径**上改投（本地工作区原样透传）')
  check(/new URL\("\/remote-ssh\/write", window\.location\.origin\)/.test(client), 'D5 改投目标就是本插件端点')
  check(/expectedMtimeMs/.test(client) && /content: wbody/.test(client), 'D6 基线与全文一起转发')
}

// ───────────────────────────── E：变异负向控制 ─────────────────────────────
{
  console.log('E. 变异控制（断言必须能变红）')
  const brokenEol = grab(src, 'function encodeRemoteText').replace('if (fmt && fmt.eol === "crlf") text = text.split("\\n").join("\\r\\n");', '')
  const broken = new Function('Buffer', grab(src, 'function detectRemoteTextFormat') + '\n' + brokenEol + '\nreturn { encodeRemoteText };')(Buffer)
  check(broken.encodeRemoteText('a\nb\n', { encoding: 'utf8', eol: 'crlf' }).toString('utf8') === 'a\nb\n', 'E1 变异：删掉 CRLF 还原 → B2/C4 断言会红')

  const noGate = grab(src, 'async function handleRemoteWrite').replace(/if \(expected !== null && Number\.isFinite\(expected\)\) \{[\s\S]*?\n        \}\n/, '')
  const env = makeEnv({ payload: { path: '/mirror/w1/docs/a.md', content: 'x', expectedMtimeMs: 1600000000000 } })
  const handleNoGate = new Function(
    'requestTrust', 'denyRequest', 'readJsonBody', 'writeJson', 'writeOk',
    'matchRemoteWorkspace', 'readRemoteInfoSync', 'getProfile', 'localToRemote',
    'runPooled', 'buildReadPageCommand', 'parseStatFrame', 'shellQuotePath',
    'invalidateRemoteCaches', 'freshnessForget', 'wrapperDir', 'writeFileSync',
    'remoteMtimeInfo', 'REMOTE_WRITE_LIMIT', 'Buffer',
    grab(src, 'function detectRemoteTextFormat') + '\n' + grab(src, 'function encodeRemoteText') + '\n' +
    noGate + '\nreturn { handleRemoteWrite };'
  )(
    () => 'ok', (res, reason) => { res.status = 403 }, async () => env.payload,
    (res, status, body) => { res.status = status; res.body = JSON.stringify(body) },
    (res, value) => { res.status = 200; res.body = JSON.stringify({ ok: true, value }) },
    () => ({ id: 'w1', mirrorPath: '/mirror/w1', remotePath: '/remote/docs' }),
    () => ({ profileId: 'p1', remotePath: '/remote/docs' }), () => ({ id: 'p1' }),
    (l, m, r) => String(l).replace(m, r), async (p, cmd, stdin) => ({ ok: true, stdout: 'x' }),
    () => 'CMD', () => env.frame, (p) => p, () => {}, () => {}, '/wrapper', () => {},
    async () => ({ ok: true, exists: true, stamp: '9:1700000005' }), undefined, Buffer
  )
  const res = { status: 0, body: null }
  await handleNoGate.handleRemoteWrite({ method: 'POST' }, res)
  check(res.status === 200, 'E2 变异：拆掉乐观锁 → C13 的 409 断言会红（这里退化成 200）')
}

console.log('')
console.log('  结果: ' + pass + ' 通过, ' + fail + ' 失败')
if (fail > 0) process.exitCode = 1