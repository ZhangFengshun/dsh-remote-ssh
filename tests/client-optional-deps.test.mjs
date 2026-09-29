// 可选依赖契约回归测试 —— 「没装 dsh-better-sidebar 时前端 web boot 直接失败」（issue #18，2026-09-29）
//
// 背景：客户端半边曾把第三方 bundle 提供的 betterSidebar 与内核服务并列写进 exports.inject：
//     exports.inject = ["betterSidebar", "slots", "locale"];
// 而 cordis 的 fiber **只要有一个 inject 键对应的服务没注册就整体停在 pending**
// （Fiber._refresh()：逐个键查 store，任一缺失即 epoch = INACTIVE；`Inject` 没有 optional 形态，
// 对象形态里的 `null` 是拦截配置而不是"可选"）。于是没装 better-sidebar 的用户前端报
//     web boot: 1 entry did not activate
//     @zhangfengshun/dsh-remote-ssh: pending (waiting for service: betterSidebar)
// Desktop 还会弹「插件恢复」——即便内核自带侧边栏、其余插件全部正常。
// 修复：exports.inject 只留内核一定提供的 slots/locale，better-sidebar 改走
//     ctx.inject(["betterSidebar"], cb)   // 子 fiber 软注入（前端自身 e.inject(["uiRenderer"], …) 同一招）
// 装了才注册远程文件编辑器页签，没装就静默降级。
//
// 真机 A/B/C（DSH 0.2.0-rc.2 沙箱 + 无头 Chrome 读前端真实状态）：
//   A 已发布 2.4.17 + 无 better-sidebar → 整屏 `Failed to load plugins` + 上面的两行（精确复现）
//   B 修复版 + 无 better-sidebar       → 干净引导、__dshRemoteSshGlobeStats 已定义、设置页出现「远程连接」
//   C 修复版 + better-sidebar 0.24.1   → 行为不变
//
// 本文件是**静态契约**（源码/文档层面的护栏），不看运行结果：
//   A. 声明面：inject 里不许出现第三方服务
//   B. 接线：软注入子 fiber 的形状与页签语义
//   C. 其余用法必须空安全
//   D. 文档与变更记录
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const client = readFileSync(root + '/lib/client.js', 'utf8')
const host = readFileSync(root + '/lib/index.js', 'utf8')
const changelog = readFileSync(root + '/CHANGELOG.md', 'utf8')
const readme = readFileSync(root + '/README.md', 'utf8')
const readmeEn = readFileSync(root + '/README_EN.md', 'utf8')
const maintenance = readFileSync(root + '/MAINTENANCE.md', 'utf8')
const pkg = JSON.parse(readFileSync(root + '/package.json', 'utf8'))

let pass = 0, fail = 0
const check = (cond, label) => { if (cond) { pass++; console.log('  ✓ ' + label) } else { fail++; console.log('  ✗ FAIL: ' + label) } }

const lines = client.split('\n')
const codeLines = lines.map((l, i) => ({ n: i + 1, t: l })).filter(x => !/^\s*(\/\/|\*|\/\*)/.test(x.t))

// ---------------------------------------------------------------------------
console.log('A. 声明面：inject 里只能是内核一定提供的服务')
// ---------------------------------------------------------------------------
const injectAssigns = [...client.matchAll(/exports\.inject\s*=\s*(\[[^\]]*\])/g)].map(m => m[1])
check(injectAssigns.length === 1, 'client.js 里 `exports.inject` 只赋值一次（避免后半段又把它写回去）')
const injectList = injectAssigns[0] || ''
check(injectList.replace(/\s/g, '') === '["slots","locale"]', '`exports.inject` 恰好是 ["slots","locale"]')
check(!/betterSidebar/.test(injectList), '`exports.inject` 里不含 betterSidebar（issue #18 的根因）')
check(codeLines.every(x => !/exports\.inject[^\n]*betterSidebar/.test(x.t)), '任何一行都没有把 betterSidebar 塞回 inject')

const hostInject = (host.match(/const inject = \[[^\]]*\]/) || [''])[0]
check(hostInject.length > 0, '宿主半边能定位到 inject 数组（接线形状没变）')
check(!/betterSidebar|better-sidebar/.test(hostInject), '宿主半边 inject 不含 better-sidebar（它只提供客户端服务）')
check(/"webServer"/.test(hostInject) && /"subprocess"/.test(hostInject), '宿主半边 inject 仍是内核服务（webServer/subprocess）')
check(Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.length === 4, 'package.json 的 dsh.client.inject 仍是 4 个内核客户端模块（模块面未变）')
check((pkg.dsh?.client?.inject || []).every(x => /^@deepseek-ai\/dsh-client-/.test(x)), 'dsh.client.inject 里全是 @deepseek-ai/dsh-client-*（不含第三方包 id）')
check(!JSON.stringify(pkg.dsh?.client?.inject || []).includes('better-sidebar'), 'dsh.client.inject 不引用 better-sidebar')

