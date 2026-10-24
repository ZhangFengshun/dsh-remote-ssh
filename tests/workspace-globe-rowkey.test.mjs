// 远程工作区「地球角标」认行方式 回归测试（issue #31）。
//
// 背景（2026-10-23 用户反馈）：**本地项目与远程项目同名**时，旧的那个本地项目也被打上了
// 地球角标（🌐）。原因是装饰层只按「标题文本」匹配 —— 两个项目同名，文本当然一样。
//
// 真实壳层结构（从 <app.asar>/@deepseek-ai/dsh-client-ui-workspace 抽出）：
//   div.projectRow[data-row-key="workspace:<原生工作区 id>"]
//     ├ span.slot.folder  > svg（文件夹图标本体，角标追加到它里面）
//     ├ span.slot.chevron > svg（展开箭头，不是目标）
//     └ span.projectText  > span.title（标题文本）
// 行键是宿主侧 workspaceRegistry 的原生 id —— 与标题无关，同名项目各行键不同。
//
// 本测试钉住：
//   A. 有行键时**只**给行键命中的行加角标（同名本地项目不标）—— 直接防 #31 复发
//   B. 幂等 + 反向自愈（不再是远程的行，角标要摘掉）
//   C. 旧壳层（无 data-row-key）回退按标题，但同名多行时**都不标**（宁可漏标不误标）
//   D. listWorkspaces 里的 shellWorkspaceId 会被用来构造行键集合
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const src = readFileSync(join(root, 'lib/client.js'), 'utf8')

let pass = 0, fail = 0
const check = (cond, label) => { if (cond) { pass++; console.log('  ✓ ' + label) } else { fail++; console.log('  ✗ FAIL: ' + label) } }

// ---- 最小假 DOM：够被测代码用（含 data-row-key / svg / 标题层级） ----
function mk(tag, attrs, text) {
  const node = {
    tagName: tag,
    attributes: Object.assign({}, attrs || {}),
    children: [],
    textContent: text === undefined ? '' : text,
    childElementCount: 0,
    isConnected: true,
    parentElement: null,
    setAttribute(k, v) { this.attributes[k] = String(v) },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null },
    removeAttribute(k) { delete this.attributes[k] },
    appendChild(c) { c.parentElement = this; this.children.push(c); this.childElementCount = this.children.length; return c },
    removeChild(c) {
      const i = this.children.indexOf(c)
      if (i >= 0) { this.children.splice(i, 1); this.childElementCount = this.children.length; c.parentElement = null }
      return c
    },
    querySelector(sel) { return queryAll(this, sel)[0] || null },
    querySelectorAll(sel) { return queryAll(this, sel) },
  }
  return node
}
function queryAll(rootNode, sel) {
  const out = []
  const visit = (n) => {
    for (const c of n.children) { if (matchEl(c, sel)) out.push(c); visit(c) }
  }
  visit(rootNode)
  return out
}
function matchEl(node, sel) {
  const s = String(sel).trim()
  if (s.indexOf('[data-row-key^=') === 0) {
    const k = node.getAttribute && node.getAttribute('data-row-key')
    return typeof k === 'string' && k.indexOf('workspace:') === 0
  }
  if (s === '[data-rssh-globe]') return node.attributes && node.attributes['data-rssh-globe'] !== undefined
  if (s === 'svg') return node.tagName === 'svg'
  if (s.indexOf(',') >= 0 || s === '[title]' || s === '[aria-label]') {
    return s.split(',').map((x) => x.trim()).some((one) => {
      if (one === 'svg') return node.tagName === 'svg'
      if (one === '[title]') return !!node.attributes.title
      if (one === '[aria-label]') return !!node.attributes['aria-label']
      return one === node.tagName
    })
  }
  return node.tagName === s
}

