// 远程工作区「地球角标」普适性 回归测试。
//
// 背景（用户 2026-09-29 反馈）：另一台电脑上装完插件后，远程工作区的文件夹图标**没有**本机看到的
// 地球角标。这个角标不是宿主原生能力 —— 壳层工作区行用的是固定原语（IconFolderOpen16/Close16），
// 没有 per-workspace 图标 API，所以本插件在客户端半边做的是 **DOM 装饰**：按工作区标题文本找到行，
// 再往行首那个文件夹 svg 里 appendChild 一组"地球经纬线"。
// 它的成立有一串前提：① 客户端半边真的加载了；② listWorkspaces 有数据（宿主 settings 读得到）；
// ③ 行文本与 title 匹配；④ 壳层 DOM 结构与我们的选择器一致；⑤ **角标颜色在主题下可见**。
//
// 本测试钉住其中可控且曾出错的部分：
//   A. 颜色必须主题自适应（历史 bug：硬编码 #ffffff，浅色主题下不可见）
//   B. 标题匹配必须容错（折叠空白、兼容 title/aria-label、兼容旧的 🌐 前缀）
//   C. 必须有"该有却没有"的自检/诊断输出（便于在别的机器上定位）
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const src = readFileSync(join(root, 'lib/client.js'), 'utf8')

/** 从真实源码里截出某个函数（花括号配平），保证测试跑的是库里那份代码。 */
function grab(name) {
  const start = src.indexOf(name)
  if (start < 0) throw new Error(name + ' not found in lib/client.js')
  const declStart = src.lastIndexOf('\n', start)
  let i = src.indexOf('{', start)
  let depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) break }
  }
  return src.slice(declStart + 1, i + 1)
}

// ---- 最小假 DOM：只实现被测代码用到的 API ----
function makeElement(tag, ns) {
  const el = {
    tagName: tag, namespaceURI: ns, attributes: {}, children: [], textContent: '', childElementCount: 0,
    setAttribute(k, v) { this.attributes[k] = String(v) },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null },
    appendChild(child) { this.children.push(child); this.childElementCount = this.children.length; return child },
    querySelector(sel) { return findByMarker(this, sel) },
  }
  return el
}
function findByMarker(el, sel) {
  const m = /^\[([a-z-]+)\]$/.exec(sel)
  if (!m) return null
  for (const child of el.children) {
    if (child.attributes[m[1]] !== undefined) return child
    const nested = findByMarker(child, sel)
    if (nested) return nested
  }
  return null
}
const fakeDoc = { createElementNS: (ns, tag) => makeElement(tag, ns) }

const api = new Function(
  'document', 'normTitle', 'globeGridElement', 'iconInkOf', 'applyFolderGlobe',
  'var decoratedRows = 0;\n' + grab('function normTitle') + '\n' + grab('function globeGridElement') + '\n' +
  grab('function iconInkOf') + '\n' + grab('function applyFolderGlobe') +
  '\nreturn { normTitle, globeGridElement, iconInkOf, applyFolderGlobe, decorated: () => decoratedRows };'
)(fakeDoc, undefined, undefined, undefined, undefined)

let pass = 0, fail = 0
const check = (cond, label) => { if (cond) { pass++; console.log('  ✓ ' + label) } else { fail++; console.log('  ✗ FAIL: ' + label) } }

console.log('A · 角标颜色主题自适应（历史 bug：硬编码白色）')
{
  const g1 = api.globeGridElement('rgb(120, 120, 120)')
  check(g1.attributes.stroke === 'rgb(120, 120, 120)', '传入计算色 → 用它作为线条颜色')
  const g2 = api.globeGridElement(null)
  check(g2.attributes.stroke === 'currentColor', '取不到颜色 → 退回 currentColor（继承行文本色，两种主题都可见）')
  check(!/#fff|#ffffff|white/i.test(src.slice(src.indexOf('function globeGridElement'), src.indexOf('function iconInkOf'))),
    '地球组代码里不再出现硬编码白色')
  check(g2.attributes.fill === 'none', '线与弧不带填充（只有描边）')
  const shapeNames = g2.children.map((c) => c.tagName).join(',')
  check(shapeNames === 'circle,ellipse,path,path,path', '仍由 轮廓/经线/赤道/南北纬弧 五笔构成（外观不变）')
  check(g2.attributes.strokeWidth === undefined && g2.attributes['stroke-width'] === '0.9', '线宽保持 0.9')
}

