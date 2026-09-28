// 终端集成 回归测试（issue #17）。
//
// 背景：DSH 0.1.7-rc.2 起侧边栏终端由宿主原生 `terminal-controller`
// （@deepseek-ai/dsh-api-terminal-controller，Config.shell = { path, name, args }）管理，
// 它**不再读** better-sidebar 的 shell 配置 —— 只 patch better-sidebar 时，远程工作区会静默
// 打开本地 shell（#7 是"连上了但落在远程 HOME"，这条是"根本没连"）。
//
// 本测试解析 bundle 的 cordis.patch.yml，**真实求值**两条 !!js 表达式（分别在 win32 / posix 下），
// 并校验原生终端要的字段形状，防止"改了 better-sidebar 忘了 terminal-controller"再次发生。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const patchText = readFileSync(root + '/cordis.patch.yml', 'utf8')

/** 按 `- id: <entry>` 切块（保留块内文本），用于定位每个 entry 的 patch。 */
function blocksByEntry(text) {
  const lines = text.split('\n')
  const blocks = []
  let current = null
  for (const line of lines) {
    const m = /^- id:\s*([^\s#]+)\s*$/.exec(line)
    if (m) {
      current = { id: m[1], lines: [] }
      blocks.push(current)
      continue
    }
    if (current) current.lines.push(line)
  }
  return blocks
}

/** 取出块里的 `!!js |` 表达式源码（块标量，按其缩进去缩进）。 */
function jsExpressionOf(block) {
  const idx = block.lines.findIndex((l) => /!!js\s*\|/.test(l))
  if (idx < 0) return undefined
  const baseIndent = block.lines[idx].length - block.lines[idx].trimStart().length
  const body = []
  for (let i = idx + 1; i < block.lines.length; i++) {
    const line = block.lines[i]
    if (line.trim() === '') { body.push(''); continue }
    const indent = line.length - line.trimStart().length
    if (indent <= baseIndent) break
    body.push(line.slice(baseIndent + 2))
  }
  return body.join('\n')
}

const blocks = blocksByEntry(patchText)
const better = blocks.find((b) => b.id === 'better-sidebar')
const native = blocks.find((b) => b.id === 'terminal-controller')

let pass = 0, fail = 0
const check = (cond, label) => { if (cond) { pass++; console.log('  ✓ ' + label) } else { fail++; console.log('  ✗ FAIL: ' + label) } }

console.log('A · patch 结构')
{
  check(/^- insert:/m.test(patchText) && /name: '@zhangfengshun\/dsh-remote-ssh'/.test(patchText), 'bundle 仍 insert 本插件行')
  check(!!better, '保留 better-sidebar 的 shell patch（旧侧边栏版本仍需要）')
  check(!!native, '新增 terminal-controller 的 shell patch（新版原生终端）')
  check(native && /shell:/.test(native.lines.join('\n')), 'terminal-controller 的 patch 设置了 shell')
}

console.log('B · 真实求值 !!js 表达式（两种平台）')
{
  const evalBlock = (block, platform, env) => {
    const code = jsExpressionOf(block)
    if (!code) return undefined
    const fakeProcess = { platform, env }
    // 块内容是 IIFE 表达式：(() => { … })()
    return new Function('process', 'return (' + code + ');')(fakeProcess)
  }
  for (const [platform, env, expectName] of [
    ['win32', { USERPROFILE: 'C:\\Users\\tester', HOME: undefined, HOMEDRIVE: undefined, HOMEPATH: undefined }, 'dsh-remote-shell.cmd'],
    ['linux', { USERPROFILE: undefined, HOME: '/home/tester', HOMEDRIVE: undefined, HOMEPATH: undefined }, 'dsh-remote-shell'],
  ]) {
    const bsShell = evalBlock(better, platform, env)
    const ntShell = evalBlock(native, platform, env)
    check(typeof bsShell === 'string' && bsShell.endsWith(expectName), `[${platform}] better-sidebar → 字符串路径（结尾 ${expectName}）`)
    // 原生终端要的是对象：{ path, name, args }
    check(ntShell && typeof ntShell === 'object' && typeof ntShell.path === 'string' && ntShell.path.endsWith(expectName),
      `[${platform}] terminal-controller → { path } 且结尾 ${expectName}`)
    check(ntShell && typeof ntShell.name === 'string' && ntShell.name.length > 0, `[${platform}] terminal-controller 的 name 非空（GUI 终端菜单会显示它）`)
    check(ntShell && Array.isArray(ntShell.args) && ntShell.args.length === 0, `[${platform}] terminal-controller 的 args 是空数组`)
    check(ntShell && ntShell.path === bsShell, `[${platform}] 两个入口指向**同一个** wrapper（不会各自漂移）`)
    check(ntShell && Object.keys(ntShell).sort().join(',') === 'args,name,path',
      `[${platform}] 字段恰为 path/name/args（与宿主 Config.shell 契约一致，多写字段会被 schema 拒）`)
  }
}

console.log('C · wrapper 路径约定')
{
  const bs = jsExpressionOf(better)
  const nt = jsExpressionOf(native)
  check(/\.dsh/.test(bs) && /remote-ssh/.test(bs), '路径指向 ~/.dsh/remote-ssh/')
  check(bs.includes('dsh-remote-shell') && nt.includes('dsh-remote-shell'), '两者都指向 dsh-remote-shell（插件 apply() 写入的 wrapper）')
  check(/process\.platform === 'win32'/.test(bs) && /process\.platform === 'win32'/.test(nt), '两者都按平台分支（Windows 用 .cmd）')
}

console.log('D · 与宿主契约对拍（本机装了 DSH 时才跑）')
{
  const appTerminal = 'E:\\Program Files\\DSH Desktop\\resources\\app\\node_modules\\@deepseek-ai\\dsh-api-terminal-controller\\lib\\index.js'
  let hostSchema = ''
  try { hostSchema = readFileSync(appTerminal, 'utf8') } catch (e) { hostSchema = '' }
  if (!hostSchema) {
    console.log('  ⚠ 未找到宿主 terminal-controller（非本机环境），跳过对拍')
  } else {
    check(/shell:\s*z\.union\(\[z\.object\(\{/.test(hostSchema), '宿主 Config 里 shell 是对象联合体（我们的 patch 形状正确）')
    check(/path:\s*z\.string\(\)\.required\(\)/.test(hostSchema), '宿主要求 shell.path 必填 ✓')
    check(/name:\s*z\.string\(\)\.required\(\)/.test(hostSchema), '宿主要求 shell.name 必填 ✓')
    check(/args:\s*z\.array\(z\.string\(\)\)\.default\(\[\]\)/.test(hostSchema), '宿主 shell.args 为字符串数组（默认 []）✓')
  }
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