/** 从真实源码截出「工作区角标」整段（含变量声明），跑的是库里那份代码。 */
function loadGlobeBlock(initial) {
  const start = src.indexOf('var remoteTitles = new Set();')
  const end = src.indexOf('// ---- 角标自检')
  if (start < 0 || end < 0 || end <= start) throw new Error('角标代码段定位失败（源码结构变了）')
  const block = src.slice(start, end)
  const doc = { body: mk('body') }
  doc.createElementNS = (ns, tag) => mk(tag)
  doc.querySelectorAll = (sel) => queryAll(doc.body, sel)
  const api = (name) => {
    if (name === 'listWorkspaces') return Promise.resolve({ ok: true, workspaces: (initial && initial.workspaces) || [] })
    return Promise.resolve({ ok: true })
  }
  const factory = new Function('document', 'api', 'refreshRootLabels', 'applyRootLabelsIn',
    block + `
    if (__seed) { remoteTitles = __seed.titles || new Set(); remoteRowKeys = __seed.keys || new Set(); remoteWorkspaceCount = __seed.count || 0; }
    return {
      swapWorkspaceIconsIn, applyRowGlobes, workspaceRowsIn, recheckWatched, refreshRemoteTitles, normTitle,
      stats: () => ({ decoratedRows, titleKeys: remoteTitles.size, rowKeyKeys: remoteRowKeys.size, watched: watchedRows.length, remoteWorkspaceCount }),
      seed: (s) => { remoteTitles = s.titles || new Set(); remoteRowKeys = s.keys || new Set(); remoteWorkspaceCount = s.count || 0; },
    };`.replace('__seed', 'null'))
  const instance = factory(doc, api, () => {}, () => {})
  return { globe: instance, doc }
}

/** 造一行工作区行：projectRow[data-row-key] > (slot.folder>svg, slot.chevron>svg, projectText>title) */
function makeRow(key, title) {
  const row = mk('div', key ? { 'data-row-key': key } : {}, title)
  const folder = mk('span', { class: 'slot folder' })
  folder.appendChild(mk('svg', {}))
  const chevron = mk('span', { class: 'slot chevron' })
  chevron.appendChild(mk('svg', {}))
  const projectText = mk('span', { class: 'projectText' })
  const titleSpan = mk('span', { class: 'title' }, title)
  projectText.appendChild(titleSpan)
  row.appendChild(folder)
  row.appendChild(chevron)
  row.appendChild(projectText)
  return row
}
const folderSvg = (row) => row.children[0].children[0]
const hasGlobe = (row) => folderSvg(row).children.some((c) => c.attributes && c.attributes['data-rssh-globe'] === '1')

console.log('A · 行键精确对齐：同名本地项目不被打标（issue #31 主回归）')
{
  const { globe, doc } = loadGlobeBlock()
  globe.seed({ titles: new Set(['my-project']), keys: new Set(['workspace:ws-remote']), count: 1 })
  const localRow = makeRow('workspace:ws-local', 'my-project')   // 本地项目，标题与远程同名
  const remoteRow = makeRow('workspace:ws-remote', 'my-project') // 远程工作区
  doc.body.appendChild(localRow)
  doc.body.appendChild(remoteRow)

  globe.swapWorkspaceIconsIn(doc.body)
  check(hasGlobe(remoteRow), '远程工作区行：加上了地球角标')
  check(!hasGlobe(localRow), '同名本地项目行：**没有**地球角标（旧实现在这里会误标）')
  check(folderSvg(remoteRow).attributes['data-rssh-folder-globe'] === '1', '远程行 svg 带处理标记（便于排查）')
  check(folderSvg(localRow).attributes['data-rssh-folder-globe'] === undefined, '本地行 svg 不带任何标记')
  check(globe.normTitle(localRow.textContent) === globe.normTitle(remoteRow.textContent), '两行 textContent 归一化后完全一致（证明"只靠标题无法区分"）')
  const chevronSvg = remoteRow.children[1].children[0]
  check(!chevronSvg.children.some((c) => c.attributes && c.attributes['data-rssh-globe'] === '1'), '箭头槽位里的 svg 不会被误加（只动 folder 槽位）')

  const before = globe.stats().decoratedRows
  globe.swapWorkspaceIconsIn(doc.body)
  check(globe.stats().decoratedRows === before, '重复扫描幂等（不重复加、不重复计数）')
  check(hasGlobe(remoteRow) && !hasGlobe(localRow), '重复扫描后结论不变')
}

console.log('A2 · 局部子树重渲染（如标题 span）不得退回标题匹配')
{
  const { globe, doc } = loadGlobeBlock()
  globe.seed({ titles: new Set(['my-project']), keys: new Set(['workspace:ws-remote']), count: 1 })
  const localRow = makeRow('workspace:ws-local', 'my-project')
  const remoteRow = makeRow('workspace:ws-remote', 'my-project')
  doc.body.appendChild(localRow)
  doc.body.appendChild(remoteRow)
  globe.swapWorkspaceIconsIn(doc.body) // 第一次扫描：确立"这个壳层支持行键"
  const localTitle = localRow.children[2].children[0]
  globe.swapWorkspaceIconsIn(localTitle) // 模拟 MutationObserver 丢进来一小块子树
  check(!hasGlobe(localRow), '子树里没有行 → 保持不动（支持行键的壳层绝不按标题猜）')
  check(hasGlobe(remoteRow), '远程行角标保持不受影响')
}