console.log('B · 计算色解析（浅色主题下退回 currentColor 而不是白）')
{
  const el = { ownerDocument: { defaultView: { getComputedStyle: () => ({ color: 'rgb(20, 20, 20)' }) } } }
  check(api.iconInkOf(el) === 'rgb(20, 20, 20)', '正常取到深色 → 返回该色')
  const transparent = { ownerDocument: { defaultView: { getComputedStyle: () => ({ color: 'rgba(0, 0, 0, 0)' }) } } }
  check(api.iconInkOf(transparent) === null, '透明色 → 返回 null（由 currentColor 兜底）')
  const broken = { ownerDocument: { defaultView: { getComputedStyle: () => { throw new Error('boom') } } } }
  check(api.iconInkOf(broken) === null, '取色抛错 → 返回 null（不炸）')
  check(api.iconInkOf(null) === null, '无元素 → null')
}

console.log('C · 幂等应用与计数（诊断依赖它）')
{
  const svg = makeElement('svg', 'http://www.w3.org/2000/svg')
  api.applyFolderGlobe(svg)
  check(svg.children.length === 1 && svg.children[0].attributes['data-rssh-globe'] === '1', '首次调用追加地球组')
  check(svg.attributes['data-rssh-folder-globe'] === '1', '标记该 svg 已处理（便于排查）')
  const before = api.decorated()
  api.applyFolderGlobe(svg)
  check(svg.children.length === 1 && api.decorated() === before, '再次调用幂等（不重复追加、不重复计数）—— React 还原后复检会频繁触发')
}

console.log('D · 标题归一化（匹配容错的基础）')
{
  check(api.normTitle('  my-project  ') === 'my-project', '去首尾空白')
  check(api.normTitle('my\n  project') === 'my project', '折叠换行/多空格（壳层可能这样渲染）')
  check(api.normTitle(null) === '' && api.normTitle(undefined) === '', '空值安全')
}

console.log('E · 匹配与诊断接线（源码级断言，防止被后来者改回去）')
{
  check(/remoteTitles\.has\(normTitle\(el\.textContent\)\)/.test(src), '按归一化后的行文本匹配')
  check(/getAttribute\("title"\) \|\| el\.getAttribute\("aria-label"\)/.test(src), '容错：也看 title / aria-label 属性')
  check(/querySelectorAll\("span,div,button,a,p,\[title\],\[aria-label\]"\)/.test(src), '候选集含带 title/aria-label 的元素')
  check(/next\.add\("🌐 " \+ t\)/.test(src), '兼容自愈前的「🌐 」前缀标题（旧版行为残留）')
  check(/remoteWorkspaceCount\s*=\s*r\.workspaces\.length/.test(src), '记录远程工作区数量（诊断用）')
  check(/window\.__dshRemoteSshGlobeStats/.test(src), '暴露自检入口 window.__dshRemoteSshGlobeStats()')
  check(/远程工作区，但工作区行上没找到可加角标的图标/.test(src), '「该有却没有」时给出可操作的告警文案')
  check(/宿主未返回远程工作区/.test(src), '工作区为空时区分原因（宿主/settings 未就绪 vs DOM 不匹配）')
  check(/setTimeout\(function \(\) \{ checkGlobeHealth\(false\); \}, 8000\)/.test(src), '等界面稳定后再自检（避免行未渲染就误报）')
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
