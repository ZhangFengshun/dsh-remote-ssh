// @ 文件引用补全（issue #10）回归测试。
//
// 分三层：
//   A. 纯逻辑：查询拆分 / 索引解析 / 评分排序 / 隐藏文件可见性 / 索引命令生成
//      —— 全部从 lib/index.js 提取**真实代码文本**执行；
//   B. 服务包装：installFileReferenceBridge + remoteRefListForAgent
//      —— 用假 service 实例 + 桩替换远程列目录，校验「远程走 SSH、本地委托原实现、异常降级」；
//   C. 真实远端输出样例（HPC 实测的 git 分支输出）喂给解析器。
import { readFileSync } from 'node:fs'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const src = readFileSync(root + '/lib/index.js', 'utf8')

// ---------- 提取真实实现 ----------
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

const moduleCode = [
  pick(/const REF_MAX_RESULTS = \d+;/),
  pick(/const REF_MAX_ENTRIES = \d+;/),
  pick(/const REF_EXCLUDED_DIRS = new Set\(\[[\s\S]*?\]\);/),
  pick(/const REF_INDEX_FIND_MAXDEPTH = \d+;/),
  pick(/const REF_INDEX_GIT_FULL_BUDGET_SEC = \d+;/),
  pick(/const REF_INDEX_GIT_CACHED_BUDGET_SEC = \d+;/),
  pick(/const REF_INDEX_FIND_BUDGET_SEC = \d+;/),
  grab('function refSplitQuery'),
  grab('function refSubsequenceScore'),
  grab('function refScoreCandidate'),
  grab('function refRankCandidates'),
  grab('function refVisibleForGlobalQuery'),
  grab('function refParseIndexOutput'),
  grab('function refExcludeRegex'),
  grab('function refIndexCommand'),
  grab('function shellQuote'),
  grab('function shellQuotePath'),
].join('\n')

const api = new Function(moduleCode + `
  return { refSplitQuery, refSubsequenceScore, refScoreCandidate, refRankCandidates, refVisibleForGlobalQuery,
           refParseIndexOutput, refIndexCommand, REF_MAX_ENTRIES, REF_EXCLUDED_DIRS, REF_MAX_RESULTS };`)()

let pass = 0, fail = 0
const check = (cond, label) => { if (cond) { pass++; console.log('  ✓ ' + label) } else { fail++; console.log('  ✗ FAIL: ' + label) } }

console.log('A1 · 查询拆分（语义对齐本地 list()）')
{
  check(JSON.stringify(api.refSplitQuery('')) === JSON.stringify({ directory: '', fragment: '', isDirectoryQuery: true }), '空查询 → 根目录列举')
  check(api.refSplitQuery('src/').directory === 'src/' && api.refSplitQuery('src/').fragment === '', '"src/" → 列 src/')
  check(api.refSplitQuery('src/ma').directory === 'src/' && api.refSplitQuery('src/ma').fragment === 'ma', '"src/ma" → 列 src/ 且过滤 ma')
  const f = api.refSplitQuery('read')
  check(f.isDirectoryQuery === false && f.fragment === 'read', '"read" → 模糊查询')
  check(api.refSplitQuery('src\\ma').directory === 'src/', '反斜杠归一化为 /')
}

console.log('A2 · 索引解析')
{
  const gitOut = ['f\tREADME.md', 'f\tbenchmarks/Cavity_RAD/README.md', 'f\tsrc/main.jl', ''].join('\n')
  const e = api.refParseIndexOutput(gitOut)
  const dirs = e.filter((x) => x.kind === 'directory').map((x) => x.path)
  const files = e.filter((x) => x.kind === 'file').map((x) => x.path)
  check(files.length === 3 && files.includes('benchmarks/Cavity_RAD/README.md'), 'git 分支：文件条目正确')
  check(dirs.includes('benchmarks') && dirs.includes('benchmarks/Cavity_RAD') && dirs.includes('src'), 'git 分支：由父路径合成目录（含多级）')
  check(new Set(dirs).size === dirs.length, '合成目录去重')

  const findOut = ['d\tsrc', 'f\tsrc/main.jl', 'l\tlink-to-something', 'd\tnode_modules', 'f\tnode_modules/x.js', 'd\tdist'].join('\n')
  const e2 = api.refParseIndexOutput(findOut)
  check(e2.some((x) => x.path === 'src' && x.kind === 'directory'), 'find 分支：目录条目保留')
  check(!e2.some((x) => x.path.startsWith('node_modules')), '排除目录（node_modules）被剪掉')
  check(!e2.some((x) => x.path === 'dist'), '排除目录（dist，与上游表一致）被剪掉')
  check(!e2.some((x) => x.path === 'link-to-something'), '符号链接（l）跳过（与本地只收 isFile/isDirectory 一致）')
  check(api.refParseIndexOutput('f\twin/path.md\r\n'.replace(/\r\n$/, '\r')).every((x) => !String(x.path).includes('\r')), 'CRLF 容错')

  const big = Array.from({ length: api.REF_MAX_ENTRIES + 50 }, (_, i) => 'f\tf' + i).join('\n')
  check(api.refParseIndexOutput(big).length <= api.REF_MAX_ENTRIES, `条目上限生效（≤ ${api.REF_MAX_ENTRIES}）`)
}

