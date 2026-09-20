// 索引截断顺序回归测试（issue #10 实测反馈）。
//
// 核心事实（本测试锁定）：`git ls-files --cached --others` 的输出**不是全局字典序** ——
// 未跟踪文件先按 readdir 顺序输出，`node_modules/` 这类目录可能占满前 N 行，把 `head`
// 的配额吃光，导致 `AGENTS.md`、`src/**` 等真实文件被整段切掉。
// 因此排除必须发生在 `head` **之前**（远端 grep -vE），而不是数据到本地之后。
//
// 三层：
//   A. 命令结构断言（grep 必须在 head 之前、正则来自单一事实来源、完整路径段匹配）
//   B. **真实端到端**：临时 git 仓库（已跟踪 AGENTS.md/src + 未跟踪大量 node_modules）
//      → 用真实代码生成的命令跑真实管道 → 断言旧行为会切掉、新行为不会
//   C. 解析器双保险（客户端 excludedSegment 仍生效）
import { readFileSync, writeFileSync, mkdirSync, rmSync, mkdtempSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 可用的 POSIX shell（优先 Git for Windows 自带 bash；WSL 的 bash 视图不同，跳过）。 */
function findPosixShell() {
  if (process.platform !== 'win32') return existsSync('/bin/bash') ? '/bin/bash' : undefined
  const candidates = [
    process.env.DSH_TEST_BASH,
    'E:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'E:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
  ].filter(Boolean)
  return candidates.find((p) => existsSync(p))
}

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

const api = new Function([
  pick(/const REF_MAX_RESULTS = \d+;/),
  pick(/const REF_MAX_ENTRIES = \d+;/),
  pick(/const REF_INDEX_FIND_MAXDEPTH = \d+;/),
  pick(/const REF_INDEX_GIT_FULL_BUDGET_SEC = \d+;/),
  pick(/const REF_INDEX_GIT_CACHED_BUDGET_SEC = \d+;/),
  pick(/const REF_INDEX_FIND_BUDGET_SEC = \d+;/),
  pick(/const REF_INDEX_BUILD_TIMEOUT_MS = \d+;/),
  pick(/const REF_EXCLUDED_DIRS = new Set\(\[[\s\S]*?\]\);/),
  grab('function refExcludeRegex'),
  grab('function refIndexCommand'),
  grab('function refParseIndexOutput'),
  grab('function shellQuote'),
  grab('function shellQuotePath'),
].join('\n') + '\nreturn { refIndexCommand, refExcludeRegex, refParseIndexOutput, REF_MAX_ENTRIES, REF_EXCLUDED_DIRS };')()

let pass = 0, fail = 0
const check = (cond, label) => { if (cond) { pass++; console.log('  ✓ ' + label) } else { fail++; console.log('  ✗ FAIL: ' + label) } }

console.log('A · 命令结构（排除必须在 head 之前）')
{
  const cmd = api.refIndexCommand('~/proj')
  const gitLine = cmd.split('\n').find((l) => l.includes('git ls-files'))
  const iGrep = gitLine.indexOf('grep -vE')
  const iHead = gitLine.indexOf('head -n')
  // sed 已移到输出行（printf '%s\n' "$G" | sed 's/^/f\t/'），故只在 git 行内校验「排除在截断之前」
  check(iGrep > 0 && iHead > 0 && iGrep < iHead, 'git 分支：grep -vE 在 head 之前（先排除后截断）')
  check(cmd.split('\n').some((l) => l.includes("| sed 's/^/f\t/'")), 'git 结果由 printf|sed 加帧输出')
  const re = api.refExcludeRegex()
  check(re === "(^|/)(\\.git|node_modules|dist|build|out|coverage|target|\\.next|\\.nuxt|\\.turbo|\\.venv|__pycache__|\\.pytest_cache|\\.mypy_cache|\\.gradle)(/|$)", '排除正则由 REF_EXCLUDED_DIRS 生成（单一事实来源）')
  for (const d of api.REF_EXCLUDED_DIRS) check(re.includes(d.replace(/\./g, '\\.')), `正则包含 ${d}`)
  check(new RegExp(re).test('node_modules/x.js') && new RegExp(re).test('a/node_modules/b'), '匹配任意层级的排除目录')
  check(!new RegExp(re).test('distribution/x.js'), '不误伤前缀相同的普通目录（distribution）')
  check(!new RegExp(re).test('src/node_modules_helper.js'), '不误伤名字前缀相同的文件')
  const findLine = cmd.split('\n').find((l) => l.includes('find .'))
  check(findLine.includes('-prune') && findLine.indexOf('-prune') < findLine.indexOf('head -n'), 'find 分支同样先剪枝后截断')
}

console.log('B · 真实端到端（临时 git 仓库 + 真实管道）')
{
  const shell = findPosixShell()
  if (!shell) {
    console.log('  ⚠ 未找到 POSIX shell（Git for Windows bash / /bin/bash），跳过端到端段（其余断言仍有效）')
  } else {
  const dir = mkdtempSync(join(tmpdir(), 'rssh-idx-'))
  const git = (args, opts) => execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...opts })
  try {
    git(['init', '-q'])
    git(['config', 'user.email', 't@t'])
    git(['config', 'user.name', 't'])
    // 已跟踪：AGENTS.md + src/**
    writeFileSync(join(dir, 'AGENTS.md'), 'x')
    mkdirSync(join(dir, 'src'))
    for (let i = 0; i < 40; i++) writeFileSync(join(dir, 'src', `m${i}.jl`), 'x')
    git(['add', '-A'])
    git(['commit', '-qm', 'init'])
    // 未跟踪：大量 node_modules（不写 .gitignore，模拟报告者的仓库）
    for (let i = 0; i < 400; i++) {
      const d = join(dir, 'node_modules', `pkg${i}`)
      mkdirSync(d, { recursive: true })
      writeFileSync(join(d, 'index.js'), 'x')
    }

    const all = git(['ls-files', '--cached', '--others', '--exclude-standard']).split('\n').filter(Boolean)
    const agentsLine = all.indexOf('AGENTS.md') + 1
    check(all[0].startsWith('node_modules/'), '真实输出：未跟踪的 node_modules 排在最前（非全局字典序）')
    check(agentsLine > all.length * 0.5, `真实输出：AGENTS.md 落到第 ${agentsLine}/${all.length} 行（字典序假设不成立）`)

    // 用**真实代码生成**的命令，但把上限压到 200 以便在夹具规模下复现截断
    const realCmd = api.refIndexCommand(dir)
    const withCap = (cap) => realCmd.replace(/head -n \d+/g, 'head -n ' + cap)
    const oldCmd = withCap(200).replace(" | grep -vE '" + api.refExcludeRegex() + "'", '') // 旧行为：无 grep
    const runSh = (script) => execFileSync(shell, ['-c', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    const oldOut = runSh(oldCmd).split('\n').filter((l) => l.includes('\t'))
    const newOut = runSh(withCap(200)).split('\n').filter((l) => l.includes('\t'))
    const hasAgents = (lines) => lines.some((l) => l.endsWith('\tAGENTS.md'))
    const srcCount = (lines) => lines.filter((l) => /\tsrc\//.test(l)).length
    const nmCount = (lines) => lines.filter((l) => /\tnode_modules\//.test(l)).length

    check(!hasAgents(oldOut) && nmCount(oldOut) > 0, `旧行为（先截断）：AGENTS.md 被切掉，前 ${oldOut.length} 行几乎全是 node_modules（${nmCount(oldOut)} 条）`)
    check(hasAgents(newOut), '新行为（先排除）：AGENTS.md 存活')
    check(srcCount(newOut) === 40, `新行为：src/ 全部 ${srcCount(newOut)} 条保留`)
    check(nmCount(newOut) === 0, '新行为：node_modules 零残留')
    check(newOut.length < oldOut.length, `新行为输出更小（${newOut.length} < ${oldOut.length} 行）`)

    // 解析器仍能吃下新输出，且客户端排除作为双保险
    const parsed = api.refParseIndexOutput(newOut.join('\n'))
    check(parsed.some((x) => x.path === 'AGENTS.md' && x.kind === 'file'), '解析器：AGENTS.md 进入索引')
    check(parsed.some((x) => x.path === 'src' && x.kind === 'directory'), '解析器：合成出 src 目录')
    check(!parsed.some((x) => x.path.startsWith('node_modules')), '解析器：node_modules 不在索引中')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  }
}

console.log('C · 解析器双保险（客户端排除仍生效）')
{
  const e = api.refParseIndexOutput(['f\tnode_modules/a.js', 'f\tsrc/b.js', 'f\tdist/c.js', 'f\tAGENTS.md'].join('\n'))
  check(!e.some((x) => x.path.startsWith('node_modules')) && !e.some((x) => x.path === 'dist'), '即便远端漏掉排除，客户端也会过滤')
  check(e.some((x) => x.path === 'AGENTS.md'), '真实文件不受影响')
}

console.log('D · 截断告警接线（建议 1）')
{
  check(/rawLines > REF_MAX_ENTRIES/.test(src), '按上限 +1 行取样并检测截断')
  check(/refTruncationWarned\.add\(key\)/.test(src), '每个 workspace 只告警一次（避免刷日志）')
  check(/文件引用索引已达上限/.test(src) && /@ 补全可能漏掉部分文件/.test(src), '告警文案说明影响与缓解方式')
  check(/const refTruncationWarned = new Set\(\)/.test(src), '告警状态集合已声明')
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
