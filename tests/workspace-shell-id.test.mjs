// 远程工作区「原生工作区 id」持久化与回填（issue #31）。
//
// 客户端半边靠 `data-row-key="workspace:<原生 id>"` 精确认行，才不会再按标题文本把
// **同名本地项目**误标成远程工作区。所以宿主侧必须：
//   A. 建工作区时把 workspaceRegistry 返回的原生 id 落盘（shellWorkspaceId）
//   B. 老记录（没有该字段）在 listWorkspaces 时按镜像路径反查回填一次并持久化
//   C. 上述动作必须幂等、失败不炸（反查抛错/缺 registry 都不能影响列表可用性）
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const src = readFileSync(join(root, 'lib/index.js'), 'utf8')

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

function loadReconcile() {
  const factory = new Function('workspaceRegistry', 'settingsFace',
    grab('async function reconcileShellWorkspaceIds') + '\nreturn reconcileShellWorkspaceIds;')
  return factory
}

/** 造一个假 settingsFace：read() 返回给定工作区数组，updateWorkspaces 记录下来。 */
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

let pass = 0, fail = 0
const check = (cond, label) => { if (cond) { pass++; console.log('  ✓ ' + label) } else { fail++; console.log('  ✗ FAIL: ' + label) } }

console.log('A · 回填：老记录按镜像路径反查原生 id 并落盘')
{
  const { face, writes } = fakeSettings([
    { id: 'w1', title: 'my-project', remotePath: '~/proj/my-project', mirrorPath: 'C:\\mirrors\\w1' },
  ])
  const calls = []
  const registry = {
    resolveByPath: async (p) => { calls.push(p); return p.endsWith('w1') ? { id: 'native-ws-1' } : null },
  }
  const reconcile = loadReconcile()(registry, face)
  const list = await reconcile()
  check(list.length === 1 && list[0].shellWorkspaceId === 'native-ws-1', '缺字段的记录被回填成原生 id')
  check(calls.length === 1 && calls[0] === 'C:\\mirrors\\w1', '反查用的是 mirrorPath（不是标题、不是 remotePath）')
  check(writes.length === 1 && writes[0][0].shellWorkspaceId === 'native-ws-1', '结果被持久化（落在 settings 里，重启后仍在）')
}

console.log('B · 常数开销：已回填的仍校验一次，但结果一致时不写盘')
{
  const { face, writes } = fakeSettings([
    { id: 'w1', title: 'p', remotePath: '~/p', mirrorPath: 'C:\\mirrors\\w1', shellWorkspaceId: 'native-ws-1' },
  ])
  let calls = 0
  const registry = { resolveByPath: async () => { calls += 1; return { id: 'native-ws-1' } } }
  const reconcile = loadReconcile()(registry, face)
  const list = await reconcile()
  check(calls === 1, '每次列表都核对一次（内存反查，不落盘；换来的是 id 永不过期）')
  check(writes.length === 0, '结果与记录一致 → 不写盘（不会每 30s 抖一次 settings）')
  check(list[0].shellWorkspaceId === 'native-ws-1', '已有值保持不变')
}

