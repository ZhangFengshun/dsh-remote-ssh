// 「添加工作区 → 目录选择器 → 新建目录」回归测试（issue #11）。
//
// 三层：
//   A. 纯函数：目录名校验 newDirNameError + 路径拼接 joinChild（真实代码文本）
//   B. 组件行为：提取 DirPicker 里**真实的** submitNewDir 逻辑，注入桩状态执行 ——
//      校验拦截、成功进入新目录、失败/异常不抛
//   C. 接线断言：两个 tab 都提供 createFn、远程走 api("mkdir")、本地走 api("mkdirLocal")、
//      宿主 mkdirLocal 用 recursive mkdir、i18n 文案中英齐全
import { readFileSync } from 'node:fs'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const client = readFileSync(root + '/lib/client.js', 'utf8')
const host = readFileSync(root + '/lib/index.js', 'utf8')

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

let pass = 0, fail = 0
const check = (cond, label) => { if (cond) { pass++; console.log('  ✓ ' + label) } else { fail++; console.log('  ✗ FAIL: ' + label) } }

const helpers = new Function(
  grab(client, 'function newDirNameError') + '\n' + grab(client, 'function joinChild') +
  '\nreturn { newDirNameError, joinChild };')()

console.log('A · 目录名校验 newDirNameError')
{
  check(helpers.newDirNameError('') === 'picker.errNameEmpty', '空名 → errNameEmpty')
  check(helpers.newDirNameError('   ') === 'picker.errNameEmpty', '纯空白 → errNameEmpty')
  check(helpers.newDirNameError(null) === 'picker.errNameEmpty', 'null → errNameEmpty')
  check(helpers.newDirNameError('.') === 'picker.errNameBad', '"." → errNameBad')
  check(helpers.newDirNameError('..') === 'picker.errNameBad', '".." → errNameBad')
  check(helpers.newDirNameError('a/b') === 'picker.errNameBad', '含 / → errNameBad')
  check(helpers.newDirNameError('a\\b') === 'picker.errNameBad', '含 \\ → errNameBad')
  check(helpers.newDirNameError('new-project') === null, '普通名 → 合法')
  check(helpers.newDirNameError('  中文目录  ') === null, '中文名（含首尾空格）→ 合法')
  check(helpers.newDirNameError('a.b') === null, '含点号（非 . / ..）→ 合法')
}

console.log('A2 · 路径拼接 joinChild')
{
  check(helpers.joinChild('/home/u/work', 'new') === '/home/u/work/new', 'POSIX 基路径')
  check(helpers.joinChild('/home/u/work/', 'new') === '/home/u/work/new', '去掉基路径尾部分隔符')
  check(helpers.joinChild('/home/u/work///', 'new') === '/home/u/work/new', '多个尾部分隔符')
  check(helpers.joinChild('', 'new') === 'new', '空基路径 → 纯名字')
  check(helpers.joinChild('/', 'new') === '/new', '根路径 → /new')
  check(helpers.joinChild('~/work', 'new') === '~/work/new', '~ 前缀（远端常见）')
  check(helpers.joinChild('C:\\Users\\me', 'new') === 'C:\\Users\\me\\new', 'Windows 基路径沿用反斜杠')
  check(helpers.joinChild('C:\\', 'new') === 'C:\\new', 'Windows 盘符根')
  check(helpers.joinChild('/home/u', '中文') === '/home/u/中文', '非 ASCII 名字')
}

