// 浏览器信任判定回归测试（issue #12）。
//
// 背景：isTrusted() 曾硬编码 loopback 白名单，非 loopback 访问（局域网 / 配对设备）下
// 插件的 5 类路由全部 403，且无论何种原因都报 "missing x-requested-with header"。
// 现在与 /api 网关、better-sidebar 的 fence 同源：Host 为 loopback 或命中宿主
// ctx.webRuntime.trustedHosts（启动采样的局域网字面量 + --trusted-host）。
//
// 三层：
//   A. 纯 fence 语义（逐条对照 @deepseek-ai/dsh-client-connection 的 api-request-trust.ts）
//   B. 组合行为：提取真实的 requestTrust，注入桩 trustedHosts 执行（verdict × 头校验）
//   C. 接线：5 处调用点、软注入 webRuntime、按请求实时读取、文案区分原因
import { readFileSync } from 'node:fs'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const src = readFileSync(root + '/lib/index.js', 'utf8')

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

const fence = new Function([
  grab(src, 'function parseAuthority'),
  grab(src, 'function isLoopbackHostname'),
  grab(src, 'function canonicalAuthority'),
  grab(src, 'function isTrustedAuthority'),
  grab(src, 'function hasRequestedWithHeader'),
  grab(src, 'function trustVerdict'),
  grab(src, 'function trustErrorMessage'),
].join('\n') + '\nreturn { parseAuthority, isLoopbackHostname, canonicalAuthority, isTrustedAuthority, hasRequestedWithHeader, trustVerdict, trustErrorMessage };')()

let pass = 0, fail = 0
const check = (cond, label) => { if (cond) { pass++; console.log('  ✓ ' + label) } else { fail++; console.log('  ✗ FAIL: ' + label) } }
const req = (headers) => ({ headers })

console.log('A1 · isLoopbackHostname')
{
  check(fence.isLoopbackHostname('localhost') === true, 'localhost')
  check(fence.isLoopbackHostname('[::1]') === true, '[::1]（IPv6 方括号形式）')
  check(fence.isLoopbackHostname('127.0.0.1') === true, '127.0.0.1')
  check(fence.isLoopbackHostname('127.1.2.3') === true, '127.x.x.x 整段')
  check(fence.isLoopbackHostname('0.0.0.0') === true, '0.0.0.0（本插件历史放行，注释已说明）')
  check(fence.isLoopbackHostname('128.0.0.1') === false, '128.0.0.1 不是 loopback')
  check(fence.isLoopbackHostname('127.0.0.256') === false, '越界段 127.0.0.256 不是 loopback')
  check(fence.isLoopbackHostname('192.168.136.169') === false, '局域网 IP 不是 loopback')
  check(fence.isLoopbackHostname('example.com') === false, '域名不是 loopback')
}

console.log('A2 · authority 解析与匹配（端口语义）')
{
  check(fence.parseAuthority('127.0.0.1:3080') instanceof URL, '可解析 authority')
  check(fence.parseAuthority('bad host') === undefined, '不可解析 → undefined')
  const url = fence.parseAuthority('192.168.136.169:3080')
  check(fence.canonicalAuthority('192.168.136.169:3080', url) === '192.168.136.169:3080', '带端口 → hostname:port')
  const url2 = fence.parseAuthority('192.168.136.169')
  check(fence.canonicalAuthority('192.168.136.169', url2) === '192.168.136.169', '不带端口 → 仅 hostname')
  check(fence.isTrustedAuthority(fence.parseAuthority('192.168.136.169:3080'), ['192.168.136.169:3080']) === true, '条目带端口：精确匹配')
  check(fence.isTrustedAuthority(fence.parseAuthority('192.168.136.169:9999'), ['192.168.136.169:3080']) === false, '条目带端口：端口不符则拒绝')
  check(fence.isTrustedAuthority(fence.parseAuthority('192.168.136.169:9999'), ['192.168.136.169']) === true, '条目不带端口：该主机任意端口都算')
  check(fence.isTrustedAuthority(fence.parseAuthority('10.0.0.5:3080'), ['192.168.136.169:3080']) === false, '主机不符 → 拒绝')
  check(fence.isTrustedAuthority(fence.parseAuthority('192.168.136.169:3080'), []) === false, '空信任列表 → 拒绝')
  check(fence.isTrustedAuthority(fence.parseAuthority('192.168.136.169:3080'), ['not a host', '192.168.136.169:3080']) === true, '无效条目被跳过，有效条目仍命中')
}

