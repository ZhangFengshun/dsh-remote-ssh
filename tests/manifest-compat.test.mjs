// 清单兼容性 回归测试（2026-09-28：DSH 0.2.0-rc.1 起 harness 会阻止不兼容插件）。
//
// 背景：DSH 的插件管理器用**插件自己声明的 DSH peer 版本范围**判定兼容性：
// 范围覆盖不到当前运行时版本时，安装/激活被整条拒绝（"Plugin … is incompatible with dsh <v>"），
// 只能靠 `dsh plugin allow-version … --accept-risk` 逐版本豁免（官方警告：可能崩溃、丢数据）。
// 2.4.15 只声明了 `^0.1.0-rc.6`，在 0.2.0-rc.1 上被拒 —— 插件在宿主里根本不出现。
//
// ⚠ 语义要点：判定是**严格 npm semver**（预发布版本只被"元组相同且自身带预发布"的比较器接受）。
// 因此 `^0.1.0-rc.6` 覆盖不到 `0.1.5-rc.1`/`0.1.7-rc.2`/`0.2.0-rc.1` 这些**预发布**运行时 ——
// 必须像 dsh-cron 那样把每条已验证的版本线**显式列出**（`^0.1.5-rc.1 || ^0.1.7-rc.2 || …`）。
//
// 本测试用内置的严格比较器断言：每个 peer 范围覆盖**全部已验证版本线**，且不越界声明未验证的线。
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/** 我们已实测过的运行时版本线（新增验证后往这里加；每条都必须被每个 peer 范围覆盖）。 */
const VERIFIED_LINES = ['0.1.0-rc.6', '0.1.5-rc.1', '0.1.7-rc.2', '0.2.0-rc.1']
/** 当前官方最新线（harness 实际跑的目标）。 */
const TARGET = process.env.DSH_RUNTIME_VERSION || '0.2.0-rc.1'
/** 运行时实际带的 cordis 版本（cordis 是普通库，版本号不属于 DSH 线）。 */
const CORDIS_VERSION = process.env.DSH_CORDIS_VERSION || '4.0.4'

// ---- 小型 semver（覆盖本项目用到的写法：^x.y.z、可带 -pre、`||` 列表），严格语义 ----
function parseVersion(text) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(text).trim())
  if (!m) return null
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] }
}
function compareIdentifiers(a, b) {
  const an = /^\d+$/.test(a), bn = /^\d+$/.test(b)
  if (an && bn) return Number(a) - Number(b)
  if (an) return -1 // 数字标识符优先级低于字母
  if (bn) return 1
  return a < b ? -1 : a > b ? 1 : 0
}
function compareVersions(a, b) {
  const va = parseVersion(a), vb = parseVersion(b)
  if (!va || !vb) throw new Error('版本号无法解析: ' + a + ' / ' + b)
  for (const k of ['major', 'minor', 'patch']) if (va[k] !== vb[k]) return va[k] - vb[k]
  if (va.pre.length === 0 && vb.pre.length === 0) return 0
  if (va.pre.length === 0) return 1 // 正式版 > 预发布
  if (vb.pre.length === 0) return -1
  for (let i = 0; i < Math.max(va.pre.length, vb.pre.length); i++) {
    if (va.pre[i] === undefined) return -1
    if (vb.pre[i] === undefined) return 1
    const d = compareIdentifiers(va.pre[i], vb.pre[i])
    if (d !== 0) return d
  }
  return 0
}
function sameTuple(a, b) {
  return a.major === b.major && a.minor === b.minor && a.patch === b.patch
}
/** caret 范围展开成一对比较器（>=floor, <ceil）；0.x 线提升 minor。 */
function caretComparators(range) {
  const v = parseVersion(range.slice(1))
  if (!v) throw new Error('不支持的 caret 范围: ' + range)
  return [
    { op: '>=', version: range.slice(1) },
    { op: '<', version: v.major === 0 ? `0.${v.minor + 1}.0` : `${v.major + 1}.0.0` },
  ]
}
/**
 * 严格 npm semver：预发布版本 v 只有在"某个比较器的元组与 v 相同、且该比较器自身带预发布"时才可能满足。
 * （这正是 `^0.1.0-rc.6` 挡不住也放不过 `0.2.0-rc.1`、而 `^0.2.0-rc.1` 才覆盖它的原因。）
 */
function satisfiesRange(version, range) {
  const v = parseVersion(version)
  if (!v) throw new Error('版本号无法解析: ' + version)
  const sets = String(range).split('||').map((r) => r.trim()).filter(Boolean).map(caretComparators)
  for (const comparators of sets) {
    const ok = comparators.every((c) => {
      const cmp = compareVersions(version, c.version)
      return c.op === '>=' ? cmp >= 0 : cmp < 0
    })
    if (!ok) continue
    if (v.pre.length > 0) {
      const allowed = comparators.some((c) => {
        const cv = parseVersion(c.version)
        return cv.pre.length > 0 && sameTuple(cv, v)
      })
      if (!allowed) continue
    }
    return true
  }
  return false
}

