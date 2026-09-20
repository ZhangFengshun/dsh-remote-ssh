// 远程文件名搜索的两趟策略 / 预算 / 缓存回归测试（issue #13 实测跟进）。
//
// 背景：侧栏「按文件名搜索」在真实的大型远程项目工作区一直「加载中…」——旧命令
//   `find <root> -name '*q*' -printf '%p\n' | sort | head -n 500`
// 有两个致命点：① `sort` 缓冲全部 find 输出，`head` 的提前短路失效；② 无深度/时间约束，
// 而 find 是深度优先，巨型子目录会吃光预算，连顶层文件都轮不到（实测 5 分钟无输出）。
// 实测该工作区：顶层 12 个条目、命中集中在 depth 1–3（0.02–0.42s），depth 4 起跳到 3s+。
//
// 现在：浅层趟（maxdepth 3 / 3s 预算）→ 未找满再深挖趟（maxdepth 8 / 5s）→ 合并去重排序，
// 全程无 sort、剪噪声目录、timeout 到点返回部分结果并标记 truncated，另加同 query 缓存与并发合并。
import { readFileSync } from 'node:fs'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const src = readFileSync(root + '/lib/index.js', 'utf8')

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
const pick = (re) => { const m = src.match(re); if (!m) throw new Error('missing ' + re); return m[0] }

const code = [
  pick(/const MAX_BYTES = [^;]+;/),
  pick(/const REF_EXCLUDED_DIRS = new Set\(\[[\s\S]*?\]\);/),
  pick(/const REMOTE_SEARCH_SKIP_DIRS = new Set\(\[[\s\S]*?\]\);/),
  pick(/const REF_SEARCH_MAX_MATCHES = \d+;/),
  pick(/const REF_SEARCH_SHALLOW_DEPTH = \d+;/),
  pick(/const REF_SEARCH_SHALLOW_BUDGET_SEC = \d+;/),
  pick(/const REF_SEARCH_DEEP_DEPTH = \d+;/),
  pick(/const REF_SEARCH_DEEP_BUDGET_SEC = \d+;/),
  pick(/const REF_SEARCH_TIMEOUT_MS = \d+;/),
  pick(/const REF_SEARCH_TTL_MS = \d+;/),
  pick(/const remoteSearchCache = new Map\(\);/),
  pick(/const remoteSearchInflight = new Map\(\);/),
  grab('function shellQuote'),
  grab('function shellQuotePath'),
  grab('async function remoteGlob'),
  grab('function profileKey'),
  grab('function cacheEpoch'),
  grab('function bumpCacheEpoch'),
  pick(/const cacheEpochs = new Map\(\);/),
  grab('async function remoteSearch'),
].join('\n')

const api = new Function(code + `
  return { remoteGlob, remoteSearch, remoteSearchCache, remoteSearchInflight, bumpCacheEpoch, profileKey,
           REF_SEARCH_MAX_MATCHES, REF_SEARCH_SHALLOW_DEPTH, REF_SEARCH_DEEP_DEPTH, REMOTE_SEARCH_SKIP_DIRS };`)()

let pass = 0, fail = 0
const check = (cond, label) => { if (cond) { pass++; console.log('  ✓ ' + label) } else { fail++; console.log('  ✗ FAIL: ' + label) } }

const ROOT = '~/proj'
const PROFILE = { id: 'p1', host: 'h', user: 'u' }

/** 可编排的桩 runner：按调用序返回预设结果，并记录命令。 */
function stubRunner(results) {
  const cmds = []
  let i = 0
  return {
    cmds,
    runner: async (p, cmd) => { cmds.push(cmd); const r = results[Math.min(i, results.length - 1)]; i++; return r },
  }
}
const info = (cmd) => ({
  maxdepth: (/-maxdepth (\d+)/.exec(cmd) || [])[1],
  budget: (/"\$T" (\d+) /.exec(cmd) || [])[1],
  sort: cmd.includes('| sort'),
  fmt: cmd.includes("'%P") ? '%P' : (cmd.includes("'%p") ? '%p' : '?'),
  head: (/head -n (\d+)/.exec(cmd) || [])[1],
  prune: cmd.includes('-prune'),
  guard: cmd.includes('command -v timeout'),
})