console.log('A3 · trustVerdict：issue #12 的验证矩阵')
{
  check(fence.trustVerdict(req({ host: '127.0.0.1:3080' }), []) === 'ok', 'Host 127.0.0.1:3080 → ok')
  check(fence.trustVerdict(req({ host: 'localhost:3080' }), []) === 'ok', 'Host localhost:3080 → ok')
  check(fence.trustVerdict(req({ host: '192.168.136.169:3080' }), []) === 'bad-host', '局域网 IP 且无信任列表 → bad-host（原 bug）')
  check(fence.trustVerdict(req({ host: '192.168.136.169:3080' }), ['192.168.136.169:3080']) === 'ok', '局域网 IP + 宿主信任列表 → ok（修复）')
  check(fence.trustVerdict(req({ host: '192.168.136.169:3080' }), ['192.168.136.169']) === 'ok', '信任条目不带端口也可放行')
  check(fence.trustVerdict(req({}), []) === 'no-host', '无 Host → no-host')
  check(fence.trustVerdict(req({ host: 'not a host' }), []) === 'bad-host', 'Host 不可解析 → bad-host')
  check(fence.trustVerdict(req({ host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' }), []) === 'cross-site', 'cross-site 即便 loopback 也拒绝')
  check(fence.trustVerdict(req({ host: '192.168.136.169:3080', 'sec-fetch-site': 'cross-site' }), ['192.168.136.169:3080']) === 'cross-site', 'cross-site 即便可信主机也拒绝')
  check(fence.trustVerdict(req({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }), []) === 'ok', 'Origin 与 Host 一致 → ok')
  check(fence.trustVerdict(req({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1' }), []) === 'ok', 'Origin 缺端口（Edge 151 序列化）仍 ok')
  check(fence.trustVerdict(req({ host: '127.0.0.1:3080', origin: 'http://evil.example' }), []) === 'bad-origin', 'Origin 不同 → bad-origin')
  check(fence.trustVerdict(req({ host: '127.0.0.1:3080', origin: 'null' }), []) === 'bad-origin', 'Origin: null（沙箱/file:）→ 拒绝')
  check(fence.trustVerdict(req({ host: '127.0.0.1:3080', origin: 'http://[::1]:3080' }), []) === 'bad-origin', 'Origin 主机名不同（[::1] vs 127.0.0.1）→ 拒绝')
}

console.log('A4 · 头校验与文案')
{
  check(fence.hasRequestedWithHeader(req({ 'x-requested-with': 'XMLHttpRequest' })) === true, '正确头 → true')
  check(fence.hasRequestedWithHeader(req({ 'x-requested-with': ' XMLHttpRequest ' })) === true, '首尾空白容忍')
  check(fence.hasRequestedWithHeader(req({})) === false, '缺头 → false')
  check(fence.hasRequestedWithHeader(req({ 'x-requested-with': 'fetch' })) === false, '错误值 → false')

  const headerMsg = fence.trustErrorMessage('header')
  const hostMsg = fence.trustErrorMessage('bad-host')
  check(headerMsg === 'missing x-requested-with header', '缺头文案保持不变（客户端依赖它）')
  check(hostMsg !== headerMsg && /untrusted host/.test(hostMsg), 'Host 被拒时不再误报「缺头」（issue #12 的误导点）')
  check(/--trusted-host/.test(hostMsg), 'Host 文案给出官方放行手段（--trusted-host）')
  check(/cross-site/.test(fence.trustErrorMessage('cross-site')), 'cross-site 文案可区分')
  check(/origin/i.test(fence.trustErrorMessage('bad-origin')), 'origin 文案可区分')
}

console.log('B · 组合行为：真实 requestTrust + 桩 trustedHosts')
{
  const requestTrustSrc = grab(src, 'function requestTrust')
  const make = (trustedHosts) => new Function('trustVerdict', 'trustedHostsNow', 'hasRequestedWithHeader',
    requestTrustSrc + '\nreturn requestTrust;')(fence.trustVerdict, () => trustedHosts, fence.hasRequestedWithHeader)

  const local = make([])
  check(local(req({ host: '127.0.0.1:3080', 'x-requested-with': 'XMLHttpRequest' }), true) === 'ok', '本机 + 带头 → ok')
  check(local(req({ host: '127.0.0.1:3080' }), true) === 'header', '本机 + 缺头（需头路由）→ header')
  check(local(req({ host: '127.0.0.1:3080' }), false) === 'ok', '本机 + 不需头路由 → ok')

  const lan = make(['192.168.136.169:3080'])
  check(lan(req({ host: '192.168.136.169:3080', 'x-requested-with': 'XMLHttpRequest' }), true) === 'ok', '可信局域网 + 带头 → ok（修复目标）')
  check(lan(req({ host: '192.168.136.169:3080' }), true) === 'header', '可信局域网 + 缺头 → 报 header（原因准确）')
  check(lan(req({ host: '192.168.136.169:3080' }), false) === 'ok', '可信局域网（fs.* 等不需头路由）→ ok')
  check(lan(req({ host: '10.1.1.1:3080', 'x-requested-with': 'XMLHttpRequest' }), true) === 'bad-host', '未列入信任列表的主机仍拒绝')

  // 实时读取：信任列表变化后无需重启（桩每次调用返回新值）
  let live = []
  const liveTrust = new Function('trustVerdict', 'trustedHostsNow', 'hasRequestedWithHeader',
    requestTrustSrc + '\nreturn requestTrust;')(fence.trustVerdict, () => live, fence.hasRequestedWithHeader)
  const lanReq = req({ host: '192.168.136.169:3080' })
  check(liveTrust(lanReq, false) === 'bad-host', '信任列表为空 → 拒绝')
  live = ['192.168.136.169:3080']
  check(liveTrust(lanReq, false) === 'ok', '信任列表被替换后立即生效（按请求实时读取）')
}

console.log('C · 接线')
{
  const callSites = (src.match(/= requestTrust\(req,/g) || []).length
  check(callSites === 5, `5 处调用点全部改用 requestTrust（实际 ${callSites}）`)
  check(!/!isTrusted\(req/.test(src), '不再有旧 isTrusted(req) 布尔调用')
  check(/ctx\.inject\(\["webRuntime"\]/.test(src), '软注入 webRuntime（缺失时退回 loopback-only，插件仍可挂载）')
  check(/function trustedHostsNow\(\)[\s\S]{0,220}webRuntimeFace/.test(src), '按请求读取 webRuntime.trustedHosts')
  check(/webRuntimeFace && webRuntimeFace\.trustedHosts/.test(src), '实时读服务值（可被替换）')
  const denyCount = (src.match(/denyRequest\(res, \w+Trust\)/g) || []).length
  check(denyCount === 4, `4 个 JSON 路由用 denyRequest 输出准确原因（实际 ${denyCount}）`)
  check(/res\.end\(trustErrorMessage\(fileTrust\)\)/.test(src), '/sidebar/file 的纯文本 403 也带准确原因')
  check(/code: reason === "header" \? "csrf" : "forbidden"/.test(src), '错误码保持兼容（缺头 csrf / 其余 forbidden）')
  check(/issue #12/.test(src), '代码注释记录了 issue 编号与同源说明')
  check(/api-request-trust\.ts/.test(src), '注释标明逐条对照的上游实现（可追溯）')
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
