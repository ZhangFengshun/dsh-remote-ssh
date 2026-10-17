#!/usr/bin/env node
/**
 * 远端 git.status 脚本的真 sh + 真 git 独立验证（随 2.4.33 引入，长期可复跑）。
 *
 * 为什么需要它：单测（sidebar-0280-git-status / perf-remote-open-2433）把 SSH 出口整个
 * 换成了伪造出口，脚本本身的 POSIX 正确性未被覆盖。本脚本在 WSL 的真 sh + 真 git 里
 * 用【真实现 gitStatusRemote + 真解析器 + 真 handler】跑（只把 runPooled 换成
 * `wsl -e sh -c`，其余一字不改），覆盖 numstat 短路的四个分支 + 降级链 + NOTREPO：
 *
 *   E1 干净仓库：无 UNSTAGED/STAGED 段 → entries=[]，分支身份齐全（短路生效且无害）
 *   E2 脏仓库（暂存+未暂存+改名+未跟踪）：守卫放行 → 行数与真 git numstat 一致
 *   E3 只有未跟踪：tracked=0 → 段缺席 → ?? 条目无行数（同本地 pathspec=[] 口径）
 *   E4 PATH shim 让 status 失败：V=none → $T 不存在 → ${N:-0} 兜底 → 不炸、空页
 *   E5 非 git 目录 / 不存在的目录 → NOTREPO / isRepo:false（回归确认）
 *
 * 只读：不修改 lib/，临时仓库全部建在 WSL /tmp 下并用完即删。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

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

const GIT_READ_ENV = /const GIT_READ_ENV = "([^"]+)"/.exec(src)[1]
const STATUS_BLOCK = (() => {
  const a = src.indexOf('// ---- better-sidebar 0.28.0 的 git.status 形状')
  const b = src.indexOf('  async function gitStatusImpl')
  if (a < 0 || b < 0 || b <= a) throw new Error('lib/index.js 里找不到 git.status 实现段（标记被改动？）')
  return src.slice(a, b)
})()

/** 可注入的前缀（E4 用 PATH shim，脚本正文一字不改）。 */
let wslPrefix = ''
/** wsl -e sh -c <script> → 与 runPooled 返回形状一致。 */
function runPooledWsl(_profile, script) {
  const s = wslPrefix ? wslPrefix + '\n' + script : script
  try {
    const out = execFileSync('wsl', ['-e', 'sh', '-c', s], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60000 })
    return { ok: true, exitCode: 0, stdout: out, stderr: '', error: '' }
  } catch (e) {
    return { ok: false, exitCode: e.status === undefined ? 255 : e.status, stdout: String(e.stdout || ''), stderr: String(e.stderr || ''), error: String(e.message || '') }
  }
}

/** 与 lib 同构的远端分支上下文（gitContextOf 的产物）。 */
const makeRemote = (remoteDir) => ({ profile: { id: 'p1', host: '<host>', user: '<user>', keyPath: '<key>' }, remoteDir: remoteDir })

const gitStatusRemote = new Function(
  'runPooled', 'GIT_READ_ENV',
  grab(src, 'function shellQuote') + '\n' +
  grab(src, 'function shellQuotePath') + '\n' +
  grab(src, 'function parsePorcelainZ') + '\n' +
  STATUS_BLOCK + '\n' +
  'return gitStatusRemote;'
)(runPooledWsl, GIT_READ_ENV)

const wsl = (cmd) => execFileSync('wsl', ['-e', 'sh', '-c', cmd], { encoding: 'utf8', timeout: 60000 })

const git = (dir, args) => wsl('cd ' + JSON.stringify(dir) + ' && git ' + args.map((a) => JSON.stringify(a)).join(' ') + ' 2>&1')
const commit = (dir, msg) => {
  git(dir, ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'add', '-A'])
  git(dir, ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', JSON.stringify(msg)])
}
const write = (dir, rel, content) => wsl('mkdir -p ' + JSON.stringify(dir) + '; printf ' + JSON.stringify(content) + ' > ' + JSON.stringify(dir + '/' + rel))

