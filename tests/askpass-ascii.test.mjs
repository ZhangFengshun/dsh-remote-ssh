// issue #36 回归测试：Windows 用户名含非 ASCII 字符时，password 认证全链路失效。
//
// 根因（真机复现，OpenSSH_for_Windows_9.5p2 / Win11）：
//   Windows OpenSSH 用**窄字符路径**启动 askpass 助手（CreateProcessW / posix_spawnp），
//   SSH_ASKPASS 指向含中文的路径时直接失败：
//       ssh_askpass: posix_spawnp: No such file or directory
//       CreateProcessW failed error:2
//   助手没跑起来 → ssh 把**空口令**发给服务端 → 服务端只回 Permission denied。
//   插件此前把助手写在 ~/.dsh/remote-ssh/askpass.cmd，而中文用户名下 %USERPROFILE% 与 %TEMP%
//   都不是 ASCII，于是整条密码认证 100% 失败，错误提示还误导成「公钥认证失败 / 检查 keyPath」。
//
// 本文件覆盖：
//   A. ensureWindowsAskpass：ProgramData → Public → 用户目录 回退、纯 ASCII 校验、
//      DSH_REMOTE_SSH_ASKPASS 覆盖、助手内容（无 BOM / CRLF / 两行 / 不含口令）、按用户分文件名
//   B. sshArgv：Windows 密码认证指向 ASCII 落点；找不到 ASCII 落点时抛**明确**错误；POSIX/key 不受影响
//   C. sshErrorHint：按认证方式归因 —— askpass 证据优先、密码连接不再提 keyPath、key 连接行为不变
//   D. 真机 OpenSSH E2E（Windows + ssh-keygen 可用时）：中文路径失败 / ASCII 路径成功 / 插件落点成功
//   E. 源码接线断言
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

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
function grabConst(pattern, label) {
  const m = src.match(pattern)
  if (!m) throw new Error(label + ' not found')
  return m[0]
}

const askpassScriptConst = grabConst(/const ASKPASS_SCRIPT = [\s\S]*?;\n/, 'ASKPASS_SCRIPT')
const askpassBody =
  'let cachedSshPath;\n' + askpassScriptConst + '\n' +
  grab('function isAsciiAskpassPath') + '\n' + grab('function askpassFileName') + '\n' +
  grab('function writeAskpassAt') + '\n' + grab('function ensureWindowsAskpass') +
  '\nreturn { ensureWindowsAskpass };'
const argvBody =
  'let cachedSshPath;\n' + grab('function sshExecutablePath') + '\n' + grab('function expandSshPath') + '\n' +
  askpassScriptConst + '\n' +
  grab('function isAsciiAskpassPath') + '\n' + grab('function askpassFileName') + '\n' +
  grab('function writeAskpassAt') + '\n' +
  grab('function ensureWindowsAskpass') + '\n' + grab('function sshArgv') +
  '\nreturn { sshExecutablePath, ensureWindowsAskpass, sshArgv };'
const hintBody =
  grabConst(/const SSH_DIAG_LINE = .*;\n/, 'SSH_DIAG_LINE') + '\n' +
  grab('function stripPqBanner') + '\n' + grab('function stripLoginBanner') + '\n' +
  grab('function findMissingIdentityFile') + '\n' + grab('function offeredAuthMethods') + '\n' +
  grab('function sshExcerpt') + '\n' + grab('function sshErrorHint') +
  '\nreturn { sshErrorHint };'

/** 造一个沙箱：homedir 与 env（ProgramData / PUBLIC / DSH_REMOTE_SSH_ASKPASS）都可注入。 */
function makeAskpass(homeDir, env) {
  return new Function('join', 'dirname', 'homedir', 'mkdirSync', 'writeFileSync', 'existsSync', 'process', 'createHash', askpassBody)(
    join, dirname, () => homeDir, mkdirSync, writeFileSync, existsSync,
    { platform: 'win32', env: env }, createHash,
  )
}
function makeSshArgv(homeDir, env) {
  return new Function('join', 'dirname', 'homedir', 'mkdirSync', 'writeFileSync', 'existsSync', 'process', 'createHash', argvBody)(
    join, dirname, () => homeDir, mkdirSync, writeFileSync, existsSync,
    { platform: 'win32', env: env }, createHash,
  )
}
const apiHint = new Function('join', hintBody)(join)

let pass = 0, fail = 0
const check = (cond, label) => { if (cond) { pass++; console.log('  ✓ ' + label) } else { fail++; console.log('  ✗ FAIL: ' + label) } }
const ASCII = /^[\x20-\x7E]+$/

