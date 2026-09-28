// DSH 0.1.7-rc.2 settings 兼容层 回归测试（issue #16）。
//
// 背景：0.1.7-rc.2 的 `settings` 服务移除了 `register(ns, schema)`，改为
//   读 `describe()`（按 **profile entry id** 取，ns 不再是包名）
//   写 `update(entryId, patch, revision)`
// 用户偏好存放于**本插件 loader 行的 Config**，且字段必须标 `.volatile()`
// （否则 Loader 的 volatile-commit 路径不提交，写入"报成功但值不变"）。
// 旧版的 section 键是包名（dsh-remote-ssh），新版按 entry id（remote-ssh）导入 →
// 旧数据会被留在 `settings.yaml.imported`，必须自己迁移，否则升级后连接/工作区全为空。
//
// 三层：A. 纯函数（ownEntryId / 旧 section 解析 / 读取 / 数组提取）
//       B. 外观与迁移行为（假 settings 服务）
//       C. 接线与 schema（Config 用 volatile、双版本分支、解析器依赖）
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const src = readFileSync(root + '/lib/index.js', 'utf8')

/**
 * 仓库本身不装 node_modules（依赖由 profile 提供），所以按目录查找真实包再按绝对路径导入。
 * CJS/ESM 双形态都兼容：优先取命名导出，取不到再退回 default。
 */
