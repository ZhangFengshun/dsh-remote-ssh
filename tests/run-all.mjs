#!/usr/bin/env node
// 全量测试聚合运行器。
//
// 为什么需要它：本仓的测试是「一个文件一套断言 + 自己打印 `结果: N 通过, M 失败`」的形态，
// 靠人肉 for 循环跑（CI 里更难写）。这个脚本把它变成一条命令：
//
//     node tests/run-all.mjs                # 跑 tests/ 下全部 *.test.mjs
//     node tests/run-all.mjs --filter=fs-  # 只跑文件名含 fs- 的
//     node tests/run-all.mjs --dir=<路径>   # 跑别的目录（运行器自测用）
//
// 判定规则（故意从严）：
//   · 有 `结果:` 行且失败数为 0  → PASS
//   · 有 `结果:` 行且失败数 > 0  → FAIL
//   · **没有** `结果:` 行          → CRASH（脚本抛错/被杀，绝不当成通过）
// 任一 FAIL/CRASH → 退出码 1。CI 直接依赖这个退出码。

import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const opt = (name, dflt) => {
  const hit = args.find((a) => a === '--' + name || a.startsWith('--' + name + '='))
  if (!hit) return dflt
  const eq = hit.indexOf('=')
  return eq === -1 ? '' : hit.slice(eq + 1)
}
const dir = resolve(opt('dir', here))
const filter = opt('filter', '')

let files
try {
  files = readdirSync(dir).filter((f) => f.endsWith('.test.mjs') && f !== 'run-all.mjs').sort()
} catch (e) {
  console.error('无法读取测试目录 ' + dir + '：' + e.message)
  process.exit(2)
}
if (filter) files = files.filter((f) => f.includes(filter))
if (files.length === 0) {
  console.error('没有匹配的测试文件（dir=' + dir + (filter ? ', filter=' + filter : '') + '）')
  process.exit(2)
}

const RE = /结果:\s*(\d+)\s*通过,\s*(\d+)\s*失败/
const results = []
const t0 = Date.now()

console.log('测试目录: ' + dir)
console.log('共 ' + files.length + ' 个文件' + (filter ? '（过滤: ' + filter + '）' : '') + '\n')

for (const f of files) {
  const full = join(dir, f)
  const t = Date.now()
  const r = spawnSync(process.execPath, [full], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  const out = (r.stdout || '') + (r.stderr || '')
  const ms = Date.now() - t
  let status, passed = 0, failed = 0
  const m = RE.exec(out)
  if (r.error) { status = 'CRASH'; }
  else if (m) { passed = Number(m[1]); failed = Number(m[2]); status = failed > 0 ? 'FAIL' : 'PASS' }
  else { status = 'CRASH' }
  results.push({ file: f, status, passed, failed, ms, out, err: r.error ? String(r.error.message) : '', code: r.status })
  const mark = status === 'PASS' ? '✓' : status === 'FAIL' ? '✗' : '✗✗'
  const info = status === 'CRASH' ? 'CRASH（没有 `结果:` 行，退出码 ' + r.status + '）' : passed + ' 通过 / ' + failed + ' 失败'
  console.log('  ' + mark + ' ' + f.padEnd(42) + info.padEnd(28) + String(ms).padStart(6) + ' ms')
  if (status === 'CRASH') {
    const lines = out.split(/\r?\n/).filter((l) => l.trim() !== '')
    const tail = lines.slice(0, 12).map((l) => '        ' + l).join('\n')
    console.log(tail)
    if (r.error) console.log('        [spawn 失败] ' + r.error.message)
    if (lines.length > 12) console.log('        …（另有 ' + (lines.length - 12) + ' 行输出）')
  }
}

const tp = results.reduce((a, r) => a + r.passed, 0)
const tf = results.reduce((a, r) => a + r.failed, 0)
const bad = results.filter((r) => r.status !== 'PASS')
const secs = ((Date.now() - t0) / 1000).toFixed(1)

console.log('\n' + '-'.repeat(78))
console.log('总计: ' + results.length + ' 文件 / ' + tp + ' 通过 / ' + tf + ' 失败' +
  (bad.length ? ' / ' + bad.length + ' 个文件有问题' : '') + '   （' + secs + ' s）')
if (bad.length) {
  console.log('有问题的文件:')
  for (const r of bad) console.log('  · ' + r.file + '  [' + r.status + ']' + (r.err ? ' ' + r.err : ''))
  console.log('\n结果: ' + tp + ' 通过, ' + tf + ' 失败')
  process.exit(1)
}
console.log('全部通过 ✓')
console.log('\n结果: ' + tp + ' 通过, ' + tf + ' 失败')
process.exit(0)
