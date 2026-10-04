// fs.trees / fs.mkdir 契约回归测试 —— 「远程项目的侧边栏文件树显示本地目录」（2026-09-29）
//
// 背景：better-sidebar 0.22.1 及更早，文件树每展开一层发一次 `fs.tree`（N 次 POST）；
// 0.23/0.24 起改为一次 `fs.trees` 批量请求「可见集」（工作区根 + 所有已展开目录，≤64 条），
// 客户端按返回的 level.path 落缓存。本插件当时只注册了 `fs.tree` 的 exact 路由，于是
// 0.24 的树列举**绕过拦截**、落到 better-sidebar 自己的本地实现 —— 远程项目里看到的
// 就是本地镜像目录（点开文件也读本地）。0.24 同时新增 `fs.mkdir`（新建目录同理会落到本地）。
//
// 三层：
//   A. 纯函数：readPathsField 校验 / find 行解析 / 条目排序 / sidebarEntriesFrom 映射 /
//      localMakeDir 真实落盘（本地工作区走它）
//   B. remoteListDirsBatch：一次 SSH 往返解析 N 层、标记分段、单层错误隔离、TTL 缓存与 epoch
//   C. 接线：两个端点都注册 exact 路由；远程与本地两条分支都必须实现（否则本地会话反而 404）；
//      远程 mkdir 不落本地镜像；文档/版本号
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { mkdir as mkdirAsync } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const src = readFileSync(root + '/lib/index.js', 'utf8')
const changelog = readFileSync(root + '/CHANGELOG.md', 'utf8')
const readme = readFileSync(root + '/README.md', 'utf8')
const pkg = JSON.parse(readFileSync(root + '/package.json', 'utf8'))

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

/** 取单行 const 声明（`const NAME = ...;`）。 */
function grabConst(text, name) {
  const start = text.indexOf('const ' + name + ' = ')
  if (start < 0) throw new Error('const ' + name + ' not found')
  return text.slice(start, text.indexOf('\n', start))
}

let pass = 0, fail = 0
const check = (cond, label) => { if (cond) { pass++; console.log('  ✓ ' + label) } else { fail++; console.log('  ✗ FAIL: ' + label) } }

// ---------------------------------------------------------------------------
// 沙箱 1：纯函数 + 批量列举（依赖模块级缓存/引用函数，一并注入）
// ---------------------------------------------------------------------------
const sandbox = new Function('join', [
  grabConst(src, 'MAX_BYTES'),
  grabConst(src, 'TREE_CACHE_MAX'),
  grabConst(src, 'TREE_CACHE_TTL_MS'),
  grabConst(src, 'BATCH_LEVEL_MARK'),
  grabConst(src, 'BATCH_LEVEL_ERR'),
  'const cacheEpochs = new Map();',
  'const treeCache = new Map();',
  grab(src, 'function shellQuote'),
  grab(src, 'function shellQuotePath'),
  grab(src, 'function profileKey'),
  grab(src, 'function cacheEpoch'),
  grab(src, 'function bumpCacheEpoch'),
  grab(src, 'function lruGet'),
  grab(src, 'function lruPut'),
  grab(src, 'function collectFindEntries'),
  grab(src, 'function sortFindEntries'),
  grab(src, 'async function remoteListDirsBatch'),
  grab(src, 'function readPathsField'),
  grab(src, 'function sidebarEntriesFrom'),
  'return { remoteListDirsBatch, readPathsField, sidebarEntriesFrom, collectFindEntries, sortFindEntries, treeCache, cacheEpochs, bumpCacheEpoch };'
].join('\n'))(join)

const profile = { id: 'p1', host: 'hpc', port: 22, user: 'u', authMethod: 'key', keyPath: '/k' }

function fakeRunner(reply) {
  const runner = async (p, cmd) => { runner.calls.push(cmd); return typeof reply === 'function' ? reply(cmd) : reply }
  runner.calls = []
  return runner
}