console.log('A3 · 评分与排序（逐字对齐上游 scoreCandidate/rankCandidates）')
{
  const cands = [
    { path: 'src/reader.jl', kind: 'file' },
    { path: 'readme.md', kind: 'file' },
    { path: 'docs/read.md', kind: 'file' },
    { path: 'read', kind: 'directory' },
    { path: 'x/y/read_me.md', kind: 'file' },
  ]
  const r = api.refRankCandidates(cands, 'read', 20)
  check(r[0].path === 'read' && r[0].kind === 'directory', '完全同名优先且目录加权（1000+25）')
  check(r[1].path === 'readme.md', '前缀命中次之（900）')
  check(r.some((x) => x.path === 'src/reader.jl'), '路径子串命中（500）也进入结果')
  check(api.refRankCandidates(cands, 'read', 2).length === 2, 'limit 生效')
  check(api.refScoreCandidate({ path: 'a/b/c', kind: 'file' }, 'abc') === 398, '子序列命中：gap=2 → 300+98（与上游公式一致）')
  check(api.refSubsequenceScore('abc', 'abc') === 100, '子序列完全相邻：gap=0 → 100')
  check(api.refSubsequenceScore('a/b/c', 'abc') === 98, '子序列间隔惩罚：每次跳格 -1')
  check(api.refScoreCandidate({ path: 'docs', kind: 'directory' }, 'doc') === 925, '目录加权 +25（前缀 900+25）')
  check(api.refScoreCandidate({ path: 'a/b/c', kind: 'file' }, 'zzz') === undefined, '不匹配返回 undefined')

  const same = [
    { path: 'bb/aa.md', kind: 'file' },
    { path: 'aa.md', kind: 'file' },
  ]
  check(api.refRankCandidates(same, 'aa', 5)[0].path === 'aa.md', '同分时路径短优先')
  const kinds = [
    { path: 'foo', kind: 'file' },
    { path: 'bar', kind: 'directory' },
  ]
  check(api.refRankCandidates(kinds, '', 5)[0].path === 'bar', '空查询：目录优先（kindRank）')
}

console.log('A4 · 隐藏文件可见性')
{
  check(api.refVisibleForGlobalQuery('src/main.jl', 'main') === true, '普通路径可见')
  check(api.refVisibleForGlobalQuery('.gitignore', 'git') === false, '点开头路径对裸查询不可见')
  check(api.refVisibleForGlobalQuery('.gitignore', '.git') === true, '查询以 . 开头时可见')
  check(api.refVisibleForGlobalQuery('src/.env', '.env') === true, '查询含 /. 时可见')
}

console.log('A5 · 索引命令生成')
{
  const cmd = api.refIndexCommand('~/work/my-project')
  check(cmd.includes("cd ~/'work/my-project'") || cmd.includes('cd ~/'), 'cd 使用 shellQuotePath（~ 保持未引号）')
  check(/git ls-files --cached --others --exclude-standard/.test(cmd), 'git 仓库优先走 git ls-files（含未跟踪、尊重 .gitignore）')
  check(/command -v timeout/.test(cmd), 'git 那一步有墙钟预算（大仓库上 --others 会跑不完）')
  check(/git ls-files --cached 2>\/dev\/null/.test(cmd), '完整 git 为空时回退到仅索引 git（恒定快）')
  check(/find \. -mindepth 1 -maxdepth 3/.test(cmd), '索引回退到有界 find（maxdepth 3 —— 原 5 在巨型目录上跑不完）')
  check(cmd.includes("head -n " + (api.REF_MAX_ENTRIES + 1)), '三条路径都有条数上限')
  check(/T=.*command -v timeout/.test(cmd) && /"\$T" \d+ find/.test(cmd), 'find 回退也有墙钟预算（timeout/gtimeout 探测 + 回退分支）')
  check(cmd.includes("-printf '%y\\t%P\\n'"), 'find 输出 类型+相对路径 帧（\\t/\\n 为字面转义，由远端 find 解释）')
  for (const d of api.REF_EXCLUDED_DIRS) check(cmd.includes("-name '" + d + "'"), `排除目录 ${d} 进入剪枝表达式`)
}

