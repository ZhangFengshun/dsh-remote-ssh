// 终端 wrapper 回归测试（issue #7）：验证生成的 dsh-remote-shell.js 在远程工作区里
// 会把终端 cd 到工作区对应的远程目录（remotePath），而不是落在远程 $HOME。
//
// 做法：从 lib/index.js 提取真实的 wrapperJs 数组字面量并求值，得到**原样**的生成脚本；
// 再用一个 CJS runner 桩掉 child_process，捕获实际 spawn 的 argv 与 stderr。
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
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

console.log('场景 1 · remotePath = ~/lhj/IB_Robot（issue #7 主场景）')
{
  const { spawns } = runScenario('tilde-sub', { ...keyProfile, remotePath: '~/lhj/IB_Robot' })
  check(spawns.length === 1, '只 spawn 一次（ssh）')
  const { bin, args } = spawns[0]
  check(args[0] === '-tt', '带 -tt 交互式通道')
  check(args.includes('-p') && args.includes('2222'), '带端口')
  check(args.includes('-i') && args.includes(keyProfile.keyPath), '带密钥')
  check(args[args.length - 2] === 'wxq@hpc.example.org', '目标 user@host 正确')
  const cmd = args[args.length - 1]
  check(cmd === 'cd "$HOME/lhj/IB_Robot" 2>/dev/null || cd "$HOME"; exec "${SHELL:-/bin/bash}" -l',
    '远程命令：远端展开 ~ + 失败回退 $HOME + exec 登录 shell')
  check(cmd.includes('$HOME/lhj/IB_Robot') && !cmd.includes('/home/u/lhj'), '~ 交给远端展开（未用本地 homedir）')
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

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