// 与远端 `find . -maxdepth 1 -mindepth 1 -printf '%Y\t%f\t%s\n' | sort` 的输出格式一致
const LEVEL_W = '__DSH_LVL__/home/u/w\nf\tb.txt\t10\nd\tsub\t4096\nd\tAlpha\t4096\n'
const LEVEL_EMPTY = '__DSH_LVL__/home/u/w/sub\n'
const LEVEL_MISSING = '__DSH_LVL__/nope\n__DSH_LVLERR__\n'

console.log('A1 · collectFindEntries / sortFindEntries（单目录与批量共用）')
{
  const rows = sandbox.collectFindEntries(['f\tb.txt\t10', 'd\tsub\t4096', '', 'd\t.\t0', 'd\t..\t0', 'garbage'], [])
  check(rows.length === 2, '跳过空行 / . / .. / 畸形行')
  check(rows[0].name === 'b.txt' && rows[0].type === 'file' && rows[0].size === 10, 'type 与 size 解析正确')
  const sorted = sandbox.sortFindEntries(rows.concat([{ name: 'Alpha', type: 'directory', size: 0 }]))
  check(sorted.map((e) => e.name).join(',') === 'Alpha,sub,b.txt', '目录在前、同类按名排序（对齐 better-sidebar listDirectory）')
}

console.log('A2 · readPathsField（对齐上游 1..64 条校验）')
{
  check(sandbox.readPathsField({ paths: [] }).error !== undefined, '空数组 → bad-request')
  check(sandbox.readPathsField({}).error !== undefined, '缺字段 → bad-request')
  check(sandbox.readPathsField({ paths: 'x' }).error !== undefined, '非数组 → bad-request')
  check(sandbox.readPathsField({ paths: [1, null, '', 'a'] }).paths.join(',') === 'a', '过滤非字符串与空串')
  check(sandbox.readPathsField({ paths: new Array(64).fill('/d') }).paths.length === 64, '64 条 → 通过（上游上限）')
  check(sandbox.readPathsField({ paths: new Array(65).fill('/d') }).error !== undefined, '65 条 → bad-request')
}

console.log('A3 · sidebarEntriesFrom（客户端只认镜像路径）')
{
  const entries = sandbox.sidebarEntriesFrom(
    [{ name: 'sub', type: 'directory', size: 0 }, { name: 'a.txt', type: 'file', size: 3 }, { name: '.env', type: 'file', size: 1 }],
    'C:\\mirror\\w'
  )
  check(entries[0].name === 'sub' && entries[0].isDir === true, '目录在前且 isDir 正确')
  check(entries.every((e) => e.path.startsWith('C:\\mirror\\w')), 'path 一律映射到本地镜像目录（fs.read/write 再由本插件映射回远端）')
  check(entries.find((e) => e.name === '.env').hidden === true, '. 开头 → hidden')
}

