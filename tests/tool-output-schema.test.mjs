// 工具输出契约回归测试（issue #14）。
//
// 背景：`remote_ssh_sync` / `remote_ssh_push` 共用一份 output schema，其中 `error` 被标成
// **必填**且 `additionalProperties: false`，而成功路径返回 `{ok:true, mirrorPath|remotePath}`
// —— 成功时既缺 `error` 又带未声明字段，必然被判 `returned invalid output`；失败路径反而合法。
// 症状极具误导性：**只有成功会报错**，模型看到"失败"但副作用已落地，只能靠再跑一次 ls 确认。
//
// 本测试用**真实的 remoteSyncUp / remoteSyncDown**（桩掉 subprocess）取实际返回对象，
// 再用**真实的 syncOutput.schema** 跑一个模拟宿主校验器的 mini-validator。
import { readFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

// ---- issue #20：同步实现区（常量 + helpers + remoteSyncDown/Up）整体抽出，注入真实 fs ----
const syncRegion = (() => {
  const constStart = src.indexOf('const SYNC_MAX_BYTES_DEFAULT')
  const constEnd = src.indexOf('\n', src.indexOf('const MIRROR_README_SENTINEL')) + 1
  const regionStart = src.indexOf('function syncErrText(')
  const upIdx = src.indexOf('async function remoteSyncUp(')
  const upSrc = grab('async function remoteSyncUp')
  const regionEnd = upIdx >= 0 ? src.indexOf(upSrc, upIdx) + upSrc.length : -1
  if (constStart < 0 || regionStart < 0 || regionEnd <= regionStart) throw new Error('sync region not found')
  return src.slice(constStart, constEnd) + '\n' + src.slice(regionStart, regionEnd)
})()

let pass = 0, fail = 0
const check = (cond, label) => { if (cond) { pass++; console.log('  ✓ ' + label) } else { fail++; console.log('  ✗ FAIL: ' + label) } }

// ---- 取出真实的 syncOutput（textRender 用桩：render 与本测试无关）----
const syncBlock = (() => {
  const start = src.indexOf('const syncOutput = {')
  const end = src.indexOf('\n  };', start)
  return src.slice(start, end + 4)
})()
const syncOutput = new Function('textRender', syncBlock + '\nreturn syncOutput;')((fn) => fn)

// ---- 模拟宿主校验器：必填齐全 + 无未声明字段 + 类型正确 ----
function validate(schema, value, path = 'value') {
  const problems = []
  const props = schema.properties || {}
  for (const [key, spec] of Object.entries(props)) {
    if (spec.required && !(key in value)) problems.push(`missing required property "${path}.${key}"`)
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!(key in props)) problems.push(`"${path}.${key}" is not a declared property (additionalProperties: false)`)
    }
  }
  for (const [key, spec] of Object.entries(props)) {
    if (!(key in value)) continue
    const v = value[key]
    const t = Array.isArray(v) ? 'array' : typeof v
    if (spec.type && t !== spec.type) problems.push(`"${path}.${key}" expected ${spec.type}, got ${t}`)
  }
  return problems
}

// ---- 用桩 subprocess 调真实的 sync 函数 ----
function makeSubprocess(exitCode) {
  const calls = []
  const handle = () => ({
    stdout: { pipe: () => {} },
    stdin: { end: () => {}, write: () => {} },
    done: Promise.resolve({ exitCode }),
    collected: { stderr: { readFrom: () => ({ text: "" }) } },
    terminate: () => {},
  })
  return {
    calls,
    spawn: (opts) => { calls.push(opts.argv.join(' ')); return handle() },
  }
}

const fsp = await import('node:fs/promises')
const fsSync = await import('node:fs')
const npath = await import('node:path')
const syncFns = new Function(
  'process', 'rm', 'mkdir', 'rename', 'cp', 'readdir', 'stat', 'readFile', 'writeFile', 'existsSync',
  'join', 'dirname', 'basename', 'spawnOne', 'readCollected', 'sshArgv', 'shellQuote', 'shellQuotePath',
  'clearCachesForProfile', 'remoteWorkspaceReadme',
  syncRegion + '\nreturn { remoteSyncDown, remoteSyncUp };'
)(
  process, fsp.rm, fsp.mkdir, fsp.rename, fsp.cp, fsp.readdir, fsp.stat, fsp.readFile, fsp.writeFile, fsSync.existsSync,
  npath.join, npath.dirname, npath.basename,
  (subprocess, argv, stdio) => subprocess.spawn({ argv, cwd: process.cwd(), stdio, graceMs: 60000 }),
  () => "",
  (p, cmd) => ['ssh', '-o', 'BatchMode=yes', `${p.user}@${p.host}`, cmd],
  (s) => "'" + String(s) + "'",
  (s) => String(s),
  () => {},
  (n, rp) => "# 🌐 Remote Workspace / 远程工作区\n" + String(n) + " " + String(rp) + "\n",
)

