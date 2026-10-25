// 密码认证运行时修复 回归测试（对应 PR：password auth never worked）。
//
// 根因：createNewSettingsFace 读设置用 svc.describe({ redactSecrets: true })，运行时
//   p.password 永远为空 → sshArgv 从不前置 sshpass → ssh 在管道上等密码提示 → 120s 超时。
//   该行为影响所有平台的密码连接，Windows 上因「没有 sshpass」再叠一层。
//
// 本文件覆盖：
//   A. settingsFace 运行时保留口令（redactSecrets:false）+ 边界脱敏（publicProfiles）
//   B. sshArgv：Windows 走 SSH_ASKPASS 环境变量；POSIX 仍前置 sshpass；缺口令就地报错
//   C. saveProfile 密码留空保留旧值（源码断言）
//   D. fs 拦截按 profileId 路由（源码断言）
//   E. ensureWindowsAskpass 助手幂等、无 BOM、口令元字符保真
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const src = readFileSync(root + '/lib/index.js', 'utf8')

async function loadDep(name, member) {
  const candidates = [
    process.env.DSH_PROFILE_DIR ? join(process.env.DSH_PROFILE_DIR, 'node_modules', name) : undefined,
    join(process.env.USERPROFILE || '', '.dsh', 'profiles', 'desktop', 'node_modules', name),
    join(root, 'node_modules', name),
  ].filter(Boolean)
  const dir = candidates.find((p) => {
    try { return readFileSync(join(p, 'package.json'), 'utf8').length > 0 } catch (e) { return false }
  })
  if (!dir) throw new Error('找不到依赖: ' + name)
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const entry = pkg.main || (pkg.exports && typeof pkg.exports === 'string' ? pkg.exports : 'index.js')
  const mod = await import(pathToFileURL(join(dir, entry)).href)
  if (member && mod[member] !== undefined) return mod[member]
  const def = mod.default && mod.default[member] !== undefined ? mod.default[member] : mod.default
  return def !== undefined ? def : mod
}
const z = await loadDep('@deepseek-ai/schemastery')

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

// ── 沙箱 1：settingsFace + publicProfiles（依赖少，直接函数提取） ──
const sandbox1Body =
  grab('function resolvePrefValue') + '\n' + grab('function prefsArray') + '\n' +
  grab('function prefsScalar') + '\n' + grab('function prefsNumber') + '\n' +
  grab('function normalizeSyncList') + '\n' + grab('function parseSyncMaxBytes') + '\n' +
  grab('function describePrefsShape') + '\n' + grab('function createNewSettingsFace') + '\n' +
  grab('function publicProfiles') +
  '\nreturn { createNewSettingsFace, publicProfiles };'
const apiSettings = new Function('join', 'readFile', 'z', sandbox1Body)(
  join,
  (await import('node:fs/promises')).readFile,
  z,
)

// ── 沙箱 2：sshArgv + ensureWindowsAskpass（依赖 sshExecutablePath / expandSshPath） ──
const sandbox2Body =
  'let cachedSshPath;\n' +
  grab('function sshExecutablePath') + '\n' + grab('function expandSshPath') + '\n' +
  grab('function ensureWindowsAskpass') + '\n' + grab('function sshArgv') +
  '\nreturn { sshExecutablePath, ensureWindowsAskpass, sshArgv };'
const apiSsh = new Function('join', 'homedir', 'mkdirSync', 'writeFileSync', 'existsSync', 'process', sandbox2Body)(
  join,
  homedir,
  mkdirSync,
  writeFileSync,
  existsSync,
  process,
)

let pass = 0, fail = 0
const check = (cond, label) => { if (cond) { pass++; console.log('  ✓ ' + label) } else { fail++; console.log('  ✗ FAIL: ' + label) } }

