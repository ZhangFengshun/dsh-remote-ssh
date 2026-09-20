// fs.search 返回契约回归测试（issue #13）。
//
// 背景：better-sidebar 客户端契约是 `{ matches: string[]（cwd 相对、'/' 分隔）, truncated }`，
// 并在渲染阶段直接读 `results.matches.length` / `results.matches.map(rel => …)`；本插件此前
// 只返回 `{ entries: [{path,isDir}], truncated }`，于是「按文件名搜索」一输入即抛
// TypeError 被 RenderBoundary 兜住 → 整个「文件」页签变错误条（本地会话同样复现）。
//
// 附带修复：远程分支原先把 remoteGlob 的**远端绝对路径** join 到镜像根上，拼出畸形路径；
// 现改为 find `-printf '%P\n'` 取相对路径。
//
// 三层：A. 纯函数（toPosixRelative / fsSearchResult） B. 契约模拟（客户端怎么用 matches）
//       C. 接线（两条分支、remoteGlob 的 relative 选项、README 契约描述）
import { readFileSync } from 'node:fs'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const src = readFileSync(root + '/lib/index.js', 'utf8')
const readme = readFileSync(root + '/README.md', 'utf8')

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

const api = new Function(
  grab(src, 'function toPosixRelative') + '\n' + grab(src, 'function fsSearchResult') +
  '\nreturn { toPosixRelative, fsSearchResult };')()

let pass = 0, fail = 0
const check = (cond, label) => { if (cond) { pass++; console.log('  ✓ ' + label) } else { fail++; console.log('  ✗ FAIL: ' + label) } }

console.log('A1 · toPosixRelative')
{
  check(api.toPosixRelative('/home/u/w', '/home/u/w/a/b.jl') === 'a/b.jl', 'POSIX：裁掉 base 前缀')
  check(api.toPosixRelative('/home/u/w/', '/home/u/w/a') === 'a', 'base 带尾斜杠也正确')
  check(api.toPosixRelative('C:\\Users\\me\\w', 'C:\\Users\\me\\w\\a\\b.jl') === 'a/b.jl', 'Windows：反斜杠归一化为 /')
  check(api.toPosixRelative('C:\\Users\\Me\\w', 'c:\\users\\me\\W\\a') === 'a', 'Windows 盘符路径大小写不敏感')
  check(api.toPosixRelative('/home/u/w', '/home/u/W/a') === '/home/u/W/a', 'POSIX 保持大小写敏感（不误裁）')
  check(api.toPosixRelative('/home/u/w', '/other/x.jl') === '/other/x.jl', '不在 base 之下 → 回退归一化绝对路径')
  check(api.toPosixRelative('/home/u/w', '/home/u/w') === '', 'base === target → 空串')
  check(api.toPosixRelative('', '/a/b') === '/a/b', '空 base → 归一化绝对路径')
  check(api.toPosixRelative(null, null) === '', 'null 输入安全')
  check(api.toPosixRelative('/home/u/项目', '/home/u/项目/文件.txt') === '文件.txt', '非 ASCII 路径')
  check(api.toPosixRelative('/home/u/w', '/home/u/ww/a') === '/home/u/ww/a', '前缀相近但非子路径（ww vs w）不误裁')
}

