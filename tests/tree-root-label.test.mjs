// 文件树根标签回归测试（issue #9）：远程工作区的「文件」页签树根应显示远程目录名
// （IB_Robot），而不是本地镜像目录 ID（wmu3sxe24jpvg）。
//
// 做法：从 lib/client.js 提取**真实**的 refreshRootLabels / isRootRow / fixRootLabel /
// watchRootLabel / recheckRootLabels / applyRootLabelsIn 函数文本，配一个极简 DOM 桩执行，
// 校验替换行为、假阳性防护、幂等与 React 还原后的自愈。
import { readFileSync } from 'node:fs'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const src = readFileSync(root + '/lib/client.js', 'utf8')

// ---- 1. 提取真实实现 ----
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
const varRootLabels = src.match(/var rootLabels = \{\};/)[0]
const varWatched = src.match(/var watchedRootLabels = \[\];[^\n]*/)[0]
const code = [
  varRootLabels,
  varWatched,
  grab('function refreshRootLabels'),
  grab('function isRootRow'),
  grab('function fixRootLabel'),
  grab('function watchRootLabel'),
  grab('function recheckRootLabels'),
  grab('function applyRootLabelsIn'),
].join('\n')
const api = new Function(code + '\nreturn { refreshRootLabels, applyRootLabelsIn, recheckRootLabels, fixRootLabel, dump: function(){ return rootLabels; } };')()

// ---- 2. 极简 DOM 桩（只实现被测代码用到的 API）----
class El {
  constructor(tag, style) {
    this.tagName = tag
    this.nodeType = 1
    this.isConnected = true
    this.children = []
    this.parentElement = null
    this._attrs = {}
    this._text = ''
    if (style !== undefined) this._attrs.style = style
  }
  get childElementCount() { return this.children.length }
  append(child) { child.parentElement = this; this.children.push(child); return child }
  get textContent() {
    return this.children.length ? this.children.map((c) => c.textContent).join('') : this._text
  }
  set textContent(v) { this.children = []; this._text = String(v) }
  getAttribute(name) { return Object.prototype.hasOwnProperty.call(this._attrs, name) ? this._attrs[name] : null }
  setAttribute(name, value) { this._attrs[name] = String(value) }
  querySelectorAll() {
    const out = []
    const walk = (node) => {
      for (const c of node.children) {
        if (c.tagName === 'span' || c.tagName === 'div') out.push(c)
        walk(c)
      }
    }
    walk(this)
    return out
  }
}

let pass = 0, fail = 0
const check = (cond, label) => { if (cond) { pass++; console.log('  ✓ ' + label) } else { fail++; console.log('  ✗ FAIL: ' + label) } }

/** 造一棵树：根行（padding-left:6px）+ 一个子行（padding-left:18px）+ 各带一个 name span。 */
function buildTree(mirrorBase, childBase) {
  const body = new El('div')
  const rootRow = body.append(new El('div', 'padding-left: 6px'))
  rootRow.append(new El('div'))            // 图标占位
  const rootSpan = rootRow.append(new El('span'))
  rootSpan.textContent = mirrorBase
  const childRow = body.append(new El('div', 'padding-left: 18px'))
  const childSpan = childRow.append(new El('span'))
  childSpan.textContent = childBase
  return { body, rootRow, rootSpan, childRow, childSpan }
}

const MIRROR = 'wmu3sxe24jpvg'

console.log('场景 1 · 远程工作区：根行标签替换为远程目录名')
{
  const t = buildTree(MIRROR, 'src')
  api.refreshRootLabels([{ mirrorPath: 'C:\\Users\\me\\.dsh\\remote-workspaces\\' + MIRROR, remotePath: '~/lhj/IB_Robot' }])
  api.applyRootLabelsIn(t.body)
  check(t.rootSpan.textContent === 'IB_Robot', '根标签 → IB_Robot')
  check(t.rootSpan.getAttribute('data-rssh-root-label') === '1', '打上幂等标记')
  check(t.rootSpan.getAttribute('title') === '~/lhj/IB_Robot', '悬停 title = 完整远程路径')
  check(t.childSpan.textContent === 'src', '子行未被触碰（假阳性防护：非根行）')
  check(JSON.stringify(api.dump()) === JSON.stringify({ [MIRROR]: { label: 'IB_Robot', remotePath: '~/lhj/IB_Robot' } }),
    '镜像 basename → 远程 basename 映射正确')
}