const sandbox = mkdtempSync(join(tmpdir(), 'rssh-ask36-'))
try {

console.log('A · askpass 落盘位置（issue #36 核心）')
{
  const cnHome = join(sandbox, '中文用户')
  mkdirSync(cnHome, { recursive: true })
  const pd = join(sandbox, 'ProgramData')
  const pub = join(sandbox, 'Public')
  const env = { ProgramData: pd, PUBLIC: pub }

  const got = makeAskpass(cnHome, env).ensureWindowsAskpass()
  check(got.ascii === true && existsSync(got.file), 'A1 落点可用（ascii:true 且文件已生成）')
  check(!got.file.startsWith(cnHome), 'A2 不落在含非 ASCII 字符的用户目录')
  check(ASCII.test(got.file), 'A3 落点路径纯 ASCII')
  check(got.file.startsWith(join(pd, 'dsh-remote-ssh')), 'A4 首选 ProgramData（多用户共享的 ASCII 目录）')
  const body = readFileSync(got.file, 'utf8')
  check(body === '@<nul set /p x="%RSSH_ASKPASS_PW%"\r\n@echo.\r\n', 'A5 助手内容严格两行 + CRLF（readpass 按行读）')
  check(!body.includes('\uFEFF'), 'A6 无 BOM')
  check(!/\bpass|pw|口令/i.test(body.replace('%RSSH_ASKPASS_PW%', '')), 'A7 脚本本身不含任何口令（只读环境变量）')

  // 同名两次：稳定；不同 home：不同文件名（多用户共用 ProgramData 不互相踩）
  const a1 = makeAskpass(cnHome, env).ensureWindowsAskpass().file
  const other = join(sandbox, '另一个用户')
  const a2 = makeAskpass(other, env).ensureWindowsAskpass().file
  check(a1 === got.file, 'A8 同用户幂等（路径稳定）')
  check(a2 !== a1, 'A9 不同用户文件名不同（按 home 隔离）')

  // ProgramData 不可写（用同名的**文件**占位，mkdir 必失败）→ 回退 Public
  const pdBlocked = join(sandbox, 'blockedProgramData')
  writeFileSync(pdBlocked, 'x')
  const fb = makeAskpass(cnHome, { ProgramData: pdBlocked, PUBLIC: pub }).ensureWindowsAskpass()
  check(fb.ascii === true && fb.file.startsWith(join(pub, 'dsh-remote-ssh')), 'A10 ProgramData 不可写 → 回退 Public')

  // 全部候选都非 ASCII / 不可写 → ascii:false（由 sshArgv 抛明确错误）
  const allBad = makeAskpass(cnHome, { ProgramData: join(cnHome, '程序数据'), PUBLIC: join(cnHome, '公共') }).ensureWindowsAskpass()
  check(allBad.ascii === false, 'A11 无可用 ASCII 落点 → ascii:false')

  // 显式覆盖：DSH_REMOTE_SSH_ASKPASS 指向 ASCII 文件 → 直接用它
  const custom = join(sandbox, 'custom', 'my-askpass.cmd')
  const ov = makeAskpass(cnHome, { DSH_REMOTE_SSH_ASKPASS: custom, ProgramData: pd, PUBLIC: pub }).ensureWindowsAskpass()
  check(ov.ascii === true && ov.file === custom && existsSync(custom), 'A12 DSH_REMOTE_SSH_ASKPASS 覆盖生效')
  // 覆盖值非 ASCII → 不采用，回退内置落点
  const ovBad = makeAskpass(cnHome, { DSH_REMOTE_SSH_ASKPASS: join(cnHome, '助手.cmd'), ProgramData: pd, PUBLIC: pub }).ensureWindowsAskpass()
  check(ovBad.ascii === true && ASCII.test(ovBad.file), 'A13 覆盖值非 ASCII 时忽略并回退（不把坏路径交给 ssh）')
}

console.log('B · sshArgv 接线')
{
  const cnHome = join(sandbox, '中文用户B')
  mkdirSync(cnHome, { recursive: true })
  const env = { ProgramData: join(sandbox, 'PD-B'), PUBLIC: join(sandbox, 'PUB-B') }
  const api = makeSshArgv(cnHome, env)
  const pw = { host: 'h', port: 22, user: 'u', authMethod: 'password', password: 'p@ss&^!' }
  const built = api.sshArgv(pw, 'echo hi', false)
  check(built.env && built.env.SSH_ASKPASS && ASCII.test(built.env.SSH_ASKPASS), 'B1 SSH_ASKPASS 指向纯 ASCII 路径')
  check(built.env.SSH_ASKPASS_REQUIRE === 'force' && built.env.DISPLAY, 'B2 保留 SSH_ASKPASS_REQUIRE=force + DISPLAY')
  check(built.env.RSSH_ASKPASS_PW === 'p@ss&^!' && !built.argv.some((a) => String(a).includes('p@ss&^!')), 'B3 口令只经环境变量（不进 argv）')

  // 无可用 ASCII 落点 → 立即抛错（不再让 ssh 发空口令 + 误报「公钥失败」）
  const apiBad = makeSshArgv(cnHome, { ProgramData: join(cnHome, '程序数据'), PUBLIC: join(cnHome, '公共') })
  let threw = null
  try { apiBad.sshArgv(pw, 'echo hi', false) } catch (e) { threw = e }
  check(!!threw, 'B4 无 ASCII 落点 → 抛错（不让 ssh 发空口令）')
  check(threw && /非 ASCII/.test(threw.message) && /DSH_REMOTE_SSH_ASKPASS/.test(threw.message) && /密钥认证/.test(threw.message),
    'B5 错误文案给出两条可执行出路（环境变量 / 密钥认证）')

  // key 认证不受影响（不注入密码环境）
  const kb = api.sshArgv({ host: 'h', port: 22, user: 'u', authMethod: 'key', keyPath: '/k' }, 'echo hi', false)
  check(kb.env === undefined && kb.argv.includes('BatchMode=yes'), 'B6 key 认证仍走 BatchMode 公钥通道')

  // POSIX 分支不变（平台分流只看 process.platform）
  const posix = new Function('join', 'dirname', 'homedir', 'mkdirSync', 'writeFileSync', 'existsSync', 'process', 'createHash', argvBody)(
    join, dirname, () => cnHome, mkdirSync, writeFileSync, existsSync, { platform: 'linux', env: {} }, createHash,
  )
  const pb = posix.sshArgv(pw, 'echo hi', false)
  check(pb.argv[0] === 'sshpass' && pb.argv[2] === 'p@ss&^!' && pb.env === undefined, 'B7 POSIX 仍前置 sshpass（行为不变）')
}

console.log('C · 错误归因（把用户带向正确方向）')
{
  const pwProfile = { host: 'h', user: 'u', authMethod: 'password' }
  const keyProfile = { host: 'h', user: 'u', authMethod: 'key', keyPath: '/x/id_rsa' }

  // issue #36 现场日志（节选）：askpass 启动失败 + 服务端拒绝
  const reproLog = [
    'debug1: read_passphrase: requested to askpass',
    'ssh_askpass: posix_spawnp: No such file or directory',
    'ave@h: Permission denied, please try again.',
    'ave@h: Permission denied (publickey,password).',
  ].join('\n')
  const h1 = apiHint.sshErrorHint(reproLog, pwProfile)
  check(/askpass/.test(h1), 'C1 askpass 启动失败被识别')
  check(/非 ASCII/.test(h1) && /DSH_REMOTE_SSH_ASKPASS/.test(h1), 'C2 给出非 ASCII 根因 + 覆盖环境变量出路')
  check(!/公钥认证失败/.test(h1) && !/keyPath/.test(h1), 'C3 不再误导成「公钥认证失败 / 检查 keyPath」')

  // 纯 Permission denied（密码连接）：仍按密码归因
  const h2 = apiHint.sshErrorHint('Permission denied, please try again.\nave@h: Permission denied (publickey,password).', pwProfile)
  check(/密码认证失败/.test(h2), 'C4 密码连接拒绝 → 明确说密码')
  check(!/keyPath/.test(h2) && !/公钥认证失败/.test(h2), 'C5 密码连接不提 keyPath / 公钥收录')
  check(/PasswordAuthentication/.test(h2) && /publickey,password/.test(h2), 'C6 提示口令与 sshd 侧开关，并回传协商到的认证方法')

  // key 连接：原有归因保持不变
  const h3 = apiHint.sshErrorHint('Permission denied (publickey).', keyProfile)
  check(/公钥认证失败/.test(h3) && /keyPath/.test(h3) && /authorized_keys/.test(h3), 'C7 key 连接仍给 keyPath / authorized_keys 清单')
  const h4 = apiHint.sshErrorHint('Warning: Identity file /x/id_rsa not accessible: No such file or directory.', keyProfile)
  check(/私钥文件不存在或不可读/.test(h4) && h4.includes('/x/id_rsa'), 'C8 私钥缺失的一手证据仍排在最前（issue #19 回归）')
  // 密码连接不应因 stderr 里出现 Identity file 字样就转去说私钥
  const h5 = apiHint.sshErrorHint('Warning: Identity file /x/id_rsa not accessible: No such file or directory.\nPermission denied (publickey,password).', pwProfile)
  check(!/私钥文件不存在/.test(h5), 'C9 密码连接不查私钥（避免张冠李戴）')
}

console.log('D · 真机 OpenSSH E2E（路径是否可被 CreateProcessW 接受）')
{
  const keygen = 'C:\\Windows\\System32\\OpenSSH\\ssh-keygen.exe'
  if (process.platform !== 'win32' || !existsSync(keygen)) {
    console.log('  （非 Windows 或无 ssh-keygen：跳过真机 E2E）')
  } else {
    const work = join(sandbox, 'e2e')
    const cnDir = join(work, '中文目录')
    const asciiDir = join(work, 'ascii')
    mkdirSync(cnDir, { recursive: true })
    mkdirSync(asciiDir, { recursive: true })
    const script = '@<nul set /p x="%RSSH_ASKPASS_PW%"' + String.fromCharCode(13, 10) + '@echo.' + String.fromCharCode(13, 10)
    const cnAsk = join(cnDir, 'askpass.cmd')
    const asciiAsk = join(asciiDir, 'askpass.cmd')
    writeFileSync(cnAsk, script, { encoding: 'ascii' })
    writeFileSync(asciiAsk, script, { encoding: 'ascii' })

    const key = join(asciiDir, 'id_enc')
    execFileSync(keygen, ['-t', 'ed25519', '-N', 'pass1', '-f', key, '-q'], { stdio: 'ignore' })

    const runChange = (askpass, fromPw, toPw) => {
      try {
        execFileSync(keygen, ['-p', '-f', key, '-N', toPw, '-q'], {
          env: Object.assign({}, process.env, { SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: 'localhost:0', RSSH_ASKPASS_PW: fromPw }),
          stdio: 'pipe', encoding: 'utf8',
        })
        return { ok: true, err: '' }
      } catch (e) {
        return { ok: false, err: String((e && (e.stderr || e.message)) || '') }
      }
    }

    const bad = runChange(cnAsk, 'pass1', 'pass2')
    if (bad.ok) {
      console.log('  （本机 OpenSSH 处理非 ASCII askpass 路径正常，D1 复现不成立 → 跳过该断言）')
    } else {
      check(/ssh_askpass|posix_spawnp|CreateProcessW/i.test(bad.err), 'D1 中文路径 askpass → OpenSSH 启动失败（issue #36 现象）')
    }
    const good = runChange(asciiAsk, 'pass1', 'pass2')
    check(good.ok, 'D2 同一份脚本放到 ASCII 路径 → 成功（唯一变量就是路径）')

    // 插件在「中文 home」环境里选出的落点，必须能被真实 OpenSSH 接受
    const apiAsk = makeAskpass(join(work, '中文用户'), { ProgramData: join(asciiDir, 'ProgramData'), PUBLIC: join(asciiDir, 'Public') })
    const chosen = apiAsk.ensureWindowsAskpass()
    check(chosen.ascii === true && ASCII.test(chosen.file), 'D3a 插入环境选出的落点是纯 ASCII')
    const viaPlugin = runChange(chosen.file, 'pass2', 'pass3')
    check(viaPlugin.ok, 'D3b 插件落点被真实 ssh-keygen 接受（密码认证可用的直接证据）')
  }
}

console.log('E · 源码接线')
{
  const calls = src.match(/sshErrorHint\(/g) || []
  check(calls.length >= 4, 'E1 sshErrorHint 仍有定义 + 3 个调用点（实际 ' + calls.length + ' 处）')
  const withProfile = (src.match(/sshErrorHint\([^)]*,\s*p\)/g) || []).length
  check(withProfile === 3, 'E2 三个调用点都传了 profile（按认证方式归因的前提，实际 ' + withProfile + ' 处）')
  check(/authMethod === "password" && \/permission denied\/i\.test\(t\)/.test(src), 'E3 密码分支存在')
  check(/authMethod === "password" \? null : findMissingIdentityFile\(t\)/.test(src), 'E4 密码连接不查私钥')
  check(src.includes('DSH_REMOTE_SSH_ASKPASS'), 'E5 文档化的环境变量覆盖点存在')
  check(/isAsciiAskpassPath/.test(src) && /ProgramData/.test(src) && /PUBLIC/.test(src), 'E6 ASCII 校验 + ProgramData/Public 回退')
}
} finally {
  try { rmSync(sandbox, { recursive: true, force: true }) } catch (e) {}
}

console.log('')
console.log('结果: ' + pass + ' 通过, ' + fail + ' 失败')
if (fail > 0) process.exit(1)