console.log('A2 · fsSearchResult 形状（客户端崩溃的直接原因）')
{
  const r = api.fsSearchResult(['a.jl', 'src/b.jl'], [{ path: '/m/a.jl', isDir: false }], true)
  check(Array.isArray(r.matches) && r.matches.length === 2, 'matches 是数组')
  check(r.matches.every((m) => typeof m === 'string'), 'matches 元素是字符串')
  check(r.entries.length === 1 && r.entries[0].path === '/m/a.jl', 'entries 保留（向前兼容）')
  check(r.truncated === true, 'truncated 透传')

  const empty = api.fsSearchResult(undefined, undefined, undefined)
  check(Array.isArray(empty.matches) && empty.matches.length === 0, '缺参数时 matches 仍是空数组（不再是 undefined → 不崩）')
  check(empty.entries.length === 0 && empty.truncated === false, '缺参数时 entries/truncated 有默认值')

  const dirty = api.fsSearchResult(['ok', '', null, 42, 'x'], [], 0)
  check(dirty.matches.length === 2 && dirty.matches[0] === 'ok' && dirty.matches[1] === 'x', '过滤空串与非字符串')
  check(dirty.truncated === false, 'truncated 归一化为布尔')

  check(!/\\/.test(api.fsSearchResult(['a/b.jl'], [], false).matches.join()), 'matches 为 POSIX 分隔（无反斜杠）')
}

console.log('B · 契约模拟：客户端如何消费 matches')
{
  // 客户端：results.matches.map(rel => …) 渲染，点击时 resolveSidebarPath(cwd, rel)
  const cwd = 'C:\\Users\\me\\.dsh\\remote-workspaces\\w1'
  const entries = [
    { path: cwd + '\\src\\a.jl', isDir: false },
    { path: cwd + '\\docs\\b.md', isDir: false },
  ]
  const result = api.fsSearchResult(entries.map((e) => api.toPosixRelative(cwd, e.path)), entries, false)
  check(result.matches.length === 2, '客户端读 .length 正常（原崩溃点）')
  const rendered = result.matches.map((rel) => rel) // 渲染文本
  check(rendered[0] === 'src/a.jl' && rendered[1] === 'docs/b.md', '渲染的是相对路径（与 better-sidebar 自带实现一致）')
  const resolved = result.matches.map((rel) => cwd.replace(/\\/g, '/') + '/' + rel)
  check(resolved[0] === entries[0].path.replace(/\\/g, '/'), '点击解析回绝对路径 = entries.path（可被 fs.read 拦截映射）')
  check(!result.matches.some((m) => m.includes('\\')), '无平台分隔符混用')
}

console.log('C · 接线与文档')
{
  const remoteBranch = src.slice(src.indexOf('} else if (method === "fs.search") {'), src.indexOf('} else if (method === "fs.rename") {'))
  check(/await remoteSearch\(runPooled, profile, rp, payload\.query \|\| ""\)/.test(remoteBranch),
    '远程分支：走 remoteSearch（内部以 %P 取相对路径 + 两趟预算，详见 tests/remote-search.test.mjs）')
  check(/fsSearchResult\(matches, matches\.map/.test(remoteBranch), '远程分支：经 fsSearchResult 产出 matches + entries')
  check(/join\(remoteBase, rel\)/.test(remoteBranch), '远程分支：entries 仍是镜像绝对路径')

  const localIdx = src.lastIndexOf('} else if (method === "fs.search") {')
  const localBranch = src.slice(localIdx, src.indexOf('} else if (method === "fs.rename") {', localIdx))
  check(/toPosixRelative\(sessionCwd, e\.path\)/.test(localBranch), '本地分支：matches 用 toPosixRelative(sessionCwd, …)')
  check(/fsSearchResult\(entries\.map/.test(localBranch), '本地分支：经 fsSearchResult 产出')

  check(/const fmt = opts\.relative \? "%P" : "%p";/.test(src), 'remoteGlob：relative 时用 %P，默认仍 %p（glob 工具行为不变）')
  check(/-printf '" \+ fmt \+ "\\\\n'/.test(src), 'remoteGlob：printf 格式已参数化')
  check(!/result = \{ entries: \(r\.files \|\| \[\]\)\.map/.test(src), '不再有只返回 entries 的旧远程分支')

  check(/fs\.tree\/read\/write\/search（4 端点契约）/.test(readme) === false, 'README 兼容性表不再笼统声称 fs.search 走旧契约')
  check(/matches/.test(readme), 'README 记录了 fs.search 的 matches 契约（issue #13）')
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