console.log('B · 服务包装（远程走 SSH / 本地委托 / 异常降级）')
{
  const wrapperCode = [
    grab('async function remoteRefListForAgent'),
    grab('function installFileReferenceBridge'),
  ].join('\n')

  // 桩：remoteRefList / readRemoteInfoSync / getProfile
  const mk = (opts) => {
    const calls = { original: 0, remote: 0 }
    const f = new Function('stub', wrapperCode + `
      const remoteRefList = stub.remoteRefList;
      const readRemoteInfoSync = stub.readRemoteInfoSync;
      const getProfile = stub.getProfile;
      return { remoteRefListForAgent, installFileReferenceBridge };`)
    const mod = f({
      remoteRefList: async (profile, root, query) => { calls.remote++; if (opts.remoteThrows) throw new Error('ssh down'); return opts.remoteResult || [] },
      readRemoteInfoSync: (cwd) => (opts.remote ? { profileId: 'p1', host: 'h', user: 'u', keyPath: 'k', remotePath: '~/work/my-project' } : null),
      getProfile: (id) => (id === 'p1' ? { id: 'p1', host: 'h', user: 'u' } : undefined),
    })
    return { mod, calls }
  }
  const svc = (result) => {
    const o = { calls: 0 }
    return { list: async () => { o.calls++; return result }, _o: o }
  }

  {
    const { mod, calls } = mk({ remote: true, remoteResult: [{ path: 'src/main.jl', kind: 'file' }] })
    const s = svc([{ path: 'README.md', kind: 'file' }])
    const restore = mod.installFileReferenceBridge({ get: () => s })
    const out = await s.list({ session: { header: { cwd: '/mirror/wmirror2' } } }, 'main', { aborted: false })
    check(calls.remote === 1 && s._o.calls === 0, '远程会话：走远端实现，未调用原实现')
    check(out.length === 1 && out[0].path === 'src/main.jl', '返回远端候选')
    restore()
    check(typeof s.list === 'function', '恢复函数可用（还原后仍是函数）')
    const after = await s.list({ session: { header: { cwd: '/mirror/x' } } }, 'q', { aborted: false })
    check(s._o.calls === 1 && after.length === 1 && after[0].path === 'README.md', '恢复后回到原实现（本地语义不受影响）')
    check(restore !== null, '安装成功返回恢复函数')
  }
  {
    const { mod } = mk({ remote: false })
    const s = svc([{ path: 'local.txt', kind: 'file' }])
    const restore = mod.installFileReferenceBridge({ get: () => s })
    const out = await s.list({ session: { header: { cwd: '/local/proj' } } }, 'loc', { aborted: false })
    check(s._o.calls === 1 && out[0].path === 'local.txt', '本地会话：委托原实现（零改动）')
    restore()
  }
  {
    const { mod } = mk({ remote: true, remoteThrows: true })
    const s = svc([{ path: 'mirror-fallback.md', kind: 'file' }])
    mod.installFileReferenceBridge({ get: () => s })
    const out = await s.list({ session: { header: { cwd: '/mirror/x' } } }, 'q', { aborted: false })
    check(s._o.calls === 1 && out[0].path === 'mirror-fallback.md', '远端异常 → 降级委托原实现（不抛错、补全不失效）')
  }
  {
    const { mod } = mk({ remote: false })
    const s = svc([])
    mod.installFileReferenceBridge({ get: () => s })
    await s.list({}, 'q', { aborted: false })
    check(s._o.calls === 1, '无 session/cwd → 委托原实现')
  }
  {
    const { mod } = mk({ remote: false })
    check(mod.installFileReferenceBridge({ get: () => ({}) }) === null, '服务缺少 list 时不包装（返回 null，不抛）')
    check(mod.installFileReferenceBridge({ get: () => undefined }) === null, '服务缺失时安全返回 null')
  }
}

console.log('C · 真实远端输出样例（HPC 实测 git 分支，逐字）')
{
  const real = ['f\t.gitignore', 'f\tLocalPreferences.toml', 'f\tManifest.toml', 'f\tProject.toml', 'f\tREADME.md',
    'f\tbenchmarks/Cavity_RAD/README.md', 'f\tbenchmarks/Cavity_RAD/case_cpu.toml', 'f\tbenchmarks/Cavity_RAD/case_gpu_1.toml'].join('\n')
  const e = api.refParseIndexOutput(real)
  const top = api.refRankCandidates(e, 'cav', 20)
  check(e.some((x) => x.path === 'benchmarks/Cavity_RAD' && x.kind === 'directory'), '真实输出：合成出 benchmarks/Cavity_RAD 目录')
  check(top.some((x) => x.path.includes('Cavity')), '真实输出：模糊查询 cav 能命中 Cavity_RAD 相关条目')
  const dirQuery = api.refRankCandidates(e.filter((x) => x.path.startsWith('benchmarks/') && !x.path.slice(11).includes('/')), '')
  check(dirQuery.length > 0, '目录查询（benchmarks/ 下）能列出子项')
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
