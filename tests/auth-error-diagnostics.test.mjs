// 认证失败诊断契约回归测试 —— 「连接腾讯云二维码认证被误报为失败」（issue #19，2026-10-04）
//
// 背景：用户贴出的「测试输出」里，真正的根因只有一行 Warning：
//     Warning: Identity file "C:\Users\<user>\.ssh\id_rsa.cloud_and_wsl" not accessible: No such file or directory.
//     <user>@<host>: Permission denied (publickey,password,keyboard-interactive).
// 但它被两件事埋掉了：
//   ① 私钥文件不存在的证据不是 debug1: 行，正好落在 testConnection 的 -v 诊断过滤器之外；
//   ② /etc/ssh/banner.txt 的**预认证登录横幅**（腾讯云的扫码二维码 ASCII 画）被拼进了「原始信息」的
//      300 字截断窗口，把关键行挤了出去 —— 用户因此以为"是扫码导致的连接失败"。
// 于是本轮给认证类失败补了三条纪律：
//   · 一手证据优先：私钥文件不存在 → 直接作为首条提示并给出路径；
//   · 交互式认证要说清边界：远端允许 password/keyboard-interactive（扫码、动态口令）≠ 本插件能走 ——
//     文件与工具能力是非交互公钥通道（BatchMode=yes + PreferredAuthentications=publickey），
//     交互式登录只能用内置「终端」页签（ssh -tt 交互通道，wrapper 里没有 BatchMode）；
//   · 登录横幅降噪：它是认证**之前**由远端打印的，与成败无关，不该占据截断窗口。
//
// 三层：
//   A. 纯函数：横幅降噪 / 私钥缺失识别 / 认证方式提取 / 诊断行优先截断
//   B. 端到端文案：把 issue 里的真实 stderr（已脱敏）喂进 sshErrorHint，断言证据在前、横幅不在
//   C. 接线与文档
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const src = readFileSync(root + '/lib/index.js', 'utf8')
const client = readFileSync(root + '/lib/client.js', 'utf8')
const changelog = readFileSync(root + '/CHANGELOG.md', 'utf8')
const readme = readFileSync(root + '/README.md', 'utf8')
const readmeEn = readFileSync(root + '/README_EN.md', 'utf8')
const maintenance = readFileSync(root + '/MAINTENANCE.md', 'utf8')
const pkg = JSON.parse(readFileSync(root + '/package.json', 'utf8'))

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

const diagLineSrc = src.split('\n').find(l => l.trim().startsWith('const SSH_DIAG_LINE'))
if (!diagLineSrc) throw new Error('SSH_DIAG_LINE not found')

const pure = new Function([
  diagLineSrc,
  grab(src, 'function stripPqBanner'),
  grab(src, 'function stripLoginBanner'),
  grab(src, 'function findMissingIdentityFile'),
  grab(src, 'function offeredAuthMethods'),
  grab(src, 'function sshExcerpt'),
  'return { stripPqBanner, stripLoginBanner, findMissingIdentityFile, offeredAuthMethods, sshExcerpt, SSH_DIAG_LINE };',
].join('\n'))()

const sshErrorHint = new Function(
  'stripLoginBanner', 'stripPqBanner', 'findMissingIdentityFile', 'offeredAuthMethods', 'sshExcerpt',
  'return (' + grab(src, 'function sshErrorHint') + ');'
)(pure.stripLoginBanner, pure.stripPqBanner, pure.findMissingIdentityFile, pure.offeredAuthMethods, pure.sshExcerpt)

// issue #19 的登录横幅（二维码 ASCII 画，取自报告里的真实形状）+ 脱敏后的两行关键证据
const QR_BANNER = [
  '██████████████████████████████████████████████████████████████████████',
  '██              ████  ██████████              ██  ████              ██',
  '██  ██████████  ██    ██    ████    ██  ████                        ██',
  '██  ██      ██  ██████  ██  ██████  ██  ██████████  ██████  ██      ██',
].join('\n')
const KEY_PATH = 'C:\\Users\\<user>\\.ssh\\id_rsa.cloud_and_wsl'
const EVIDENCE = [
  'Warning: Identity file "' + KEY_PATH + '" not accessible: No such file or directory.',
  '<user>@<host>: Permission denied (publickey,password,keyboard-interactive).',
].join('\n')
const REAL_STDERR = QR_BANNER + '\n' + EVIDENCE

