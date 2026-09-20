// 模块加载冒烟测试：**真正**用 Node 加载 lib/index.js，断言模块求值不抛错。
//
// 为什么必须有这一层：此前的测试都只从源码里「提取函数/常量文本」再单独求值，因此
// 模块级初始化顺序问题（TDZ）完全测不出来。实际发生过一次：
//   const REMOTE_SEARCH_SKIP_DIRS = new Set([...REF_EXCLUDED_DIRS, …])   // 定义在 REF_EXCLUDED_DIRS 之前
//   → ReferenceError: Cannot access 'REF_EXCLUDED_DIRS' before initialization
//   → 插件树整体加载失败（dsh-plugin-desktop: plugin tree failed to load），用户连桌面都进不去。
//
// 做法：把 lib/index.js 复制到临时目录，为 DSH 运行时提供的模块放桩（@deepseek-ai/dsh-tools），
// 用 profile 里真实的 schemastery（我们的运行时依赖），然后 import() —— 与 DSH 的加载路径一致。
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync, existsSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
// 默认检查仓库源码；设 DSH_TEST_MODULE=<已安装的 lib/index.js> 可对**实际将被 DSH 加载的文件**做上机前冒烟
const target = process.env.DSH_TEST_MODULE || (root + '/lib/index.js')
const src = readFileSync(target, 'utf8')

let pass = 0, fail = 0
const check = (cond, label) => { if (cond) { pass++; console.log('  ✓ ' + label) } else { fail++; console.log('  ✗ FAIL: ' + label) } }

/** 找出 profile 里真实的 schemastery（我们的运行时依赖）。 */
function findSchemastery() {
  const candidates = [
    process.env.DSH_PROFILE_DIR ? join(process.env.DSH_PROFILE_DIR, 'node_modules', 'schemastery') : undefined,
    join(process.env.USERPROFILE || '', '.dsh', 'profiles', 'desktop', 'node_modules', 'schemastery'),
    join(root, 'node_modules', 'schemastery'),
  ].filter(Boolean)
  return candidates.find((p) => existsSync(join(p, 'package.json')))
}

