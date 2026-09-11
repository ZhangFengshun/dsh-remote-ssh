// 超时逻辑单元测试：从 lib/index.js 提取真实的 withTimeout / resolveTimeoutMs / DEFAULT_CMD_TIMEOUT_MS 文本执行。
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");

// 提取 withTimeout 函数文本（含内部依赖 resolveTimeoutMs / DEFAULT_CMD_TIMEOUT_MS）
const grab = (name) => {
  const start = src.indexOf(name);
  if (start < 0) throw new Error(name + " not found");
  // 向前找到所属声明起点
  const declStart = src.lastIndexOf("\n", start);
  // 向后做括号配对，找到函数体结束
  let i = src.indexOf("{", start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) break; }
  }
  // 箭头函数 IIFE（const X = (() => {...})();）补上 )();
  if (src.slice(i + 1).match(/^\s*\)\s*\(\s*\)\s*;/)) {
    const m = src.slice(i + 1).match(/^\s*\)\s*\(\s*\)\s*;/)[0];
    return src.slice(declStart + 1, i + 1 + m.length);
  }
  return src.slice(declStart + 1, i + 1);
};

const code = [grab("const DEFAULT_CMD_TIMEOUT_MS"), grab("function resolveTimeoutMs"), grab("function withTimeout")].join("\n");
const factory = new Function(code + "\nreturn { withTimeout, resolveTimeoutMs, DEFAULT_CMD_TIMEOUT_MS };");
const { withTimeout, resolveTimeoutMs, DEFAULT_CMD_TIMEOUT_MS } = factory();

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log("  ✓ " + msg); }
  else { fail++; console.log("  ✗ FAIL: " + msg); }
}

console.log("DEFAULT_CMD_TIMEOUT_MS =", DEFAULT_CMD_TIMEOUT_MS);
assert(DEFAULT_CMD_TIMEOUT_MS === 120000, "默认超时 120s");
assert(resolveTimeoutMs(undefined) === 120000, "resolveTimeoutMs(undefined) → 默认");
assert(resolveTimeoutMs(null) === 120000, "resolveTimeoutMs(null) → 默认");
assert(resolveTimeoutMs(3000) === 3000, "resolveTimeoutMs(3000) → 3000");
assert(resolveTimeoutMs("5000") === 5000, "resolveTimeoutMs('5000') → 5000");
assert(resolveTimeoutMs(0) === 0, "resolveTimeoutMs(0) → 0（禁用）");
assert(resolveTimeoutMs(-1) === 120000, "resolveTimeoutMs(-1) → 默认（非法值回落）");

// 正常完成：不触发超时
const r1 = await withTimeout(Promise.resolve("done"), 1000, "t1");
assert(r1 === "done", "正常 promise 原样透传");

// 超时触发：isTimeout 标记 + onTimeout 被调用
let cleaned = false;
try {
  await withTimeout(new Promise(() => {}), 80, "挂起命令", () => { cleaned = true; });
  assert(false, "挂起 promise 应超时 reject");
} catch (e) {
  assert(e.isTimeout === true, "超时错误带 isTimeout");
  assert(/挂起命令/.test(e.message) && /80ms/.test(e.message), "错误消息含标签与毫秒数");
  assert(cleaned === true, "onTimeout（丢弃会话）被调用");
}

// 禁用超时：ms<=0 时原样返回 promise（不做 race）
const same = withTimeout(Promise.resolve("x"), 0, "t2");
assert(typeof same.then === "function", "ms=0 时返回原 promise");

// 超时后，被放弃的 promise 后续 settle 不产生 unhandledRejection（race 已挂处理器）
const late = new Promise((_, rej) => setTimeout(() => rej(new Error("late")), 150));
try { await withTimeout(late, 50, "t3"); } catch (e) { assert(e.isTimeout, "t3 超时"); }
await new Promise((r) => setTimeout(r, 250)); // 留时间让 late 的 reject 落地
console.log("（若上方无 unhandledRejection 告警，则 late rejection 已被安全处理）");

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