console.log('B · 组件行为（真实 submitNewDir 逻辑 + 桩状态）')
{
  const src = grab(client, 'function submitNewDir')
  /** 构造一次提交：返回 { calls, states, loads } */
  async function run(newDirState, createResult, opts) {
    const calls = { create: 0, createArgs: null }
    const states = []
    const loads = []
    const t = (k) => 'T:' + k
    const fn = new Function('newDir', 'path', 'props', 'setNewDir', 't', 'load', 'newDirNameError', 'joinChild',
      src + '\nreturn submitNewDir;')(
      newDirState,
      (opts && opts.path !== undefined) ? opts.path : '/home/u/work',
      {
        createFn: (p, name) => {
          calls.create++
          calls.createArgs = [p, name]
          if (opts && opts.reject) return Promise.reject(new Error('boom'))
          return Promise.resolve(createResult)
        }
      },
      (s) => states.push(s),
      t,
      (p) => loads.push(p),
      helpers.newDirNameError,
      helpers.joinChild,
    )
    await fn()
    await new Promise((r) => setTimeout(r, 0)) // 让 then 链落地
    return { calls, states, loads }
  }

  {
    const r = await run({ name: 'a/b', busy: false, error: null }, { ok: true })
    check(r.calls.create === 0, '非法名（含 /）：不调用 createFn')
    check(r.states.length === 1 && r.states[0].error === 'T:picker.errNameBad', '非法名：展示校验错误')
  }
  {
    const r = await run({ name: '   ', busy: false, error: null }, { ok: true })
    check(r.calls.create === 0 && r.states[0].error === 'T:picker.errNameEmpty', '空名：拦截并提示')
  }
  {
    const r = await run({ name: 'new-project', busy: false, error: null }, { ok: true, path: '/home/u/work/new-project' })
    check(r.calls.create === 1 && r.calls.createArgs[0] === '/home/u/work' && r.calls.createArgs[1] === 'new-project',
      '合法名：以（当前目录, 名字）调用 createFn')
    check(r.loads.length === 1 && r.loads[0] === '/home/u/work/new-project', '成功后进入新目录（便于紧接着「选择此目录」）')
    check(r.states.some((s) => s === null), '成功后收起输入行（setNewDir(null)）')
    check(r.states.some((s) => s && s.busy === true), '提交中置 busy（按钮禁用/文案切换）')
  }
  {
    const r = await run({ name: 'x', busy: false, error: null }, { ok: true }) // 后端没回 path
    check(r.loads[0] === '/home/u/work/x', '后端未回 path 时回退 joinChild(path, name)')
  }
  {
    const r = await run({ name: 'x', busy: false, error: null }, { ok: false, error: '远端只读' })
    check(r.loads.length === 0, '失败：不跳转')
    check(r.states[r.states.length - 1].error === '远端只读', '失败：展示后端错误')
  }
  {
    const r = await run({ name: 'x', busy: false, error: null }, null, { reject: true })
    check(r.states[r.states.length - 1].error === 'boom', '异常：捕获并展示（不抛出）')
    check(r.loads.length === 0, '异常：不跳转')
  }
  {
    const r = await run(null, { ok: true })
    check(r.calls.create === 0 && r.states.length === 0, '未进入新建状态时提交是 no-op')
  }
}

console.log('C · 接线与文案')
{
  const dirPicker = client.slice(client.indexOf('function DirPicker'), client.indexOf('function RemoteWorkspaceFlow'))
  check(/props\.createFn \? h\("button"/.test(dirPicker) && /t\("ops\.newDir"\)/.test(dirPicker), 'DirPicker：提供 createFn 时才渲染「新建目录」按钮')
  check(/placeholder: t\("ops\.newDirPh"\)/.test(dirPicker), '输入框复用既有文案 ops.newDirPh')
  check(/onKeyDown: function \(e\) \{ if \(e\.key === "Enter"\) \{ e\.preventDefault\(\); submitNewDir\(\); \} \}/.test(dirPicker), '输入框回车即提交')
  check(/newDirNameError\(name\)/.test(dirPicker), '提交前先做名字校验')

  const flow = client.slice(client.indexOf('function RemoteWorkspaceFlow'), client.indexOf('function SettingsSection'))
  check((flow.match(/createFn:/g) || []).length === 2, '两个 tab（本地 / 远程）都传了 createFn')
  check(/api\("mkdir", \{ profileId: profileId, path: target \}\)/.test(flow), '远程：走 api("mkdir")（mkdir -p + 缓存失效）')
  check(/api\("mkdirLocal", \{ path: target \}\)/.test(flow), '本地：走 api("mkdirLocal")')
  check(/joinChild\(p, name\)/.test(flow), '两处都用 joinChild 拼路径')

  const hostApi = host.slice(host.indexOf('mkdirLocal: async (args)'), host.indexOf('deleteFile: async (args)'))
  check(/await mkdir\(p, \{ recursive: true \}\)/.test(hostApi), '宿主 mkdirLocal：recursive mkdir')
  check(/return \{ ok: true, path: p \}/.test(hostApi), '宿主 mkdirLocal：回传创建路径')
  check(/catch \(e\)/.test(hostApi) && /创建目录失败/.test(hostApi), '宿主 mkdirLocal：异常转成 ok:false 错误文案')

  for (const key of ['picker.errNameEmpty', 'picker.errNameBad', 'flow.errMkdir', 'ops.newDir', 'ops.newDirPh']) {
    const n = (client.match(new RegExp('"' + key.replace('.', '\\.') + '"', 'g')) || []).length
    check(n >= 2, `i18n 键 ${key} 中英各一份（命中 ${n}）`)
  }
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
