// 远程工作区条目的生命周期（issue #32）：壳层删区要连带删设置条目、重复条目要防住、
// 删一条不能连带删掉另一条还在用的会话行。
//
// 病象（用户报告，2.4.37）：
//   1. 在壳层侧删掉工作区后，插件设置里那条记录还在；
//   2. 之后再添加同一个远程工作区 → 设置里出现两条一模一样的条目；
//   3. 删其中一条重复条目时，会话栏里另一条对应的行也没了。
//
// 宿主的「删除工作区」最终走 `workspaceRegistry.delete(id)`（dsh-api-workspace-controller），
// 所以：
//   A. 挂一层 delete 联动 → 原生删除成功后清掉配置里匹配的条目 + 镜像目录
//   B. 建区时同一「连接 + 远程路径」只允许一条记录（接管旧条目，不新建）
//   C. 删除时若还有别的条目共用同一镜像/原生 id → 不动原生工作区（避免误删会话行）
import { readFileSync } from 'node:fs'
import { join as joinPath } from 'node:path'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const src = readFileSync(joinPath(root, 'lib/index.js'), 'utf8')

function grab(name) {
  const start = src.indexOf(name)
  if (start < 0) throw new Error(name + ' not found in lib/index.js')
  const declStart = src.lastIndexOf('\n', start)
  let i = src.indexOf('{', start)
  let depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) break }
  }
  return src.slice(declStart + 1, i + 1)
}

/** 载入 sharingEntryOf / cleanupWorkspace / pruneWorkspaceEntriesForNativeId / installNativeDeleteSync。 */
function loadLifecycle() {
  const code = [
    grab('function sharingEntryOf'),
    grab('async function cleanupWorkspace'),
    grab('async function pruneWorkspaceEntriesForNativeId'),
    grab('function installNativeDeleteSync'),
    'return { sharingEntryOf, cleanupWorkspace, pruneWorkspaceEntriesForNativeId, installNativeDeleteSync };',
  ].join('\n')
  return new Function('settingsFace', 'workspaceRegistry', 'rm', 'ctx', code)
}

/** 载入 createRemoteWorkspace 的箭头函数本体（对象字面量里的那个方法）。 */
function loadCreate() {
  const marker = 'createRemoteWorkspace: async (args) =>'
  const at = src.indexOf(marker)
  if (at < 0) throw new Error('createRemoteWorkspace not found')
  const braceAt = src.indexOf('{', at)
  let depth = 0
  let i = braceAt
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) break }
  }
  const arrow = src.slice(at + 'createRemoteWorkspace: '.length, i + 1)
  const code = 'return (' + arrow + ');'
  return new Function(
    'getProfile', 'settingsFace', 'workspaceRegistry', 'mkdir', 'writeFile', 'join',
    'mirrorBaseDir', 'remoteWorkspaceReadme', 'normalizeSyncList', 'parseSyncMaxBytes',
    code)
}

function fakeSettings(workspaces) {
  const writes = []
  const state = { workspaces: workspaces.map((w) => Object.assign({}, w)) }
  return {
    writes,
    state,
    face: {
      read: () => ({ workspaces: state.workspaces.map((w) => Object.assign({}, w)) }),
      updateWorkspaces: async (list) => { writes.push(list.map((w) => Object.assign({}, w))); state.workspaces = list },
    },
  }
}

const log = { info: () => {}, warn: () => {} }
const quietCtx = { logger: log }

let pass = 0, fail = 0
const check = (cond, label) => { if (cond) { pass++; console.log('  ✓ ' + label) } else { fail++; console.log('  ✗ FAIL: ' + label) } }

console.log('A · 共用保护：别的条目还用着同一镜像/原生 id 时，不动原生工作区（issue #32 第 3 条）')
{
  const s = fakeSettings([
    { id: 'w1', mirrorPath: 'C:\\m\\w1', shellWorkspaceId: 'n1' },
    { id: 'w2', mirrorPath: 'C:\\m\\w1', shellWorkspaceId: 'n1' },
  ])
  const deleted = []
  const rms = []
  const L = loadLifecycle()(s.face, { get: () => ({ id: 'n1' }), delete: async (id) => { deleted.push(id) } }, async (p) => { rms.push(p) }, quietCtx)
  check(L.sharingEntryOf({ id: 'w1', mirrorPath: 'C:\\m\\w1' }, s.state.workspaces) !== null, 'sharingEntryOf 认出同镜像目录的另一条')
  await L.cleanupWorkspace({ id: 'w1', mirrorPath: 'C:\\m\\w1', shellWorkspaceId: 'n1' })
  check(deleted.length === 0, '共用 → 不删原生工作区（否则另一条的会话行会跟着消失）')
  check(rms.length === 0, '共用 → 也不 rm 镜像目录（另一条还在用它）')

  // 只有一条引用时照常清理
  s.state.workspaces = s.state.workspaces.filter((w) => w.id === 'w1')
  await L.cleanupWorkspace({ id: 'w1', mirrorPath: 'C:\\m\\w1', shellWorkspaceId: 'n1' })
  check(deleted.length === 1 && deleted[0] === 'n1', '无共用 → 正常删除原生工作区')
  check(rms.length === 1, '无共用 → 正常 rm 镜像目录')
}