// ---------------------------------------------------------------------------
console.log('A. 纯函数：横幅降噪 / 证据识别 / 认证方式 / 诊断行优先截断')
// ---------------------------------------------------------------------------
const cleaned = pure.stripLoginBanner(REAL_STDERR)
check(!cleaned.includes('█'), 'A1 登录横幅（二维码块）被丢弃')
check(cleaned.includes('已省略服务端登录横幅'), 'A2 明确告知用户省略了几行横幅（避免又被当成"报错内容"）')
check(cleaned.includes('Identity file') && cleaned.includes('Permission denied'), 'A3 诊断行原样保留')
check(pure.stripLoginBanner('debug1: Trying private key: /home/<user>/.ssh/id_rsa').includes('debug1:'), 'A4 debug 行永不被当成横幅')
check(pure.stripLoginBanner('ssh: connect to host <host> port 22: Connection refused').includes('Connection refused'), 'A5 连接错误行保留')
check(pure.stripLoginBanner('error') === 'error', 'A6 短行保留（可能是摘要）')
check(pure.stripLoginBanner('') === '', 'A7 空输入安全')
check(pure.stripLoginBanner(QR_BANNER + '\n' + QR_BANNER).match(/已省略服务端登录横幅 8 行/) !== null, 'A8 省略行数统计正确（8 行横幅）')

const miss = pure.findMissingIdentityFile(REAL_STDERR)
check(miss && miss.path === KEY_PATH, 'A9 带引号的 Identity file Warning 能取出路径：' + (miss && miss.path))
check(miss && /not accessible/.test(miss.line), 'A10 同时回带原始 Warning 行（可直接给用户看）')
const missUnix = pure.findMissingIdentityFile('Warning: Identity file /home/<user>/.ssh/id_ed25519 not accessible: No such file or directory.')
check(missUnix && missUnix.path === '/home/<user>/.ssh/id_ed25519', 'A11 无引号形式（Unix ssh）同样识别')
const missDbg = pure.findMissingIdentityFile('debug1: no such identity: /home/<user>/.ssh/id_rsa: No such file or directory')
check(missDbg && missDbg.path === '/home/<user>/.ssh/id_rsa', 'A12 debug1: no such identity 形式兜底')
check(pure.findMissingIdentityFile('<user>@<host>: Permission denied (publickey).') === null, 'A13 没有该证据时不误报')

check(pure.offeredAuthMethods(EVIDENCE) === 'publickey,password,keyboard-interactive', 'A14 从 Permission denied(...) 取认证方式')
check(pure.offeredAuthMethods('debug1: Authentications that can continue: publickey') === 'publickey', 'A15 回落 Authentications that can continue')
check(pure.offeredAuthMethods('ssh: connect to host <host> port 22: Connection refused') === '', 'A16 取不到时返回空串')

const ex = pure.sshExcerpt(REAL_STDERR)
check(ex.includes('Identity file') && ex.includes('Permission denied'), 'A17 截断优先保留诊断行')
check(!ex.includes('█'), 'A18 截断结果里没有二维码块')
check(pure.sshExcerpt('x'.repeat(600)).length <= 301, 'A19 超长内容按上限截断')
check(pure.sshExcerpt('x'.repeat(600)).endsWith('…'), 'A20 截断有省略标记')
check(pure.sshExcerpt('plain text without diagnostics') === 'plain text without diagnostics', 'A21 无诊断行时回落到原文')

// ---------------------------------------------------------------------------
console.log('B. 端到端文案：把 issue #19 的真实 stderr 喂进 sshErrorHint')
// ---------------------------------------------------------------------------
const msg = sshErrorHint(REAL_STDERR)
check(msg.startsWith('配置的私钥文件不存在或不可读：'), 'B1 一手证据提到最前面')
check(msg.includes(KEY_PATH), 'B2 直接给出出问题的私钥路径（用户一眼可改 keyPath）')
check(msg.includes('keyPath'), 'B3 给出可执行的修复动作（改 keyPath 或依赖 ssh-agent）')
check(!msg.includes('█'), 'B4 输出里不再出现二维码横幅')
check(!msg.includes('公钥认证失败（服务器拒绝了公钥）'), 'B5 不再用泛泛的"公钥认证失败"掩盖真实根因')
check(msg.includes('另：远端还允许 publickey,password,keyboard-interactive 认证'), 'B6 说明远端还允许交互式认证')
check(msg.includes('「终端」页签') && msg.includes('ssh -tt'), 'B7 指路：交互式登录用内置终端页签')
check(msg.includes('BatchMode') && msg.includes('PreferredAuthentications=publickey'), 'B8 讲清插件为何不能扫码（非交互公钥通道）')