console.log('A · settingsFace 运行时保留口令 + 边界脱敏')
{
  const calls = []
  const value = { profiles: [{ id: 'p1', authMethod: 'password', password: 'secret-pw' }], workspaces: [] }
  const svc = {
    describe: (opts) => { calls.push(opts); return [{ ns: 'remote-ssh', value, revision: 1 }] },
    update: async () => {},
  }
  const built = apiSettings.createNewSettingsFace(svc, 'remote-ssh', {}, { warn: () => {} })
  const read = built.face.read()
  check(calls[0] && calls[0].redactSecrets === false, 'A1 describe 以 redactSecrets:false 调用（运行时拿到明文）')
  check(read.profiles[0].password === 'secret-pw', 'A2 settingsFace.read() 返回明文口令（sshArgv 需要）')

  const pub = apiSettings.publicProfiles(read.profiles)
  check(pub[0].password === undefined && pub[0].passwordConfigured === true, 'A3 publicProfiles 剥离口令、回 passwordConfigured')
  const pubEmpty = apiSettings.publicProfiles([{ id: 'x', authMethod: 'key', keyPath: '/k' }])
  check(pubEmpty[0].passwordConfigured === false, 'A4 无口令的 profile → passwordConfigured:false')
  check(!JSON.stringify(pub).includes('secret-pw'), 'A5 序列化后不出现明文口令')

  // A6: 工作区更新不碰 profiles（口令不会被写路径意外清掉）
  await built.face.updateWorkspaces([{ id: 'w1' }])
  check(built.face.read().profiles[0].password === 'secret-pw', 'A6 updateWorkspaces 后口令仍在')
}

console.log('B · sshArgv 平台分流')
{
  const p = { host: 'h', port: 22, user: 'u', authMethod: 'password', password: 'pw123' }
  const built = apiSsh.sshArgv(p, 'echo hi', false)
  if (process.platform === 'win32') {
    check(built.argv[0] && String(built.argv[0]).toLowerCase().includes('ssh'), 'B1(w) argv[0] 是 ssh 客户端（无 sshpass 前缀）')
    check(built.env && built.env.SSH_ASKPASS && built.env.SSH_ASKPASS_REQUIRE === 'force', 'B2(w) env 带 SSH_ASKPASS + force')
    check(built.env && built.env.DSH_REMOTE_SSH_PW === 'pw123', 'B3(w) 口令经环境变量传递')
    check(!built.argv.some(a => String(a).includes('pw123')), 'B4(w) argv 里不出现明文口令')
  } else {
    check(built.argv[0] === 'sshpass' && built.argv[1] === '-p' && built.argv[2] === 'pw123', 'B1(p) POSIX 前置 sshpass -p')
    check(built.env === undefined, 'B2(p) POSIX 不注入 askpass 环境变量')
  }
  const k = { host: 'h', port: 22, user: 'u', authMethod: 'key', keyPath: '/id_x' }
  const kb = apiSsh.sshArgv(k, 'echo hi', false)
  check(kb.env === undefined, 'B5 key 认证不注入密码环境')
  check(kb.argv.includes('BatchMode=yes'), 'B6 key 认证仍带 BatchMode（非交互公钥通道不变）')
  const nopw = { host: 'h', port: 22, user: 'u', authMethod: 'password', password: '' }
  let threw = false
  try { apiSsh.sshArgv(nopw, 'echo hi', false) } catch (e) { threw = true }
  check(threw, 'B7 密码缺失（非 tty）→ 立即抛错，不让 ssh 挂等提示')
  const ttyBuilt = apiSsh.sshArgv(nopw, undefined, true)
  check(Array.isArray(ttyBuilt.argv), 'B8 密码缺失但 tty → 不抛（交互终端由用户输入）')
}

console.log('C · saveProfile 密码留空保留旧值（源码断言）')
{
  check(src.includes('password: p.authMethod === "password" ? (p.password || (existing && existing.password) || "") : ""'),
    'C1 留空时回退 existing.password')
  check(src.includes('passwordConfigured'), 'C2 源码引入 passwordConfigured 字段')
}

console.log('D · fs 拦截按 profileId 路由（源码断言）')
{
  check(src.includes('remoteInfo && remoteInfo.profileId && remoteInfo.host && remoteInfo.user'),
    'D1 拦截条件用 profileId（密码工作区文件面板可用）')
  check(!src.includes('remoteInfo && remoteInfo.keyPath && remoteInfo.host && remoteInfo.user'),
    'D2 旧的 keyPath 前置条件已移除')
}