console.log('B · 反向自愈：不再是远程的行要摘掉角标')
{
  const { globe, doc } = loadGlobeBlock()
  globe.seed({ titles: new Set(['proj']), keys: new Set(['workspace:ws-remote']), count: 1 })
  const row = makeRow('workspace:ws-remote', 'proj')
  doc.body.appendChild(row)
  globe.swapWorkspaceIconsIn(doc.body)
  check(hasGlobe(row), '先按行键加上了')

  // 模拟宿主侧把该工作区删了（行键集合不再包含它）
  globe.seed({ titles: new Set(), keys: new Set(), count: 0 })
  globe.applyRowGlobes(globe.workspaceRowsIn(doc.body))
  check(!hasGlobe(row), '该行不再是远程 → 角标被摘掉（升级前误标的行也能自愈）')
  check(folderSvg(row).attributes['data-rssh-folder-globe'] === undefined, '处理标记一并清掉')

  globe.seed({ titles: new Set(['proj']), keys: new Set(['workspace:ws-remote']), count: 1 })
  globe.swapWorkspaceIconsIn(doc.body)
  check(hasGlobe(row), '重新变回远程 → 角标回来')
}

console.log('C · 旧壳层回退（无 data-row-key）：同名多行都不标')
{
  const { globe, doc } = loadGlobeBlock()
  globe.seed({ titles: new Set(['my-project']), keys: new Set(), count: 1 })
  const a = makeRow(null, 'my-project')
  const b = makeRow(null, 'my-project')
  doc.body.appendChild(a)
  doc.body.appendChild(b)
  globe.swapWorkspaceIconsIn(doc.body)
  check(!hasGlobe(a) && !hasGlobe(b), '两行同名且无法用行键区分 → 都不标（宁可漏标，不误标）')

  const { globe: g2, doc: d2 } = loadGlobeBlock()
  g2.seed({ titles: new Set(['solo']), keys: new Set(), count: 1 })
  const only = makeRow(null, 'solo')
  d2.body.appendChild(only)
  g2.swapWorkspaceIconsIn(d2.body)
  check(hasGlobe(only), '只有一行同名 → 仍按标题标（旧壳层不至于完全失效）')

  const { globe: g3, doc: d3 } = loadGlobeBlock()
  g3.seed({ titles: new Set(['solo']), keys: new Set(), count: 1 })
  const other = makeRow(null, 'unrelated')
  d3.body.appendChild(other)
  g3.swapWorkspaceIconsIn(d3.body)
  check(!hasGlobe(other), '标题不匹配 → 不标')
}

console.log('D · 行键集合来自 listWorkspaces.shellWorkspaceId')
{
  const { globe, doc } = loadGlobeBlock({
    workspaces: [{ title: 'proj', shellWorkspaceId: 'ws-1' }, { title: 'no-id' }],
  })
  await globe.refreshRemoteTitles()
  const s = globe.stats()
  check(s.rowKeyKeys === 1, '只对带 shellWorkspaceId 的记录建行键（1 条）')
  check(s.titleKeys >= 2, '标题集合仍然收录全部工作区（旧壳层回退要用）')
  check(s.remoteWorkspaceCount === 2, '工作区计数正确（诊断用）')

  const row = makeRow('workspace:ws-1', 'proj')
  doc.body.appendChild(row)
  globe.swapWorkspaceIconsIn(doc.body)
  check(hasGlobe(row), '行键 workspace:ws-1 命中 → 打标')
}

console.log('E · 源码接线（防止被后来者改回标题匹配）')
{
  check(/data-row-key/.test(src), '客户端代码出现 data-row-key（壳层行键）')
  check(/workspaceRowsIn/.test(src) && /applyRowGlobes/.test(src), '有独立的「按行键」路径')
  check(/remoteRowKeys\.has\(key\)/.test(src), '判定用行键集合，不是标题')
  check(/if \(same > 1\) continue;/.test(src), '旧壳层回退里保留「同名不标」护栏')
  check(/shellWorkspaceId/.test(src), '客户端消费 shellWorkspaceId')
  check(/rowKeyKeys: remoteRowKeys\.size/.test(src), '自检输出行键数量')
  check(/matchedBy: remoteRowKeys\.size \? "rowKey" : "title"/.test(src), '自检标明当前走的是哪条匹配路径')
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
