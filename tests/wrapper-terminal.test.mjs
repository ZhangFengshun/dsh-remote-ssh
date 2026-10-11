// 终端 wrapper 回归测试（issue #7）：验证生成的 dsh-remote-shell.js 在远程工作区里
// 会把终端 cd 到工作区对应的远程目录（remotePath），而不是落在远程 $HOME。
// issue #21 补充：ProxyJump 分支此前**没有任何场景走过**，于是 args.splice(2,0,'-J',…) 把
// ProxyJump 插进 '-o' 与其取值之间也没人发现 —— 所以下面除结构化断言外，还加了一条
// 真实 ssh 的离线判据（`ssh -G`：只解析配置、不连网），让"ssh 会不会吃下这串 argv"由 ssh 自己回答。
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const src = readFileSync(join(root, 'lib', 'index.js'), 'utf8')

// ---- 1. 提取生成的 wrapper 脚本文本 ----
const marker = 'const wrapperJs = ['
const start = src.indexOf(marker)
if (start < 0) throw new Error('wrapperJs 数组字面量未找到')
const endMarker = '].join("\\n");'
const end = src.indexOf(endMarker, start)
if (end < 0) throw new Error('wrapperJs 结尾未找到')
const literal = src.slice(start + marker.length - 1, end + 1)
const scriptText = new Function('return ' + literal)().join('\n')

// 生成脚本本身必须是合法 JS
new Function(scriptText)

let pass = 0
let fail = 0
const check = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label) }
  else { fail++; console.log('  ✗ FAIL: ' + label) }
}

const RUNNER = `
const Module = require('node:module');
const fs = require('node:fs');
const [target, cwdDir, capture] = process.argv.slice(2);
const orig = Module._load;
Module._load = function (request) {
  if (request === 'child_process' || request === 'node:child_process') {
    return {
      spawn(bin, args, opts) {
        fs.appendFileSync(capture, JSON.stringify({ bin, args, stdio: opts && opts.stdio }) + '\\n');
        return { on() {} };
      }
    };
  }
  return orig.apply(this, arguments);
};
process.chdir(cwdDir);
require(target);
`