console.log('A · 模块加载（真实 import）')
{
  const dir = mkdtempSync(join(tmpdir(), 'rssh-load-'))
  try {
    mkdirSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh-tools'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh-tools', 'package.json'),
      JSON.stringify({ name: '@deepseek-ai/dsh-tools', version: '0.0.0', type: 'module', main: 'index.js', exports: { '.': './index.js' } }))
    writeFileSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh-tools', 'index.js'),
      'export function defineTool(def) { return def }\nexport default { defineTool }\n')

    const sm = findSchemastery()
    if (sm) {
      // 用 junction 指向真实包：它的传递依赖（cosmokit 等）会沿真实路径的父级 node_modules 解析到
      mkdirSync(join(dir, 'node_modules'), { recursive: true })
      try {
        symlinkSync(sm, join(dir, 'node_modules', 'schemastery'), 'junction')
      } catch (e) {
        // 退路：整目录复制（含传递依赖可能失败，但至少覆盖无依赖场景）
        const smDir = join(dir, 'node_modules', 'schemastery')
        mkdirSync(join(smDir, 'lib'), { recursive: true })
        copyFileSync(join(sm, 'package.json'), join(smDir, 'package.json'))
        for (const f of ['index.cjs', 'index.mjs']) {
          if (existsSync(join(sm, 'lib', f))) copyFileSync(join(sm, 'lib', f), join(smDir, 'lib', f))
        }
      }
    }
    check(!!sm, `找到真实 schemastery（${sm || '未找到，用最小桩'}）`)

    copyFileSync(target, join(dir, 'index.js'))
    let mod
    let error = null
    try {
      mod = await import(pathToFileURL(join(dir, 'index.js')).href)
    } catch (e) {
      error = e
    }
    check(error === null, 'import lib/index.js 不抛错（TDZ / 初始化顺序 / 语法）')
    if (error) console.log('      实际错误: ' + (error && error.message))
    check(!!mod && mod.name === '@zhangfengshun/dsh-remote-ssh', '导出 name = 包名')
    check(!!mod && typeof mod.apply === 'function', '导出 apply 函数')
    check(!!mod && Array.isArray(mod.inject) && mod.inject.includes('webServer') && mod.inject.includes('subprocess'), '导出 inject（webServer / subprocess 等）')
    check(!!mod && !!mod.Config, '导出 Config（schemastery schema 构建成功）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log('B · 静态防线：模块级（花括号深度 0）常量不得引用尚未定义的绑定')
{
  // 只关心**模块求值期**会执行的引用：即花括号深度为 0 的行。函数体内的引用在模块加载时
  // 并不执行（此前的朴素扫描因此产生误报）。字符串/注释里的花括号需要先剔除。
  const strip = (line, state) => {
    let out = ''
    let i = 0
    while (i < line.length) {
      if (state.block) {
        const end = line.indexOf('*/', i)
        if (end < 0) break
        state.block = false; i = end + 2; continue
      }
      if (state.template) {
        const end = line.indexOf('`', i)
        if (end < 0) break
        state.template = false; i = end + 1; continue
      }
      const ch = line[i], next = line[i + 1]
      if (ch === '/' && next === '/') break
      if (ch === '/' && next === '*') { state.block = true; i += 2; continue }
      if (ch === '"' || ch === "'") {
        let j = i + 1
        while (j < line.length) { if (line[j] === '\\') { j += 2; continue } if (line[j] === ch) break; j++ }
        i = j + 1; continue
      }
      if (ch === '`') { state.template = true; i += 1; continue }
      out += ch; i += 1
    }
    return out
  }

  const lines = src.split('\n')
  const state = { block: false, template: false }
  let depth = 0
  const moduleLines = []   // { line, text }
  const decls = []
  lines.forEach((raw, idx) => {
    const code = strip(raw, state)
    if (depth === 0) {
      moduleLines.push({ line: idx + 1, text: code })
      const m = /^(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/.exec(code)
      if (m) decls.push({ name: m[1], line: idx + 1 })
    }
    for (const ch of code) { if (ch === '{') depth++; else if (ch === '}') depth-- }
  })

  const problems = []
  for (const d of decls) {
    const re = new RegExp('\\b' + d.name.replace(/\$/g, '\\$') + '\\b')
    for (const ml of moduleLines) {
      if (ml.line >= d.line) break
      if (!re.test(ml.text)) continue
      if (new RegExp('^(?:const|let)\\s+' + d.name.replace(/\$/g, '\\$') + '\\s*=').test(ml.text)) continue
      problems.push(`${d.name}（定义于 L${d.line}）在模块级 L${ml.line} 已被引用`)
      break
    }
  }
  check(problems.length === 0, '模块级没有「先引用后定义」的常量' + (problems.length ? '：' + problems.join('；') : ''))
  check(decls.length > 20, `扫描到 ${decls.length} 个模块级常量声明（深度 0）`)

  // 反向自检：把历史上真实触发过 TDZ 的写法喂给扫描器，必须能抓到
  const buggy = 'const A = new Set([...B, "x"]);\nconst B = new Set(["y"]);\n'
  const st2 = { block: false, template: false }
  const decls2 = [], mod2 = []
  buggy.split('\n').forEach((raw, idx) => {
    const code = strip(raw, st2)
    mod2.push({ line: idx + 1, text: code })
    const m = /^(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/.exec(code)
    if (m) decls2.push({ name: m[1], line: idx + 1 })
  })
  let caught = false
  for (const d of decls2) {
    const re = new RegExp('\\b' + d.name + '\\b')
    for (const ml of mod2) { if (ml.line >= d.line) break; if (re.test(ml.text)) caught = true }
  }
  check(caught === true, '自检：历史 TDZ 写法（先展开后定义）能被扫描器抓到')
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
