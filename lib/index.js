/**
 * @zhangfengshun/dsh-remote-ssh — Host 半边（静态 DSH Web 插件）
 *
 * 能力：
 *   1. 远程连接配置 + 远程工作区持久化到 DSH settings 命名空间 `dsh-remote-ssh`
 *      （schemastery schema，密码字段 role('secret') 在描述时脱敏）。
 *   2. 通过 SSH 提供文件列举 / 读取 / 写入 / 执行 / 集成终端（ssh -tt 管道通道）。
 *   3. 暴露 HTTP JSON API（/remote-ssh/api/*）给 Client 半边。
 *   4. 注册 5 个模型工具（remote_ssh_*）。
 */
import z from "schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import { mkdir, rm, writeFile, readFile, opendir, stat, open, rename, readdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

/** Plugin identity for cordis.yml rows. */
const name = "@zhangfengshun/dsh-remote-ssh";
/** Services required before mounting. */
const inject = ["webServer", "subprocess", "tools", "workspaceRegistry"];
/** Composition config schema（本插件暂无配置项）。 */
const Config = z.object({});

const NS = "dsh-remote-ssh";
const MAX_BYTES = 4 * 1024 * 1024;
const API_BASE = "/remote-ssh/api/";

/** 连接配置 schema（存于 settings）。 */
const ProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  host: z.string(),
  port: z.number().default(22),
  user: z.string(),
  authMethod: z.string().default("key"),
  keyPath: z.string().default(""),
  password: z.string().default("").role("secret"),
  remoteRoot: z.string().default("~"),
  proxyJump: z.string().default("")
});
/** 远程工作区 schema（连接配置 + 远程根目录 + 本地镜像目录）。 */
const WorkspaceSchema = z.object({
  id: z.string(),
  profileId: z.string(),
  title: z.string(),
  remotePath: z.string(),
  mirrorPath: z.string().default("")
});
/** settings 命名空间的完整 schema。 */
const PrefsSchema = z.object({
  profiles: z.array(ProfileSchema).default([]),
  workspaces: z.array(WorkspaceSchema).default([])
});

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

/** 引用远程路径：开头 `~`/`~/` 保留给远程 shell 展开为家目录，其余单引号防注入。 */
function shellQuotePath(s) {
  const str = String(s);
  if (str === "~") return "~";
  if (str.startsWith("~/")) return "~/" + shellQuote(str.slice(2));
  return shellQuote(str);
}

/**
 * 解析 OpenSSH 用户配置（~/.ssh/config），递归处理 Include，发现其中的具体主机。
 * 借鉴 Yan-Zero dsh-remote-ssh：自动读取 OpenSSH 配置发现主机，免去手动录入。
 * 返回 [{ name, hostName, user, port, identityFile, proxyJump }]。
 */
function expandSshPath(raw) {
  const s = String(raw || "").trim();
  if (s === "~") return join(homedir());
  if (s.startsWith("~/")) return join(homedir(), s.slice(2));
  return s;
}

async function parseSshConfigFile(filePath, seen) {
  const real = filePath;
  if (seen.has(real)) return [];
  seen.add(real);
  let text;
  try {
    text = await readFile(filePath, "utf8");
  } catch (e) {
    return [];
  }
  const hosts = [];
  let cur = null;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const hash = raw.indexOf("#");
    const line = (hash >= 0 ? raw.slice(0, hash) : raw).trim();
    if (!line) continue;
    const sp = line.search(/\s+/);
    if (sp < 0) continue;
    const key = line.slice(0, sp).toLowerCase();
    const val = line.slice(sp).trim();
    if (key === "host") {
      // 多个名字空格分隔；含通配符 * / ? 的跳过
      const names = val.split(/\s+/);
      cur = null;
      for (const n of names) {
        if (n && !/[*?]/.test(n)) {
          cur = { name: n, hostName: "", user: "", port: 22, identityFile: "", proxyJump: "" };
          hosts.push(cur);
          break;
        }
      }
    } else if (cur) {
      if (key === "hostname") cur.hostName = val;
      else if (key === "user") cur.user = val;
      else if (key === "port") { const pn = parseInt(val, 10); if (!isNaN(pn)) cur.port = pn; }
      else if (key === "identityfile") cur.identityFile = expandSshPath(val);
      else if (key === "proxyjump") cur.proxyJump = val;
      else if (key === "include") {
        // 递归 Include（相对 ~/.ssh/ 或绝对）
        for (const inc of val.split(/\s+/)) {
          if (!inc) continue;
          const incPath = expandSshPath(inc);
          const sub = await parseSshConfigFile(incPath, seen);
          for (const h of sub) hosts.push(h);
        }
      }
    }
  }
  return hosts;
}

async function listSshConfigHosts() {
  const cfg = join(homedir(), ".ssh", "config");
  const seen = new Set();
  let hosts = [];
  try {
    hosts = await parseSshConfigFile(cfg, seen);
  } catch (e) {
    return { ok: false, error: "读取 ~/.ssh/config 失败: " + String(e && e.message ? e.message : e) };
  }
  // 过滤掉没有 hostName 的占位条目；保留 user 默认
  const out = hosts.filter((h) => h.hostName).map((h) => ({
    name: h.name,
    hostName: h.hostName,
    user: h.user || "",
    port: h.port || 22,
    identityFile: h.identityFile || "",
    proxyJump: h.proxyJump || ""
  }));
  return { ok: true, hosts: out };
}

/**
 * 持久 SSH 会话：维护一条常驻 ssh <host> bash 进程，所有命令复用它，
 * 避免每次操作都做完整 TCP 握手 + SSH 密钥交换 + 认证（超算/跳板机单次 2-10 秒）。
 *
 * 工作原理：向 bash 的 stdin 写入命令 + 哨兵标记 printf，从 stdout 读取直到哨兵出现，
 * 哨兵后的数字即退出码。每条命令用 2>&1 合并 stderr（成功时 stderr 为空，不影响解析；
 * 失败时错误信息在 stdout 中，退出码非 0）。带 stdin 的写操作用 heredoc。
 */
class CommandSession {
  constructor(subprocess, profile) {
    this.subprocess = subprocess;
    this.profile = profile;
    this.handle = null;
    this.alive = false;
    this.buf = "";
    this.queue = [];
    this.current = null;
    this.sentinel = "DSHEOF" + Math.random().toString(36).slice(2, 14) + Math.random().toString(36).slice(2, 10) + "DSHEOF";
    this.lastUsed = Date.now();
    this.connectPromise = null;
  }

  async connect() {
    if (this.alive && this.handle) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this._doConnect();
    try { await this.connectPromise; } finally { this.connectPromise = null; }
  }

