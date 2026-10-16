// better-sidebar 0.26.1 的 fs.readPage 接管测试（与 issue #27 同批发现）。
// 契约取自上游 readPage()：页大小 128 KiB、页尾回退到最后一个换行、整页无换行时原样返回，
// 返回 { kind, text, offset, nextOffset, eof, size, mtimeMs, encoding }。
// 本地部分跑**真实文件系统上的真实现**；远端部分用真实现 + 伪造的 SSH 出口（只替换 SSH 层）。
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { stat, open } from 'node:fs/promises'

const SRC = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')

let pass = 0, fail = 0
const check = (cond, label) => { if (cond) { pass++; console.log('  ✓ ' + label) } else { fail++; console.log('  ✗ FAIL: ' + label) } }

/** 按大括号配平切出一个 `function`/`async function` 定义。 */
function grab(src, marker) {
  const i = src.indexOf(marker)
  if (i < 0) throw new Error('missing ' + marker)
  const start = src.lastIndexOf('\n', i) + 1
  let depth = 0, k = src.indexOf('{', i)
  for (; k < src.length; k++) { if (src[k] === '{') depth++; else if (src[k] === '}') { depth--; if (!depth) break } }
  const end = src.indexOf('\n', k)
  return src.slice(start, end < 0 ? src.length : end)
}
/** 取含该字符串的整行（用于一行式 const）。 */
const LINE = (marker) => {
  const i = SRC.indexOf(marker)
  if (i < 0) throw new Error('missing ' + marker)
  return SRC.slice(SRC.lastIndexOf('\n', i) + 1, SRC.indexOf('\n', i))
}

const PAGE = 131072   // 与上游 PAGE_BYTES 一致

// ---------------------------------------------------------------------------
// A. 本地分支：真实文件系统上的真实现
// ---------------------------------------------------------------------------
console.log('\nA. localReadPage（真实文件系统）')
const base = mkdtempSync(join(tmpdir(), 'rssh-page-'))
const localReadPage = new Function('stat', 'open',
  grab(SRC, 'async function localReadPage') + '\nreturn localReadPage;')(stat, open)

