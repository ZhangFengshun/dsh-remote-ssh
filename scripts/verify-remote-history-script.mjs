#!/usr/bin/env node
/**
 * 远端 git.history 脚本的真 sh + 真 git 独立验证（随 2.4.42 引入，长期可复跑）。
 *
 * 为什么需要它：`tests/sidebar-0282-history.test.mjs` 把 SSH 出口整个换成了伪造出口
 * （`remoteScripts[i]` 直接喂字符串），historyRemoteIo 生成的**那段 sh 本身**的 POSIX 正确性
 * 没有被覆盖 —— 而 0.28.2 这个端点恰好在远端分支里做了些"假出口看不出来"的事：
 *   · 用 `@@DSH_GH@@` 标记把「快照 + log + 快照」切成 9 段，段间靠 printf '\n' 兜换行；
 *   · shallow 边界文件用 `case "$SH" in /*)` 兼容绝对/相对路径 + `wc -c` 判 1 MiB + `base64 | tr -d '\n'`；
 *   · git 调用全部走 `git -C <root>` 且参数逐个 shellQuote（含 `--format=%H%x00…` 这种带 % 的串）。
 *
 * 本脚本在 WSL 的真 sh + 真 git 里用【真实现 historyRemoteIo + 真 gitHistoryPage】跑
 * （只把 runPooled 换成 `wsl -e sh -c`，其余一字不改）：
 *
 *   E1 真仓库首页：entries 与真 `git log --branches --remotes HEAD` 一致、无装饰、snapshot 是 64 hex
 *   E2 分页：count=2 的游标 → 第二页闭环，两页快照一致
 *   E3 真过期：游标之后多一个提交 → graph-stale（409 语义）
 *   E4 非仓库目录 / 不存在的目录 → isRepo:false（脚本内 NOREPO，不是异常）
 *   E5 浅克隆：shallow 边界文件真的被读进指纹（与同 HEAD 的完整克隆指纹必须不同）
 *   E6 多分支 + 中文提交信息：`--branches` 与 `--encoding=UTF-8` 的真实效果
 *
 * 只读：不修改 lib/，临时仓库全部建在 WSL /tmp 下并用完即删。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { stat as statAsync, readFile as readFileAsync } from 'node:fs/promises'
import { join, resolve as resolvePath } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const src = readFileSync(root + '/lib/index.js', 'utf8')

let pass = 0, fail = 0
const check = (cond, label) => { if (cond) { pass++; console.log('  ✓ ' + label) } else { fail++; console.log('  ✗ FAIL: ' + label) } }

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

const GIT_READ_ENV = (() => {
  const m = /const GIT_READ_ENV = "([^"]+)"/.exec(src)
  if (!m) throw new Error('lib/index.js 里找不到 GIT_READ_ENV')
  return m[1]
})()

// history 段用到的 graph 段共享件：常量整行取出（避免在验证脚本里复制一份走样）
const lines = src.split('\n')
const constLine = (name) => {
  const hit = lines.find((l) => l.trimStart().startsWith('const ' + name + ' = '))
  if (!hit) throw new Error('lib/index.js 里找不到常量 ' + name)
  return hit.trim()
}
const SHARED_CONSTS = ['GRAPH_OID', 'GRAPH_MAX_OFFSET', 'GRAPH_DEFAULT_COUNT', 'GRAPH_MAX_COUNT', 'GRAPH_LOG_FORMAT',
  'GRAPH_MAX_HISTORY_REFS', 'GRAPH_MAX_SHALLOW_BYTES'].map(constLine).join('\n')

const HISTORY_BLOCK = (() => {
  const a = src.indexOf('// ---- better-sidebar 0.28.2 新增 git.history')
  const b = src.indexOf('  async function interceptGitHandler')
  if (a < 0 || b < 0 || b <= a) throw new Error('lib/index.js 里找不到 git.history 实现段（标记被改动？）')
  return src.slice(a, b)
})()

// ---------------------------------------------------------------------------
// WSL 出口：与 runPooled 返回形状一致
// ---------------------------------------------------------------------------
function runPooledWsl(_profile, script) {
  try {
    const out = execFileSync('wsl', ['-e', 'sh', '-c', script], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60000 })
    return { ok: true, exitCode: 0, stdout: out, stderr: '', error: '' }
  } catch (e) {
    return {
      ok: false,
      exitCode: e.status === undefined ? 255 : e.status,
      stdout: String(e.stdout || ''),
      stderr: String(e.stderr || ''),
      error: String(e.message || '')
    }
  }
}

const built = new Function(
  'runPooled', 'GIT_READ_ENV', 'createHash', 'resolvePath', 'stat', 'readFile',
  SHARED_CONSTS + '\n' +
  grab(src, 'function gitReplyFail') + '\n' +
  grab(src, 'function shellQuote') + '\n' +
  grab(src, 'function shellQuotePath') + '\n' +
  grab(src, 'function graphEntriesFromLog') + '\n' +
  '// 验证脚本只关心 entries/指纹，root 映射由 sidebar-0282 的假 SSH 用例覆盖\n' +
  'const mirrorRootOf = function () { return "/mirror/root" }\n' +
  HISTORY_BLOCK + '\n' +
  'return { gitHistoryPage: gitHistoryPage, historyRemoteIo: historyRemoteIo };'
)(runPooledWsl, GIT_READ_ENV, createHash, resolvePath, statAsync, readFileAsync)

const makeRemote = (remoteDir) => ({ profile: { id: 'p1', host: '<host>', user: '<user>', keyPath: '<key>' }, remoteDir: remoteDir })
const page = async (remoteDir, payload) => built.gitHistoryPage(payload || {}, built.historyRemoteIo(makeRemote(remoteDir)))

/** 期望 gitReplyFail 抛出的错误码（graph-stale / graph-limit / bad-request…） */
const codeOf = async (fn) => {
  try { await fn(); return 'no-throw' } catch (e) { return e && e.code ? e.code : 'unknown:' + e }
}

