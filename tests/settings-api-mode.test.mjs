// settings API 代际判定（issue #34）回归测试。
//
// 背景：DSH 0.1.5 / 0.1.6 的 `settings` 服务**同时**有 `register()` 与 `describe()/update()`，
// 但那一代还没有把 loader 行的 Config 注册成 settings 命名空间。只看「接口存不存在」会把它们
// 误判成新版（0.1.7-rc.2+），于是：
//   · `describe()` 取不到本插件命名空间 → 连接列表恒为空；
//   · `update()` 抛 `settings namespace "…" is not registered` → 导入与保存必然失败。
// 判据因此改成「两套都在时，只有 describe 真能看到本插件命名空间才走新路径」。
//
// 三层：A. 判定函数三态与边界；B. 0.1.5 现场语义（读空 + 写抛错时仍判 legacy）；
//       C. 接线（apply 门闩用判定结果）与变异负向控制。
import { readFileSync } from 'node:fs'

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

const helperSrc = grab('function settingsApiMode')
const makeMode = (body) => new Function(body + '\nreturn settingsApiMode;')()

const settingsApiMode = makeMode(helperSrc)

let pass = 0
let fail = 0
const check = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label) } else { fail++; console.log('  ✗ FAIL: ' + label) }
}

const ENTRY = 'remote-ssh'

/** 0.1.7-rc.2+ 的形态：只有 configure/describe/update。 */
function newStyleSvc(namespaces) {
  return {
    describeCalls: 0,
    update: async () => {},
    configure: () => {},
    describe(opts) {
      this.describeCalls++
      this.lastOpts = opts
      return (typeof namespaces === 'function' ? namespaces() : namespaces) || []
    },
  }
}

/** ≤0.1.6 的形态：register + scope。 */
function legacyStyleSvc(extra) {
  const store = { profiles: [] }
  const svc = {
    registered: [],
    register(ns, schema) {
      svc.registered.push({ ns, schema })
      return {
        get: () => store,
        update: async (patch) => { Object.assign(store, patch) },
      }
    },
    store,
  }
  return Object.assign(svc, extra || {})
}

console.log('A · settingsApiMode 三态判定')
{
  check(settingsApiMode(newStyleSvc([]), ENTRY) === 'new',
    'A1 只有 describe/update（0.1.7-rc.2+）→ new')
  check(settingsApiMode(legacyStyleSvc(), ENTRY) === 'legacy',
    'A2 只有 register（更旧宿主）→ legacy')

  const both = legacyStyleSvc({
    describe: () => [],
    update: async () => { throw new Error('settings namespace "remote-ssh" is not registered') },
  })
  check(settingsApiMode(both, ENTRY) === 'legacy',
    'A3 两套都有但 describe 看不到本插件（0.1.5/0.1.6 现场，issue #34）→ legacy')

  const bothSeen = legacyStyleSvc({
    describe: () => [{ ns: ENTRY, value: {} }],
    update: async () => {},
  })
  check(settingsApiMode(bothSeen, ENTRY) === 'new',
    'A4 两套都有且 describe 能看到本插件命名空间 → new（向前兼容）')

  const bothOther = legacyStyleSvc({
    describe: () => [{ ns: 'other-plugin', value: {} }],
    update: async () => {},
  })
  check(settingsApiMode(bothOther, ENTRY) === 'legacy',
    'A5 两套都有、describe 只看到别的命名空间 → legacy')

  const bothThrow = legacyStyleSvc({
    describe: () => { throw new Error('boom') },
    update: async () => {},
  })
  check(settingsApiMode(bothThrow, ENTRY) === 'legacy',
    'A6 两套都有、describe 抛错（探测失败）→ legacy，不静默当新版')

  const describeNoUpdate = { describe: () => [], register: () => ({ get: () => ({}), update: async () => {} }) }
  check(settingsApiMode(describeNoUpdate, ENTRY) === 'legacy',
    'A7 有 describe 但没有 update（接口不完整）→ legacy')

  const describeNoUpdateNoRegister = { describe: () => [] }
  check(settingsApiMode(describeNoUpdateNoRegister, ENTRY) === 'config',
    'A8 接口不完整且没有 register → config 只读兜底')

  check(settingsApiMode(null, ENTRY) === 'config', 'A9 svc 缺失（null）→ config')
  check(settingsApiMode(undefined, ENTRY) === 'config', 'A10 svc 缺失（undefined）→ config')
  check(settingsApiMode({}, ENTRY) === 'config', 'A11 空对象 → config')
}