console.log('B2 · 漂移自愈：原生 id 变了 / 原生工作区没了（issue #31 后续，真机暴露）')
{
  // 场景一：原生工作区被重建 → id 变了，必须跟上，否则永远对不上行
  const s1 = fakeSettings([
    { id: 'w1', title: 'zfs', remotePath: '~/run/zfs', mirrorPath: 'C:\\mirrors\\w1', shellWorkspaceId: 'old-id' },
  ])
  const r1 = loadReconcile()({ resolveByPath: async () => ({ id: 'new-id' }) }, s1.face)
  const l1 = await r1()
  check(l1[0].shellWorkspaceId === 'new-id', 'id 变了 → 跟上真实 id（不然角标永远不出现）')
  check(s1.writes.length === 1 && s1.writes[0][0].shellWorkspaceId === 'new-id', '修正被持久化')
  check(s1.state.workspaces[0].shellWorkspaceId === 'new-id', '内存里的 settings 也已更新（同一轮即可生效）')

  // 场景二：应用重启后原生注册丢了（真机踩到的就是这条）
  const s2 = fakeSettings([
    { id: 'w1', title: 'zfs', remotePath: '~/run/zfs', mirrorPath: 'C:\\mirrors\\w1', shellWorkspaceId: 'vanished-id' },
  ])
  const r2 = loadReconcile()({ resolveByPath: async () => undefined }, s2.face)
  const l2 = await r2()
  check(l2[0].shellWorkspaceId === '', '原生工作区不存在 → 清空（拿不存在的 id 去猜行只会白等）')
  check(s2.writes.length === 1, '清空也被持久化')

  // 场景三：反查抛错 → 保持原值，不能因为一次异常把好 id 清掉
  const s3 = fakeSettings([
    { id: 'w1', title: 'zfs', remotePath: '~/run/zfs', mirrorPath: 'C:\\mirrors\\w1', shellWorkspaceId: 'good-id' },
  ])
  const r3 = loadReconcile()({ resolveByPath: async () => { throw new Error('registry busy') } }, s3.face)
  const l3 = await r3()
  check(l3[0].shellWorkspaceId === 'good-id', '反查异常 → 保持原值（不误清）')
  check(s3.writes.length === 0, '异常时不写盘')
}

console.log('C · 反查失败/查不到：保持空值、不炸、不写盘')
{
  const { face, writes } = fakeSettings([
    { id: 'w1', title: 'p', remotePath: '~/p', mirrorPath: 'C:\\mirrors\\w1' },
    { id: 'w2', title: 'q', remotePath: '~/q', mirrorPath: 'C:\\mirrors\\w2' },
  ])
  let n = 0
  const registry = {
    resolveByPath: async () => { n += 1; if (n === 1) throw new Error('registry down'); return null },
  }
  const reconcile = loadReconcile()(registry, face)
  const list = await reconcile()
  check(list.length === 2, '两个工作区都还在（列表可用性不受影响）')
  check(!list[0].shellWorkspaceId && !list[1].shellWorkspaceId, '查不到就留空 → 客户端自动退回标题匹配')
  check(writes.length === 0, '没有新值就不写盘')
  check(n === 2, '两条都尝试过（一条抛错不影响另一条）')
}

console.log('D · 缺 workspaceRegistry / 缺 mirrorPath')
{
  const { face, writes } = fakeSettings([{ id: 'w1', title: 'p', remotePath: '~/p', mirrorPath: 'C:\\mirrors\\w1' }])
  const reconcile = loadReconcile()(undefined, face)
  const list = await reconcile()
  check(list.length === 1 && !list[0].shellWorkspaceId, '无 registry → 原样返回（不抛错）')
  check(writes.length === 0, '无 registry → 不写盘')

  const s2 = fakeSettings([{ id: 'w1', title: 'p', remotePath: '~/p', mirrorPath: '' }])
  let calls = 0
  const r2 = { resolveByPath: async () => { calls += 1; return { id: 'x' } } }
  const list2 = await loadReconcile()(r2, s2.face)()
  check(calls === 0 && !list2[0].shellWorkspaceId, '缺 mirrorPath → 跳过反查（不浪费 IPC）')
}

console.log('E · 源码接线（宿主侧三处必须同时成立）')
{
  check(/shellWorkspaceId: z\.string\(\)\.default\(""\)/.test(src), 'schema 收录 shellWorkspaceId（否则 zod strip 会把它丢掉）')
  check(/shellWorkspaceId: workspaceId \? String\(workspaceId\) : ""/.test(src), 'createRemoteWorkspace 把原生 id 一并落盘')
  check(/listWorkspaces: async \(\) => \(\{ ok: true, workspaces: await reconcileShellWorkspaceIds\(\) \}\)/.test(src),
    'listWorkspaces 先回填再返回（老用户升级后立即正确，无需重装工作区）')
  check(/await workspaceRegistry\.resolveByPath\(ws\.mirrorPath\)/.test(grab('async function reconcileShellWorkspaceIds')),
    '回填依据是镜像路径与 registry 的对应关系')
  check(!/workspaceRegistry\.resolveByPath\(ws\.title\)/.test(src), '不得用标题去反查（那正是 #31 的病根）')
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
