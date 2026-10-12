// 设置项的可达性（issue #24 第二轮验收里举报人指出的问题）：
// 2.4.24 修好了"写回失败对模型不可见"，但 `nodePath`（#23 的逃生舱）、`writeBack*`、
// `writeBackFreshness` 这几个字段**没有进客户端设置界面** —— 而 #23 的场景恰恰是"终端完全
// 打不开、最需要一条自救路径"的那批用户；他们够不着设置，等于逃生舱不存在。
//
// 这个文件同时钉住三件事：
//   ① 客户端设置面板真的有这几个控件（而不是只存在于 README 里）；
//   ② 宿主侧真的有对应端点，且三个 settings face（新版 / 旧版 / 只读兜底）都实现了 updatePrefs；
//   ③ `settingsFace.read()` 真的回这几个标量 —— 否则 writeBackFailure / writeBackFreshness
//      的运行时判断永远读不到用户设的值（这是 2.4.24 里一个没被发现的 bug）。
import { readFileSync } from 'node:fs'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const src = readFileSync(root + '/lib/index.js', 'utf8')
const client = readFileSync(root + '/lib/client.js', 'utf8')

let pass = 0
let fail = 0
const check = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label) }
  else { fail++; console.log('  ✗ FAIL: ' + label) }
}

console.log('A · 客户端设置面板：四个字段都有控件（issue #23 的 nodePath + issue #24 的三项）')
{
  check(/api\("getPrefs"\)/.test(client), '面板加载时读全局偏好（getPrefs）')
  check(/api\("savePrefs"/.test(client), '面板能保存全局偏好（savePrefs）')
  check(/api\("updateWorkspaceGuards"/.test(client), '每个工作区能保存写回护栏（updateWorkspaceGuards）')
  check(/setPref\("nodePath"/.test(client), 'nodePath 有输入框（终端起不来时用户能自救）')
  check(/setPref\("writeBackFailure"/.test(client), 'writeBackFailure 有下拉（error / log）')
  check(/setPref\("writeBackFreshness"/.test(client), 'writeBackFreshness 有勾选（护栏 B 开关）')
  check(/setGuard\(ws\.id, "writeBack"/.test(client), '每个工作区有"启用写回"勾选（护栏 A）')
  check(/setGuard\(ws\.id, "exclude"/.test(client), '每个工作区有写回排除输入框（护栏 A）')
  check(/placeholder: "_patch\/, \*\.log, wbdeep\/\*\*"/.test(client), '排除项的占位示例就是验收里用过的三条（可照抄）')
}

console.log('B · 双语键齐备：每个新键在 zh 与 en 各出现一次（只加一种语言是常见疏漏）')
{
  const keys = [
    'settings.guards', 'settings.guardsHint', 'settings.nodePath', 'settings.writeBackFailure',
    'settings.wbError', 'settings.wbLog', 'settings.writeBackFreshness',
    'settings.wsWriteBack', 'settings.wsWriteBackExclude', 'settings.saveGuards'
  ]
  for (const k of keys) {
    const n = (client.match(new RegExp('"' + k.replace(/\./g, '\\.') + '":', 'g')) || []).length
    check(n === 2, k + ' 在 zh/en 各定义一次（实际 ' + n + '）')
  }
}

console.log('C · 宿主端点：白名单、只写这三个字段，且写回的是最新值')
{
  check(/getPrefs: async \(\) => \{/.test(src), '有 getPrefs 端点')
  check(/savePrefs: async \(args\) => \{/.test(src), '有 savePrefs 端点')
  check(/updateWorkspaceGuards: async \(args\) => \{/.test(src), '有 updateWorkspaceGuards 端点')
  const saveBody = src.slice(src.indexOf('savePrefs: async (args) => {'), src.indexOf('updateWorkspaceGuards: async (args) => {'))
  check(/typeof a\.nodePath === "string"/.test(saveBody), '只接受字符串 nodePath（白名单，不让客户端乱写）')
  check(/patch\.writeBackFailure = \(m === "log" \|\| m === "silent"\) \? "log" : "error"/.test(saveBody),
    'writeBackFailure 只归一化成 error / log 两态（避免写入拼错的字符串）')
  check(/typeof a\.writeBackFreshness === "boolean"/.test(saveBody), 'writeBackFreshness 只接受布尔')
  check(!/patch\.profiles/.test(saveBody) && !/patch\.workspaces/.test(saveBody), '不会顺手改 profiles / workspaces（负向控制）')
  const guardBody = src.slice(src.indexOf('updateWorkspaceGuards: async (args) => {'), src.indexOf('createRemoteWorkspace: async (args) => {'))
  check(/settingsFace\.updateWorkspaces\(list\)/.test(guardBody), '工作区护栏走整表替换（schema 是数组字段）')
  check(/\.map\(\(s\) => String\(s \|\| ""\)\.trim\(\)\)\.filter\(Boolean\)/.test(guardBody), '排除项去空白、丢空串（否则空规则会命中一切）')
}

console.log('D · 三个 settings face 都要有 updatePrefs，否则旧版 DSH 上保存会静默无效')
{
  const n = (src.match(/updatePrefs:/g) || []).length
  check(n === 3, 'updatePrefs 在三处都实现（新版 describe/update、旧版 register、只读兜底；实际 ' + n + '）')
  check(/updatePrefs: \(patch\) => write\(patch\)/.test(src), '新版 face：写进 loader 行的 Config')
  check(/updatePrefs: async \(patch\) => \{ await scope\.update\(patch\); \}/.test(src), '旧版 face：走 scope.update')
}

console.log('E · read() 必须回标量（2.4.24 的隐性 bug：writeBackFailure 读了 undefined）')
{
  check(/nodePath: String\(prefsScalar\("", v && v\.nodePath/.test(src), '新版 read() 回 nodePath')
  check(/writeBackFailure: String\(prefsScalar\("error", v && v\.writeBackFailure/.test(src), '新版 read() 回 writeBackFailure')
  check(/writeBackFreshness: prefsScalar\(true, v && v\.writeBackFreshness/.test(src), '新版 read() 回 writeBackFreshness')
  const reads = (src.match(/nodePath: String\(prefsScalar/g) || []).length
  check(reads === 3, '三个 face 的 read() 都回这些标量（实际 ' + reads + '）')
  // 运行时的两个判断读的就是 read() 的字段 —— 把这条关系钉住，避免以后又把字段挪走
  const failureMode = src.slice(src.indexOf('function writeBackFailureMode() {'), src.indexOf('function writeBackFreshnessEnabled() {'))
  check(/settingsFace\.read\(\)\.writeBackFailure/.test(failureMode), 'writeBackFailureMode 读的是 read().writeBackFailure')
  check(/settingsFace\.read\(\)\.writeBackFreshness/.test(src), 'writeBackFreshnessEnabled 读的是 read().writeBackFreshness')
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