console.log('场景 2 · 幂等：重复 apply 不产生副作用')
{
  const t = buildTree(MIRROR, 'src')
  api.refreshRootLabels([{ mirrorPath: '/home/me/.dsh/remote-workspaces/' + MIRROR, remotePath: '/data/proj/IB_Robot' }])
  api.applyRootLabelsIn(t.body)
  api.applyRootLabelsIn(t.body)
  api.recheckRootLabels()
  check(t.rootSpan.textContent === 'IB_Robot', '仍为 IB_Robot（无重复替换）')
}

console.log('场景 3 · React 还原文本后，1s 复检自愈')
{
  const t = buildTree(MIRROR, 'src')
  api.refreshRootLabels([{ mirrorPath: '/x/' + MIRROR, remotePath: '~/lhj/IB_Robot' }])
  api.applyRootLabelsIn(t.body)
  t.rootSpan.textContent = MIRROR      // 模拟 React 重渲染还原成镜像 ID
  api.recheckRootLabels()
  check(t.rootSpan.textContent === 'IB_Robot', '复检后恢复为远程目录名')
}

console.log('场景 4 · 本地工作区（无映射）与同名干扰项')
{
  const t = buildTree('local-proj', 'local-proj')
  api.refreshRootLabels([])            // 无远程工作区
  api.applyRootLabelsIn(t.body)
  check(t.rootSpan.textContent === 'local-proj', '无映射时原样保留')
  // 远程文件恰好与镜像目录同名：非根行 → 不动
  const t2 = buildTree('IB_Robot', MIRROR)
  api.refreshRootLabels([{ mirrorPath: '/x/' + MIRROR, remotePath: '~/lhj/IB_Robot' }])
  api.applyRootLabelsIn(t2.body)
  check(t2.childSpan.textContent === MIRROR, '与镜像同名的子条目不被误改')
  check(t2.rootSpan.textContent === 'IB_Robot', '而根行（若同名）仍按规则处理')
}

console.log('场景 5 · 根行判据的容错')
{
  // 内联样式里 padding-left 与其它声明并存
  const body = new El('div')
  const row = body.append(new El('div', 'color: red; padding-left:6px; overflow: hidden'))
  const span = row.append(new El('span'))
  span.textContent = MIRROR
  api.refreshRootLabels([{ mirrorPath: '/x/' + MIRROR, remotePath: '~/a/RemoteDir' }])
  api.applyRootLabelsIn(body)
  check(span.textContent === 'RemoteDir', 'padding-left:6px 与其它样式并存时仍能识别根行')

  // 无 style 属性（例如上游改了根行样式）→ 保守不替换，避免误伤
  const body2 = new El('div')
  const row2 = body2.append(new El('div'))
  const span2 = row2.append(new El('span'))
  span2.textContent = MIRROR
  api.applyRootLabelsIn(body2)
  check(span2.textContent === MIRROR, '缺少根行标志时保守不动（宁可不改也不误改）')
}

console.log('场景 6 · 镜像名与远程名相同的边界')
{
  api.refreshRootLabels([{ mirrorPath: '/x/' + MIRROR, remotePath: '~/lhj/' + MIRROR }])
  check(Object.keys(api.dump()).length === 0, '同名时不入映射表（无需替换）')
}

console.log('场景 7 · 接线检查（同步替换 + 1s 复检 + 轮询刷新）')
{
  check(/if \(node && node\.nodeType === 1 && node\.isConnected\) \{\s*\n\s*checkCellIn\(node\);\s*\n[\s\S]{0,200}applyRootLabelsIn\(node\);/.test(src),
    'MutationObserver 回调内同步调用 applyRootLabelsIn(node)（绘制前替换，不闪镜像 ID）')
  check(/setInterval\(function \(\) \{ recheckWatched\(\); recheckRootLabels\(\); \}, 1000\)/.test(src),
    '1s 定时器同时复检树根标签')
  check(/refreshRootLabels\(r\.workspaces\)/.test(src), 'refreshRemoteTitles 内重建映射（并 30s 轮询）')
  check(/applyRootLabelsIn\(document\.body\)/.test(src), '有无根场景的全量补扫')
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)