async function loadDep(name, member) {
  const candidates = [
    process.env.DSH_PROFILE_DIR ? join(process.env.DSH_PROFILE_DIR, 'node_modules', name) : undefined,
    join(process.env.USERPROFILE || '', '.dsh', 'profiles', 'desktop', 'node_modules', name),
    'E:\\Program Files\\DSH Desktop\\resources\\app\\node_modules\\' + name,
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

const parseYaml = await loadDep('yaml', 'parse')
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

const api = new Function(
  'parseYaml', 'join', 'readFile', 'z',
  grab('function ownEntryId') + '\n' + grab('function parseLegacyPrefsSection') + '\n' +
  grab('async function readLegacyPrefs') + '\n' + grab('function resolvePrefValue') + '\n' + grab('function prefsArray') + '\n' +
  grab('function describePrefsShape') + '\n' +
  grab('function createNewSettingsFace') + '\n' + grab('async function migrateLegacyPrefs') +
  '\nreturn { ownEntryId, parseLegacyPrefsSection, readLegacyPrefs, resolvePrefValue, prefsArray, createNewSettingsFace, migrateLegacyPrefs };'
)(
  parseYaml,
  (await import('node:path')).join,
  (await import('node:fs/promises')).readFile,
  z,
)

let pass = 0, fail = 0
const check = (cond, label) => { if (cond) { pass++; console.log('  ✓ ' + label) } else { fail++; console.log('  ✗ FAIL: ' + label) } }

const PKG = '@zhangfengshun/dsh-remote-ssh'

console.log('A1 · ownEntryId（新版命名空间 = loader entry id）')
{
  const mkCtx = (entries, fiber) => ({ fiber, loader: { entries: () => entries } })
  const fiber = {}
  check(api.ownEntryId(mkCtx([{ options: { id: 'remote-ssh', name: PKG }, fiber }], fiber), PKG) === 'remote-ssh',
    '按 fiber 命中本插件行 → 返回其 id')
  check(api.ownEntryId(mkCtx([{ options: { id: 'other', name: 'x' }, fiber }, { options: { id: 'remote-ssh', name: PKG }, fiber: {} }], fiber), PKG) === 'remote-ssh',
    'fiber 不匹配时退回「同包名且未禁用」的行')
  check(api.ownEntryId(mkCtx([{ options: { id: 'remote-ssh', name: PKG }, fiber: {}, disabled: true }], fiber), PKG) === undefined,
    '只有被禁用的行 → undefined（调用方回退 NS）')
  check(api.ownEntryId(mkCtx([{ options: { name: PKG }, fiber }], fiber), PKG) === undefined, 'id 非字符串 → 跳过')
  check(api.ownEntryId({ loader: { entries: () => { throw new Error('boom') } } }, PKG) === undefined, 'loader 抛错 → 安全返回 undefined')
}

console.log('A2 · parseLegacyPrefsSection（旧 section 键是包名）')
{
  const yamlText = [
    'llm-deepseek:',
    '  baseURL: https://example.invalid',
    'dsh-remote-ssh:',
    '  profiles:',
    '    - id: p1',
    '      host: hpc-a.example.com',
    '  workspaces:',
    '    - id: w1',
    '      mirrorPath: ~/.dsh/remote-workspaces/wmirror1',
    '  unrelatedLegacyField: dropped',
  ].join('\n')
  const section = api.parseLegacyPrefsSection(yamlText, 'dsh-remote-ssh', ['profiles', 'workspaces'])
  check(!!section && Array.isArray(section.profiles) && section.profiles.length === 1, '取到 profiles（1 条）')
  check(section.profiles[0].host === 'hpc-a.example.com', '条目字段保留')
  check(section.unrelatedLegacyField === undefined, 'section 内未声明的**顶层**键被过滤（不写与 Config 无关的字段）')
  check(Array.isArray(section.workspaces) && section.workspaces.length === 1, '取到 workspaces')
  check(api.parseLegacyPrefsSection(yamlText, 'nope', ['profiles']) === undefined, 'section 不存在 → undefined')
  check(api.parseLegacyPrefsSection('{{ not yaml', 'dsh-remote-ssh', ['profiles']) === undefined, 'YAML 损坏 → undefined（不抛）')
  check(api.parseLegacyPrefsSection('dsh-remote-ssh: [1,2]', 'dsh-remote-ssh', ['profiles']) === undefined, 'section 是数组 → undefined')
  check(api.parseLegacyPrefsSection('dsh-remote-ssh:\n  other: 1', 'dsh-remote-ssh', ['profiles', 'workspaces']) === undefined,
    '过滤后为空 → undefined（不写空配置）')
}

console.log('A3 · readLegacyPrefs（.imported 优先，退回 settings.yaml）')
{
  const dir = mkdtempSync(join(tmpdir(), 'rssh-legacy-'))
  try {
    const ns = 'dsh-remote-ssh'
    const declared = ['profiles', 'workspaces']
    // 只有 settings.yaml 时
    writeFileSync(join(dir, 'settings.yaml'), 'dsh-remote-ssh:\n  profiles:\n    - id: old\n')
    let got = await api.readLegacyPrefs(dir, ns, declared)
    check(!!got && got.profiles[0].id === 'old', '只有 settings.yaml → 能读到（迁移进行中的主机）')
    // 两个都在时，.imported 优先
    writeFileSync(join(dir, 'settings.yaml.imported'), 'dsh-remote-ssh:\n  profiles:\n    - id: imported\n')
    got = await api.readLegacyPrefs(dir, ns, declared)
    check(!!got && got.profiles[0].id === 'imported', '两个都在 → .imported 优先（已启动过一次的主机）')
    // 都没有
    const empty = mkdtempSync(join(tmpdir(), 'rssh-legacy-empty-'))
    try {
      check((await api.readLegacyPrefs(empty, ns, declared)) === undefined, '两个文件都没有 → undefined')
      check((await api.readLegacyPrefs('', ns, declared)) === undefined, '空 home → undefined')
    } finally { rmSync(empty, { recursive: true, force: true }) }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log('A4 · prefsArray / resolvePrefValue（volatile 字段是**引用对象**，要 .get()）')
{
  check(api.prefsArray([1, 2]).length === 2, '普通数组直接返回')
  // issue #16 报告者明确提示的形状：schema 验证后字段是引用对象而非数组
  const ref = { get: () => [{ id: 'fromRef' }], meta: { volatile: true } }
  check(api.prefsArray(ref).length === 1 && api.prefsArray(ref)[0].id === 'fromRef', 'volatile 引用对象 → 调 .get() 取实时值')
  check(api.prefsArray({ meta: { volatile: true }, value: [9] })[0] === 9, '带 meta.volatile 的普通包装 → 取 .value')
  // get() 抛错时安全跳过，继续试下一个候选
  const bad = { get: () => { throw new Error('gone') } }
  check(api.prefsArray(bad, [7])[0] === 7, '.get() 抛错 → 跳过该候选，退回下一个')
  check(api.prefsArray(undefined, null, 'x').length === 0, '都不是数组 → 空数组')
  check(api.resolvePrefValue('plain') === 'plain' && api.resolvePrefValue(null) === null, 'resolvePrefValue 对普通值原样返回')
}

console.log('B1 · createNewSettingsFace（新版读写）')
{
  const calls = []
  const value = { profiles: [{ id: 'p1' }, { id: 'p2' }], workspaces: [{ id: 'w1' }] }
  const svc = {
    describe: (opts) => { calls.push(['describe', opts]); return [{ ns: 'other', value: {} }, { ns: 'remote-ssh', value, revision: 7, user: {} }] },
    update: async (ns, patch, rev) => { calls.push(['update', ns, patch, rev]) },
  }
  const built = api.createNewSettingsFace(svc, 'remote-ssh', { profiles: [], workspaces: [] }, { warn: () => {} })
  const read = built.face.read()
  check(read.profiles.length === 2 && read.workspaces.length === 1, '按 entry id 从 describe().value 读取')
  check(calls[0][0] === 'describe' && calls[0][1].redactSecrets === true, 'describe 带 redactSecrets（避免把密钥读回来）')
  await built.face.updateProfiles([{ id: 'p9' }])
  const upd = calls.find((c) => c[0] === 'update')
  check(!!upd && upd[1] === 'remote-ssh' && upd[3] === 7, '写走 update(entryId, patch, revision)（带 revision 防并发覆盖）')
  check(!!upd && Array.isArray(upd[2].profiles) && upd[2].profiles[0].id === 'p9', 'patch 只带被改的字段')

  // 表单缺失 → 退回 fallback（apply 的 config；volatile 引用要 .get()）
  const svc2 = { describe: () => [], update: async () => {} }
  const built2 = api.createNewSettingsFace(svc2, 'remote-ssh', { profiles: [{ id: 'fromConfig' }], workspaces: [] }, { warn: () => {} })
  check(built2.face.read().profiles[0].id === 'fromConfig', '表单缺失 → 退回 apply(config) 的值')
  const built2b = api.createNewSettingsFace(svc2, 'remote-ssh', { profiles: { get: () => [{ id: 'fromRef' }], meta: { volatile: true } } }, { warn: () => {} })
  check(built2b.face.read().profiles[0].id === 'fromRef', 'apply(config) 的字段是引用对象时也能读到（.get()）')

  // 刚迁移进来的数据：让升级后第一次启动即可见（describe 与 config 都还是空）
  const migrated = { profiles: [{ id: 'justImported' }], workspaces: [{ id: 'w-imported' }] }
  const built2c = api.createNewSettingsFace(svc2, 'remote-ssh', {}, { warn: () => {} }, migrated)
  const readC = built2c.face.read()
  check(readC.profiles[0].id === 'justImported' && readC.workspaces[0].id === 'w-imported', '迁移后的内存兜底：第一次启动就能看到连接与工作区')
  // describe 抛错 → 不炸
  const svc3 = { describe: () => { throw new Error('svc down') }, update: async () => {} }
  const warnings = []
  const built3 = api.createNewSettingsFace(svc3, 'remote-ssh', { profiles: [], workspaces: [] }, { warn: (m) => warnings.push(m) })
  check(built3.face.read().profiles.length === 0 && warnings.length === 1, 'describe 抛错 → 空配置 + 一条 warn（不抛）')
}

console.log('B2 · migrateLegacyPrefs（仅在用户层为空时导入）')
{
  const dir = mkdtempSync(join(tmpdir(), 'rssh-migrate-'))
  try {
    writeFileSync(join(dir, 'settings.yaml.imported'), 'dsh-remote-ssh:\n  profiles:\n    - id: legacy\n  workspaces:\n    - id: w9\n')
    const updates = []
    const svc = { describe: () => [], update: async (ns, patch) => { updates.push([ns, patch]) } }
    const formOfEmpty = () => ({ ns: 'remote-ssh', value: { profiles: [], workspaces: [] }, revision: 1, user: {} })
    const out1 = await api.migrateLegacyPrefs({ svc, entryId: 'remote-ssh', formOf: formOfEmpty, homeDir: dir, ns: 'dsh-remote-ssh', declaredKeys: ['profiles', 'workspaces'], log: {} })
    check(out1 === 'imported', '用户层为空 → 导入旧 section')
    check(updates.length === 1 && updates[0][0] === 'remote-ssh' && updates[0][1].profiles[0].id === 'legacy' && updates[0][1].workspaces[0].id === 'w9',
      '写到 entry id，且 profiles/workspaces 都带上')

    updates.length = 0
    const formOfUser = () => ({ ns: 'remote-ssh', value: {}, revision: 2, user: { profiles: [{ id: 'newer' }] } })
    const out2 = await api.migrateLegacyPrefs({ svc, entryId: 'remote-ssh', formOf: formOfUser, homeDir: dir, ns: 'dsh-remote-ssh', declaredKeys: ['profiles', 'workspaces'], log: {} })
    check(out2 === 'already-configured' && updates.length === 0, '用户层已有值 → 不导入（绝不覆盖升级后的设置）')

    const out3 = await api.migrateLegacyPrefs({ svc, entryId: 'remote-ssh', formOf: formOfEmpty, homeDir: '', ns: 'dsh-remote-ssh', declaredKeys: ['profiles'], log: {} })
    check(out3 === 'no-profile-home', '没有 profile home → no-profile-home')
    const out4 = await api.migrateLegacyPrefs({ svc, entryId: 'remote-ssh', formOf: formOfEmpty, homeDir: join(dir, 'nope'), ns: 'dsh-remote-ssh', declaredKeys: ['profiles'], log: {} })
    check(out4 === 'no-legacy-section', '没有旧文件 → no-legacy-section（不写空配置）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log('C · 接线与 schema')
{
  check(/import z from "@deepseek-ai\/schemastery";/.test(src), '用 DSH 分支的 schemastery（只有它实现 .volatile()）')
  check(/import \{ parse as parseYaml \} from "yaml";/.test(src), '引入 yaml 解析器（旧 settings.yaml 迁移用）')
  check(/PrefsSchema\.dict\[key\]\.volatile\(\)/.test(src), 'Config 字段逐个标 .volatile()（否则新版 Loader 不提交写入）')
  check(/const Config = z\.object\(Object\.fromEntries/.test(src), 'Config 由 PrefsSchema 派生（单一事实来源）')
  const cfgIdx = src.indexOf('const Config = z.object(Object.fromEntries')
  const prefsIdx = src.indexOf('const PrefsSchema = z.object')
  check(prefsIdx > 0 && cfgIdx > prefsIdx, 'Config 定义在 PrefsSchema 之后（模块级求值顺序）')
  check(/typeof svc\.describe === "function" && typeof svc\.update === "function"/.test(src), '新版分支按能力探测（describe + update）')
  check(/typeof svc\.register === "function"/.test(src), '旧版分支保留 register（≤0.1.6 兼容）')
  check(/svc\.configure\(\{ auto: false \}, ctx\.fiber\)/.test(src), '新版用 configure 注册页面策略（替代 register）')
  check(/ctx\.loader\.await/.test(src), '迁移等 loader 落定后再写（与 better-sidebar 一致）')
  check(/ctx\.profileContext && ctx\.profileContext\.home/.test(src), '迁移从 profileContext.home 找旧 settings.yaml')
  const pkg = JSON.parse(readFileSync(root + '/package.json', 'utf8'))
  check(pkg.dependencies['@deepseek-ai/schemastery'] !== undefined, 'package.json 声明 @deepseek-ai/schemastery 依赖')
  check(pkg.dependencies.yaml !== undefined, 'package.json 声明 yaml 依赖')
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