const base = '/tmp/dsh-perf-t3-' + Date.now()
wsl('mkdir -p ' + JSON.stringify(base))
try {
  const haveGit = wsl('command -v git >/dev/null && echo yes || echo no').trim() === 'yes'
  if (!haveGit) {
    console.log('结果: 0 通过, 0 失败')
    console.log('· SKIP：WSL 里没有 git，跳过（不算失败）')
    process.exit(0)
  }

  // ---- E1/E2/E4/E5 共用的真仓库 ----
  const repo = base + '/repo'
  wsl('mkdir -p ' + JSON.stringify(repo))
  git(repo, ['init', '-q'])
  git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  write(repo, 'a.txt', 'one\n')
  write(repo, 'keep.txt', 'k1\nk2\n')
  commit(repo, 'first')
  git(repo, ['remote', 'add', 'origin', base + '/upstream-does-not-exist.git'])

  console.log('\nE1 干净仓库：守卫跳过两条全仓 numstat，且响应形状完整')
  {
    const v = await gitStatusRemote(makeRemote(repo))
    check(v.isRepo === true && v.branch === 'main' && v.entries.length === 0, 'E1a 干净仓库 → entries=[]（短路后缺段 = 空串口径）')
    check(v.upstream === undefined && v.ahead === undefined && v.behind === undefined, 'E1b 无 upstream 跟踪目标时字段按 git 实际输出（不伪造）')
    check(v.detached === false, 'E1c detached=false')
    check(v.truncated === false, 'E1d truncated=false')
  }

  console.log('\nE2 脏仓库：守卫放行，真 numstat 行数经真 sh 分段后逐条对上')
  {
    write(repo, 'a.txt', 'x\ntwo\nthree\n')        // 未暂存：换首行 + 加两行 → +3/-1（真 diff）
    write(repo, 'staged.txt', 's1\n')
    git(repo, ['add', 'staged.txt'])               // 暂存新增 +1/-0
    wsl('git -C ' + JSON.stringify(repo) + ' mv keep.txt moved.txt')
    write(repo, 'moved.txt', 'k1\nk2\nk3\n')
    git(repo, ['add', 'moved.txt'])                // 暂存改名 R100 + 内容 +1/-0
    write(repo, 'untracked.txt', 'x\n')            // 未跟踪（不计入 N，但出现在 status）
    const v = await gitStatusRemote(makeRemote(repo))
    const byPath = (p) => v.entries.find((e) => e.path === p)
    check(v.isRepo === true && v.entries.some((e) => e.path === 'a.txt'), 'E2a 脏仓库 → 条目齐全')
    check(byPath('staged.txt') && byPath('staged.txt').staged && byPath('staged.txt').staged.additions === 1 && byPath('staged.txt').staged.deletions === 0,
      'E2b 暂存新增 staged.txt：暂存侧 +1/-0（真 numstat 经真 sh 分段）')
    check(byPath('a.txt') && byPath('a.txt').unstaged && byPath('a.txt').unstaged.additions === 3 && byPath('a.txt').unstaged.deletions === 1,
      'E2c a.txt 未暂存侧 +3/-1（换首行 + 加两行，两个计数器都对上）')
    check(byPath('moved.txt') && byPath('moved.txt').origin === 'keep.txt' && byPath('moved.txt').staged && byPath('moved.txt').staged.additions === 1,
      'E2d 真改名：origin 归到新名，内容改动 +1 归暂存侧')
    check(byPath('untracked.txt') && byPath('untracked.txt').staged === undefined && byPath('untracked.txt').unstaged === undefined,
      'E2e 未跟踪条目无行数')
    check(v.entries.some((e) => e.xy === '??') === true, 'E2f ?? 记录存在（N 排除 ?? 计数后其余条目 >0 → 段存在）')
  }

  console.log('\nE3 只有未跟踪：tracked=0 → 段缺席（短路第二分支）')
  {
    const only = base + '/only-untracked'
    wsl('mkdir -p ' + JSON.stringify(only))
    git(only, ['init', '-q'])
    git(only, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
    write(only, 'x.txt', 'x\n')
    const v = await gitStatusRemote(makeRemote(only))
    check(v.isRepo === true && v.entries.length === 1 && v.entries[0].xy === '??', 'E3a 只有未跟踪 → 1 条 ?? 记录')
    check(v.entries[0].staged === undefined && v.entries[0].unstaged === undefined, 'E3b 未跟踪条目无行数（tracked=0 → 段缺席 → 空串口径）')
  }

  console.log('\nE4 PATH shim：status 全变体失败（V=none）→ $T 不存在 → ${N:-0} 兜底不炸')
  {
    const shim = base + '/shim'
    wsl('mkdir -p ' + JSON.stringify(shim))
    // shim git：参数里出现 status → exit 97；其余透传真 git
    wsl('cat > ' + JSON.stringify(shim + '/git') + " <<'EOF'\n" +
      '#!/bin/sh\n' +
      'for a in \"$@\"; do [ \"$a\" = status ] && exit 97; done\n' +
      'exec /usr/bin/git \"$@\"\n' +
      'EOF\n' +
      'chmod +x ' + JSON.stringify(shim + '/git'))
    wslPrefix = 'export PATH=' + JSON.stringify(shim) + ':$PATH;'
    let v
    try { v = await gitStatusRemote(makeRemote(repo)) } finally { wslPrefix = '' }
    check(v.isRepo === true && v.branch === 'HEAD' && v.entries.length === 0,
      'E4a status 全失败（V=none）→ 不报错、空页 + branch=HEAD（与 C15 同口径）')
    check(v.operation === undefined || v.operation === '', 'E4b 无 operation')
  }

  console.log('\nE5 非 git 目录 / 不存在的目录（回归确认）')
  {
    const notRepo = base + '/notrepo'
    wsl('mkdir -p ' + JSON.stringify(notRepo))
    const v1 = await gitStatusRemote(makeRemote(notRepo))
    check(v1.isRepo === false && v1.entries.length === 0, 'E5a 非 git 目录 → isRepo:false（NOTREPO）')
    const v2 = await gitStatusRemote(makeRemote(base + '/no-such-dir'))
    check(v2.isRepo === false && v2.entries.length === 0, 'E5b 不存在的目录 → isRepo:false（NOTREPO，不再 500）')
  }
} finally {
  try { wsl('rm -rf ' + JSON.stringify(base)) } catch (e) {}
}

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