console.log('A4 · localMakeDir（本地工作区的 fs.mkdir 实现，真实落盘）')
{
  const localMakeDir = new Function('join', 'existsSync', 'mkdir',
    grab(src, 'async function localMakeDir') + '\nreturn localMakeDir;')(join, existsSync, mkdirAsync)
  const dir = mkdtempSync(join(tmpdir(), 'dsh-remote-ssh-mkdir-'))
  try {
    const ok = await localMakeDir(dir, '新目录')
    check(ok.ok === true && ok.path === join(dir, '新目录') && existsSync(ok.path), '创建成功 → 返回新绝对路径')
    const dup = await localMakeDir(dir, '新目录')
    check(dup.ok === false && String(dup.error).includes('已存在'), '同名已存在 → 失败且不覆盖')
    for (const bad of ['', '.', '..', 'a/b', 'a\\b']) {
      const r = await localMakeDir(dir, bad)
      check(r.ok === false, `非法目录名 ${JSON.stringify(bad)} → 失败（单段名校验）`)
    }
    check((await localMakeDir('', 'x')).ok === false, '缺父目录 → 失败')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log('B1 · remoteListDirsBatch：一次往返解析 N 层（含单层失败隔离）')
{
  const runner = fakeRunner({ ok: true, stdout: LEVEL_W + LEVEL_EMPTY + LEVEL_MISSING, stderr: '', error: '' })
  const targets = ['/home/u/w', '/home/u/w/sub', '/nope']
  const out = await sandbox.remoteListDirsBatch(runner, profile, targets)
  check(runner.calls.length === 1, '3 个目录只发 1 次 SSH（不是 N 次）')
  check(runner.calls[0].split('__DSH_LVL__%s').length - 1 === 3, '命令里每个待列举目录各有一个标记 printf')
  check(out.length === 3 && out[0].ok && out[1].ok && out[2].ok === false, '结果与 targets 等长且顺序一致')
  check(out[0].path === '/home/u/w', 'path 回显目标（客户端按 level.path 落缓存）')
  check(out[0].entries.map((e) => e.name).join(',') === 'Alpha,sub,b.txt', '层内条目解析 + 排序')
  check(out[1].entries.length === 0, '空目录 → 空 entries（不是错误）')
  check(typeof out[2].error === 'string' && out[2].error.length > 0, 'cd 失败只让该层带 error，整批仍成功')
  check(!/__DSH_LVL/.test(JSON.stringify(out[0].entries)), '标记行不会混进 entries')
}

console.log('B2 · 注入防护：远端路径一律单引号引用')
{
  const runner = fakeRunner({ ok: true, stdout: '__DSH_LVL__/tmp/x\n', stderr: '', error: '' })
  const evil = "/home/u/it's; rm -rf /"
  await sandbox.remoteListDirsBatch(runner, profile, [evil])
  const cmd = runner.calls[0]
  check(cmd.includes("'" + evil.replace(/'/g, "'\\''") + "'"), '含单引号的路径按 shellQuote 转义')
  check(!cmd.includes("it's; rm -rf /"), '未出现未转义的原始路径（无命令注入）')
}

console.log('B3 · TTL 缓存与 epoch 失效（刷新 tick 不会每次都打 SSH）')
{
  const runner = fakeRunner((cmd) => {
    const paths = [...cmd.matchAll(/printf '__DSH_LVL__%s\\n' '([^']+)'/g)].map((m) => m[1])
    return { ok: true, stdout: paths.map((p) => '__DSH_LVL__' + p + '\n').join(''), stderr: '', error: '' }
  })
  await sandbox.remoteListDirsBatch(runner, profile, ['/c/a', '/c/b'])
  check(runner.calls.length === 1, '首次列举：1 次往返')
  await sandbox.remoteListDirsBatch(runner, profile, ['/c/a', '/c/b'])
  check(runner.calls.length === 1, 'TTL 内重复请求（refresh tick）→ 0 额外往返')
  await sandbox.remoteListDirsBatch(runner, profile, ['/c/b', '/c/c'])
  check(runner.calls.length === 2 && runner.calls[1].split('__DSH_LVL__%s').length - 1 === 1, '部分命中：只列举未缓存的层')
  sandbox.bumpCacheEpoch(profile)
  await sandbox.remoteListDirsBatch(runner, profile, ['/c/a'])
  check(runner.calls.length === 3, 'epoch 递增（远端已变更）→ 缓存作废重新列举')
}

console.log('B4 · 整批失败（SSH 挂了）→ 每层带 error，不抛异常')
{
  const runner = fakeRunner({ ok: false, stdout: '', stderr: '', error: 'ssh: connect failed' })
  const out = await sandbox.remoteListDirsBatch(runner, profile, ['/x', '/y'])
  check(out.every((l) => l.ok === false && l.error.includes('ssh')), '整批失败 → 逐层 ok:false + 原因')
}

console.log('B5 · 客户端缓存键：levels 的 path 覆盖请求集（0.24 树渲染依赖）')
{
  const runner = fakeRunner({ ok: true, stdout: '__DSH_LVL__/m/w\nf\ta\t1\n__DSH_LVL__/m/w/sub\n', stderr: '', error: '' })
  const targets = ['/m/w', '/m/w/sub']
  const levels = (await sandbox.remoteListDirsBatch(runner, profile, targets)).map((l) => ({ path: l.path, entries: l.entries }))
  const store = {}
  for (const level of levels) store[level.path] = { entries: level.entries }
  check(Object.keys(store).sort().join(',') === targets.slice().sort().join(','), 'storeLevel 的键集 === 请求集（否则树渲染空/错位）')
}

// ---------------------------------------------------------------------------
// C. 接线与文档
// ---------------------------------------------------------------------------
console.log('C1 · exact 路由注册（少一个就静默回落到宿主本地实现）')
{
  const start = src.indexOf('["fs.tree"')
  const list = src.slice(start, src.indexOf('].forEach(function (m) {', start))
  for (const m of ['fs.tree', 'fs.trees', 'fs.read', 'fs.write', 'fs.search', 'fs.rename', 'fs.remove', 'fs.mkdir']) {
    check(list.includes('"' + m + '"'), '注册 ' + m + ' 的 exact 路由')
  }
}

console.log('C2 · 两条分支都必须实现 fs.trees / fs.mkdir')
{
  const remoteIdx = src.indexOf('} else if (method === "fs.trees") {')
  const localIdx = src.indexOf('} else if (method === "fs.trees") {', remoteIdx + 1)
  check(remoteIdx > 0 && localIdx > remoteIdx, '远程分支与本地分支各有一处 fs.trees')
  const remoteTrees = src.slice(remoteIdx, src.indexOf('} else if (method === "fs.mkdir") {', remoteIdx))
  const localTrees = src.slice(localIdx, src.indexOf('// fs.rename / fs.remove', localIdx))
  check(remoteTrees.includes('readPathsField(payload)') && remoteTrees.includes('400'), '远程 fs.trees：字段校验 + bad-request')
  check(remoteTrees.includes('remoteListDirsBatch(runPooled, profile'), '远程 fs.trees：批量远端列举')
  check(remoteTrees.includes('localToRemote(lp, remoteBase, remoteInfo.remotePath)'), '远程 fs.trees：镜像路径 → 远端路径')
  check(remoteTrees.includes('sidebarEntriesFrom(lvl.entries, locals[i])') && remoteTrees.includes('path: locals[i]'), '远程 fs.trees：levels 形状与上游一致')
  check(localTrees.includes('localListDir(lp, LIST_LIMIT)') && localTrees.includes('levels: levels'), '本地 fs.trees：本地工作区不能 404（否则本地会话反而被弄坏）')

  const remoteMkdir = src.slice(src.indexOf('} else if (method === "fs.mkdir") {'), src.indexOf('} else {', src.indexOf('} else if (method === "fs.mkdir") {')))
  check(remoteMkdir.includes('mkdir -- ') && remoteMkdir.includes('shellQuotePath(destRemote)'), '远程 fs.mkdir：在远端 mkdir（路径单引号引用）')
  check(remoteMkdir.includes('already exists') && remoteMkdir.includes('409'), '远程 fs.mkdir：同名 → 409（对齐上游）')
  check(remoteMkdir.includes('invalidateRemoteCaches(profile, parentRemote'), '远程 fs.mkdir：父目录缓存失效（刷新能看到新目录）')
  check(!remoteMkdir.includes('mkdir(join(parentLocal'), '远程 fs.mkdir：不在本地镜像里建目录')
  check(src.includes('localMakeDir(payload.path || sessionCwd'), '本地 fs.mkdir：走 localMakeDir')
}

console.log('C3 · 远程工作区探测：fs.trees 没有 path 字段，用 paths[0] 兜底')
{
  check(src.includes('Array.isArray(payload.paths) && typeof payload.paths[0] === "string"'), 'sessionCwd 为空时用第一条路径探测 .remote-ssh.json')
}

console.log('C4 · 版本与文档')
{
  // 版本号不写死：真正的不变量是「package.json ↔ CHANGELOG 顶部 ↔ README 安装命令」三者一致
  // （此前每发一版都要手改这里的字面量，属于测试自己的维护成本）。
  const headVersion = (changelog.match(/^## \[?(\d+\.\d+\.\d+)\]?/m) || [])[1]
  check(pkg.version === headVersion, 'package.json 版本与 CHANGELOG 顶部版本一致（' + pkg.version + ' / ' + headVersion + '）')
  check(changelog.includes('2.4.18') && changelog.includes('fs.trees'), 'CHANGELOG 记录 2.4.18 / fs.trees')
  check(readme.includes('fs.trees'), 'README 契约里写明 fs.trees（0.23+ 批量列举）')
}

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