let pass = 0, fail = 0
const check = (cond, label) => { if (cond) { pass++; console.log('  ✓ ' + label) } else { fail++; console.log('  ✗ FAIL: ' + label) } }

console.log('A · 比较器自检（先证明围栏本身与 harness 判定一致）')
{
  check(satisfiesRange('0.1.0-rc.6', '^0.1.0-rc.6') === true, '^0.1.0-rc.6 覆盖自身')
  check(satisfiesRange('0.1.7-rc.2', '^0.1.0-rc.6') === false, '⚠ 严格语义：^0.1.0-rc.6 **不**覆盖 0.1.7-rc.2（预发布需元组匹配）')
  check(satisfiesRange('0.1.7-rc.2', '^0.1.7-rc.2') === true, '^0.1.7-rc.2 覆盖 0.1.7-rc.2')
  check(satisfiesRange('0.2.0-rc.1', '^0.1.0-rc.6') === false, '⚠ 回归点：^0.1.0-rc.6 **不**覆盖 0.2.0-rc.1（2.4.15 被拒的原因）')
  check(satisfiesRange('0.2.0-rc.1', '^0.2.0-rc.1') === true, '^0.2.0-rc.1 覆盖 0.2.0-rc.1')
  check(satisfiesRange('0.3.0-rc.1', '^0.2.0-rc.1') === false, '^0.2.0-rc.1 不越界覆盖 0.3 线')
  check(satisfiesRange('0.1.0-rc.6', '^0.1.0-rc.6 || ^0.1.5-rc.1 || ^0.1.7-rc.2 || ^0.2.0-rc.1') === true, 'OR 列表覆盖首条线')
  check(satisfiesRange('0.1.5-rc.3', '^0.1.0-rc.6 || ^0.1.5-rc.1 || ^0.1.7-rc.2 || ^0.2.0-rc.1') === true, 'OR 列表覆盖 0.1.5 线的补丁预发布')
  check(satisfiesRange('4.0.4', '^4.0.1') === true, '^4.0.1 覆盖 4.0.4（正式版比较）')
  check(satisfiesRange('5.0.0', '^4.0.1') === false, '^4.0.1 不越界覆盖 5.x')
}

console.log('B · 每个 peer 范围覆盖全部已验证版本线')
{
  const peers = pkg.peerDependencies || {}
  const dshPeers = Object.keys(peers).filter((n) => n !== '@deepseek-ai/cordis')
  check(dshPeers.length >= 3, `声明了 ${dshPeers.length} 个 DSH peer`)
  for (const name of dshPeers) {
    for (const line of VERIFIED_LINES) {
      check(satisfiesRange(line, peers[name]) === true, `${name} 覆盖 ${line}`)
    }
    check(satisfiesRange(TARGET, peers[name]) === true, `${name} 覆盖当前官方最新 ${TARGET}`)
  }
  for (const name of ['@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-primitives']) {
    check(typeof peers[name] === 'string', `声明了 ${name}`)
  }
  check(satisfiesRange(CORDIS_VERSION, peers['@deepseek-ai/cordis'] || '') === true, `cordis 范围覆盖运行时实际版本 ${CORDIS_VERSION}`)
}

console.log('C · 不越界（不声明未实测的版本线）')
{
  const peers = pkg.peerDependencies || {}
  for (const name of Object.keys(peers)) {
    if (name === '@deepseek-ai/cordis') continue
    check(satisfiesRange('0.3.0-rc.1', peers[name]) === false, `${name} 不声明 0.3 线（未验证）`)
    check(satisfiesRange('1.0.0', peers[name]) === false, `${name} 不声明 1.x（未验证）`)
  }
}

console.log('D · 客户端注入清单与 bundle 声明')
{
  const inject = (pkg.dsh && pkg.dsh.client && pkg.dsh.client.inject) || []
  check(pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch === './cordis.patch.yml', 'dsh.bundle.patch 指向 cordis.patch.yml')
  check(existsSync(join(root, 'cordis.patch.yml')), 'cordis.patch.yml 确实存在（否则 bundle 无法装载）')
  check((pkg.dsh && pkg.dsh.client && pkg.dsh.client.platform) === 'web', 'client.platform = web')
  check(inject.includes('@deepseek-ai/dsh-client-ui-primitives'), 'client 注入 dsh-client-ui-primitives（client.js 真的 require 它）')
  check(inject.includes('@deepseek-ai/dsh-client-locale') && inject.includes('@deepseek-ai/dsh-client-ui-slots'), 'client 注入 locale 与 ui-slots')
  check(inject.includes('@deepseek-ai/dsh-client-modules'), 'client 注入 dsh-client-modules（客户端插件运行时）')
  // 0.2.0-rc.1 起运行时不再提供 dsh-client-runtime；注入不存在的包会让客户端半边装不上
  check(!inject.includes('@deepseek-ai/dsh-client-runtime'), '不再注入 dsh-client-runtime（0.2.0-rc.1 运行时已无此包，代码也未使用）')
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