console.log('E · ensureWindowsAskpass 助手')
{
  // 单独实例化沙箱，homedir 指向临时目录 —— 不污染真实 ~/.dsh/remote-ssh
  const fakeHome = mkdtempSync(join(tmpdir(), 'rssh-askpass-'))
  const apiAsk = new Function('join', 'homedir', 'mkdirSync', 'writeFileSync', 'existsSync', 'process', sandbox2Body)(
    join, () => fakeHome, mkdirSync, writeFileSync, existsSync, process,
  )
  const file = apiAsk.ensureWindowsAskpass()
  check(existsSync(file), 'E1 助手已生成: ' + file)
  check(file === join(fakeHome, '.dsh', 'remote-ssh', 'askpass.cmd'), 'E2 位于 <home>/.dsh/remote-ssh/（与终端 wrapper 同目录）')
  const again = apiAsk.ensureWindowsAskpass()
  check(again === file, 'E3 幂等（重复调用返回同一路径）')
  const head = readFileSync(file).subarray(0, 3)
  check(!(head[0] === 0xEF && head[1] === 0xBB && head[2] === 0xBF), 'E4 无 BOM（BOM 会挂掉首行命令）')
  const body = readFileSync(file, 'utf8')
  check(body.includes('@<nul set /p x="%DSH_REMOTE_SSH_PW%"'), 'E4b 第一行 set /p 引号保护（口令元字符保真）')
  check(/^@echo\./m.test(body), 'E4c 第二行 @echo. 补尾换行（readpass 按行读，无换行会读到空口令）')
  if (process.platform === 'win32') {
    // 有的受限运行环境（沙箱 CI runner）禁止 spawnSync —— 防御性降级，不让测试 crash。
    let canSpawn = true
    try {
      execFileSync('cmd.exe', ['/c', 'exit 0'], { stdio: 'ignore' })
    } catch (e) {
      canSpawn = false
      console.log('  （探测失败: ' + (e && e.code ? e.code : e.message) + ' → E5/E6 降级为源码断言）')
    }
    if (canSpawn) {
      const cases = ['plain123', 'a&b', 'caret^x', 'sp ace', 'quote"x', 'mix & ^ ! % "']
      const outFile = join(fakeHome, 'probe.out')
      const runProbe = (pw) => {
        try { rmSync(outFile, { force: true }) } catch (e) {}
        // set /p 读 nul 返回非零退出码 —— & exit 0 归一，判输出不判退出码
        execFileSync('cmd.exe', ['/c', file + ' > ' + outFile + ' & exit 0'], {
          env: { ...process.env, DSH_REMOTE_SSH_PW: pw },
          stdio: 'ignore'
        })
        return readFileSync(outFile, 'utf8').replace(/\r?\n$/, '')
      }
      let allOk = true
      for (const pw of cases) {
        let out = null
        try { out = runProbe(pw) }
        catch (e) { allOk = false; console.log('      E5 运行失败: ' + (e && e.code ? e.code : e.message)); break }
        if (out !== pw) { allOk = false; console.log('      E5 差异: [' + pw + '] -> [' + out + ']') }
      }
      check(allOk, 'E5 含 & ^ ! 空格 引号 % 的口令全部原样保真（set /p 引号保护）')
      let probe = null
      try {
        // 直接读原始字节验证尾换行
        try { rmSync(outFile, { force: true }) } catch (e) {}
        execFileSync('cmd.exe', ['/c', file + ' > ' + outFile + ' & exit 0'], {
          env: { ...process.env, DSH_REMOTE_SSH_PW: 't' }, stdio: 'ignore'
        })
        probe = readFileSync(outFile, 'utf8')
      } catch (e) { console.log('      E6 运行失败: ' + (e && e.code ? e.code : e.message)) }
      check(probe !== null && probe.replace(/\r?\n$/, '') === 't' && /\n$/.test(probe), 'E6 输出带尾换行（OpenSSH readpass 语义）')
      try { rmSync(outFile, { force: true }) } catch (e) {}
    } else {
      console.log('  （受限环境无法 spawn cmd.exe：E5/E6 降级为源码断言）')
      check(readFileSync(file, 'utf8').includes('set /p x="%DSH_REMOTE_SSH_PW%"'), 'E5(降级) 助手源码含 set /p 引号保护')
    }
  } else {
    console.log('  （非 Windows：跳过 E5/E6 真机 cmd 检查）')
  }
  try { rmSync(fakeHome, { recursive: true, force: true }) } catch (e) {}
}

console.log('')
console.log('结果: ' + pass + ' 通过, ' + fail + ' 失败')
if (fail > 0) process.exit(1)