try {
  // 4000 行约 100 字节 → 约 400 KB，跨 4 页
  const lines = []
  for (let i = 0; i < 4000; i++) lines.push('line ' + String(i).padStart(4, '0') + ' ' + 'x'.repeat(88))
  const bigText = lines.join('\n') + '\n'
  const bigPath = join(base, 'big.txt')
  writeFileSync(bigPath, bigText)
  const bigSize = Buffer.byteLength(bigText)

  const p1 = await localReadPage(bigPath, undefined)
  check(p1.kind === 'text' && p1.offset === 0, 'A1 首页：kind=text / offset=0')
  check(p1.size === bigSize && p1.mtimeMs > 0, 'A2 带出 size 与 mtimeMs（客户端据此判缓存）')
  check(p1.eof === false && p1.nextOffset > 0 && p1.nextOffset <= PAGE, 'A3 未读完：eof=false，nextOffset 落在首页窗口内')
  check(p1.text.endsWith('\n'), 'A4 页尾回退到换行（页以整行结束，JSONL/CSV 不会被劈开）')
  check(p1.text.length === p1.nextOffset, 'A5 页尾回退后 nextOffset 与返回内容一致（ASCII 夹具下按字节=按字符；多字节的字节推进由 B10 覆盖）')
  check(p1.encoding === 'utf8', 'A6 encoding 字段与上游一致（utf8）')

  let acc = '', off = 0, guard = 0, pages = 0
  const advances = [], pageEndsWithNewline = []
  while (guard++ < 50) {
    const p = await localReadPage(bigPath, off)
    acc += p.text
    pages++
    if (p.eof) break
    advances.push(p.nextOffset > off)
    pageEndsWithNewline.push(p.text.endsWith('\n'))
    off = p.nextOffset
  }
  check(advances.every(Boolean) && advances.length === pages - 1, 'A7 每次翻页都严格前进（' + pages + ' 页）')
  check(pageEndsWithNewline.length === pages - 1 && pageEndsWithNewline.every(Boolean),
    'A7b 除末页外**每一页**都以换行结束（逐页回退，不只有首页）')
  check(acc === bigText, 'A8 逐页拼接后与原文件逐字节相同（' + pages + ' 页 / ' + bigSize + ' 字节）')
  check(pages === Math.ceil(bigSize / PAGE), 'A9 页数与 ceil(size/页大小) 一致（' + pages + '）')

  const pEnd = await localReadPage(bigPath, bigSize)
  check(pEnd.text === '' && pEnd.eof === true && pEnd.nextOffset === bigSize, 'A10 offset ≥ size → 空页 + eof + nextOffset=size')
  const pFar = await localReadPage(bigPath, bigSize + 9999)
  check(pFar.text === '' && pFar.eof === true && pFar.nextOffset === bigSize, 'A11 offset 远超 size 同样收敛到 size（不越界读）')

  const smallPath = join(base, 'small.txt')
  writeFileSync(smallPath, 'hello\nworld\n')
  const ps = await localReadPage(smallPath, 0)
  check(ps.text === 'hello\nworld\n' && ps.eof === true && ps.nextOffset === 12, 'A12 小于一页的文件：一次返回全部 + eof=true')

  const longPath = join(base, 'oneline.txt')
  writeFileSync(longPath, 'y'.repeat(PAGE + 5000))
  const pl = await localReadPage(longPath, 0)
  check(pl.text.length === PAGE && pl.nextOffset === PAGE && pl.eof === false, 'A13 单行超页：首页原样返回满页（不回退、不丢字节）')
  const pl2 = await localReadPage(longPath, pl.nextOffset)
  check(pl2.nextOffset === PAGE + 5000 && pl2.eof === true, 'A14 第二页接上后收敛到文件末尾')

  let err = ''
  try { await localReadPage(join(base, 'nope.txt'), 0) } catch (e) { err = String(e.message) }
  check(err.includes('cannot read'), 'A15 文件不存在 → 抛 cannot read（上游同款 400 fs-error 文案来源）')
  mkdirSync(join(base, 'adir'))
  err = ''
  try { await localReadPage(join(base, 'adir'), 0) } catch (e) { err = String(e.message) }
  check(err.includes('is a directory'), 'A16 目录 → 抛 is a directory（与上游一致，不当成空文件）')
  const pNeg = await localReadPage(smallPath, -5)
  check(pNeg.offset === 0 && pNeg.text === 'hello\nworld\n', 'A17 负 offset 归零处理（不抛错、不从文件外读）')
} finally {
  rmSync(base, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// B. 远端分支：真实现 + 伪造 SSH 出口
// ---------------------------------------------------------------------------
console.log('\nB. remoteReadPageForSidebar（真实现 + 伪造 SSH 出口）')
{
  const SANDBOX_DEPS = [
    LINE('const DSH_ST_MARK'),
    grab(SRC, 'function shellQuote('),
    grab(SRC, 'function shellQuotePath('),
    grab(SRC, 'function sanitizeErrLine('),
    grab(SRC, 'function parseStatFrame('),
    grab(SRC, 'function statFrameSnippet('),
    grab(SRC, 'function errSnippet('),
    grab(SRC, 'function buildReadPageCommand('),
    grab(SRC, 'async function remoteReadPageForSidebar'),
  ].join('\n')
  const makeApi = (runPooled) => new Function('runPooled',
    SANDBOX_DEPS + '\nreturn { remoteReadPageForSidebar, buildReadPageCommand };')(runPooled)

  const cmd = makeApi(async () => ({})).buildReadPageCommand('/mnt/data/logs/app.log', PAGE, PAGE)
  check(cmd.includes('stat -c'), 'B1 命令带 stat 帧（size/mtime 与内容同一次往返）')
  check(cmd.includes('tail -c +' + (PAGE + 1)), 'B2 offset=131072 → tail -c +131073（1-based，不差一字节）')
  check(cmd.includes('head -c ' + PAGE), 'B3 页大小 128 KiB 写进命令')
  check(cmd.includes('base64 -w0'), 'B4 载荷用 base64 -w0（与其它读命令同一惯例，二进制安全）')
  check(cmd.includes('/mnt/data/logs/app.log'), 'B5 远端绝对路径原样进命令（不二次拼接）')
  check(cmd.includes('__DSH_ST__'), 'B6 标记行与解析器配套（载荷里不可能出现该标记）')

  const pageText = '远端第二页\n'
  const api = makeApi(async () => ({
    ok: true,
    stdout: '__DSH_ST__' + PAGE * 2 + ':1700000000\n' + Buffer.from(pageText, 'utf8').toString('base64'),
  }))
  const r = await api.remoteReadPageForSidebar({ id: 'p1' }, '/mnt/data/logs/app.log', PAGE)
  check(r.ok === true, 'B7 正常帧 → ok')
  check(r.page && r.page.kind === 'text' && r.page.offset === PAGE, 'B8 回显请求的 offset')
  check(r.page.text === pageText, 'B9 base64 载荷解码成文本')
  check(r.page.size === PAGE * 2 && r.page.nextOffset === PAGE + Buffer.byteLength(pageText),
    'B10 nextOffset 按**字节**推进（多字节字符不会算错）')
  check(r.page.mtimeMs === 1700000000000, 'B11 mtime 秒 → mtimeMs 毫秒（与上游字段语义一致）')
  check(r.page.eof === false && r.page.encoding === 'utf8', 'B12 eof 与 encoding 字段齐备')

  const api2 = makeApi(async () => ({
    ok: true,
    stdout: '__DSH_ST__1000:1700000000\n' + Buffer.from('aaa\nbbb\nccc', 'utf8').toString('base64'),
  }))
  const r2 = await api2.remoteReadPageForSidebar({ id: 'p1' }, '/r/x.txt', 0)
  check(r2.page.text === 'aaa\nbbb\n' && r2.page.nextOffset === 8, 'B13 页尾回退到最后一个换行，nextOffset 随之回退（不重不漏）')
  check(r2.page.eof === false, 'B14 回退后未到文件末尾 → eof=false')

  const api3 = makeApi(async () => ({ ok: true, stdout: 'not a frame' }))
  const r3 = await api3.remoteReadPageForSidebar({ id: 'p1' }, '/r/x.txt', 0)
  check(r3.ok === false && String(r3.error).includes('stat 标记'), 'B15 没有 stat 帧 → ok=false（不静默返回空页）')
  const api4 = makeApi(async () => ({ ok: true, stdout: '__DSH_ST__ERR:permission denied\n' }))
  const r4 = await api4.remoteReadPageForSidebar({ id: 'p1' }, '/r/x.txt', 0)
  check(r4.ok === false && String(r4.error).includes('permission denied'), 'B16 ERR 帧 → 透出远端原因')
  const api5 = makeApi(async () => ({ ok: false, error: 'ssh down' }))
  const r5 = await api5.remoteReadPageForSidebar({ id: 'p1' }, '/r/x.txt', 0)
  check(r5.ok === false && String(r5.error).includes('ssh down'), 'B17 SSH 失败 → ok=false 且带上原因')
  const api6 = makeApi(async () => ({ ok: true, stdout: '__DSH_ST__10:1700000000\n' }))
  const r6 = await api6.remoteReadPageForSidebar({ id: 'p1' }, '/r/x.txt', 10)
  check(r6.ok === true && r6.page.text === '' && r6.page.eof === true && r6.page.nextOffset === 10,
    'B18 offset ≥ size → 远端空页 + eof')

  // 远端读到的页与本地读到的页形状必须一致（客户端只写了一套渲染）
  const keys = ['kind', 'text', 'offset', 'nextOffset', 'eof', 'size', 'mtimeMs', 'encoding']
  check(keys.every((k) => Object.prototype.hasOwnProperty.call(r2.page, k)),
    'B19 远端页字段集与上游契约一致：' + keys.join('/'))
}

// ---------------------------------------------------------------------------
// C. 接线
// ---------------------------------------------------------------------------
console.log('\nC. 接线')
{
  check(LINE('"fs.tree", "fs.trees", "fs.read", "fs.readPage"').includes('"fs.readPage"'),
    'C1 fs.readPage 已注册 exact 路由（不接管就会被上游读本地镜像）')
  const handler = SRC.slice(SRC.indexOf('async function interceptFsHandler'))
  const body = handler.slice(0, handler.indexOf('\n  async function ', 10) > 0 ? handler.indexOf('\n  async function ', 10) : handler.length)
  check((body.match(/method === "fs\.readPage"/g) || []).length === 2, 'C2 远端与本地两个分支都实现了 fs.readPage')
  check(/localPathOf\(payload\.path, pathBase\); if \(p === null\) return;\s*try \{ result = await localReadPage\(/.test(body),
    'C4 本地分支：path 必填（不像 fs.tree 拿 sessionCwd 兜底）→ 空路径仍 400')
  check(body.includes('code: "fs-error"'), 'C5 读失败映射成上游同款 fs-error 400')
  const branches = body.split('} else if (method === "').slice(1)
  const pageBranches = branches.filter((b) => b.startsWith('fs.readPage"'))
  const remotePage = pageBranches.find((b) => b.includes('remoteReadPageForSidebar')) || ''
  check(pageBranches.length === 2 && remotePage.includes('remotePathForRequest(localPath)') &&
    remotePage.includes('remoteReadPageForSidebar(profile, rp, payload.offset)'),
    'C3 远端分支：先经 remotePathForRequest 映射（读远端那份，不是镜像），再用映射结果分页读')
  check(pageBranches.length === 2 && pageBranches.every((b) => !/(localWriteFile|localRemoveEntry|localRenameEntry|remoteWriteFile|localMakeDir|localCreateFile)\(/.test(b)),
    'C6 readPage 是只读端点：两个分支内都不触碰写/删/重命名（按分支切片判定，不看邻居）')
}

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