// ---------------------------------------------------------------------------
console.log('B. 软注入接线（子 fiber + 生命周期绑定 + 页签语义）')
// ---------------------------------------------------------------------------
const softStart = client.indexOf('ctx.inject(["betterSidebar"]')
check(softStart > 0, '存在 `ctx.inject(["betterSidebar"], …)` 软注入')
const softBlock = (() => {
  const open = client.indexOf('{', client.indexOf('function (bsCtx)', softStart))
  let depth = 0
  for (let i = open; i < client.length; i++) {
    if (client[i] === '{') depth++
    else if (client[i] === '}') { depth--; if (depth === 0) return client.slice(open, i + 1) }
  }
  return ''
})()
check(softBlock.length > 0, '软注入回调能整体提取（括号平衡）')
check(/var bs = bsCtx\.betterSidebar;/.test(softBlock), '回调内从**子 ctx** 取服务（bsCtx.betterSidebar，而不是闭包里的 ctx）')
check(/if \(!bs \|\| typeof bs\.registerTab !== "function"\) return;/.test(softBlock), '有 registerTab 可用性守卫（服务在但 API 不匹配时静默降级）')
check(/bsCtx\.effect\(function \(\) \{/.test(softBlock), '页签注册包在 bsCtx.effect 里（随子 fiber 生命周期注销，不泄漏）')
check(/return bs\.registerTab\(\{/.test(softBlock), 'effect 内 registerTab 的返回值被返回（cordis 用返回值做 disposer）')
check(/id: "remssh:editor"/.test(softBlock), '页签 id 仍是 remssh:editor')
check(/hidden: true/.test(softBlock), '页签仍是隐藏页签（只由代码打开）')
check(/dedupeKey: function \(tab\) \{ return \(tab && tab\.meta && tab\.meta\.profileId \|\| ""\)/.test(softBlock), 'dedupeKey 仍是 profileId + path（同一远程文件不重复开栏）')
check(/RemoteEditor/.test(softBlock) && /component: function \(props\)/.test(softBlock), '组件仍渲染 RemoteEditor')
check((client.match(/registerTab\(/g) || []).length === 1, 'registerTab 只有这一处调用（没有别处硬依赖它）')
check(!/return betterSidebar\.registerTab/.test(client), '旧的硬依赖写法（直接 betterSidebar.registerTab）已消失')
check(!/var betterSidebar = ctx\.betterSidebar;/.test(client), 'apply 开头不再裸取 ctx.betterSidebar（那样会让软注入形同虚设）')
check(/exported apply entry:/i.test(client) || /function apply\(ctx\)/.test(client), 'apply 入口形状未变（便于定位注入点）')

// ---------------------------------------------------------------------------
console.log('C. 其余 betterSidebar 用法必须空安全')
// ---------------------------------------------------------------------------
const usage = codeLines.filter(x => /betterSidebar\./.test(x.t) && !/bsCtx\.betterSidebar/.test(x.t))
check(usage.length >= 3, `仍有 ${usage.length} 处 betterSidebar 用法（内置文件页签等）`)
const unsafe = usage.filter((x, i) => {
  if (/betterSidebar\s*&&/.test(x.t)) return false
  const prev = usage[i - 1]
  return !(prev && /betterSidebar\s*&&/.test(prev.t))
})
check(unsafe.length === 0, '每处用法都在真值守卫之后（含跨行的 openTab/closeTab 调用）' + (unsafe.length ? ' → ' + unsafe.map(x => 'L' + x.n).join(',') : ''))
check(/if \(betterSidebar && betterSidebar\.openTab\) \{/.test(client), 'openTab 访问有守卫')
check(/if \(ctx && ctx\.betterSidebar && tab\.id\) ctx\.betterSidebar\.closeTab\(tab\.id\);/.test(client), 'closeTab 访问有守卫（卸载时 better-sidebar 可能已不在）')
check(/var betterSidebar = props\.betterSidebar;/.test(client), 'props 上的 betterSidebar 允许为空（props 由宿主传入）')
let syntaxOk = true
try { new Script(client) } catch { syntaxOk = false }
check(syntaxOk, 'client.js 仍是语法合法的脚本（vm.Script 编译通过）')

// ---------------------------------------------------------------------------
console.log('D. 文档与变更记录')
// ---------------------------------------------------------------------------
check(/issue \[#18\]\(https:\/\/github\.com\/ZhangFengshun\/dsh-remote-ssh\/issues\/18\)/.test(changelog), 'CHANGELOG 链到 issue #18')
check(/子 fiber 软注入/.test(changelog), 'CHANGELOG 说明了修复手法（子 fiber 软注入）')
check(/真机 A\/B/.test(changelog), 'CHANGELOG 记录了真机 A/B 复现与验证')
check(/fs\.trees` 只存在于 dsh-better-sidebar|只存在于 dsh-better-sidebar/.test(changelog), 'CHANGELOG 写清了降级边界（原生侧边栏不吃 /sidebar/api）')
check(/web boot: 1 entry did not activate/.test(readme), 'README 故障排查收录了该报错原文')
check(/pending \(waiting for service: betterSidebar\)/.test(readme), 'README 收录了 pending 原文（便于搜索命中）')
check(/只装本插件、不装 `dsh-better-sidebar`/.test(readme), 'README 安装节说明了不装 better-sidebar 时能/不能做什么')
check(/patch: entry "better-sidebar" not found/.test(readme), 'README 说明了该 warn 属正常（避免被当成新故障）')
check(/web boot: 1 entry did not activate/.test(readmeEn) && /child-fiber soft inject/.test(readmeEn), 'README_EN 同步（报错原文 + 软注入说明）')
check(/没有 optional/.test(maintenance) && /Fiber\._refresh/.test(maintenance), 'MAINTENANCE 记下了 cordis inject 语义这一课（含源码位置）')
check(/__DSH_BOOT_READY__/.test(maintenance) && /Network\.setCacheDisabled/.test(maintenance), 'MAINTENANCE 记下了 A/B/C 验证配方与「BOOT_READY 不能当判据」的坑')

console.log('')
console.log(`结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