console.log('A · 命令生成（两趟）')
{
  const s = stubRunner([{ ok: true, stdout: '' }])
  await api.remoteSearch(s.runner, PROFILE, ROOT, 'solver')
  check(s.cmds.length === 2, '未找满时跑两趟（浅层 + 深挖）')
  const a = info(s.cmds[0]), b = info(s.cmds[1])
  check(a.maxdepth === String(api.REF_SEARCH_SHALLOW_DEPTH), `浅层趟 -maxdepth ${a.maxdepth}`)
  check(b.maxdepth === String(api.REF_SEARCH_DEEP_DEPTH), `深挖趟 -maxdepth ${b.maxdepth}`)
  check(a.budget === '3' && b.budget === '5', `两趟墙钟预算 ${a.budget}s / ${b.budget}s`)
  check(!a.sort && !b.sort, '两趟都不用 sort（head 才能提前短路）')
  check(a.fmt === '%P' && b.fmt === '%P', '两趟都用 %P（cwd 相对路径，matches 契约）')
  check(a.head === String(api.REF_SEARCH_MAX_MATCHES), `head -n ${a.head}（与上游 200 一致）`)
  check(a.prune && b.prune, '两趟都剪噪声目录（-prune）')
  check(a.guard && b.guard, '两趟都有 timeout/gtimeout 探测与回退分支')
  check(s.cmds[0].includes("-name '.git'") && s.cmds[0].includes("-name 'node_modules'"), '剪枝表含 .git / node_modules')
  check(s.cmds[0].includes("-name '.pnpm-store'") && s.cmds[0].includes("-name '.umi-production'"), '剪枝表含上游 SEARCH_SKIP_DIRS 的条目')
  check(s.cmds[0].includes('|| command -v gtimeout'), 'macOS 回退到 gtimeout')
}

console.log('B · 两趟合并与降级（延迟策略：有结果即返回，深挖后台预热）')
{
  api.remoteSearchCache.clear()
  const s = stubRunner([
    { ok: true, stdout: 'a.jl\nb/c.jl\n' },
    { ok: true, stdout: 'b/c.jl\nd/e/f.jl\n' },
  ])
  const r = await api.remoteSearch(s.runner, PROFILE, ROOT, 'q1')
  check(r.ok && r.files.length === 2, `浅层有结果 → 立即返回浅层 ${r.files.length} 条（不等深挖）`)
  check(JSON.stringify(r.files) === JSON.stringify(['a.jl', 'b/c.jl']), '返回内容即浅层结果（本地排序）')
  check(r.truncated === false, '未触预算 → truncated false')
  await new Promise((res) => setTimeout(res, 5))  // 等后台预热落地
  const warmed = await api.remoteSearch(s.runner, PROFILE, ROOT, 'q1')
  check(warmed.files.length === 3, `后台预热写回缓存：同一 query 再查得到合并后的 ${warmed.files.length} 条`)
  check(JSON.stringify(warmed.files) === JSON.stringify(['a.jl', 'b/c.jl', 'd/e/f.jl']), '合并结果去重且排序')

  api.remoteSearchCache.clear()
  const empty = stubRunner([
    { ok: true, stdout: '' },
    { ok: true, stdout: 'deep/only.jl\n' },
  ])
  const re = await api.remoteSearch(empty.runner, PROFILE, ROOT, 'q-empty')
  check(re.files.length === 1 && re.files[0] === 'deep/only.jl', '浅层零命中 → 同步等深挖（用户此时没别的可看）')
  check(empty.cmds.length === 2, '零命中时两趟都在响应前完成')

  api.remoteSearchCache.clear()
  const full = stubRunner([{ ok: true, stdout: Array.from({ length: api.REF_SEARCH_MAX_MATCHES }, (_, i) => 'f' + i).join('\n') }])
  const rf = await api.remoteSearch(full.runner, PROFILE, ROOT, 'q2')
  check(full.cmds.length === 1, `浅层已满 ${api.REF_SEARCH_MAX_MATCHES} 条 → 不深挖也不预热（无法再展示更多）`)
  check(rf.truncated === true, '满额 → truncated true')

  api.remoteSearchCache.clear()
  const budget = stubRunner([
    { ok: false, exitCode: 124, stdout: 'p.jl\n' },     // 浅层被预算杀掉，但有部分输出
    { ok: false, exitCode: 124, stdout: 'q/r.jl\n' },   // 后台预热同样
  ])
  const rb = await api.remoteSearch(budget.runner, PROFILE, ROOT, 'q3')
  check(rb.ok && rb.files.length === 1, '预算到点：立即返回已收集的部分结果（不再无限加载）')
  check(rb.truncated === true, '部分结果标记 truncated（客户端可提示不完整）')

  api.remoteSearchCache.clear()
  const dead = stubRunner([{ ok: false, exitCode: 1, stdout: '', error: 'ssh down' }])
  const rd = await api.remoteSearch(dead.runner, PROFILE, ROOT, 'q4')
  check(rd.ok === false && rd.files.length === 0, '硬失败且无输出 → ok:false（不缓存）')
  const deadKey = api.profileKey(PROFILE) + '|' + ROOT + '|q4'
  check(!api.remoteSearchCache.has(deadKey), '失败结果不进缓存（按 key 判定，避免后台预热干扰）')

  api.remoteSearchCache.clear()
  const half = stubRunner([
    { ok: false, exitCode: 1, stdout: '', error: 'boom' },
    { ok: true, stdout: 'deep/only.jl\n' },
  ])
  const rh = await api.remoteSearch(half.runner, PROFILE, ROOT, 'q5')
  check(rh.ok === false && rh.files.length === 0, '浅层硬失败（无任何输出）→ ok:false')
  check(half.cmds.length === 1, '硬失败不再深挖（连接已坏，省一趟往返；预算到点带部分输出时才继续）')
}

