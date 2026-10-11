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

// ---------------------------------------------------------------------------
// issue #23：wrapper 不能依赖 PATH 找 node（桌面端 PATH 上没有 node 是常态）
// 验收判据取自举报人：给一个干净 PATH 直接跑真实产物，看失败点是"找不到 node"还是 ssh 阶段。
// ---------------------------------------------------------------------------
{
  const { existsSync } = await import('node:fs')
  const { join: pjoin, dirname: pdirname } = await import('node:path')
  const s23 = src.indexOf('function resolveWrapperNode(config) {')
  const e23 = src.indexOf('// apply', s23)
  if (s23 < 0 || e23 < 0) throw new Error('#23 的 wrapper node 解析代码未找到')
  const grab23 = new Function(
    'existsSync', 'join', 'dirname',
    src.slice(s23, e23) + '\nreturn { resolveWrapperNode, wrapperShims, shSingleQuote };'
  )(existsSync, pjoin, pdirname)

  console.log('场景 7 · node 解析优先级（issue #23）')
  const realNode = process.execPath
  const cfgFile = join(mkdtempSync(join(tmpdir(), 'rssh-node-')), 'my node.exe')
  writeFileSync(cfgFile, 'x', 'utf8')
  const r1 = grab23.resolveWrapperNode({ nodePath: cfgFile })
  check(r1.bin === cfgFile, '设置里的 nodePath 优先（且带空格的路径可用）')
  check(/nodePath/.test(r1.source), '来源标明是设置项')
  const r2 = grab23.resolveWrapperNode({ nodePath: join(tmpdir(), 'no-such-node-xyz.exe') })
  check(r2.bin === realNode && /process\.execPath/.test(r2.source),
    '配置路径不存在时不盲用：回退到 process.execPath（正在跑本插件的解释器）')
  const r3 = grab23.resolveWrapperNode({ nodePath: '' })
  check(r3.bin === realNode && /process\.execPath/.test(r3.source), '不配置也能自动解析出 node（这就是桌面端的修复路径）')
  const oldEnv = process.env.DSH_REMOTE_SSH_NODE
  try {
    process.env.DSH_REMOTE_SSH_NODE = cfgFile
    const r4 = grab23.resolveWrapperNode({})
    check(r4.bin === cfgFile && /DSH_REMOTE_SSH_NODE/.test(r4.source), '环境变量 DSH_REMOTE_SSH_NODE 可覆盖')
    // 优先级：设置 > 环境变量
    const cfgFile2 = cfgFile + '2'
    writeFileSync(cfgFile2, 'x', 'utf8')
    check(grab23.resolveWrapperNode({ nodePath: cfgFile2 }).bin === cfgFile2, '设置优先于环境变量')
  } finally {
    if (oldEnv === undefined) delete process.env.DSH_REMOTE_SSH_NODE
    else process.env.DSH_REMOTE_SSH_NODE = oldEnv
  }

  console.log('场景 8 · 生成的薄壳文本（绝对路径 + 回退 + 可操作错误）')
  const shims = grab23.wrapperShims(cfgFile)
  check(shims.winCmd.includes('set "DSH_NODE=' + cfgFile + '"'), '.cmd 写死 node 绝对路径')
  check(!/^node "%~dp0/m.test(shims.winCmd), '.cmd 不再裸调 node（旧形状已消除）')
  check(/where node 2\^>nul/.test(shims.winCmd), '.cmd 仍有 PATH 回退（where node）')
  check(/\[dsh-remote-ssh\] node not found/.test(shims.winCmd) && /exit \/b 127/.test(shims.winCmd),
    '.cmd 找不到 node 时给可操作错误并以 127 退出（不是 cmd 原文）')
  check(/nodePath/.test(shims.winCmd) && /DSH_REMOTE_SSH_NODE/.test(shims.winCmd), '.cmd 的错误里指明两条修法')
  check(shims.posixSh.includes("DSH_NODE='" + cfgFile + "'"), 'POSIX 薄壳写死 node 绝对路径')
  check(/command -v node/.test(shims.posixSh) && /exit 127/.test(shims.posixSh), 'POSIX 薄壳有回退与 127 退出')
  check(!/\bdirname\b/.test(shims.posixSh) && shims.posixSh.includes('${0%/*}'),
    'POSIX 薄壳只用 shell 内建（不依赖 dirname / 外部命令）')
  // 转义：POSIX 单引号、cmd 百分号
  const weird = grab23.wrapperShims("/tmp/it's here/node")
  check(weird.posixSh.includes("'\\''"), "POSIX 侧对路径里的单引号做了转义")
  const pct = grab23.wrapperShims('C:\\100%\\node.exe')
  check(pct.winCmd.includes('C:\\100%%\\node.exe'), 'cmd 侧对路径里的 % 做了转义（否则会被当变量展开）')

  console.log('场景 9 · 真实 .cmd 端到端：干净 PATH 下必须越过 node 解析（issue #23 验收判据）')
  {
    const dir = mkdtempSync(join(tmpdir(), 'rssh-e2e-'))
    try {
      const jsPath = join(dir, 'dsh-remote-shell.js')
      writeFileSync(jsPath, scriptText, 'utf8')
      // 记录"到底用了哪个 node"：假的 node（.cmd）只写标记文件就退出，不进 ssh 阶段
      const marker = join(dir, 'node-used.txt')
      const fakeNode = join(dir, 'fake-node.cmd')
      writeFileSync(fakeNode, '@echo off\r\necho %~nx0> "' + marker + '"\r\nexit /b 0\r\n', 'utf8')
      writeFileSync(join(dir, 'dsh-remote-shell.cmd'), grab23.wrapperShims(fakeNode).winCmd, 'utf8')
      writeFileSync(join(dir, '.remote-ssh.json'), JSON.stringify({ ...keyProfile, remotePath: '~/x' }), 'utf8')
      const cleanEnv = { SystemRoot: process.env.SystemRoot || 'C:\\Windows', PATH: 'C:\\Windows\\System32' }
      const run = (file, extraEnv) => spawnSync('cmd.exe', ['/c', file], {
        cwd: dir, encoding: 'utf8', timeout: 30000, env: { ...cleanEnv, ...(extraEnv || {}) },
      })
      const ok = run(join(dir, 'dsh-remote-shell.cmd'))
      check(existsSync(marker), '写死的绝对路径被采用（假 node 留下了标记）—— 干净 PATH 下照样跑起来')
      check(ok.status === 0, '退出码 0（假 node 正常结束）')
      check(!/not recognized|不是内部或外部命令/.test(String(ok.stderr || '')), '不再出现 cmd 的 node 找不到原文')

      // 负向控制：把旧形状（裸调 node）放回同一环境，必须复现举报人的现象
      const oldCmd = join(dir, 'old-shape.cmd')
      writeFileSync(oldCmd, '@echo off\r\nnode "%~dp0dsh-remote-shell.js"\r\n', 'utf8')
      const bad = run(oldCmd)
      check(bad.status !== 0 && /not recognized|不是内部或外部命令/.test(String(bad.stderr || '')),
        '负向控制：裸调 node 的旧形状在干净 PATH 下复现「node 找不到」并失败（证明这条判据真的能抓到回归）')

      // 写死的路径失效（换机/卸载）且 PATH 也没有 node → 我们的错误信息 + 127
      const missing = join(dir, 'missing-node.cmd')
      writeFileSync(missing, grab23.wrapperShims(join(dir, 'gone-node.exe')).winCmd, 'utf8')
      const noNode = run(missing)
      check(noNode.status === 127, '写死路径失效且 PATH 无 node → 退出码 127（不是 cmd 的 1）')
      check(/\[dsh-remote-ssh\] node not found/.test(String(noNode.stderr || '')), '并打印插件自己的可操作提示')
      check(/nodePath/.test(String(noNode.stderr || '')), '提示里给出 nodePath 这条修法')

      // 真正的 ssh 阶段：写死真 node + 干净 PATH + 立即失败的域名 → 失败点必须后移到 ssh。
      // 判据用**退出码 255**（ssh 自己的失败码；cmd 找不到命令是 9009/1、node 自身崩溃是 1），
      // 不依赖 ssh 的文本：Windows 的 ssh.exe 在 stderr 是管道时会把消息写到控制台，
      // 于是 spawnSync 捕获不到（真实终端里是 pty，用户照常能看到）—— 这是测量方式的限制，
      // 不是 wrapper 丢了输出，写在这里免得以后有人"顺手修好"。
      const realCmd = join(dir, 'real-node.cmd')
      writeFileSync(realCmd, grab23.wrapperShims(process.execPath).winCmd, 'utf8')
      const keyFile = join(dir, 'id_test')
      writeFileSync(keyFile, 'not-a-real-key', 'utf8')
      writeFileSync(join(dir, '.remote-ssh.json'),
        JSON.stringify({ host: 'hpc.invalid', user: 'u', port: 22, keyPath: keyFile, remotePath: '~/x' }), 'utf8')
      const sshStage = run(realCmd)
      const errText = String(sshStage.stderr || '')
      check(!/not recognized|不是内部或外部命令/.test(errText), '干净 PATH + 真 node：失败点已越过 node 解析')
      check(sshStage.status === 255, '失败点后移到 ssh 阶段（退出码 255 = ssh 连接失败，而非 cmd/node 的报错）')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  console.log('场景 10 · POSIX 薄壳真实执行（WSL 可跳过）')
  {
    const wslOk = spawnSync('wsl.exe', ['bash', '-lc', 'echo ok'], { encoding: 'utf8', timeout: 30000 })
    if (wslOk.status !== 0) {
      console.log('  … 跳过（本机没有可用的 WSL bash）')
    } else {
      const dir = mkdtempSync(join(tmpdir(), 'rssh-posix-'))
      try {
        // WSL 里访问同一份 Windows 临时目录
        const wslDir = '/mnt/' + dir[0].toLowerCase() + dir.slice(2).replace(/\\/g, '/')
        const jsPath = join(dir, 'dsh-remote-shell.js')
        writeFileSync(jsPath, scriptText, 'utf8')
        const marker = join(dir, 'node-used.txt')
        const fakeNode = join(dir, 'fake-node')
        // 假的 node：只把"自己是谁"写到 marker（路径必须是 WSL 形式，否则 WSL 里写不出去）
        writeFileSync(fakeNode, '#!/bin/sh\necho "$0" > "' + wslDir + '/node-used.txt"\nexit 0\n', 'utf8')
        writeFileSync(join(dir, 'dsh-remote-shell'), grab23.wrapperShims(wslDir + '/fake-node').posixSh, 'utf8')
        writeFileSync(join(dir, '.remote-ssh.json'), JSON.stringify({ ...keyProfile, remotePath: '~/x' }), 'utf8')
        // PATH 指向一个不存在的目录：薄壳只用内建，必须照样跑通（证明完全不依赖 PATH）。
        // 显式用 `bash <脚本>` 而不是靠 shebang 执行：`#!/usr/bin/env bash` 里的 env 要靠 PATH
        // 找 bash，PATH 清空时它自己就起不来 —— 那是终端的调用方式问题，与本薄壳无关，别混进来。
        const r = spawnSync('wsl.exe', ['bash', '-lc',
          'chmod +x "' + wslDir + '/dsh-remote-shell" "' + wslDir + '/fake-node" 2>/dev/null; PATH=/nonexistent /bin/bash "' + wslDir + '/dsh-remote-shell"'],
          { encoding: 'utf8', timeout: 60000 })
        check(existsSync(marker), 'PATH=/nonexistent 下仍用写死的绝对路径跑起来了（只用 shell 内建）')
        check(r.status === 0, 'POSIX 薄壳退出码 0（stderr: ' + String(r.stderr || '').trim().slice(0, 80) + '）')
        // 语法检查
        const syn = spawnSync('wsl.exe', ['bash', '-n', wslDir + '/dsh-remote-shell'], { encoding: 'utf8', timeout: 30000 })
        check(syn.status === 0, 'bash -n 语法检查通过')
        // 写死路径失效且 PATH 无 node → 127 + 可操作错误
        writeFileSync(join(dir, 'broken'), grab23.wrapperShims(wslDir + '/gone-node').posixSh, 'utf8')
        const noNode = spawnSync('wsl.exe', ['bash', '-lc',
          'PATH=/nonexistent /bin/bash "' + wslDir + '/broken"'], { encoding: 'utf8', timeout: 30000 })
        check(noNode.status === 127, 'POSIX：找不到 node 时退出码 127')
        check(/\[dsh-remote-ssh\] node not found/.test(String(noNode.stderr || '')), 'POSIX：打印插件自己的可操作提示')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  }
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