  async _doConnect() {
    if (this.handle) { try { this.handle.terminate(); } catch (e) {} this.handle = null; }
    this.alive = false;
    this.buf = "";
    this.current = null;
    this.queue = [];
    const argv = sshArgv(this.profile, "bash", false);
    const h = this.subprocess.spawn({
      argv: argv,
      cwd: process.cwd(),
      stdio: { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
      graceMs: 60000
    });
    this.handle = h;
    h.stdout.on("data", (chunk) => {
      this.buf += chunk.toString("utf8");
      this._check();
    });
    const onEnd = () => {
      this.alive = false;
      if (this.current) { this.current.reject(new Error("ssh 会话已关闭")); this.current = null; }
      while (this.queue.length) this.queue.shift().reject(new Error("ssh 会话已关闭"));
    };
    h.stdout.on("end", onEnd);
    h.stdout.on("error", onEnd);
    h.done.then(() => { this.alive = false; }, () => { this.alive = false; });
    this.alive = true;
    this.lastUsed = Date.now();
  }

  _check() {
    if (!this.current) return;
    const idx = this.buf.indexOf(this.sentinel);
    if (idx < 0) return;
    const before = this.buf.slice(0, idx);
    const after = this.buf.slice(idx + this.sentinel.length);
    const nl = after.indexOf("\n");
    const codeStr = nl >= 0 ? after.slice(0, nl) : after;
    const rest = nl >= 0 ? after.slice(nl + 1) : "";
    this.buf = rest;
    const exitCode = parseInt(codeStr, 10);
    const cur = this.current;
    this.current = null;
    cur.resolve({ stdout: before, exitCode: isNaN(exitCode) ? -1 : exitCode });
    this._next();
  }

  _next() {
    if (this.current || !this.alive || this.queue.length === 0) return;
    const item = this.queue.shift();
    this.current = { resolve: item.resolve, reject: item.reject };
    try {
      let toWrite;
      if (item.stdinData !== undefined && item.stdinData !== null) {
        // 写操作：heredoc 传内容，不用 2>&1（cat > file 不产生 stdout）
        const delim = "DSHW" + Math.random().toString(36).slice(2, 14);
        toWrite = item.cmd + " <<'" + delim + "'\n" + String(item.stdinData) + "\n" + delim + "\nprintf '\\n" + this.sentinel + "%s\\n' $?\n";
      } else {
        // 读/列举/搜索：2>&1 合并 stderr（成功时 stderr 为空）
        toWrite = "{ " + item.cmd + " ; } 2>&1\nprintf '\\n" + this.sentinel + "%s\\n' $?\n";
      }
      this.handle.stdin.write(toWrite);
    } catch (e) {
      this.current = null;
      item.reject(e);
      this._next();
    }
  }

  async exec(cmd, stdinData) {
    await this.connect();
    this.lastUsed = Date.now();
    return new Promise((resolve, reject) => {
      this.queue.push({ cmd, stdinData, resolve, reject });
      this._next();
    });
  }

  close() {
    this.alive = false;
    if (this.current) { this.current.reject(new Error("session closed")); this.current = null; }
    while (this.queue.length) this.queue.shift().reject(new Error("session closed"));
    if (this.handle) { try { this.handle.terminate(); } catch (e) {} this.handle = null; }
  }
}

function sshArgv(p, remoteCmd, tty) {
  const opts = ["ssh"];
  if (tty) opts.push("-tt");
  opts.push("-p", String(p.port || 22));
  opts.push("-o", "StrictHostKeyChecking=accept-new");
  opts.push("-o", "ConnectTimeout=15");
  opts.push("-o", "ServerAliveInterval=30");
  opts.push("-o", "ServerAliveCountMax=3");
  // 插件内部连接（文件读写/工具/同步）不需要端口转发；
  // 清除 ssh config 里的 RemoteForward/LocalForward，避免端口被占时连接直接失败。
  opts.push("-o", "ClearAllForwardings=yes");
  if (p.proxyJump) opts.push("-o", "ProxyJump=" + String(p.proxyJump));
  if (p.authMethod === "key" && p.keyPath) opts.push("-i", p.keyPath);
  const target = String(p.user || "") + "@" + String(p.host || "");
  const head = (p.authMethod === "password" && p.password) ? ["sshpass", "-p", String(p.password)] : [];
  const argv = head.concat(opts, [target]);
  if (remoteCmd !== undefined) argv.push(remoteCmd);
  return argv;
}

async function runRemote(subprocess, p, remoteCmd, stdinData, maxBytes) {
  const max = maxBytes || MAX_BYTES;
  let handle;
  try {
    handle = subprocess.spawn({
      argv: sshArgv(p, remoteCmd, false),
      cwd: process.cwd(),
      stdio: {
        stdin: stdinData !== undefined ? { data: String(stdinData) } : "ignore",
        stdout: { maxBytes: max, spill: { maxBytes: max } },
        stderr: { maxBytes: max, spill: { maxBytes: max } }
      },
      graceMs: 3000
    });
  } catch (e) {
    return { ok: false, error: "spawn 失败: " + String(e && e.message ? e.message : e) };
  }
  let outcome;
  try {
    outcome = await handle.done;
  } catch (e) {
    return { ok: false, error: "执行失败: " + String(e && e.message ? e.message : e) };
  }
  const so = (handle.collected && handle.collected.stdout) ? handle.collected.stdout.readFrom(0) : { text: "", nextOffset: 0, lossy: false };
  const se = (handle.collected && handle.collected.stderr) ? handle.collected.stderr.readFrom(0) : { text: "", nextOffset: 0, lossy: false };
  const outText = so.text;
  const errText = se.text;
  let error = "";
  if (outcome.exitCode !== 0 && !outText && !errText) {
    error = "ssh 退出码 " + outcome.exitCode + (outcome.signal ? " (signal " + outcome.signal + ")" : "");
  }
  return {
    ok: outcome.exitCode === 0,
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    stdout: outText,
    stderr: errText,
    truncated: !!(so.lossy || se.lossy),
    error: error
  };
}

async function remoteListDir(runner, p, path) {
  const target = path || p.remoteRoot || "~";
  const script = "cd " + shellQuotePath(target) + " 2>/dev/null || { echo '__DSH_ERR__ cannot cd'; exit 1; }; find . -maxdepth 1 -mindepth 1 -printf '%Y\\t%f\\t%s\\n' 2>/dev/null | sort";
  const r = await runner(p, script, undefined, MAX_BYTES);
  if (!r.ok) return { ok: false, error: (r.error || r.stderr || "").trim() || "读取目录失败" };
  const entries = [];
  const lines = String(r.stdout || "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 2) continue;
    const nm = parts[1];
    if (nm === "." || nm === "..") continue;
    entries.push({ name: nm, type: parts[0] === "d" ? "directory" : "file", size: parts[2] ? (parseInt(parts[2], 10) || 0) : 0 });
  }
  entries.sort(function (a, b) {
    return a.type === b.type ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : (a.type === "directory" ? -1 : 1);
  });
  return { ok: true, path: target, entries: entries };
}

async function remoteReadFile(runner, p, path) {
  if (!path) return { ok: false, error: "path 为必填项" };
  const r = await runner(p, "base64 -w0 " + shellQuotePath(path), undefined, MAX_BYTES);
  if (!r.ok) return r;
  let text = "";
  let binary = false;
  try {
    const bytes = new Uint8Array(Buffer.from(String(r.stdout).trim(), "base64"));
    const first = bytes.subarray(0, 8000);
    for (let i = 0; i < first.length; i++) { if (first[i] === 0) { binary = true; break; } }
    text = new TextDecoder().decode(bytes);
  } catch (e) {
    return { ok: false, error: "解码失败: " + String(e) };
  }
  return { ok: true, path: path, content: text, binary: binary, truncated: r.truncated };
}

async function remoteWriteFile(runner, p, path, content) {
  if (!path) return { ok: false, error: "path 为必填项" };
  const c = content !== undefined ? String(content) : "";
  return await runner(p, "cat > " + shellQuotePath(path), c, MAX_BYTES);
}

/**
 * 在远端递归搜索文件内容（grep -rnIE）。借鉴 dsh-remote / dsh-remote-ssh 的远程内容搜索，
 * 但用通用的 GNU grep（超算/Linux 通用），不依赖 ripgrep。
 * exit 1 = 无匹配（ok，空结果）；exit 0 = 有匹配；exit 2 = 出错。
 */
async function remoteGrep(runner, p, pattern, path, opts) {
  opts = opts || {};
  const target = path || p.remoteRoot || "~";
  const parts = ["grep", "-rnIE"];
  if (opts.ignoreCase) parts.push("-i");
  if (opts.include) parts.push("--include=" + String(opts.include));
  parts.push("--", shellQuote(pattern), shellQuotePath(target));
  const cmd = parts.join(" ");
  const r = await runner(p, cmd, undefined, MAX_BYTES);
  if (r.exitCode === 1 || (r.ok && !r.stdout)) {
    return { ok: true, pattern: pattern, path: target, matches: [], truncated: false, error: "" };
  }
  if (r.exitCode > 1 && !r.ok) {
    const err = (r.stderr || r.error || "").trim();
    if (err && !r.stdout) return { ok: false, pattern: pattern, path: target, matches: [], truncated: false, error: err };
  }
  const all = [];
  const lines = String(r.stdout || "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const c1 = line.indexOf(":");
    if (c1 < 0) { all.push({ file: line, line: 0, content: "" }); continue; }
    const file = line.slice(0, c1);
    const rest = line.slice(c1 + 1);
    const c2 = rest.indexOf(":");
    if (c2 < 0) { all.push({ file: file, line: 0, content: rest }); continue; }
    const ln = parseInt(rest.slice(0, c2), 10);
    all.push({ file: file, line: isNaN(ln) ? 0 : ln, content: rest.slice(c2 + 1) });
  }
  const max = parseInt(String(opts.maxResults || 200), 10) || 200;
  const truncated = all.length > max || !!r.truncated;
  const matches = all.slice(0, max);
  return { ok: true, pattern: pattern, path: target, matches: matches, truncated: truncated, error: "" };
}

/**
 * 在远端按 glob 模式查找文件（find -name）。find 已递归；pattern 为 basename 通配
 * （如 .py 后缀），自动剥离前导双星号-斜杠与星号-斜杠以适配 POSIX find -name。
 */
async function remoteGlob(runner, p, pattern, path, opts) {
  opts = opts || {};
  const target = path || p.remoteRoot || "~";
  let pat = String(pattern || "").trim();
  pat = pat.replace(/^(\*\*\/|\*\/)+/, "");
  const max = parseInt(String(opts.maxResults || 500), 10) || 500;
  const cmd = "find " + shellQuotePath(target) + " -name " + shellQuote(pat) + " -printf '%p\\n' 2>/dev/null | sort | head -n " + max;
  const r = await runner(p, cmd, undefined, MAX_BYTES);
  const files = String(r.stdout || "").split("\n").filter(function (s) { return !!s; });
  return { ok: true, pattern: pattern, path: target, files: files, truncated: !!r.truncated, error: "" };
}

/**
 * tar-over-ssh 双向同步（借鉴 flymysql dsh-remote 的 SFTP 镜像同步，但复用现有 ssh.exe + tar，
 * 不引入 ssh2 依赖）。用流式管道把一条 ssh 的 stdout 喂给本地 tar 的 stdin（反之亦然），
 * 不经过 4MB Buffer 上限。
 */
function spawnOne(subprocess, argv, stdio, cwd) {
  return subprocess.spawn({ argv: argv, cwd: cwd || process.cwd(), stdio: stdio, graceMs: 60000 });
}

function readCollected(handle, name) {
  if (!handle || !handle.collected || !handle.collected[name]) return "";
  const r = handle.collected[name].readFrom(0);
  return r ? r.text : "";
}

/** 远端 → 本地镜像：先清空 mirror，再 tar 展开到 mirror。 */
async function remoteSyncDown(subprocess, p, remotePath, mirrorPath) {
  if (!remotePath) return { ok: false, error: "remotePath 为必填项" };
  if (!mirrorPath) return { ok: false, error: "mirrorPath 为必填项" };
  try { await rm(mirrorPath, { recursive: true, force: true }); } catch (e) {}
  try { await mkdir(mirrorPath, { recursive: true }); } catch (e) {
    return { ok: false, error: "创建镜像目录失败: " + String(e && e.message ? e.message : e) };
  }
  const COLLECT = { maxBytes: 1024 * 1024, spill: { maxBytes: 1024 * 1024 } };
  let sshH, tarH;
  try {
    sshH = spawnOne(subprocess, sshArgv(p, "tar cf - -C " + shellQuotePath(remotePath) + " ."), {
      stdin: "ignore", stdout: "pipe", stderr: COLLECT
    });
    tarH = spawnOne(subprocess, ["tar", "xf", "-", "-C", mirrorPath], {
      stdin: "pipe", stdout: "ignore", stderr: COLLECT
    });
  } catch (e) {
    return { ok: false, error: "spawn 失败: " + String(e && e.message ? e.message : e) };
  }
  let pipeErr = "";
  try {
    if (sshH.stdout && tarH.stdin) sshH.stdout.pipe(tarH.stdin);
    else pipeErr = "stdout/stdin 管道不可用（subprocess 未暴露原始流）";
  } catch (e) { pipeErr = String(e && e.message ? e.message : e); }
  let sshOut, tarOut;
  try { sshOut = await sshH.done; } catch (e) { sshOut = { exitCode: -1 }; }
  try { tarOut = await tarH.done; } catch (e) { tarOut = { exitCode: -1 }; }
  const sshErr = readCollected(sshH, "stderr");
  const tarErr = readCollected(tarH, "stderr");
  // ssh 正常退出且 tar 正常退出才算成功
  if (sshOut.exitCode === 0 && tarOut.exitCode === 0) return { ok: true, mirrorPath: mirrorPath };
  const parts = [];
  if (pipeErr) parts.push("管道: " + pipeErr);
  if (sshOut.exitCode !== 0) parts.push("ssh 退出码 " + sshOut.exitCode + (sshErr ? ": " + sshErr.slice(0, 500) : ""));
  if (tarOut.exitCode !== 0) parts.push("tar 退出码 " + tarOut.exitCode + (tarErr ? ": " + tarErr.slice(0, 500) : ""));
  if (!parts.length) parts.push("远端可能缺少 tar，或本机无 tar.exe");
  return { ok: false, error: "同步失败: " + parts.join("；") };
}

/** 本地镜像 → 远端：本地 tar 打包喂给远端 tar 展开。 */
async function remoteSyncUp(subprocess, p, remotePath, mirrorPath) {
  if (!remotePath) return { ok: false, error: "remotePath 为必填项" };
  if (!mirrorPath) return { ok: false, error: "mirrorPath 为必填项" };
  const COLLECT = { maxBytes: 1024 * 1024, spill: { maxBytes: 1024 * 1024 } };
  let tarH, sshH;
  try {
    tarH = spawnOne(subprocess, ["tar", "cf", "-", "-C", mirrorPath, "."], {
      stdin: "ignore", stdout: "pipe", stderr: COLLECT
    });
    sshH = spawnOne(subprocess, sshArgv(p, "tar xf - -C " + shellQuotePath(remotePath)), {
      stdin: "pipe", stdout: "ignore", stderr: COLLECT
    });
  } catch (e) {
    return { ok: false, error: "spawn 失败: " + String(e && e.message ? e.message : e) };
  }
  let pipeErr = "";
  try {
    if (tarH.stdout && sshH.stdin) tarH.stdout.pipe(sshH.stdin);
    else pipeErr = "stdout/stdin 管道不可用（subprocess 未暴露原始流）";
  } catch (e) { pipeErr = String(e && e.message ? e.message : e); }
  let tarOut, sshOut;
  try { tarOut = await tarH.done; } catch (e) { tarOut = { exitCode: -1 }; }
  try { sshOut = await sshH.done; } catch (e) { sshOut = { exitCode: -1 }; }
  const tarErr = readCollected(tarH, "stderr");
  const sshErr = readCollected(sshH, "stderr");
  if (tarOut.exitCode === 0 && sshOut.exitCode === 0) return { ok: true, remotePath: remotePath };
  const parts = [];
  if (pipeErr) parts.push("管道: " + pipeErr);
  if (tarOut.exitCode !== 0) parts.push("tar 退出码 " + tarOut.exitCode + (tarErr ? ": " + tarErr.slice(0, 500) : ""));
  if (sshOut.exitCode !== 0) parts.push("ssh 退出码 " + sshOut.exitCode + (sshErr ? ": " + sshErr.slice(0, 500) : ""));
  if (!parts.length) parts.push("远端可能缺少 tar，或本机无 tar.exe");
  return { ok: false, error: "推送失败: " + parts.join("；") };
}

function normExec(r) {
  return {
    ok: !!r.ok,
    exitCode: (typeof r.exitCode === "number") ? r.exitCode : -1,
    stdout: r.stdout || "",
    stderr: r.stderr || "",
    error: r.error || "",
    truncated: !!r.truncated
  };
}

// ---------------------------------------------------------------------------
// HTTP 工具
// ---------------------------------------------------------------------------

function isTrusted(req) {
  const secFetchSite = req.headers["sec-fetch-site"];
  if (secFetchSite === "cross-site") return false;
  const host = req.headers["host"];
  if (!host) return false;
  const hostname = String(host).split(":")[0].replace(/^\[/, "").replace(/\]$/, "");
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "0.0.0.0") return true;
  return false;
}

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BYTES) throw new Error("request body too large");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("request body is not valid JSON");
  }
}

function writeJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}
function writeOk(res, value) { writeJson(res, 200, { ok: true, value: value }); }
function writeError(res, error, status) {
  writeJson(res, status || 500, { ok: false, error: { code: "error", message: String(error && error.message ? error.message : error) } });
}

function textRender(fn) {
  return function (args, value) { return [{ type: "text", text: fn(args, value) }]; };
}

function execSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      ok: { type: "boolean", required: true },
      exitCode: { type: "number", required: true },
      stdout: { type: "string", required: true },
      stderr: { type: "string", required: true },
      error: { type: "string", required: true },
      truncated: { type: "boolean", required: true }
    }
  };
}

const CONN_PARAMS = {
  profileId: { type: "string", description: "已保存连接配置的 id（见 remote_ssh_profiles）。" },
  host: { type: "string", description: "远程主机（未提供 profileId 时使用）。" },
  user: { type: "string", description: "SSH 用户名。" },
  port: { type: "number", description: "SSH 端口，默认 22。" },
  keyPath: { type: "string", description: "SSH 私钥路径（密钥认证）。" }
};

/** 写入远程工作区镜像目录的说明文件，提示模型使用 remote_ssh_* 工具操作远程环境。 */
function remoteWorkspaceReadme(profileName, remotePath) {
  return [
    "# 🌐 Remote Workspace / 远程工作区",
    "",
    "This directory is the **local mirror** of a remote workspace (registered as a native DSH",
    "workspace). Remote files are NOT stored here. Use the Remote-SSH tools to operate the remote",
    "environment directly. / 这是远程工作区的本地镜像目录（用于注册原生 DSH 工作区），远程文件并不在本机，",
    "请使用以下 Remote-SSH 工具直接操作远程环境：",
    "",
    "- `remote_ssh_ls`        — list remote directories / 列举远程目录",
    "- `remote_ssh_cat`       — read a remote file / 读取远程文件",
    "- `remote_ssh_write`     — write a remote file / 写入远程文件",
    "- `remote_ssh_exec`      — run a command on the remote host (like a terminal) / 在远程执行命令",
    "- `remote_ssh_grep`      — search file contents (recursive grep) / 递归搜索文件内容",
    "- `remote_ssh_glob`      — find files by glob pattern / 按通配符查找文件",
    "- `remote_ssh_mkdir`     — create a directory (mkdir -p) / 创建目录",
    "- `remote_ssh_delete`    — delete a file or directory (rm -rf) / 删除文件或目录",
    "- `remote_ssh_move`      — move/rename a file or directory (mv) / 移动或重命名",
    "- `remote_ssh_sync`      — sync remote files to this local mirror / 同步远端文件到本地镜像",
    "- `remote_ssh_push`      — push local mirror changes back to remote / 推送本地改动回远端",
    "- `remote_ssh_profiles`  — list profiles and the current remote-workspace context / 查看配置与当前上下文",
    "",
    "Workspace info / 工作区信息：",
    "",
    "- Profile / 连接配置：`" + (profileName || "?") + "`",
    "- Remote root / 远程根目录：`" + (remotePath || "~") + "`",
    "",
    "> In this workspace session you can call these tools **without** `profileId`; the workspace's",
    "> profile and directory are used automatically, and relative paths resolve against the remote root. /",
    "> 在本工作区会话中调用上述工具时**无需**提供 `profileId`，会自动使用本工作区的连接与目录，相对路径基于远程根目录解析。"
  ].join("\n");
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

function apply(ctx, config) {
  const subprocess = ctx.subprocess;
  const workspaceRegistry = ctx.workspaceRegistry;
  const terminals = new Map();
  let nextTerminalId = 1;

  // ---- 持久 SSH 会话池（连接复用，避免每次操作都做完整 SSH 握手）----
  const sessions = new Map(); // profileKey -> CommandSession
  const SESSION_IDLE_MS = 10 * 60 * 1000;
  function profileKey(p) {
    return String(p.id) + "|" + String(p.host) + ":" + String(p.port || 22) + "|" + String(p.user || "");
  }
  function getSession(p) {
    const key = profileKey(p);
    let s = sessions.get(key);
    if (!s) { s = new CommandSession(subprocess, p); sessions.set(key, s); }
    return s;
  }
  /** 池化执行：复用持久会话，失败时回退到一次性 runRemote。 */
  async function runPooled(p, cmd, stdinData, maxBytes) {
    try {
      const s = getSession(p);
      const r = await s.exec(cmd, stdinData);
      return { ok: r.exitCode === 0, exitCode: r.exitCode, stdout: r.stdout, stderr: "", error: r.exitCode !== 0 ? String(r.stdout).trim().slice(0, 500) : "", truncated: false };
    } catch (e) {
      // 会话挂了 —— 清理并回退到一次性连接
      const key = profileKey(p);
      const old = sessions.get(key);
      if (old) { old.close(); sessions.delete(key); }
      return runRemote(subprocess, p, cmd, stdinData, maxBytes);
    }
  }
  // 定期清理空闲会话
  const idleTimer = setInterval(function () {
    const now = Date.now();
    for (const [key, s] of sessions) {
      if (now - s.lastUsed > SESSION_IDLE_MS) { s.close(); sessions.delete(key); }
    }
  }, 60 * 1000);

  // ---- settings 持久化 ----
  let settingsFace = {
    read: () => ({ profiles: [], workspaces: [] }),
    updateProfiles: async () => {},
    updateWorkspaces: async () => {}
  };
  ctx.inject(["settings"], (sctx) => {
    const scope = sctx.settings.register(settingsNamespace(NS), PrefsSchema);
    settingsFace = {
      read: () => {
        const v = scope.get();
        return {
          profiles: Array.isArray(v && v.profiles) ? v.profiles : [],
          workspaces: Array.isArray(v && v.workspaces) ? v.workspaces : []
        };
      },
      updateProfiles: async (profiles) => { await scope.update({ profiles: profiles }); },
      updateWorkspaces: async (workspaces) => { await scope.update({ workspaces: workspaces }); }
    };
  });

  function getProfile(id) { return settingsFace.read().profiles.find((p) => p.id === id); }
  function resolveProfile(args) {
    if (args && args.profileId) {
      const p = getProfile(args.profileId);
      if (p) return p;
    }
    if (args && args.host && args.user) {
      return { id: "__inline__", name: args.host, host: args.host, port: args.port || 22, user: args.user, authMethod: "key", keyPath: args.keyPath || "", password: "", remoteRoot: "~" };
    }
    return null;
  }

  /** 从工具执行上下文推断当前会话所属的远程工作区（镜像目录 == 会话 cwd）。 */
  function remoteContextFor(exec) {
    try {
      const session = exec && exec.agent && exec.agent.session;
      const cwd = session && session.header && session.header.cwd;
      if (!cwd) return null;
      const workspaces = settingsFace.read().workspaces;
      for (let i = 0; i < workspaces.length; i++) {
        const w = workspaces[i];
        if (w.mirrorPath === cwd) return w;
        if (w.mirrorPath && String(w.mirrorPath).toLowerCase() === String(cwd).toLowerCase()) return w;
      }
    } catch (e) {}
    return null;
  }

  /** 解析工具的连接+工作目录上下文：显式参数优先，其次当前会话的远程工作区。 */
  function toolContext(args, exec) {
    const explicit = resolveProfile(args);
    if (explicit) return { profile: explicit, remotePath: undefined };
    const rc = remoteContextFor(exec);
    if (rc) return { profile: getProfile(rc.profileId), remotePath: rc.remotePath };
    return { profile: null, remotePath: undefined };
  }

  /** 解析同步工具的目标工作区：显式 workspaceId 优先，其次当前会话的远程工作区。 */
  function resolveWorkspace(args, exec) {
    const a = args || {};
    const workspaces = settingsFace.read().workspaces;
    if (a.workspaceId) {
      return workspaces.find((w) => w.id === a.workspaceId) || null;
    }
    return remoteContextFor(exec);
  }

  /** 相对路径拼到远程工作目录下，绝对路径（/、~、盘符）原样返回。 */
  function resolveRemotePath(path, base) {
    if (!base) return path || "";
    if (!path) return base;
    const ch = String(path).charAt(0);
    if (ch === "/" || ch === "~" || /^[A-Za-z]:[\\/]/.test(String(path))) return String(path);
    return base.replace(/\/+$/, "") + "/" + String(path);
  }

  const api = {
    listProfiles: async () => ({ ok: true, profiles: settingsFace.read().profiles }),
    /** 读取本机 ~/.ssh/config 发现的主机（借鉴 Yan-Zero dsh-remote-ssh）。 */
    listSshConfigHosts: async () => listSshConfigHosts(),
    saveProfile: async (args) => {
      const p = args || {};
      if (!p.host || !p.user) return { ok: false, error: "host 和 user 为必填项" };
      const profiles = settingsFace.read().profiles.slice();
      let id = p.id;
      const existing = id ? profiles.find((x) => x.id === id) : undefined;
      const record = {
        id: existing ? existing.id : ("p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
        name: p.name || p.host,
        host: p.host,
        port: parseInt(p.port, 10) || 22,
        user: p.user,
        authMethod: p.authMethod || "key",
        keyPath: p.keyPath || "",
        password: p.password || "",
        remoteRoot: p.remoteRoot || "~",
        proxyJump: p.proxyJump || ""
      };
      if (existing) {
        const i = profiles.indexOf(existing);
        profiles[i] = record;
      } else {
        profiles.push(record);
      }
      await settingsFace.updateProfiles(profiles);
      return { ok: true, id: record.id, profiles: profiles };
    },
    deleteProfile: async (args) => {
      const id = args && args.id;
      const profiles = settingsFace.read().profiles.filter((p) => p.id !== id);
      const workspaces = settingsFace.read().workspaces.filter((w) => w.profileId !== id);
      await settingsFace.updateProfiles(profiles);
      await settingsFace.updateWorkspaces(workspaces);
      return { ok: true, profiles: profiles, workspaces: workspaces };
    },
    testConnection: async (args) => {
      const p = getProfile(args && args.id);
      if (!p) return { ok: false, error: "未找到连接配置" };
      return await runRemote(subprocess, p, "echo __DSH_OK__; hostname; whoami; pwd; uname -a", undefined, 256 * 1024);
    },
    listWorkspaces: async () => ({ ok: true, workspaces: settingsFace.read().workspaces }),
    createRemoteWorkspace: async (args) => {
      const a = args || {};
      const p = getProfile(a.profileId);
      if (!p) return { ok: false, error: "未找到连接配置" };
      if (!a.remotePath) return { ok: false, error: "remotePath 为必填项" };
      const wsId = "w" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      // 默认标题取远程路径最后一段目录名（如 ~/run/zfs/codex/DSH_Test → DSH_Test）；
      // 取不到有效段（如 ~/ 或 /）时回退为 连接名:远程路径。
      const lastSeg = String(a.remotePath).replace(/\/+$/, "").split("/").pop();
      const title = a.title || (lastSeg && lastSeg !== "~" ? lastSeg : (p.name + ":" + a.remotePath));
      // 本地镜像目录：作为原生工作区注册进 workspaceRegistry，会话 cwd 即指向它。
      const mirrorDir = join(homedir(), ".dsh", "remote-workspaces", wsId);
      try {
        await mkdir(mirrorDir, { recursive: true });
      } catch (e) {
        return { ok: false, error: "创建本地镜像目录失败: " + String(e && e.message ? e.message : e) };
      }
      // 在镜像目录里放一份说明，提示模型本工作区是远程的、应使用 remote_ssh_* 工具。
      try {
        await writeFile(join(mirrorDir, "README.md"), remoteWorkspaceReadme(p.name, a.remotePath), "utf8");
      } catch (e) {}
      // 不再需要 syncDown：内置「文件」页签已通过 fs.* 拦截直接 SSH 读写远程文件。
      // 写 .remote-ssh.json：供 shell wrapper 和 fs.* 拦截器读取连接信息（仅密钥认证，不含密码）。
      try {
        const connInfo = {
          profileId: p.id, host: p.host, port: p.port || 22, user: p.user,
          keyPath: p.keyPath || "", proxyJump: p.proxyJump || "", remotePath: a.remotePath
        };
        await writeFile(join(mirrorDir, ".remote-ssh.json"), JSON.stringify(connInfo, null, 2), "utf8");
      } catch (e) {}
      let workspaceId = null;
      if (workspaceRegistry) {
        try {
          const wsTitle = "🌐 " + title;
          const native = await workspaceRegistry.create(mirrorDir, wsTitle);
          workspaceId = native.id;
          // workspaceRegistry.create 仅首次创建时应用 title；已存在的旧工作区
          // （早期版本未传 title，标题卡在镜像目录名，如 wmt3tev5cdfge）会被直接
          // 返回而不更新。这里显式 setTitle，保证标题始终是远程路径最后一段目录名。
          if (native && typeof native.setTitle === "function" && native.title !== wsTitle) {
            await native.setTitle(wsTitle);
          }
        } catch (e) {
          return { ok: false, error: "注册原生工作区失败: " + String(e && e.message ? e.message : e) };
        }
      }
      const workspaces = settingsFace.read().workspaces.slice();
      const ws = {
        id: wsId,
        profileId: a.profileId,
        title: title,
        remotePath: a.remotePath,
        mirrorPath: mirrorDir
      };
      workspaces.push(ws);
      await settingsFace.updateWorkspaces(workspaces);
      return { ok: true, workspace: ws, workspaceId: workspaceId, mirrorPath: mirrorDir, workspaces: workspaces };
    },
    deleteWorkspace: async (args) => {
      const id = args && args.id;
      const all = settingsFace.read().workspaces;
      const ws = all.find((w) => w.id === id);
      const workspaces = all.filter((w) => w.id !== id);
      await settingsFace.updateWorkspaces(workspaces);
      if (ws && ws.mirrorPath) {
        if (workspaceRegistry) {
          try {
            const entity = await workspaceRegistry.resolveByPath(ws.mirrorPath);
            if (entity) await workspaceRegistry.delete(entity.id);
          } catch (e) {}
        }
        try { await rm(ws.mirrorPath, { recursive: true, force: true }); } catch (e) {}
      }
      return { ok: true, workspaces: workspaces };
    },
    updateWorkspace: async (args) => {
      const a = args || {};
      const id = a.id;
      const workspaces = settingsFace.read().workspaces.slice();
      const ws = workspaces.find((w) => w.id === id);
      if (!ws) return { ok: false, error: "未找到远程工作区" };
      if (a.remotePath !== undefined && a.remotePath !== "") ws.remotePath = String(a.remotePath);
      if (a.title !== undefined && a.title !== "") ws.title = String(a.title);
      await settingsFace.updateWorkspaces(workspaces);
      return { ok: true, workspace: ws, workspaces: workspaces };
    },
    remoteExec: async (args) => {
      const p = resolveProfile(args);
      if (!p) return { ok: false, error: "需要 profileId 或 host+user" };
      if (!args || !args.command) return { ok: false, error: "command 为必填项" };
      return await runRemote(subprocess, p, args.command, args.stdin, undefined);
    },
    listDir: async (args) => {
      const p = resolveProfile(args);
      if (!p) return { ok: false, error: "需要 profileId 或 host+user" };
      return await remoteListDir(runPooled, p, args && args.path);
    },
    readFile: async (args) => {
      const p = resolveProfile(args);
      if (!p) return { ok: false, error: "需要 profileId 或 host+user" };
      return await remoteReadFile(runPooled, p, args && args.path);
    },
    writeFile: async (args) => {
      const p = resolveProfile(args);
      if (!p) return { ok: false, error: "需要 profileId 或 host+user" };
      return await remoteWriteFile(runPooled, p, args && args.path, args && args.content);
    },
    grep: async (args) => {
      const p = resolveProfile(args);
      if (!p) return { ok: false, error: "需要 profileId 或 host+user" };
      return await remoteGrep(runPooled, p, args && args.pattern, args && args.path, args || {});
    },
    glob: async (args) => {
      const p = resolveProfile(args);
      if (!p) return { ok: false, error: "需要 profileId 或 host+user" };
      return await remoteGlob(runPooled, p, args && args.pattern, args && args.path, args || {});
    },
    mkdir: async (args) => {
      const p = resolveProfile(args);
      if (!p) return { ok: false, error: "需要 profileId 或 host+user" };
      if (!args || !args.path) return { ok: false, error: "path 为必填项" };
      return await runPooled(p, "mkdir -p " + shellQuotePath(args.path), undefined, undefined);
    },
    deleteFile: async (args) => {
      const p = resolveProfile(args);
      if (!p) return { ok: false, error: "需要 profileId 或 host+user" };
      if (!args || !args.path) return { ok: false, error: "path 为必填项" };
      return await runPooled(p, "rm -rf " + shellQuotePath(args.path), undefined, undefined);
    },
    move: async (args) => {
      const p = resolveProfile(args);
      if (!p) return { ok: false, error: "需要 profileId 或 host+user" };
      if (!args || !args.src || !args.dst) return { ok: false, error: "src 和 dst 为必填项" };
      return await runPooled(p, "mv " + shellQuotePath(args.src) + " " + shellQuotePath(args.dst), undefined, undefined);
    },
    /** 远端 → 本地镜像（按工作区）。 */
    syncDown: async (args) => {
      const a = args || {};
      const ws = settingsFace.read().workspaces.find((w) => w.id === (a.workspaceId || a.id));
      if (!ws) return { ok: false, error: "未找到远程工作区" };
      const p = getProfile(ws.profileId);
      if (!p) return { ok: false, error: "未找到连接配置" };
      const r = await remoteSyncDown(subprocess, p, ws.remotePath, ws.mirrorPath);
      // remoteSyncDown 会清空镜像目录，需要重新写入 .remote-ssh.json
      if (r.ok) {
        try {
          const connInfo = {
            profileId: p.id, host: p.host, port: p.port || 22, user: p.user,
            keyPath: p.keyPath || "", proxyJump: p.proxyJump || "", remotePath: ws.remotePath
          };
          await writeFile(join(ws.mirrorPath, ".remote-ssh.json"), JSON.stringify(connInfo, null, 2), "utf8");
        } catch (e) {}
      }
      return r;
    },
    /** 本地镜像 → 远端（按工作区）。 */
    syncUp: async (args) => {
      const a = args || {};
      const ws = settingsFace.read().workspaces.find((w) => w.id === (a.workspaceId || a.id));
      if (!ws) return { ok: false, error: "未找到远程工作区" };
      const p = getProfile(ws.profileId);
      if (!p) return { ok: false, error: "未找到连接配置" };
      return await remoteSyncUp(subprocess, p, ws.remotePath, ws.mirrorPath);
    },
    spawnTerminal: async (args) => {
      const p = resolveProfile(args);
      if (!p) return { ok: false, error: "需要 profileId 或 host+user" };
      let handle;
      try {
        handle = subprocess.spawn({
          argv: sshArgv(p, undefined, true),
          cwd: process.cwd(),
          stdio: {
            stdin: "pipe",
            stdout: { maxBytes: MAX_BYTES, spill: { maxBytes: MAX_BYTES } },
            stderr: { maxBytes: 1024 * 1024, spill: { maxBytes: 1024 * 1024 } }
          },
          graceMs: 3000
        });
      } catch (e) {
        return { ok: false, error: "终端启动失败: " + String(e && e.message ? e.message : e) };
      }
      const id = "t" + (nextTerminalId++);
      const session = { id: id, handle: handle, profileId: p.id, stdoutOffset: 0, stderrOffset: 0, status: "running", exitCode: null };
      handle.done.then(
        function (outcome) { session.status = "exited"; session.exitCode = outcome.exitCode; },
        function (err) { session.status = "exited"; session.error = String(err); }
      );
      terminals.set(id, session);
      return { ok: true, id: id };
    },
    terminalWrite: async (args) => {
      const s = terminals.get(args && args.id);
      if (!s) return { ok: false, error: "终端不存在" };
      if (!s.handle.stdin) return { ok: false, error: "stdin 不可用" };
      try { s.handle.stdin.write(String(args && args.data !== undefined ? args.data : "")); } catch (e) { return { ok: false, error: String(e) }; }
      return { ok: true };
    },
    terminalRead: async (args) => {
      const s = terminals.get(args && args.id);
      if (!s) return { ok: false, error: "终端不存在" };
      const out = (s.handle.collected && s.handle.collected.stdout) ? s.handle.collected.stdout.readFrom(s.stdoutOffset) : { text: "", nextOffset: s.stdoutOffset, lossy: false };
      const err = (s.handle.collected && s.handle.collected.stderr) ? s.handle.collected.stderr.readFrom(s.stderrOffset) : { text: "", nextOffset: s.stderrOffset, lossy: false };
      s.stdoutOffset = out.nextOffset;
      s.stderrOffset = err.nextOffset;
      return { ok: true, data: out.text, stderr: err.text, status: s.status, exitCode: s.exitCode, truncated: !!(out.lossy || err.lossy) };
    },
    terminalClose: async (args) => {
      const s = terminals.get(args && args.id);
      if (!s) return { ok: false, error: "终端不存在" };
      try { s.handle.terminate(); } catch (e) {}
      terminals.delete(args.id);
      return { ok: true };
    },
    terminalList: async () => {
      const list = [];
      terminals.forEach(function (s) { list.push({ id: s.id, profileId: s.profileId, status: s.status, exitCode: s.exitCode }); });
      return { ok: true, terminals: list };
    }
  };

  // ---- HTTP JSON API ----
  ctx.effect(() => ctx.webServer.register({
    kind: "prefix",
    path: "/remote-ssh/api",
    handler: async (req, res) => {
      if (!isTrusted(req)) { writeError(res, new Error("forbidden"), 403); return; }
      if (req.method !== "POST") { writeError(res, new Error("method not allowed"), 405); return; }
      const pathname = new URL(req.url || "/", "http://dsh.internal").pathname;
      if (!pathname.startsWith(API_BASE)) { writeError(res, new Error("not-found"), 404); return; }
      const method = pathname.slice(API_BASE.length);
      if (!method || method.includes("/")) { writeError(res, new Error("not-found"), 404); return; }
      try {
        const handler = api[method];
        if (!handler) throw new Error("unknown api method: " + method);
        const payload = await readJsonBody(req);
        const result = await handler(payload);
        writeOk(res, result);
      } catch (error) {
        writeError(res, error);
      }
    }
  }), "dsh-remote-ssh: /remote-ssh/api routes");

  // ---- 模型工具 ----
  const register = (tool) => ctx.tools.register(defineTool(tool));

  register({
    name: "remote_ssh_profiles",
    description: "列出 Remote-SSH 插件中已保存的 SSH 连接配置，并返回当前会话所属的远程工作区上下文（若当前会话是从远程工作区创建的）。List saved SSH connection profiles and return the current session's remote-workspace context (when the session was created from a remote workspace).",
    parameters: {},
    output: {
      schema: {
        type: "object", additionalProperties: false, properties: {
          profiles: { type: "array", required: true, items: { type: "object", additionalProperties: true } },
          currentRemote: { type: "object", required: true, additionalProperties: true }
        }
      },
      render: textRender(function (a, v) { return JSON.stringify(v); })
    },
    execute: async function (args, exec) {
      const rc = remoteContextFor(exec);
      return {
        profiles: settingsFace.read().profiles,
        currentRemote: rc ? { id: rc.id, profileId: rc.profileId, title: rc.title, remotePath: rc.remotePath, mirrorPath: rc.mirrorPath } : {}
      };
    }
  });

  register({
    name: "remote_ssh_exec",
    description: "通过 SSH 在远程主机（超算/服务器）上执行一条命令。用 profileId 引用已保存配置，或直接给 host/user。在当前远程工作区会话中可不填连接参数，自动用该工作区的连接并在其远程目录下执行。返回 stdout/stderr/exitCode。Run a command on a remote host (HPC/server) over SSH; returns stdout/stderr/exitCode.",
    parameters: Object.assign({}, CONN_PARAMS, {
      command: { type: "string", required: true, description: "要执行的远程命令。" },
      stdin: { type: "string", description: "可选，写入远程命令的标准输入。" }
    }),
    output: {
      schema: execSchema(),
      render: textRender(function (a, v) { return v.ok ? (v.stdout || "ok") : (v.error || v.stderr || v.stdout || "failed"); })
    },
    execute: async function (args, exec) {
      const tc = toolContext(args, exec);
      if (!tc.profile) return normExec({ ok: false, error: "需要 profileId 或 host+user（当前会话非远程工作区时必填）" });
      if (!args.command) return normExec({ ok: false, error: "command 为必填项" });
      let cmd = String(args.command);
      if (tc.remotePath) cmd = "cd " + shellQuotePath(tc.remotePath) + " 2>/dev/null; " + cmd;
      return normExec(await runRemote(subprocess, tc.profile, cmd, args.stdin, undefined));
    }
  });

  register({
    name: "remote_ssh_ls",
    description: "通过 SSH 列举远程主机上的一个目录。用 profileId 引用已保存配置，或直接给 host/user。在当前远程工作区会话中可不填连接参数，相对路径基于该工作区远程目录解析；缺省 path 即列出该目录。List a directory on a remote host over SSH.",
    parameters: Object.assign({}, CONN_PARAMS, { path: { type: "string", description: "远程目录路径，默认使用配置的远程根目录（当前工作区为工作区目录）。" } }),
    output: {
      schema: {
        type: "object", additionalProperties: false, properties: {
          ok: { type: "boolean", required: true },
          path: { type: "string", required: true },
          entries: { type: "array", required: true, items: { type: "object", additionalProperties: true } },
          error: { type: "string", required: true }
        }
      },
      render: textRender(function (a, v) {
        if (!v.ok) return v.error || "failed";
        const names = (v.entries || []).map(function (e) { return (e.type === "directory" ? "[d] " : "    ") + e.name; });
        return v.path + "\n" + names.join("\n");
      })
    },
    execute: async function (args, exec) {
      const tc = toolContext(args, exec);
      if (!tc.profile) return { ok: false, path: "", entries: [], error: "需要 profileId 或 host+user（当前会话非远程工作区时必填）" };
      const r = await remoteListDir(runPooled, tc.profile, resolveRemotePath(args.path, tc.remotePath));
      return { ok: !!r.ok, path: r.path || "", entries: r.entries || [], error: r.error || "" };
    }
  });

  register({
    name: "remote_ssh_cat",
    description: "通过 SSH 读取远程主机上的一个文本文件（base64 传输，二进制安全）。用 profileId 引用已保存配置，或直接给 host/user。在当前远程工作区会话中可不填连接参数，相对路径基于该工作区远程目录解析。Read a text file from a remote host over SSH (base64 transfer, binary-safe).",
    parameters: Object.assign({}, CONN_PARAMS, { path: { type: "string", required: true, description: "远程文件路径。" } }),
    output: {
      schema: {
        type: "object", additionalProperties: false, properties: {
          ok: { type: "boolean", required: true },
          path: { type: "string", required: true },
          content: { type: "string", required: true },
          binary: { type: "boolean", required: true },
          truncated: { type: "boolean", required: true },
          error: { type: "string", required: true }
        }
      },
      render: textRender(function (a, v) { return v.error || v.content || ""; })
    },
    execute: async function (args, exec) {
      const tc = toolContext(args, exec);
      if (!tc.profile) return { ok: false, path: "", content: "", binary: false, truncated: false, error: "需要 profileId 或 host+user（当前会话非远程工作区时必填）" };
      const r = await remoteReadFile(runPooled, tc.profile, resolveRemotePath(args.path, tc.remotePath));
      return { ok: !!r.ok, path: r.path || "", content: r.content || "", binary: !!r.binary, truncated: !!r.truncated, error: r.error || "" };
    }
  });

  register({
    name: "remote_ssh_write",
    description: "通过 SSH 把内容写入远程主机上的一个文件（覆盖写入）。用 profileId 引用已保存配置，或直接给 host/user。在当前远程工作区会话中可不填连接参数，相对路径基于该工作区远程目录解析。Write content to a file on a remote host over SSH (overwrite).",
    parameters: Object.assign({}, CONN_PARAMS, {
      path: { type: "string", required: true, description: "远程文件路径。" },
      content: { type: "string", required: true, description: "要写入的完整内容。" }
    }),
    output: {
      schema: execSchema(),
      render: textRender(function (a, v) { return v.ok ? "已写入" : (v.error || v.stderr || "写入失败"); })
    },
    execute: async function (args, exec) {
      const tc = toolContext(args, exec);
      if (!tc.profile) return normExec({ ok: false, error: "需要 profileId 或 host+user（当前会话非远程工作区时必填）" });
      return normExec(await remoteWriteFile(runPooled, tc.profile, resolveRemotePath(args.path, tc.remotePath), args.content));
    }
  });

  // 同步：把远程工作区的文件同步到本地镜像目录（syncDown），或把本地镜像改动推回远端（syncUp）。
  // 借鉴 flymysql dsh-remote 的 rw_sync / rw_push，但用 tar-over-ssh 流式管道，不引入 ssh2。
  const syncDesc = "按远程工作区双向同步：sync 把远端文件同步到本地镜像目录，push 把本地镜像改动推回远端。" +
    "用 workspaceId 指定工作区，或留空在当前远程工作区会话中自动识别。" +
    "Sync/push a remote workspace to its local mirror (or back). Pass workspaceId, or omit it inside a remote-workspace session.";
  const syncParams = {
    workspaceId: { type: "string", description: "远程工作区 id（留空则在当前远程工作区会话中自动识别）。" }
  };
  const syncOutput = {
    schema: { type: "object", additionalProperties: false, properties: {
      ok: { type: "boolean", required: true },
      error: { type: "string", required: true }
    } },
    render: textRender(function (a, v) { return v.ok ? "同步完成" : (v.error || "同步失败"); })
  };
  register({
    name: "remote_ssh_sync",
    description: syncDesc,
    parameters: syncParams,
    output: syncOutput,
    execute: async function (args, exec) {
      const ws = resolveWorkspace(args, exec);
      if (!ws) return { ok: false, error: "未找到远程工作区（workspaceId 必填，或当前会话非远程工作区）" };
      const p = getProfile(ws.profileId);
      if (!p) return { ok: false, error: "未找到连接配置" };
      const r = await remoteSyncDown(subprocess, p, ws.remotePath, ws.mirrorPath);
      // remoteSyncDown 会清空镜像目录，需要重新写入 .remote-ssh.json
      if (r.ok) {
        try {
          const connInfo = {
            profileId: p.id, host: p.host, port: p.port || 22, user: p.user,
            keyPath: p.keyPath || "", proxyJump: p.proxyJump || "", remotePath: ws.remotePath
          };
          await writeFile(join(ws.mirrorPath, ".remote-ssh.json"), JSON.stringify(connInfo, null, 2), "utf8");
        } catch (e) {}
      }
      return r;
    }
  });
  register({
    name: "remote_ssh_push",
    description: syncDesc,
    parameters: syncParams,
    output: syncOutput,
    execute: async function (args, exec) {
      const ws = resolveWorkspace(args, exec);
      if (!ws) return { ok: false, error: "未找到远程工作区（workspaceId 必填，或当前会话非远程工作区）" };
      const p = getProfile(ws.profileId);
      if (!p) return { ok: false, error: "未找到连接配置" };
      return await remoteSyncUp(subprocess, p, ws.remotePath, ws.mirrorPath);
    }
  });

  // ---- 搜索与文件操作（借鉴 dsh-remote 的 rw_grep/rw_glob/rw_mkdir/rw_delete/rw_move）----
  // 内容搜索：grep -rnIE（GNU grep，超算/Linux 通用，不依赖 ripgrep）。
  register({
    name: "remote_ssh_grep",
    description: "通过 SSH 在远程主机上递归搜索文件内容（grep -rnIE，扩展正则）。用 profileId 引用已保存配置，或直接给 host/user。在当前远程工作区会话中可不填连接参数，path 默认为工作区远程目录。可选 include 限定文件名通配（如 *.py）、ignoreCase 忽略大小写、maxResults 限制条数（默认 200）。Search file contents on a remote host over SSH (recursive grep).",
    parameters: Object.assign({}, CONN_PARAMS, {
      pattern: { type: "string", required: true, description: "搜索模式（grep 扩展正则）。" },
      path: { type: "string", description: "搜索目录，默认使用工作区远程目录。" },
      include: { type: "string", description: "文件名通配过滤，如 *.py（GNU grep --include）。" },
      ignoreCase: { type: "boolean", description: "忽略大小写。" },
      maxResults: { type: "number", description: "最多返回的匹配条数，默认 200。" }
    }),
    output: {
      schema: {
        type: "object", additionalProperties: false, properties: {
          ok: { type: "boolean", required: true },
          pattern: { type: "string", required: true },
          path: { type: "string", required: true },
          matches: { type: "array", required: true, items: { type: "object", additionalProperties: true } },
          truncated: { type: "boolean", required: true },
          error: { type: "string", required: true }
        }
      },
      render: textRender(function (a, v) {
        if (!v.ok) return v.error || "搜索失败";
        const ms = v.matches || [];
        if (!ms.length) return "无匹配";
        const lines = ms.map(function (m) { return m.file + ":" + m.line + ": " + m.content; });
        return lines.join("\n") + (v.truncated ? "\n…（已截断）" : "");
      })
    },
    execute: async function (args, exec) {
      const tc = toolContext(args, exec);
      if (!tc.profile) return { ok: false, pattern: "", path: "", matches: [], truncated: false, error: "需要 profileId 或 host+user（当前会话非远程工作区时必填）" };
      if (!args.pattern) return { ok: false, pattern: "", path: "", matches: [], truncated: false, error: "pattern 为必填项" };
      const r = await remoteGrep(runPooled, tc.profile, args.pattern, resolveRemotePath(args.path, tc.remotePath), args);
      return { ok: !!r.ok, pattern: r.pattern || args.pattern, path: r.path || "", matches: r.matches || [], truncated: !!r.truncated, error: r.error || "" };
    }
  });

  // 文件名通配查找：find -name（已递归，自动剥离前导 **/）。
  register({
    name: "remote_ssh_glob",
    description: "通过 SSH 在远程主机上按通配符查找文件（find -name，递归）。用 profileId 引用已保存配置，或直接给 host/user。在当前远程工作区会话中可不填连接参数，path 默认为工作区远程目录。pattern 为 basename 通配，如 *.py（自动剥离前导 **/ 以适配 POSIX find）。Find files by glob pattern on a remote host over SSH.",
    parameters: Object.assign({}, CONN_PARAMS, {
      pattern: { type: "string", required: true, description: "文件名通配，如 *.py 或 *.js。" },
      path: { type: "string", description: "查找目录，默认使用工作区远程目录。" },
      maxResults: { type: "number", description: "最多返回条数，默认 500。" }
    }),
    output: {
      schema: {
        type: "object", additionalProperties: false, properties: {
          ok: { type: "boolean", required: true },
          pattern: { type: "string", required: true },
          path: { type: "string", required: true },
          files: { type: "array", required: true, items: { type: "string" } },
          truncated: { type: "boolean", required: true },
          error: { type: "string", required: true }
        }
      },
      render: textRender(function (a, v) {
        if (!v.ok) return v.error || "查找失败";
        const fs2 = v.files || [];
        if (!fs2.length) return "无匹配文件";
        return fs2.join("\n") + (v.truncated ? "\n…（已截断）" : "");
      })
    },
    execute: async function (args, exec) {
      const tc = toolContext(args, exec);
      if (!tc.profile) return { ok: false, pattern: "", path: "", files: [], truncated: false, error: "需要 profileId 或 host+user（当前会话非远程工作区时必填）" };
      if (!args.pattern) return { ok: false, pattern: "", path: "", files: [], truncated: false, error: "pattern 为必填项" };
      const r = await remoteGlob(runPooled, tc.profile, args.pattern, resolveRemotePath(args.path, tc.remotePath), args);
      return { ok: !!r.ok, pattern: r.pattern || args.pattern, path: r.path || "", files: r.files || [], truncated: !!r.truncated, error: r.error || "" };
    }
  });

  // 创建目录：mkdir -p。
  register({
    name: "remote_ssh_mkdir",
    description: "通过 SSH 在远程主机上创建目录（mkdir -p，含父目录）。用 profileId 引用已保存配置，或直接给 host/user。在当前远程工作区会话中可不填连接参数，相对路径基于工作区远程目录解析。Create a directory on a remote host over SSH (mkdir -p).",
    parameters: Object.assign({}, CONN_PARAMS, { path: { type: "string", required: true, description: "远程目录路径。" } }),
    output: { schema: execSchema(), render: textRender(function (a, v) { return v.ok ? "已创建" : (v.error || v.stderr || "创建失败"); }) },
    execute: async function (args, exec) {
      const tc = toolContext(args, exec);
      if (!tc.profile) return normExec({ ok: false, error: "需要 profileId 或 host+user（当前会话非远程工作区时必填）" });
      if (!args.path) return normExec({ ok: false, error: "path 为必填项" });
      let cmd = "mkdir -p " + shellQuotePath(resolveRemotePath(args.path, tc.remotePath));
      return normExec(await runPooled(tc.profile, cmd, undefined, undefined));
    }
  });

  // 删除文件或目录：rm -rf。谨慎使用。
  register({
    name: "remote_ssh_delete",
    description: "通过 SSH 删除远程主机上的文件或目录（rm -rf，递归不询问）。用 profileId 引用已保存配置，或直接给 host/user。在当前远程工作区会话中可不填连接参数，相对路径基于工作区远程目录解析。⚠️ 不可恢复，请谨慎使用。Delete a file or directory on a remote host over SSH (rm -rf).",
    parameters: Object.assign({}, CONN_PARAMS, { path: { type: "string", required: true, description: "远程文件或目录路径。" } }),
    output: { schema: execSchema(), render: textRender(function (a, v) { return v.ok ? "已删除" : (v.error || v.stderr || "删除失败"); }) },
    execute: async function (args, exec) {
      const tc = toolContext(args, exec);
      if (!tc.profile) return normExec({ ok: false, error: "需要 profileId 或 host+user（当前会话非远程工作区时必填）" });
      if (!args.path) return normExec({ ok: false, error: "path 为必填项" });
      let cmd = "rm -rf " + shellQuotePath(resolveRemotePath(args.path, tc.remotePath));
      return normExec(await runPooled(tc.profile, cmd, undefined, undefined));
    }
  });

  // 移动/重命名：mv。
  register({
    name: "remote_ssh_move",
    description: "通过 SSH 在远程主机上移动或重命名文件/目录（mv）。用 profileId 引用已保存配置，或直接给 host/user。在当前远程工作区会话中可不填连接参数，相对路径基于工作区远程目录解析。Move or rename a file/directory on a remote host over SSH (mv).",
    parameters: Object.assign({}, CONN_PARAMS, {
      src: { type: "string", required: true, description: "源路径。" },
      dst: { type: "string", required: true, description: "目标路径。" }
    }),
    output: { schema: execSchema(), render: textRender(function (a, v) { return v.ok ? "已移动" : (v.error || v.stderr || "移动失败"); }) },
    execute: async function (args, exec) {
      const tc = toolContext(args, exec);
      if (!tc.profile) return normExec({ ok: false, error: "需要 profileId 或 host+user（当前会话非远程工作区时必填）" });
      if (!args.src || !args.dst) return normExec({ ok: false, error: "src 和 dst 为必填项" });
      let cmd = "mv " + shellQuotePath(resolveRemotePath(args.src, tc.remotePath)) + " " + shellQuotePath(resolveRemotePath(args.dst, tc.remotePath));
      return normExec(await runPooled(tc.profile, cmd, undefined, undefined));
    }
  });

  // ---- 创建 shell wrapper（供 better-sidebar 的 shell 配置指向它，实现远程终端透明接入）----
  // wrapper 逻辑：读取当前工作目录下的 .remote-ssh.json，若存在且含 keyPath → exec ssh -tt；
  // 否则降级到平台默认 shell（bash -l / powershell）。
  // 实现方式：跨平台 Node.js 脚本 + 平台特定的薄壳调用它。
  const wrapperDir = join(homedir(), ".dsh", "remote-ssh");
  const isWin = process.platform === "win32";
  const wrapperJsPath = join(wrapperDir, "dsh-remote-shell.js");
  const wrapperPath = isWin ? join(wrapperDir, "dsh-remote-shell.cmd") : join(wrapperDir, "dsh-remote-shell");
  const wrapperJs = [
    "// DSH remote-ssh shell wrapper — auto-detects remote workspace via .remote-ssh.json",
    "const fs = require('fs');",
    "const path = require('path');",
    "const { spawn } = require('child_process');",
    "const info = path.join(process.cwd(), '.remote-ssh.json');",
    "try {",
    "  if (fs.existsSync(info)) {",
    "    const j = JSON.parse(fs.readFileSync(info, 'utf8'));",
    "    if (j.keyPath && j.keyPath !== '' && j.host && j.user) {",
    "      const port = j.port || 22;",
    "      // ExitOnForwardFailure=no：ssh config 里的 RemoteForward 端口被占时终端仍能打开",
    "      const args = ['-tt', '-o', 'StrictHostKeyChecking=no', '-o', 'ExitOnForwardFailure=no', '-p', String(port), '-i', j.keyPath, j.user + '@' + j.host];",
    "      if (j.proxyJump) { args.splice(2, 0, '-J', j.proxyJump); }",
    "      const ssh = spawn('ssh', args, { stdio: 'inherit' });",
    "      ssh.on('exit', function(c) { process.exit(c == null ? 0 : c); });",
    "      return;",
    "    }",
    "  }",
    "} catch (e) {}",
    "// 默认本地 shell",
    "var sh = process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/bash');",
    "var shArgs = process.platform === 'win32' ? [] : ['-l'];",
    "var p = spawn(sh, shArgs, { stdio: 'inherit' });",
    "p.on('exit', function(c) { process.exit(c == null ? 0 : c); });",
    ""
  ].join("\n");
  const winCmd = [
    "@echo off",
    'node "%~dp0dsh-remote-shell.js"',
    ""
  ].join("\r\n");
  const posixSh = [
    "#!/usr/bin/env bash",
    "# DSH remote-ssh shell wrapper (POSIX) — delegates to Node.js script",
    'exec node "$(dirname "$0")/dsh-remote-shell.js"',
    ""
  ].join("\n");
  (async function () {
    try {
      await mkdir(wrapperDir, { recursive: true });
      await writeFile(wrapperJsPath, wrapperJs, "utf8");
      if (isWin) {
        await writeFile(wrapperPath, winCmd, "utf8");
      } else {
        await writeFile(wrapperPath, posixSh, "utf8");
        try { await (await import("node:fs/promises")).chmod(wrapperPath, 0o755); } catch (e) {}
      }
    } catch (e) {
      ctx.logger?.warn("[dsh-remote-ssh] 创建 shell wrapper 失败: " + String(e && e.message ? e.message : e));
    }
  })();

  // ---- 启动自愈：把既有远程工作区的原生标题统一为「🌐 + 远程路径最后一段」----
  // 早期版本 create 工作区时未传 title，DSH 用镜像目录 basename（wsId，如 wmt3tev5cdfge）
  // 作标题；workspaceRegistry.create 只对新建记录应用 title，旧记录会被原样返回。
  // 这里仅在标题等于镜像目录 basename（明显是旧 bug 产物）时修复，不覆盖用户自定义标题。
  function healWorkspaceTitles() {
    const reg = workspaceRegistry;
    if (!reg || typeof reg.resolveByPath !== "function") return;
    const wsList = settingsFace.read().workspaces;
    for (const w of wsList) {
      if (!w || !w.mirrorPath || !w.remotePath) continue;
      const lastSeg = String(w.remotePath).replace(/\/+$/, "").split("/").pop();
      if (!lastSeg || lastSeg === "~" || lastSeg === ".") continue;
      const desired = "🌐 " + lastSeg;
      const base = String(w.mirrorPath).split(/[\\/]/).filter(Boolean).pop();
      (async () => {
        try {
          const ent = await reg.resolveByPath(w.mirrorPath);
          // 只在标题仍卡在镜像目录名（旧 bug）时才改，尊重用户自定义标题。
          if (ent && typeof ent.setTitle === "function" && (ent.title === base || ent.title === "🌐 " + base)) {
            await ent.setTitle(desired);
          }
        } catch (e) {}
      })();
    }
  }
  // settings 注入是异步的，稍作延迟确保 workspaces 已就绪。
  setTimeout(healWorkspaceTitles, 3000);

  // ---- 拦截 better-sidebar 的 fs.* API：远程工作区走 SSH，本地走本地 fs ----
  // 注册更长前缀 /sidebar/api/fs. 优先于 better-sidebar 的 /sidebar/api 匹配。
  const READ_LIMIT = 524288;
  const LIST_LIMIT = 1000;

  // 读取镜像目录下的 .remote-ssh.json，返回连接信息或 null
  function readRemoteInfoSync(mirrorCwd) {
    if (!mirrorCwd) return null;
    try {
      const jsonPath = join(mirrorCwd, ".remote-ssh.json");
      if (existsSync(jsonPath)) {
        return JSON.parse(readFileSync(jsonPath, "utf8"));
      }
    } catch (e) {}
    return null;
  }

  // 把本地镜像路径转换为远程路径
  function localToRemote(localPath, mirrorCwd, remoteBase) {
    if (!localPath) return remoteBase;
    // 规范化：去掉前缀 mirrorCwd，剩余部分拼到 remoteBase
    let rel = String(localPath);
    const mc = String(mirrorCwd).replace(/\\/g, "/");
    rel = rel.replace(/\\/g, "/");
    if (rel.toLowerCase().startsWith(mc.toLowerCase())) {
      rel = rel.slice(mc.length);
    } else {
      // 可能是相对于 cwd 的路径
    }
    if (rel.startsWith("/")) rel = rel.slice(1);
    if (!rel) return remoteBase;
    // 拼接远程路径
    const rb = String(remoteBase).replace(/\/+$/, "");
    return rb + "/" + rel;
  }

  // 本地 listDirectory（复制 better-sidebar 的逻辑）
  async function localListDir(path, maxEntries) {
    if (!path) path = homedir();
    let level;
    try { level = await opendir(path); }
    catch (e) { return { ok: false, error: "cannot list: " + String(e && e.message ? e.message : e) }; }
    const rows = [];
    let overflow = 0;
    try {
      for await (const dirent of level) {
        if (rows.length >= (maxEntries || 1000)) { overflow++; continue; }
        rows.push({
          name: dirent.name,
          path: join(path, dirent.name),
          isDir: dirent.isDirectory(),
          isSymlink: dirent.isSymbolicLink(),
          broken: false,
          hidden: dirent.name.startsWith(".")
        });
      }
    } catch (e) { return { ok: false, error: "cannot list: " + String(e && e.message ? e.message : e) }; }
    rows.sort(function (a, b) {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
    return { path: path, entries: rows, truncated: overflow > 0 };
  }

  // 本地 readText（复制 better-sidebar 的逻辑）
  async function localReadText(path, readLimit) {
    const info = await stat(path).catch(function (e) { throw new Error("cannot read: " + String(e && e.message ? e.message : e)); });
    if (info.isDirectory()) throw new Error("is a directory");
    const size = info.size;
    const truncated = size > readLimit;
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(Math.min(size, readLimit));
      const r = await handle.read(buffer, 0, buffer.length, 0);
      const slice = buffer.subarray(0, r.bytesRead);
      const binary = slice.includes(0);
      if (binary) {
        return { kind: "binary", size: size, truncated: truncated, head: slice.subarray(0, Math.min(slice.length, 4096)).toString("base64") };
      }
      return { kind: "text", content: slice.toString("utf8"), truncated: truncated };
    } finally { await handle.close(); }
  }

  // 本地 writeFile（原子写入）
  async function localWriteFile(path, content) {
    const tmp = path + ".dsh-rssh-tmp-" + process.pid;
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(tmp, content, "utf8");
      await rename(tmp, path);
    } catch (e) {
      try { await rm(tmp, { force: true }); } catch (e2) {}
      throw e;
    }
    return { ok: true };
  }

  // 本地 searchFiles（简单递归文件名搜索）
  async function localSearchFiles(root, query) {
    if (!query) return { entries: [] };
    const q = query.toLowerCase();
    const results = [];
    async function walk(dir, depth) {
      if (depth > 10 || results.length > 500) return;
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); }
      catch (e) { return; }
      for (const e of entries) {
        if (e.name.toLowerCase().includes(q)) {
          results.push({ path: join(dir, e.name), isDir: e.isDirectory() });
          if (results.length > 500) return;
        }
        if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules") {
          await walk(join(dir, e.name), depth + 1);
        }
      }
    }
    await walk(root, 0);
    return { entries: results, truncated: false };
  }

  // 远程 listDir → better-sidebar 格式
  async function remoteListForSidebar(profile, remotePath, localCwd) {
    const r = await remoteListDir(runPooled, profile, remotePath);
    if (!r.ok) return { ok: false, error: r.error || "list failed" };
    const entries = (r.entries || []).map(function (e) {
      return {
        name: e.name,
        path: join(localCwd, e.name), // 返回本地镜像路径格式，保持客户端兼容
        isDir: e.type === "directory",
        isSymlink: false,
        broken: false,
        hidden: e.name.startsWith(".")
      };
    });
    entries.sort(function (a, b) {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
    return { path: localCwd, entries: entries, truncated: false };
  }

  // 远程 readText → better-sidebar 格式
  async function remoteReadForSidebar(profile, remotePath) {
    const r = await remoteReadFile(runPooled, profile, remotePath);
    if (!r.ok) return { ok: false, error: r.error || "read failed" };
    if (r.binary) {
      return { kind: "binary", size: 0, truncated: !!r.truncated, head: (r.content || "").slice(0, 4096) };
    }
    return { kind: "text", content: r.content || "", truncated: !!r.truncated };
  }

  // exact 路由优先于 prefix 路由匹配，所以每个 fs.* 端点注册一个 exact 路由即可拦截。
  // webServer prefix 匹配要求 pathname 以 prefix+"/" 开头，但 fs.tree 用的是点分隔符，
  // 所以无法用 prefix 拦截，必须用 exact。
  async function interceptFsHandler(req, res, method) {
    if (!isTrusted(req)) { writeJson(res, 403, { ok: false, error: { code: "forbidden", message: "forbidden" } }); return; }
    if (req.method !== "POST") { writeJson(res, 405, { ok: false, error: { code: "method-error", message: "method not allowed" } }); return; }
    let payload;
    try { payload = await readJsonBody(req); }
    catch (e) { writeJson(res, 400, { ok: false, error: { code: "bad-request", message: String(e && e.message ? e.message : e) } }); return; }
    try {
      // 获取会话 cwd
      const sessionId = payload && payload.sessionId;
      let sessionCwd = payload && payload.cwd;
      if ((!sessionCwd || sessionCwd === "") && sessionId) {
        const sessions = ctx.get("sessions");
        const session = sessions ? sessions.get(sessionId) : null;
        sessionCwd = session && session.header && session.header.cwd;
      }
      // 如果 sessionCwd 还是空，尝试用 payload.path（文件操作时 path 包含工作区路径）
      if ((!sessionCwd || sessionCwd === "") && payload && payload.path) {
        sessionCwd = payload.path;
      }
      // 检查是否远程工作区：先查 sessionCwd，再查 payload.path
      let remoteInfo = readRemoteInfoSync(sessionCwd);
      let remoteBase = sessionCwd;
      if (!remoteInfo && payload && payload.path) {
        remoteInfo = readRemoteInfoSync(payload.path);
        remoteBase = payload.path;
      }
      console.log("[dsh-remote-ssh] intercept " + method + ": sessionId=" + sessionId + " cwd=" + sessionCwd + " path=" + (payload && payload.path) + " remote=" + (remoteInfo ? "YES" : "NO"));
      let result;
      if (remoteInfo && remoteInfo.keyPath && remoteInfo.host && remoteInfo.user) {
        // ---- 远程工作区：走 SSH ----
        const profile = getProfile(remoteInfo.profileId);
        if (!profile) { writeJson(res, 500, { ok: false, error: { code: "internal", message: "remote profile not found: " + remoteInfo.profileId } }); return; }
        if (method === "fs.tree") {
          const localPath = payload.path || sessionCwd;
          const rp = localToRemote(localPath, remoteBase, remoteInfo.remotePath);
          result = await remoteListForSidebar(profile, rp, localPath);
        } else if (method === "fs.read") {
          const localPath = payload.path || sessionCwd;
          const rp = localToRemote(localPath, remoteBase, remoteInfo.remotePath);
          result = await remoteReadForSidebar(profile, rp);
        } else if (method === "fs.write") {
          const localPath = payload.path || sessionCwd;
          const rp = localToRemote(localPath, remoteBase, remoteInfo.remotePath);
          result = await remoteWriteFile(runPooled, profile, rp, payload.content || "");
        } else if (method === "fs.search") {
          const rp = remoteInfo.remotePath;
          const r = await remoteGlob(runPooled, profile, "*" + (payload.query || "") + "*", rp);
          result = { entries: (r.files || []).map(function (f) {
            return { path: join(remoteBase, f), isDir: false };
          }), truncated: !!r.truncated };
        } else {
          writeJson(res, 404, { ok: false, error: { code: "not-found", message: "unknown method " + method } }); return;
        }
      } else {
        // ---- 本地工作区：走本地 fs ----
        if (method === "fs.tree") {
          const p = payload.path || sessionCwd;
          result = await localListDir(p, LIST_LIMIT);
        } else if (method === "fs.read") {
          result = await localReadText(payload.path, READ_LIMIT);
        } else if (method === "fs.write") {
          result = await localWriteFile(payload.path, payload.content || "");
        } else if (method === "fs.search") {
          result = await localSearchFiles(sessionCwd, payload.query || "");
        } else {
          writeJson(res, 404, { ok: false, error: { code: "not-found", message: "unknown method " + method } }); return;
        }
      }
      if (result && result.ok === false) {
        writeJson(res, 400, { ok: false, error: { code: "fs-error", message: result.error || "operation failed" } });
      } else {
        writeOk(res, result);
      }
    } catch (e) {
      writeJson(res, 400, { ok: false, error: { code: "fs-error", message: String(e && e.message ? e.message : e) } });
    }
  }

  ["fs.tree", "fs.read", "fs.write", "fs.search"].forEach(function (m) {
    ctx.effect(() => ctx.webServer.register({
      kind: "exact",
      path: "/sidebar/api/" + m,
      handler: function (req, res) { return interceptFsHandler(req, res, m); }
    }), "dsh-remote-ssh: intercept /sidebar/api/" + m);
  });

  // ---- 清理 ----
  ctx.effect(() => () => {
    clearInterval(idleTimer);
    sessions.forEach(function (s) { try { s.close(); } catch (e) {} });
    sessions.clear();
    terminals.forEach(function (s) { try { s.handle.terminate(); } catch (e) {} });
    terminals.clear();
  });
}

export { Config, apply, inject, name };