console.log('C · 缓存与并发合并')
{
  api.remoteSearchCache.clear()
  const s = stubRunner([{ ok: true, stdout: 'x.jl\n' }, { ok: true, stdout: '' }])
  const r1 = await api.remoteSearch(s.runner, PROFILE, ROOT, 'same')
  const callsAfterFirst = s.cmds.length
  const r2 = await api.remoteSearch(s.runner, PROFILE, ROOT, 'same')
  check(s.cmds.length === callsAfterFirst, '相同 query 30s 内直接命中缓存（不再发起 SSH）')
  check(JSON.stringify(r1.files) === JSON.stringify(r2.files), '缓存结果一致')

  api.bumpCacheEpoch(PROFILE)
  await api.remoteSearch(s.runner, PROFILE, ROOT, 'same')
  check(s.cmds.length > callsAfterFirst, 'epoch 变更（写/exec 后）→ 缓存失效并重新遍历')

  api.remoteSearchCache.clear()
  const conc = stubRunner([{ ok: true, stdout: 'a\n' }, { ok: true, stdout: '' }])
  const [c1, c2, c3] = await Promise.all([
    api.remoteSearch(conc.runner, PROFILE, ROOT, 'race'),
    api.remoteSearch(conc.runner, PROFILE, ROOT, 'race'),
    api.remoteSearch(conc.runner, PROFILE, ROOT, 'race'),
  ])
  check(conc.cmds.length === 2, `三个并发同 query 只跑一趟遍历（实际 ${conc.cmds.length} 次命令 = 浅层+深挖）`)
  check(c1.files.length === 1 && c2.files.length === 1 && c3.files.length === 1, '并发调用都拿到同一结果')
  check(api.remoteSearchInflight.size === 0, 'in-flight 表已清理（无泄漏）')
}

console.log('D · 接线')
{
  const branch = src.slice(src.indexOf('} else if (method === "fs.search") {'), src.indexOf('} else if (method === "fs.rename") {'))
  check(/await remoteSearch\(runPooled, profile, rp, payload\.query \|\| ""\)/.test(branch), 'fs.search 远程分支改走 remoteSearch（两趟 + 缓存）')
  check(!/remoteGlob\(runPooled, profile, "\*"/.test(branch), '不再直接调用 remoteGlob（避免无预算的单趟遍历）')
  check(/fsSearchResult\(matches/.test(branch), '仍经 fsSearchResult 产出 matches 契约（issue #13 主修复不回退）')
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