/** 跑一个场景，返回 { spawns, stderr } */
function runScenario(name, connInfo) {
  const dir = mkdtempSync(join(tmpdir(), 'rssh-wrapper-'))
  try {
    writeFileSync(join(dir, 'wrapper.js'), scriptText, 'utf8')
    writeFileSync(join(dir, 'runner.cjs'), RUNNER, 'utf8')
    if (connInfo) writeFileSync(join(dir, '.remote-ssh.json'), JSON.stringify(connInfo, null, 2), 'utf8')
    const capture = join(dir, 'capture.jsonl')
    writeFileSync(capture, '')
    let stderr = ''
    try {
      execFileSync(process.execPath, [join(dir, 'runner.cjs'), join(dir, 'wrapper.js'), dir, capture], {
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
      })
    } catch (e) {
      stderr = String(e.stderr || '')
      throw e
    }
    const spawns = readFileSync(capture, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    return { name, spawns, stderr }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const keyProfile = { host: 'hpc.example.org', user: 'wxq', port: 2222, keyPath: '/home/u/.ssh/id_ed25519' }

console.log('场景 1 · remotePath = ~/work/my-project（issue #7 主场景）')
{
  const { spawns } = runScenario('tilde-sub', { ...keyProfile, remotePath: '~/work/my-project' })
  check(spawns.length === 1, '只 spawn 一次（ssh）')
  const { bin, args } = spawns[0]
  check(args[0] === '-tt', '带 -tt 交互式通道')
  check(args.includes('-p') && args.includes('2222'), '带端口')
  check(args.includes('-i') && args.includes(keyProfile.keyPath), '带密钥')
  check(args[args.length - 2] === 'wxq@hpc.example.org', '目标 user@host 正确')
  const cmd = args[args.length - 1]
  check(cmd === 'cd "$HOME/work/my-project" 2>/dev/null || cd "$HOME"; exec "${SHELL:-/bin/bash}" -l',
    '远程命令：远端展开 ~ + 失败回退 $HOME + exec 登录 shell')
  check(cmd.includes('$HOME/work/my-project') && !cmd.includes('/home/u/work'), '~ 交给远端展开（未用本地 homedir）')
  check(bin.length > 0, `ssh 可执行文件解析为 ${bin}`)
}

console.log('场景 2 · remotePath = ~')
{
  const { spawns } = runScenario('tilde', { ...keyProfile, remotePath: '~' })
  const cmd = spawns[0].args[spawns[0].args.length - 1]
  check(cmd.startsWith('cd "$HOME" '), '落在 $HOME（与旧行为一致）')
}

console.log('场景 3 · absolute remotePath')
{
  const { spawns } = runScenario('absolute', { ...keyProfile, remotePath: '/data/proj' })
  const cmd = spawns[0].args[spawns[0].args.length - 1]
  check(cmd.startsWith('cd "/data/proj" '), '绝对路径原样使用')
}

console.log('场景 4 · 无 remotePath（向后兼容，旧标记文件）')
{
  const { spawns } = runScenario('none', { ...keyProfile })
  const args = spawns[0].args
  check(!args.some((a) => typeof a === 'string' && a.startsWith('cd ')), '不追加远程命令（行为与 2.4.4 之前一致）')
}

console.log('场景 5 · 非密钥认证的远程工作区 → 提示 + 本地 shell')
{
  const dir = mkdtempSync(join(tmpdir(), 'rssh-wrapper-'))
  try {
    writeFileSync(join(dir, 'wrapper.js'), scriptText, 'utf8')
    writeFileSync(join(dir, 'runner.cjs'), RUNNER, 'utf8')
    writeFileSync(join(dir, '.remote-ssh.json'), JSON.stringify({ ...keyProfile, keyPath: '', remotePath: '~/x' }), 'utf8')
    const capture = join(dir, 'capture.jsonl')
    writeFileSync(capture, '')
    const out = execFileSync(process.execPath, [join(dir, 'runner.cjs'), join(dir, 'wrapper.js'), dir, capture], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    }).toString()
    const spawns = readFileSync(capture, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    check(spawns.length === 1 && !spawns[0].bin.includes('ssh'), '未 spawn ssh（回落本地 shell）')
    check(spawns[0].stdio === 'inherit', '本地 shell 继承 stdio')
    // runner 的 stdout 不含警告（警告走 stderr）；用同步 API 读回 stderr：
    check(typeof out === 'string', 'runner 正常结束（exit 0）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log('场景 5b · 同上，校验 stderr 提示文案确实打印')
{
  const dir = mkdtempSync(join(tmpdir(), 'rssh-wrapper-'))
  try {
    writeFileSync(join(dir, 'wrapper.js'), scriptText, 'utf8')
    writeFileSync(join(dir, 'runner.cjs'), RUNNER, 'utf8')
    writeFileSync(join(dir, '.remote-ssh.json'), JSON.stringify({ ...keyProfile, keyPath: '', remotePath: '~/x' }), 'utf8')
    const capture = join(dir, 'capture.jsonl')
    writeFileSync(capture, '')
    // execFileSync 默认把子进程 stderr 透传给父进程；这里显式捕获
    let stderr = ''
    try {
      execFileSync(process.execPath, [join(dir, 'runner.cjs'), join(dir, 'wrapper.js'), dir, capture], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
    } catch (e) {
      stderr = String(e.stderr || '')
    }
    // 用 spawnSync 重新跑一次以稳定拿到 stderr
    const { spawnSync } = await import('node:child_process')
    const r = spawnSync(process.execPath, [join(dir, 'runner.cjs'), join(dir, 'wrapper.js'), dir, capture], { encoding: 'utf8' })
    const err = String(r.stderr || '')
    check(/dsh-remote-ssh/.test(err) && /密钥认证/.test(err), 'stderr 打出「仅支持密钥认证，已回退为本地 shell」提示')
    check(/key-authenticated/.test(err), '附英文提示')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---- 结构不变式：'-o' 必须紧跟自己的取值，且取值不能是另一个选项 ----
function checkOptionPairs(args, tag) {
  let bad = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-o') {
      const v = args[i + 1]
      if (typeof v !== 'string' || v.startsWith('-') || !v.includes('=')) bad.push(`-o -> ${JSON.stringify(v)}`)
    }
    if (args[i] === '-J' || args[i] === '-p' || args[i] === '-i') {
      const v = args[i + 1]
      if (typeof v !== 'string' || v === '' || v.startsWith('-')) bad.push(`${args[i]} -> ${JSON.stringify(v)}`)
    }
  }
  check(bad.length === 0, `${tag}：每个选项都紧跟自己的取值（${bad.length ? bad.join('; ') : '无交叉'}）`)
}

/** 用真实 ssh 做离线判据：`ssh -G` 只解析命令行/config、不建立连接。返回 { ok, stdout, stderr, skipped } */
function sshConfigDump(args) {
  const bin = process.env.DSH_TEST_SSH || 'ssh'
  const probe = spawnSync(bin, ['-G'].concat(args), { encoding: 'utf8' })
  if (probe.error) return { skipped: true, reason: String(probe.error.code || probe.error.message) }
  return { ok: probe.status === 0, stdout: String(probe.stdout || ''), stderr: String(probe.stderr || ''), status: probe.status }
}

console.log('场景 6 · ProxyJump（issue #21 主场景：填了跳板机，终端立即退出 255）')
{
  const { spawns } = runScenario('proxy', { ...keyProfile, proxyJump: 'jump-host', remotePath: '~/work/my-project' })
  const { args } = spawns[0]
  check(spawns.length === 1, '只 spawn 一次（ssh）')
  check(args.includes('-J') && args[args.indexOf('-J') + 1] === 'jump-host', '-J 与跳板机取值成对出现')
  checkOptionPairs(args.slice(0, -1), '含 ProxyJump 的 argv')
  check(args[args.length - 2] === 'wxq@hpc.example.org', '目标 user@host 仍是最后一个选项之后的位置')
  check(args[args.length - 1].startsWith('cd "$HOME/work/my-project"'), '远程命令仍被追加（cd + 登录 shell）')
  const idx = args.indexOf('-J')
  check(idx > args.indexOf('ExitOnForwardFailure=no'), '-J 排在所有 -o 对之后（不插进任何 -o 与取值之间）')
}

console.log('场景 6b · ProxyJump 取值原样传递（user@host:port 形态）')
{
  const { spawns } = runScenario('proxy-full', { ...keyProfile, proxyJump: 'ops@jump.example.org:2222', remotePath: '~' })
  const { args } = spawns[0]
  check(args[args.indexOf('-J') + 1] === 'ops@jump.example.org:2222', '含 user@host:port 的取值原样透传（不经 shell、不会被拆词）')
  checkOptionPairs(args.slice(0, -1), 'user@host:port 形态的 argv')
}

console.log('场景 6c · 没有 ProxyJump 时不得凭空多出 -J（负向控制）')
{
  const { spawns } = runScenario('no-proxy', { ...keyProfile, remotePath: '~/x' })
  check(!spawns[0].args.includes('-J'), '未配置 ProxyJump 时不追加 -J')
}

console.log('场景 6d · 真实 ssh 的离线判据（ssh -G：解析命令行但不连网）')
{
  const { spawns } = runScenario('proxy-real', { ...keyProfile, proxyJump: 'jump-host', remotePath: '~/work/my-project' })
  const raw = spawns[0].args
  const argv = raw[raw.length - 1].startsWith('cd ') ? raw.slice(0, -1) : raw  // 去掉远程命令，只留 ssh 自己的选项
  const dump = sshConfigDump(argv)
  if (dump.skipped) {
    console.log('  … 跳过（本机没有可用的 ssh：' + dump.reason + '）')
  } else {
    check(dump.ok && !/no argument after keyword/.test(dump.stderr), '真实 ssh 接受这串 argv（issue #21 的 255 已消失）')
    check(/^proxyjump jump-host$/m.test(dump.stdout), 'ssh -G 确认 ProxyJump 真的生效（proxyjump jump-host）')
    check(/^port 2222$/m.test(dump.stdout) && /^stricthostkeychecking false$/m.test(dump.stdout), '其余选项也按预期生效（port / StrictHostKeyChecking=no）')
    // 负向控制：证明这个判据能抓到 issue #21 的坏形状（把 -J 插回 '-o' 与取值之间）
    const broken = argv.slice()
    broken.splice(2, 0, '-J', 'jump-host')
    const bad = sshConfigDump(broken)
    check(!bad.ok && /no argument after keyword/.test(bad.stderr), '负向控制：坏形状会被同一判据判为失败（no argument after keyword "-j"）')
  }
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
