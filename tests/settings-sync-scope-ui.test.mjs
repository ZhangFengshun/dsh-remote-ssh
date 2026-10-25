// 同步范围的可达性（issue #28）。
//
// 举报人核对过：`syncPaths` / `syncExclude` / `syncMaxBytes`（#20 引入）后端早就齐了
// —— schema 有字段、`updateWorkspace` 能写、`syncOptsFrom` 有三级回退 —— 但 GUI 里
// 一个入口都没有，「添加工作区」也只会建出 `syncPaths: []` 的工作区。对 remotePath 是
// `~` 的工作区，空范围意味着 sync 退化成整树、先被 2 GiB 体积哨兵拒绝，每次都得手改配置
// 或直调 HTTP。
//
// 这个文件钉住四件事：
//   ① 三个归一化/解析函数的行为（抽真实实现跑，不是看代码里有没有写）；
//   ② 宿主三个入口（updateWorkspaceGuards / createRemoteWorkspace / savePrefs+getPrefs）
//      都真的接住了这三个字段，且 createRemoteWorkspace 会回落到全局默认；
//   ③ 三个 settings face 的 read() 都回 defaultSync*（少一处，设置面板在旧版 DSH 上就显示空）；
//   ④ 客户端真有控件（含「添加工作区」弹窗与手动同步按钮），且新文案中英各一份。
import { readFileSync } from 'node:fs'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const src = readFileSync(root + '/lib/index.js', 'utf8')
const client = readFileSync(root + '/lib/client.js', 'utf8')

let pass = 0
let fail = 0
const check = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label) }
  else { fail++; console.log('  ✗ FAIL: ' + label) }
}

/** 从源码里按大括号配对抽出一个函数声明（含注释头）。 */
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

console.log('A · 归一化函数的行为（抽真实实现跑）')
{
  const block = [
    grab(src, 'function normalizeSyncList('),
    grab(src, 'function parseSyncMaxBytes(')
  ].join('\n')
  const fns = new Function(block + '\nreturn { normalizeSyncList, parseSyncMaxBytes }')()
  const { normalizeSyncList, parseSyncMaxBytes } = fns

  check(Array.isArray(normalizeSyncList(['a', ' b ', '', '  '])), 'normalizeSyncList 回数组')
  check(JSON.stringify(normalizeSyncList(['a', ' b ', '', '  '])) === '["a","b"]', '数组输入：trim + 丢空串')
  check(JSON.stringify(normalizeSyncList('.dsh, src\n docs;config')) === '[".dsh","src","docs","config"]',
    '整串输入：逗号/换行/分号都认（与客户端输入框同语义）')
  check(JSON.stringify(normalizeSyncList(['a', 'a', ' a '])) === '["a"]', '重复项去重（否则 tar 命令行无谓变长）')
  check(JSON.stringify(normalizeSyncList(null)) === '[]' && JSON.stringify(normalizeSyncList(undefined)) === '[]',
    'null / undefined → 空数组（清空范围时不会塞进奇怪值）')
  check(JSON.stringify(normalizeSyncList('')) === '[]', '空串 → 空数组（空 exclude 会命中一切，必须丢掉）')

  check(parseSyncMaxBytes(0) === 0, '数字 0 是合法值（= 用内置默认上限）')
  check(parseSyncMaxBytes(1048576) === 1048576, '数字按字节原样接受')
  check(parseSyncMaxBytes('2 GiB') === 2 * 1024 * 1024 * 1024, '"2 GiB" 按 1024 进制解析')
  check(parseSyncMaxBytes('512MB') === 512 * 1000 * 1000, '"512MB" 按 1000 进制解析')
  check(parseSyncMaxBytes('1.5GiB') === Math.round(1.5 * 1024 * 1024 * 1024), '接受小数')
  check(parseSyncMaxBytes(-1) === null, '负数非法 → null')
  check(parseSyncMaxBytes('abc') === null, '乱填非法 → null')
  check(parseSyncMaxBytes('') === null && parseSyncMaxBytes(null) === null, '空值 → null（调用方据此回落到默认）')
}