console.log('')
console.log('B · 探测语义（0.1.5 现场）')
{
  const both = legacyStyleSvc({
    describe: () => [],
    update: async () => { throw new Error('settings namespace "remote-ssh" is not registered') },
  })
  let updateErr = null
  try { await both.update() } catch (e) { updateErr = String((e && e.message) || e) }
  check(!!updateErr && /not registered/.test(updateErr),
    'B1 现场前提成立：该代 update() 确实抛 "not registered"')
  check(settingsApiMode(both, ENTRY) === 'legacy',
    'B2 即便 update() 会抛错，判定也走 legacy（不回落到必然失败的新路径）')

  const nsAware = legacyStyleSvc({ describe: () => [{ ns: ENTRY }], update: async () => {} })
  check(settingsApiMode(nsAware, ENTRY) === 'new' && settingsApiMode(nsAware, 'another-entry') === 'legacy',
    'B3 命名空间比对用**本插件 entry id**，不是包名/NS 常量')

  const spy = legacyStyleSvc({
    describe: function (opts) { this.seen = opts; return [] },
    update: async () => {},
  })
  settingsApiMode(spy, ENTRY)
  check(!!spy.seen && spy.seen.redactSecrets === false,
    'B4 探测调用带 redactSecrets: false（否则口令字段被剥，判定与读取都用不到真值）')
}

console.log('')
console.log('C · 接线与变异负向控制')
{
  check((src.match(/settingsApiMode\(/g) || []).length === 2,
    'C1 settingsApiMode 在源码里恰好 2 处（1 定义 + 1 调用）')
  check(src.includes('const settingsApi = settingsApiMode(svc, entryId)'),
    'C2 apply 里把判定结果存进 settingsApi，供两个分支共用')
  check(src.includes('if (settingsApi === "new") {'),
    'C3 新分支门闩 = settingsApi === "new"')
  check(src.includes('if (settingsApi === "legacy") {'),
    'C4 旧分支门闩 = settingsApi === "legacy"')
  check(!/if \(svc && typeof svc\.describe === "function" && typeof svc\.update === "function"\)/.test(src),
    'C5 旧判据（只看接口存在性）已不存在于 apply')
  check((src.match(/typeof svc\.register === "function"/g) || []).length === 1,
    'C6 register 存在性判断只在判定函数里出现一次')

  // 变异：把「两套都在」直接判成 new（= issue #34 的原始实现），A3 必须变红
  const head = '  if (!canRegister) return "new";'
  const tail = '  return "legacy";'
  const hAt = helperSrc.indexOf(head)
  const tAt = helperSrc.indexOf(tail, hAt + 1)
  const mutated = hAt >= 0 && tAt > hAt
    ? helperSrc.slice(0, hAt) + head + '\n  return "new";' + helperSrc.slice(tAt + tail.length)
    : helperSrc
  check(mutated !== helperSrc, 'C7 变异体生成成功（可用于负向控制）')
  const mutatedMode = makeMode(mutated)
  const both = legacyStyleSvc({ describe: () => [], update: async () => {} })
  check(mutatedMode(both, ENTRY) === 'new' && settingsApiMode(both, ENTRY) === 'legacy',
    'C8 变异负向控制：原始写法把 0.1.5 判成 new，修好后的实现判 legacy（变异必须变红）')
  check(/try \{\s*scope = svc\.register\(NS, PrefsSchema\);/.test(src) && /if \(scope\) \{/.test(src),
    'C9 legacy 分支给 register 包了 try/catch，失败时不占用 settingsFace（可退只读 config）')
  check(src.includes('settings.register 失败，本次以只读配置运行'),
    'C10 register 失败的 warn 文案存在（可排查、不静默）')
}

console.log('')
console.log('结果: ' + pass + ' 通过, ' + fail + ' 失败')
if (fail > 0) process.exit(1)