const wsl = (cmd) => execFileSync('wsl', ['-e', 'sh', '-c', cmd], { encoding: 'utf8', timeout: 60000 })
const git = (dir, args) => wsl('cd ' + JSON.stringify(dir) + ' && git ' + args.map((a) => JSON.stringify(a)).join(' ') + ' 2>&1')
const commit = (dir, msg) => {
  git(dir, ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'add', '-A'])
  git(dir, ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', msg])
}
const write = (dir, rel, content) => wsl('mkdir -p ' + JSON.stringify(dir) + " ; printf '%b' " + JSON.stringify(content) + ' > ' + JSON.stringify(dir + '/' + rel))

const base = '/tmp/dsh-history-sh-' + Date.now()
wsl('mkdir -p ' + JSON.stringify(base))
try {
  if (wsl('command -v git >/dev/null && echo yes || echo no').trim() !== 'yes') {
    console.log('结果: 0 通过, 0 失败')
    console.log('· SKIP：WSL 里没有 git，跳过（不算失败）')
    process.exit(0)
  }

  const repo = base + '/repo'
  wsl('mkdir -p ' + JSON.stringify(repo))
  git(repo, ['init', '-q'])
  git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  write(repo, 'a.txt', 'one\n')
  commit(repo, 'first commit')
  write(repo, 'a.txt', 'one\ntwo\n')
  commit(repo, 'second commit')
  write(repo, 'a.txt', 'one\ntwo\nthree\n')
  commit(repo, 'third commit')

  console.log('\nE1 真仓库首页：标记分段 + 字段解析 + 快照口径')
  {
    const v = await page(repo)
    check(v.isRepo === true, 'E1a isRepo=true')
    check(v.entries.length === 3, 'E1b entries=3（真 git log 经 @@DSH_GH@@ 分段后解析）')
    check(v.entries[0].subject === 'third commit' && v.entries[0].author === 'T', 'E1c subject/author 正确（%s/%an）')
    check(v.entries[0].parents.length === 1 && v.entries[0].parents[0] === v.entries[1].hashFull, 'E1d parents 拓扑正确（%P）')
    check(v.entries.every((e) => Array.isArray(e.refs) && e.refs.length === 0), 'E1e refs 恒为 []（上游 history 不做装饰）')
    check(/^[a-f0-9]{64}$/.test(v.snapshot), 'E1f snapshot 是 sha256（真 refs+HEAD+shallow 拼接后算）')
    check(v.hasMore === false && v.nextCursor === undefined, 'E1g 未超 limit → hasMore=false / 无 nextCursor')
    check(v.root === '/mirror/root', 'E1h root 走镜像映射（本脚本用桩，映射逻辑另测）')
  }

  console.log('\nE2 分页：真游标翻第二页，两页快照一致')
  {
    const p1 = await page(repo, { count: 2 })
    check(p1.entries.length === 2 && p1.hasMore === true && typeof p1.nextCursor === 'string', 'E2a count=2 → 2 条 + hasMore + nextCursor')
    const p2 = await page(repo, { count: 2, cursor: p1.nextCursor })
    check(p2.entries.length === 1 && p2.entries[0].subject === 'first commit', 'E2b 第二页拿到最老一条（--skip=2 真生效）')
    check(p2.hasMore === false, 'E2c 第二页 hasMore=false')
    check(p2.snapshot === p1.snapshot, 'E2d 仓库未变 → 两页指纹相同（否则客户端会被无故判过期）')
    const cur = JSON.parse(Buffer.from(p1.nextCursor, 'base64url').toString('utf8'))
    check(cur.version === 1 && cur.offset === 2 && cur.fingerprint === p1.snapshot, 'E2e 游标字段与上游口径一致')
  }

  console.log('\nE3 真过期：游标之后多了提交')
  {
    const p1 = await page(repo, { count: 2 })
    write(repo, 'b.txt', 'x\n')
    commit(repo, 'fourth commit')
    const code = await codeOf(() => page(repo, { count: 2, cursor: p1.nextCursor }))
    check(code === 'graph-stale', 'E3a 游标失效 → graph-stale（interceptGitHandler 映射 409）')
    const fresh = await page(repo)
    check(fresh.entries.length === 4 && fresh.entries[0].subject === 'fourth commit', 'E3b 不带游标重取 → 新提交出现、首页照常')
  }

  console.log('\nE4 非仓库 / 目录不存在：脚本内 NOREPO，不抛异常')
  {
    const empty = base + '/empty'
    wsl('mkdir -p ' + JSON.stringify(empty))
    const v = await page(empty)
    check(v.isRepo === false && v.entries.length === 0, 'E4a 普通空目录 → isRepo=false')
    const gone = await page(base + '/does-not-exist')
    check(gone.isRepo === false, 'E4b 目录不存在（cd 失败）→ isRepo=false，不是 500')
    const code = await codeOf(() => page(empty, { cursor: Buffer.from(JSON.stringify({ version: 1, fingerprint: 'a'.repeat(64), offset: 1 })).toString('base64url') }))
    check(code === 'graph-stale', 'E4c 非仓库 + 游标 → graph-stale（不能静默回首页）')
  }

  console.log('\nE5 浅克隆：shallow 边界文件真的进入指纹（case/wc/base64 三段都真跑）')
  {
    const fullClone = base + '/full-clone'
    const shallowClone = base + '/shallow-clone'
    wsl('git clone -q ' + JSON.stringify('file://' + repo) + ' ' + JSON.stringify(fullClone) + ' 2>&1')
    wsl('git clone -q --depth 1 ' + JSON.stringify('file://' + repo) + ' ' + JSON.stringify(shallowClone) + ' 2>&1')
    const shallowFile = wsl('cat ' + JSON.stringify(shallowClone + '/.git/shallow') + ' 2>/dev/null | wc -l').trim()
    check(shallowFile !== '0', 'E5a 浅克隆确实有 .git/shallow（' + shallowFile.trim() + ' 行）')
    const vf = await page(fullClone)
    const vs = await page(shallowClone)
    check(vs.isRepo === true && vs.entries.length === 1, 'E5b 浅克隆 → 只有 1 条历史（真 git 行为）')
    check(vf.snapshot !== vs.snapshot, 'E5c 同 HEAD 下浅克隆与完整克隆指纹不同 ⇒ shallow 内容真的被读进指纹')
    // 同一仓库前后两次请求指纹稳定（base64 段没有多余换行导致漂移）
    const again = await page(shallowClone)
    check(again.snapshot === vs.snapshot, 'E5d 浅克隆重复请求 → 指纹稳定（base64 去换行正确，不会每页都判过期）')
  }

  console.log('\nE6 多分支 + 中文提交信息：--branches 与 --encoding=UTF-8')
  {
    git(repo, ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'checkout', '-q', '-b', 'side'])
    write(repo, 'c.txt', 'side\n')
    commit(repo, '旁支提交：中文标题')
    git(repo, ['checkout', '-q', 'main'])
    const v = await page(repo, { count: 20 })
    const subjects = v.entries.map((e) => e.subject)
    check(subjects.indexOf('旁支提交：中文标题') >= 0, 'E6a 别的分支上的提交也出现（--branches 真生效）')
    check(subjects[0] !== undefined && v.entries.every((e) => typeof e.subject === 'string'), 'E6b 中文未被转义/截断（--encoding=UTF-8）')
    const m = v.entries.find((e) => e.subject === '旁支提交：中文标题')
    check(!!m && m.message.indexOf('旁支提交：中文标题') === 0, 'E6c %B 完整消息同样是中文')
  }
} finally {
  try { wsl('rm -rf ' + JSON.stringify(base)) } catch (e) { /* 清理失败不影响结论 */ }
}

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