console.log('B · 宿主：schema 与三个入口都接住新字段')
{
  check(/defaultSyncPaths: z\.array\(z\.string\(\)\)\.default\(\[\]\)/.test(src), 'PrefsSchema 有 defaultSyncPaths')
  check(/defaultSyncExclude: z\.array\(z\.string\(\)\)\.default\(\[\]\)/.test(src), 'PrefsSchema 有 defaultSyncExclude')
  check(/defaultSyncMaxBytes: z\.number\(\)\.default\(0\)/.test(src), 'PrefsSchema 有 defaultSyncMaxBytes')

  const guardBody = src.slice(
    src.indexOf('updateWorkspaceGuards: async (args) => {'),
    src.indexOf('createRemoteWorkspace: async (args) => {')
  )
  check(/next\.syncPaths = normalizeSyncList\(a\.syncPaths\)/.test(guardBody), 'updateWorkspaceGuards 写 syncPaths')
  check(/next\.syncExclude = normalizeSyncList\(a\.syncExclude\)/.test(guardBody), 'updateWorkspaceGuards 写 syncExclude')
  check(/next\.syncMaxBytes = n === null \? 0 : n/.test(guardBody), 'updateWorkspaceGuards 写 syncMaxBytes（非法值归 0）')
  check(/if \(a\.syncPaths !== undefined\)/.test(guardBody), '只有传了才写（undefined = 不动，避免误清空）')

  const createBody = src.slice(
    src.indexOf('createRemoteWorkspace: async (args) => {'),
    src.indexOf('deleteWorkspace: async (args) => {')
  )
  // issue #32 起建区还会「接管」同连接同路径的旧条目：取值优先级是
  // 显式参数 > 旧记录（复用时不把用户设好的范围重置回默认） > 全局默认。
  check(/a\.syncPaths !== undefined/.test(createBody) && /prefsNow\.defaultSyncPaths/.test(createBody),
    '建区时显式 syncPaths 优先，否则回落全局默认')
  check(/existing \? existing\.syncPaths : prefsNow\.defaultSyncPaths/.test(createBody),
    '复用旧条目时沿用该条目自己的 syncPaths（不被默认值覆盖）')
  check(/a\.syncExclude !== undefined/.test(createBody) && /prefsNow\.defaultSyncExclude/.test(createBody),
    '建区时 syncExclude 同样回落全局默认')
  check(/existing \? existing\.syncExclude : prefsNow\.defaultSyncExclude/.test(createBody),
    '复用旧条目时沿用该条目自己的 syncExclude')
  check(/prefsNow\.defaultSyncMaxBytes/.test(createBody), '建区时体积上限回落全局默认')
  check(/syncPaths: normalizeSyncList\(/.test(createBody) && /syncExclude: normalizeSyncList\(/.test(createBody),
    '落库前先归一化（手调 HTTP 传整串也不会写进脏数据）')

  const saveBody = src.slice(
    src.indexOf('savePrefs: async (args) => {'),
    src.indexOf('updateWorkspaceGuards: async (args) => {')
  )
  check(/patch\.defaultSyncPaths = normalizeSyncList\(a\.defaultSyncPaths\)/.test(saveBody), 'savePrefs 接受 defaultSyncPaths')
  check(/patch\.defaultSyncExclude = normalizeSyncList\(a\.defaultSyncExclude\)/.test(saveBody), 'savePrefs 接受 defaultSyncExclude')
  check(/patch\.defaultSyncMaxBytes = n === null \? 0 : n/.test(saveBody), 'savePrefs 接受 defaultSyncMaxBytes（非法归 0）')
  check(!/patch\.profiles/.test(saveBody) && !/patch\.workspaces/.test(saveBody), 'savePrefs 仍不碰 profiles / workspaces（负向控制）')

  const getBody = src.slice(src.indexOf('getPrefs: async () => {'), src.indexOf('savePrefs: async (args) => {'))
  check(/defaultSyncPaths: normalizeSyncList\(v\.defaultSyncPaths\)/.test(getBody), 'getPrefs 回 defaultSyncPaths（设置面板要能显示）')
  check(/defaultSyncMaxBytes: Number\.isFinite\(v\.defaultSyncMaxBytes\)/.test(getBody), 'getPrefs 回 defaultSyncMaxBytes')
}

console.log('C · 三个 settings face 的 read() 都回 defaultSync*（旧版 DSH 上也不能显示成空）')
{
  const n = (src.match(/defaultSyncPaths: normalizeSyncList\(prefsArray\(/g) || []).length
  check(n === 3, 'defaultSyncPaths 在三处 read() 都回（实际 ' + n + '）')
  const m = (src.match(/defaultSyncMaxBytes: prefsNumber\(0,/g) || []).length
  check(m === 3, 'defaultSyncMaxBytes 在三处 read() 都回（实际 ' + m + '）')
  check(/function prefsNumber\(fallback, \.\.\.candidates\)/.test(src), '有 prefsNumber（0 是合法值，不能被当成"没设"）')
}

console.log('D · 客户端：控件、弹窗、手动同步按钮')
{
  check(/api\("updateWorkspaceGuards"/.test(client), '工作区保存仍走 updateWorkspaceGuards')
  const saveCall = client.slice(
    client.indexOf('function saveGuard(ws) {'),
    client.indexOf('function runSync(ws, action) {')
  )
  check(/syncPaths: splitList\(g\.syncPaths\)/.test(saveCall), 'saveGuard 提交 syncPaths')
  check(/syncExclude: splitList\(g\.syncExclude\)/.test(saveCall), 'saveGuard 提交 syncExclude')
  check(/syncMaxBytes: gibTextToBytes\(g\.syncMaxBytes\)/.test(saveCall), 'saveGuard 提交 syncMaxBytes（GiB 文本 → 字节）')

  check(/setGuard\(ws\.id, "syncPaths"/.test(client), '每个工作区有"同步范围"输入框')
  check(/setGuard\(ws\.id, "syncExclude"/.test(client), '每个工作区有"同步排除"输入框')
  check(/setGuard\(ws\.id, "syncMaxBytes"/.test(client), '每个工作区有"体积上限"输入框')
  check(/setPref\("defaultSyncPaths"/.test(client), '偏好设置里有"默认同步范围"输入框')
  check(/setPref\("defaultSyncMaxBytes"/.test(client), '偏好设置里有"默认体积上限"输入框')

  check(/defaultSyncPaths: splitList\(prefs\.defaultSyncPaths\)/.test(client), 'savePrefs 提交默认同步范围')

  const flow = client.slice(client.indexOf('function RemoteWorkspaceFlow(props) {'), client.indexOf('// 设置页小节'))
  check(/payload\.syncPaths = scope/.test(flow), '「添加工作区」弹窗把同步范围传给 createRemoteWorkspace')
  check(/scope\.length/.test(flow), '留空不传（交给宿主用全局默认兜底）')

  check(/api\(action, \{ id: ws\.id \}\)/.test(client), '手动同步按钮复用已有 syncDown / syncUp 端点')
  check(/runSync\(ws, "syncDown"\)/.test(client) && /runSync\(ws, "syncUp"\)/.test(client), '工作区卡片有"同步/推送"两个按钮')
  check(/if \(syncId\) return;/.test(client) && /disabled: !!syncId/.test(client),
    '同步进行中再次点击被挡住（两次同步会在同一镜像目录里抢）')
}

console.log('E · 客户端辅助函数的行为（抽真实实现跑）')
{
  const start = client.indexOf('// ---- 同步范围输入框')
  const end = client.indexOf('// 远程操作弹窗')
  check(start > 0 && end > start, '能定位客户端辅助函数区块')
  const block = client.slice(start, end)
  const fns = new Function(block + '\nreturn { splitList, bytesToGibText, gibTextToBytes, prefsForUi }')()
  const { splitList, bytesToGibText, gibTextToBytes, prefsForUi } = fns

  check(JSON.stringify(splitList('.dsh, src\ndocs')) === '[".dsh","src","docs"]', 'splitList 与宿主同样拆分')
  check(JSON.stringify(splitList('')) === '[]', 'splitList 空串 → 空数组')
  check(bytesToGibText(2 * 1024 * 1024 * 1024) === '2', 'bytesToGibText(2 GiB) = "2"')
  check(bytesToGibText(0) === '' && bytesToGibText(undefined) === '', '0 / 未设 → 空（占位符提示用默认）')
  check(gibTextToBytes('2') === 2 * 1024 * 1024 * 1024, 'gibTextToBytes("2") = 2 GiB')
  check(gibTextToBytes('') === 0 && gibTextToBytes('abc') === 0, '空/乱填 → 0（回到内置默认上限）')
  const ui = prefsForUi({ nodePath: 'n', writeBackFailure: 'log', writeBackFreshness: false, defaultSyncPaths: ['.dsh', 'src'], defaultSyncExclude: [], defaultSyncMaxBytes: 1073741824 })
  check(ui.defaultSyncPaths === '.dsh, src' && ui.defaultSyncExclude === '' && ui.defaultSyncMaxBytes === '1',
    'prefsForUi 数组转文本、字节转 GiB')
  check(ui.writeBackFreshness === false, 'prefsForUi 保留复选框的 false（负向控制）')
}

console.log('F · 文案：新键在 zh / en 各定义一次')
{
  const keys = [
    'settings.wsSyncPaths', 'settings.wsSyncExclude', 'settings.wsSyncMaxBytes',
    'settings.syncScope', 'settings.syncScopeHint',
    'settings.defaultSyncPaths', 'settings.defaultSyncExclude', 'settings.defaultSyncMaxBytes',
    'flow.syncPaths', 'sync.upDone', 'sync.upFail'
  ]
  for (const k of keys) {
    const n = (client.match(new RegExp('"' + k.replace(/\./g, '\\.') + '":', 'g')) || []).length
    check(n === 2, k + ' 在 zh/en 各定义一次（实际 ' + n + '）')
  }
}

/** 从源码里抽出一个对象方法（`name: async (args) => { ... }`），按大括号配对，保留箭头头。 */
function grabMethod(text, label) {
  const start = text.indexOf(label)
  if (start < 0) throw new Error(label + ' not found')
  let i = text.indexOf('{', start)
  let depth = 0
  for (; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') { depth--; if (depth === 0) break }
  }
  const arrowStart = text.indexOf('async', start)
  return text.slice(arrowStart, i + 1)
}

console.log('G · 真跑宿主写路径（抽真实 handler，注入假 settingsFace）')
{
  const block = grab(src, 'function normalizeSyncList(') + '\n' + grab(src, 'function parseSyncMaxBytes(')
  const helpers = new Function(block + '\nreturn { normalizeSyncList, parseSyncMaxBytes }')()

  // ---- updateWorkspaceGuards：同步范围真的落库，undefined 不动，空值清空 ----
  const store = {
    workspaces: [{ id: 'w1', profileId: 'p1', title: 't', remotePath: '~', mirrorPath: 'm', syncPaths: [], syncExclude: [], syncMaxBytes: 0 }]
  }
  const face = {
    read: () => JSON.parse(JSON.stringify(store)),
    updateWorkspaces: async (list) => { store.workspaces = JSON.parse(JSON.stringify(list)) },
    updatePrefs: async () => {}
  }
  const guard = new Function(
    'settingsFace', 'normalizeSyncList', 'parseSyncMaxBytes',
    'return ' + grabMethod(src, 'updateWorkspaceGuards: async (args) => {')
  )(face, helpers.normalizeSyncList, helpers.parseSyncMaxBytes)

  const r1 = await guard({ id: 'w1', syncPaths: ' .dsh , src\n.dsh ', syncExclude: ['data/', '  '], syncMaxBytes: '2 GiB' })
  check(r1.ok === true, 'updateWorkspaceGuards 返回 ok')
  check(JSON.stringify(store.workspaces[0].syncPaths) === '[".dsh","src"]', 'syncPaths 真落库（trim + 去重 + 拆整串）')
  check(JSON.stringify(store.workspaces[0].syncExclude) === '["data/"]', 'syncExclude 真落库（空项被丢掉）')
  check(store.workspaces[0].syncMaxBytes === 2 * 1024 * 1024 * 1024, 'syncMaxBytes 按 "2 GiB" 落成字节数')

  const before = JSON.stringify(store.workspaces[0].syncPaths)
  await guard({ id: 'w1', writeBack: false })
  check(store.workspaces[0].writeBack === false, 'writeBack 照旧可写')
  check(JSON.stringify(store.workspaces[0].syncPaths) === before, '没传同步范围 → 原值不动（undefined = 不改，负向控制）')

  await guard({ id: 'w1', syncPaths: [], syncExclude: '', syncMaxBytes: 'garbage' })
  check(JSON.stringify(store.workspaces[0].syncPaths) === '[]', '传空数组 = 显式清空（回到整树）')
  check(JSON.stringify(store.workspaces[0].syncExclude) === '[]', '传空串 = 显式清空')
  check(store.workspaces[0].syncMaxBytes === 0, '乱填体积上限 → 归 0（回到内置默认），不会写进 NaN')

  const missing = await guard({ id: 'nope', syncPaths: ['.dsh'] })
  check(missing.ok === false && /未找到远程工作区/.test(missing.error), '工作区不存在时报错而不是静默成功')

  // ---- savePrefs：新键进白名单、非法体积归一化、无关键不写 ----
  const prefsStore = { nodePath: '', writeBackFailure: 'error', writeBackFreshness: true, defaultSyncPaths: [], defaultSyncExclude: [], defaultSyncMaxBytes: 0 }
  const patches = []
  const prefsFace = {
    read: () => Object.assign({}, prefsStore),
    updatePrefs: async (patch) => { patches.push(patch); Object.assign(prefsStore, patch) }
  }
  const savePrefs = new Function(
    'settingsFace', 'normalizeSyncList', 'parseSyncMaxBytes',
    'return ' + grabMethod(src, 'savePrefs: async (args) => {')
  )(prefsFace, helpers.normalizeSyncList, helpers.parseSyncMaxBytes)

  const saved = await savePrefs({ defaultSyncPaths: '.dsh, src', defaultSyncExclude: 'data/', defaultSyncMaxBytes: '512MB', evil: 'x' })
  check(saved.ok === true, 'savePrefs 返回 ok')
  check(JSON.stringify(patches[0].defaultSyncPaths) === '[".dsh","src"]', 'defaultSyncPaths 归一化后写入')
  check(patches[0].defaultSyncMaxBytes === 512 * 1000 * 1000, 'defaultSyncMaxBytes 按 "512MB" 写入')
  check(!('evil' in patches[0]) && !('profiles' in patches[0]) && !('workspaces' in patches[0]), '白名单外的键不写（负向控制）')
  check(JSON.stringify(saved.prefs.defaultSyncPaths) === '[".dsh","src"]', '返回值回读最新值（面板据此刷新）')

  const none = await savePrefs({ unrelated: 1 })
  check(none.ok === false && /没有可保存的字段/.test(none.error), '没有任何白名单键时报错')
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)