/** 体积探测桩：小体积，让哨兵放行（issue #20 的哨兵本身由 sync-safety.test.mjs 覆盖）。 */
const smallRunner = async () => ({ ok: true, stdout: "1024\n", exitCode: 0 })
// .remote-ssh.json 已不再由调用方补写（改在 remoteSyncDown 内部恢复），这里断言的是工具返回对象。

const PROFILE = { id: 'p1', host: 'hpc-a.example.com', port: 22, user: 'user', keyPath: '/k' }

console.log('A · 成功路径必须通过 schema 校验（原崩溃点）')
{
  const dir = mkdtempSync(join(tmpdir(), 'rssh-sync-'))
  try {
    const upSub = makeSubprocess(0)
    const up = await syncFns.remoteSyncUp(upSub, PROFILE, '~/proj', dir)
    check(up.ok === true, 'remoteSyncUp 成功返回 ok:true')
    const upProblems = validate(syncOutput.schema, up)
    check(upProblems.length === 0, 'push 成功对象通过校验' + (upProblems.length ? '：' + upProblems.join('；') : ''))
    check(up.error === "", '成功时显式带 error: ""（与同文件其它工具一致）')

    const downSub = makeSubprocess(0)
    const down = await syncFns.remoteSyncDown(downSub, smallRunner, PROFILE, '~/proj', dir, {})
    check(down.ok === true, 'remoteSyncDown 成功返回 ok:true')
    const downProblems = validate(syncOutput.schema, down)
    check(downProblems.length === 0, 'sync 成功对象通过校验' + (downProblems.length ? '：' + downProblems.join('；') : ''))
    check(down.mirrorPath === dir, '成功时回传 mirrorPath（供调用方使用）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log('B · 失败路径同样通过校验')
{
  const sub = makeSubprocess(1)
  const bad1 = await syncFns.remoteSyncUp(sub, PROFILE, '', '/tmp/x')
  const bad2 = await syncFns.remoteSyncDown(sub, smallRunner, PROFILE, '~/proj', '')
  check(bad1.ok === false && typeof bad1.error === 'string', 'push 参数缺失 → ok:false + error')
  check(bad2.ok === false && typeof bad2.error === 'string', 'sync 参数缺失 → ok:false + error')
  check(validate(syncOutput.schema, bad1).length === 0 && validate(syncOutput.schema, bad2).length === 0, '失败对象也通过校验')
  const dir = mkdtempSync(join(tmpdir(), 'rssh-sync-'))
  try {
    const failUp = await syncFns.remoteSyncUp(makeSubprocess(2), PROFILE, '~/proj', dir)
    check(failUp.ok === false && /推送失败/.test(failUp.error), '非零退出码 → ok:false + 具体错误')
    check(validate(syncOutput.schema, failUp).length === 0, '退出码失败对象通过校验')
    const failDown = await syncFns.remoteSyncDown(makeSubprocess(2), smallRunner, PROFILE, '~/proj', dir, {})
    check(failDown.ok === false && /同步失败/.test(failDown.error), 'sync 非零退出码 → ok:false + 具体错误')
    check(validate(syncOutput.schema, failDown).length === 0, 'sync 退出码失败对象通过校验')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log('C · schema 静态防线（这一类 bug 的通用护栏）')
{
  check(!/error:\s*\{[^}]*required:\s*true/.test(src), '**没有任何** output schema 把 error 标成必填（成功时本来就没有 error）')
  const declared = Object.keys(syncOutput.schema.properties)
  check(declared.includes('remotePath') && declared.includes('mirrorPath'), 'syncOutput 声明了 remotePath / mirrorPath（additionalProperties: false 会拒未声明字段）')
  check(syncOutput.schema.properties.ok.required === true, 'ok 仍为必填（成功/失败都必须有结论字段）')
  check(/const res = \{ ok: true, error: "", mirrorPath: mirrorPath \}/.test(src), 'sync 成功路径带 error: ""')
  check(/const res = \{ ok: true, error: "", remotePath: remotePath \}/.test(src), 'push 成功路径带 error: ""')
  // issue #20 新增字段必须都在 schema 里（否则 additionalProperties:false 会把成功判成 invalid output）
  check(validate(syncOutput.schema, { ok: true, error: '', mirrorPath: '/m', bytes: 123, paths: ['src'] }).length === 0, 'issue #20 字段（bytes/paths）已声明')
  check(validate(syncOutput.schema, { ok: false, error: 'x', onlyMirrorTotal: 2, onlyMirror: ['a'] }).length === 0, '被拒清单字段（onlyMirror/onlyMirrorTotal）已声明')
  // 反向自检：把历史的坏 schema 喂给校验器，必须报错
  const badSchema = { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, error: { type: 'string', required: true } } }
  const badProblems = validate(badSchema, { ok: true, mirrorPath: '/m' })
  check(badProblems.length === 2, `自检：历史坏 schema 会报 2 条（实际 ${badProblems.length}）：${badProblems.join('；')}`)
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