const onlyKey = sshErrorHint('<user>@<host>: Permission denied (publickey).')
check(onlyKey.includes('公钥认证失败（服务器拒绝了公钥）'), 'B9 负向控制：仅公钥被拒时保留原提示')
check(!onlyKey.includes('另：远端还允许'), 'B10 负向控制：远端只提供公钥时不硬塞交互式建议')
check(sshErrorHint('ssh: connect to host <host> port 22: Connection refused').includes('连接被拒绝'), 'B11 其它分支不受影响（connection refused）')
check(sshErrorHint('remote port forwarding failed for listen port 2222').includes('端口转发失败'), 'B12 端口转发分支不受影响')
check(sshErrorHint('').length >= 0 && sshErrorHint(undefined).length >= 0, 'B13 空/undefined 输入不抛错')

// ---------------------------------------------------------------------------
console.log('C. 接线：host 预检与 -v 过滤器、客户端展示 warning、版本与文档')
// ---------------------------------------------------------------------------
const tc = grab(src, 'testConnection: async (args)')
check(tc.includes('existsSync(kp)'), 'C1 testConnection 对 keyPath 做存在性预检')
check(tc.includes('expandSshPath(p.keyPath)'), 'C2 预检前先展开 ~ 与 %USERPROFILE%（复用既有展开逻辑）')
check(tc.includes('p.authMethod === "key" && p.keyPath'), 'C3 只在密钥认证且填了 keyPath 时预检')
check(tc.includes('Object.assign({}, r, { warning: keyWarn })'), 'C4 预检发现问题但连接成功时，成功路径也带 warning')
check(tc.includes('(keyWarn ? keyWarn + "\\n" : "") + sshErrorHint('), 'C5 失败路径把预检结论前置')
check(!tc.includes('不阻断') || tc.includes('不阻断后续探测'), 'C6 预检不阻断探测（ssh-agent 场景仍可能成功）')
check(/Identity file \.\*not accessible/.test(tc), 'C7 -v 诊断过滤器新增 Identity file … not accessible')
check(tc.includes('.filter(Boolean).join("\\n")'), 'C8 送进 sshErrorHint 的 stderr 按行拼接（按行取诊断才有效）')
check(!src.includes('t.trim().slice(0, 300)'), 'C9 旧的 300 字硬截断已全部换成诊断行优先的 sshExcerpt')
check(src.includes('function sshExcerpt') && src.includes('function stripLoginBanner'), 'C10 两个新助手都在模块层（可被测试直接实例化）')
check(client.includes('r.warning ? r.warning + "\\n" : ""'), 'C11 设置页「测试连接」成功时展示 warning')
check(new Script(client) instanceof Script, 'C12 lib/client.js 语法可解析')

check(changelog.includes('[2.4.19]') && /issues\/19|issue #19/.test(changelog), 'C13 CHANGELOG 有 2.4.19 条目并引用 issue #19')
check(/keyboard-interactive|扫码/.test(readme) && readme.includes('私钥文件不存在'), 'C14 README 故障排查补了「扫码/键盘交互」与「私钥文件不存在」')
check(/keyboard-interactive|QR/.test(readmeEn) && /does not exist|not accessible/.test(readmeEn), 'C15 README_EN 同步')
check(maintenance.includes('#19') || maintenance.includes('登录横幅'), 'C16 MAINTENANCE 记录了这次的诊断教训')
check(pkg.version === '2.4.19', 'C17 package.json 版本号 = 2.4.19（当前 ' + pkg.version + '）')
check(readme.includes('dsh-remote-ssh@2.4.19'), 'C18 README 安装命令指向 2.4.19')

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败')
if (fail > 0) process.exit(1)