console.log('B · 精确优先：先按 shellWorkspaceId 取实体，取不到才按镜像路径兜底')
{
  const s = fakeSettings([{ id: 'w1', mirrorPath: 'C:\\m\\w1', shellWorkspaceId: 'n-exact' }])
  const calls = []
  const registry = {
    get: (id) => { calls.push(['get', id]); return id === 'n-exact' ? { id: 'n-exact' } : undefined },
    resolveByPath: async (p) => { calls.push(['resolve', p]); return { id: 'n-path' } },
    delete: async (id) => { calls.push(['delete', id]) },
  }
  const L = loadLifecycle()(s.face, registry, async () => {}, quietCtx)
  await L.cleanupWorkspace({ id: 'w1', mirrorPath: 'C:\\m\\w1', shellWorkspaceId: 'n-exact' })
  check(calls.some((c) => c[0] === 'get' && c[1] === 'n-exact'), '按 shellWorkspaceId 精确取实体')
  check(!calls.some((c) => c[0] === 'resolve'), '精确命中就不再多反查一次（省 IPC）')
  check(calls.some((c) => c[0] === 'delete' && c[1] === 'n-exact'), '删的是自己的原生 id')

  // id 失效 → 路径兜底
  const s2 = fakeSettings([{ id: 'w1', mirrorPath: 'C:\\m\\w1', shellWorkspaceId: 'stale' }])
  const calls2 = []
  const registry2 = {
    get: () => undefined,
    resolveByPath: async () => ({ id: 'n-live' }),
    delete: async (id) => { calls2.push(id) },
  }
  const L2 = loadLifecycle()(s2.face, registry2, async () => {}, quietCtx)
  await L2.cleanupWorkspace({ id: 'w1', mirrorPath: 'C:\\m\\w1', shellWorkspaceId: 'stale' })
  check(calls2.length === 1 && calls2[0] === 'n-live', 'id 失效 → 退回镜像路径反查后删除')
}

console.log('C · 壳层删除联动：清条目 + 清镜像目录（issue #32 第 1 条）')
{
  const s = fakeSettings([
    { id: 'w1', title: 'zfs', mirrorPath: 'C:\\m\\w1', shellWorkspaceId: 'native-1' },
    { id: 'w2', title: 'other', mirrorPath: 'C:\\m\\w2', shellWorkspaceId: 'native-2' },
  ])
  const rms = []
  const L = loadLifecycle()(s.face, { resolveByPath: async () => undefined }, async (p) => { rms.push(p) }, quietCtx)
  const n = await L.pruneWorkspaceEntriesForNativeId('native-1')
  check(n === 1, '删掉 1 条匹配条目')
  check(s.writes.length === 1 && s.writes[0].length === 1 && s.writes[0][0].id === 'w2', '只留下另一条（写回 settings）')
  check(rms.length === 1 && rms[0] === 'C:\\m\\w1', '被删条目的镜像目录一并 rm')

  // 老记录没有 shellWorkspaceId → 按镜像路径反查匹配
  const s2 = fakeSettings([{ id: 'w9', mirrorPath: 'C:\\m\\w9' }])
  const L2 = loadLifecycle()(s2.face, { resolveByPath: async (p) => (p.endsWith('w9') ? { id: 'native-9' } : null) }, async () => {}, quietCtx)
  check(await L2.pruneWorkspaceEntriesForNativeId('native-9') === 1, '无 id 的老记录也能靠镜像路径反查命中')

  // 不匹配 → 不写盘
  const s3 = fakeSettings([{ id: 'w1', mirrorPath: 'C:\\m\\w1', shellWorkspaceId: 'native-1' }])
  const L3 = loadLifecycle()(s3.face, { resolveByPath: async () => undefined }, async () => {}, quietCtx)
  check(await L3.pruneWorkspaceEntriesForNativeId('native-other') === 0, '不匹配 → 0 条')
  check(s3.writes.length === 0, '不匹配 → 不写盘')
  check(await L3.pruneWorkspaceEntriesForNativeId('') === 0, '空 id → 直接返回（绝不拿空串匹配）')
}

console.log('D · 挂钩子：workspaceRegistry.delete 包一层，只包一次，原实现仍被调用')
{
  const s = fakeSettings([{ id: 'w1', mirrorPath: 'C:\\m\\w1', shellWorkspaceId: 'native-1' }])
  const registry = {}
  registry.delete = async (id) => { registry.deleted = (registry.deleted || []).concat([id]); return true }
  const L = loadLifecycle()(s.face, registry, async () => {}, quietCtx)
  L.installNativeDeleteSync()
  const patched = registry.delete
  check(typeof registry.delete === 'function' && registry.__dshRemoteSshDeleteSync === true, '钩子装上并打了幂等标记')
  check(await patched('native-1') === true, '返回值沿用原实现的返回值')
  check(registry.deleted.length === 1 && registry.deleted[0] === 'native-1', '原 delete 真的被调用了（删除仍然生效）')
  check(s.state.workspaces.length === 0, '删除后配置里的对应条目已消失（不需要用户再去设置里手动删）')

  L.installNativeDeleteSync()
  check(registry.delete === patched, '重复安装不叠加（只包一层）')

  // 服务对象不可写 → 静默放弃，不抛错
  const frozen = Object.freeze({ delete: async () => true })
  const L2 = loadLifecycle()(fakeSettings([]).face, frozen, async () => {}, quietCtx)
  let threw = false
  try { L2.installNativeDeleteSync() } catch (e) { threw = true }
  check(!threw, '服务不可写时静默放弃（不影响插件其它能力）')
}

console.log('E · 建区去重：同一「连接 + 远程路径」接管旧条目，不再新增（issue #32 第 2 条）')
{
  const settings = fakeSettings([
    {
      id: 'w1', profileId: 'p1', title: 'proj', remotePath: '~/proj', mirrorPath: 'C:\\mirrors\\w1',
      shellWorkspaceId: '', syncPaths: ['.dsh'], syncExclude: [], syncMaxBytes: 0,
      writeBack: true, writeBackExclude: ['keep-me'],
    },
  ])
  const nativeCalls = []
  const registry = {
    create: async (dir, title) => { nativeCalls.push([dir, title]); return { id: 'native-new', title, setTitle: async (t) => { nativeCalls.push(['setTitle', t]) } } },
  }
  const mkdirCalls = []
  const writeCalls = []
  const create = loadCreate()(
    () => ({ id: 'p1', name: 'conn' }),
    settings.face,
    registry,
    async (d) => { mkdirCalls.push(d) },
    async (p) => { writeCalls.push(p) },
    joinPath,
    () => 'C:\\mirrors',
    () => 'readme',
    (v) => (Array.isArray(v) ? v : []),
    () => 0,
  )
  const r = await create({ profileId: 'p1', remotePath: '~/proj' })
  check(r.ok === true && r.reused === true, '返回 reused:true（客户端无感，但设置里不会再出现第二条）')
  check(settings.state.workspaces.length === 1, '列表仍然只有 1 条（这就是「重复条目」的根治点）')
  check(r.workspace.id === 'w1', '接管的是原条目 id（不换 id，前端选中状态不乱）')
  check(r.workspace.shellWorkspaceId === 'native-new', '原生 id 更新为新注册的那一个（角标才对得上行）')
  check(r.workspace.mirrorPath === 'C:\\mirrors\\w1', '沿用原镜像目录（里面的本地改动不丢）')
  check(JSON.stringify(r.workspace.writeBackExclude) === JSON.stringify(['keep-me']), '护栏/排除项沿用旧记录，不被重置')
  check(JSON.stringify(r.workspace.syncPaths) === JSON.stringify(['.dsh']), '同步范围沿用旧记录')
  check(writeCalls.length === 2, '镜像目录里仍然补写 README + .remote-ssh.json')

  // 不同远程路径 → 正常新建
  const r2 = await create({ profileId: 'p1', remotePath: '~/other' })
  check(r2.ok === true && r2.reused === false, '不同远程路径 → reused:false')
  check(settings.state.workspaces.length === 2, '不同路径正常新增一条')
  check(r2.workspace.id !== 'w1', '新条目用新 id')
}

console.log('F · 源码接线')
{
  check(/installNativeDeleteSync\(\);/.test(src), '插件加载时真的安装了删除联动')
  check(/workspaceRegistry\.__dshRemoteSshDeleteSync/.test(src), '安装是幂等的（有标记）')
  check(/pruneWorkspaceEntriesForNativeId\(id\)/.test(src), '钩子里调用的是按原生 id 清条目')
  check(/if \(sharingEntryOf\(ws, list\)\) return;/ .test(src) || /sharingEntryOf\(ws, list\)\) return/.test(src),
    'cleanupWorkspace 先过共用保护')
  check(/if \(ws && !sharingEntryOf\(ws, workspaces\)\) await cleanupWorkspace\(ws\)/.test(src),
    'deleteWorkspace 在摘掉本条后判共用，再决定动不动原生工作区')
  check(/const existing = prefsNow\.workspaces\.find\(\(w\) => w && w\.profileId === a\.profileId/.test(src),
    'createRemoteWorkspace 先找同连接同路径的旧条目')
  check(/reused: !!existing/.test(src), '返回值带 reused 标记（便于客户端/日志区分）')
  // 自检位：重启后不走 UI 也能确认钩子挂上了（getPrefs 里回 deleteSync）
  check(/deleteSync: !!\(workspaceRegistry && workspaceRegistry\.__dshRemoteSshDeleteSync\)/.test(src),
    'getPrefs 回 deleteSync 自检位（排查用：钩子到底挂没挂上）')
  check(/ctx\.logger\?\.info\?\.\("\[dsh-remote-ssh\] 已挂接原生工作区删除联动/.test(src),
    '挂接成功时记一条 info 日志（失败时是 warn）')
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
