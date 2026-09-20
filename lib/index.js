/**
 * @zhangfengshun/dsh-remote-ssh — Host 半边（静态 DSH Web 插件）
 *
 * 能力：
 *   1. 远程连接配置 + 远程工作区持久化到 DSH settings 命名空间 `dsh-remote-ssh`
 *      （schemastery schema，密码字段 role('secret') 在描述时脱敏）。
 *   2. 通过 SSH 提供文件列举 / 读取 / 写入 / 执行 / 集成终端（ssh -tt 管道通道）。
 *   3. 暴露 HTTP JSON API（/remote-ssh/api/*）给 Client 半边。
 *   4. 注册 13 个模型工具（remote_ssh_*），命令级超时 + remote_ssh_kill 兜底恢复。
 */
import z from "schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { mkdir, rm, writeFile, readFile, opendir, stat, open, rename, readdir, lstat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, basename } from "node:path";

/** Plugin identity for cordis.yml rows. */
const name = "@zhangfengshun/dsh-remote-ssh";
/** Services required before mounting. */
const inject = ["webServer", "subprocess", "tools", "workspaceRegistry"];
/** Composition config schema（本插件暂无配置项）。 */
const Config = z.object({});

const NS = "dsh-remote-ssh";
const MAX_BYTES = 4 * 1024 * 1024;
/** 持久会话单条命令的 stdout 缓冲硬上限（防止大文件/海量输出撑爆内存）。 */
const SESSION_MAX_STDOUT = 8 * 1024 * 1024;
const API_BASE = "/remote-ssh/api/";

// ---------------------------------------------------------------------------
// 命令级超时（issue #5）：一条挂起的远端命令（网络卡顿 / 远端进程僵死 / 等待 stdin）
// 会永久占用池化会话并阻塞其后所有命令。默认 120 秒超时，可用环境变量
// DSH_REMOTE_SSH_CMD_TIMEOUT_MS 覆盖全局默认，0 表示禁用（长时任务显式放宽）。
// ---------------------------------------------------------------------------
const DEFAULT_CMD_TIMEOUT_MS = (() => {
  const v = parseInt(process.env.DSH_REMOTE_SSH_CMD_TIMEOUT_MS, 10);
  return Number.isFinite(v) && v >= 0 ? v : 120000;
})();

/** 归一化单次调用传入的超时：显式 timeoutMs 优先，其次环境变量默认值。 */
function resolveTimeoutMs(timeoutMs) {
  if (timeoutMs !== undefined && timeoutMs !== null) {
    const v = parseInt(timeoutMs, 10);
    if (Number.isFinite(v) && v >= 0) return v;
  }
  return DEFAULT_CMD_TIMEOUT_MS;
}

/** 给任意 Promise 加超时：超时时带 isTimeout 标记 reject，并先执行 onTimeout
 *  （用于终止进程 / 丢弃会话）。ms<=0 时原样返回（禁用超时）。 */
function withTimeout(promise, ms, label, onTimeout) {
  if (!ms || ms <= 0) return promise;
  let timer;
  const timed = new Promise(function (_, reject) {
    timer = setTimeout(function () {
      const err = new Error((label || "命令") + " 执行超时（" + ms + "ms），已放弃等待");
      err.isTimeout = true;
      if (onTimeout) { try { onTimeout(); } catch (e) {} }
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timed]).finally(function () { clearTimeout(timer); });
}

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
 * 哨兵后的数字即退出码。split（分离 stderr）模式下，stderr 重定向到远端临时文件，
 * 退出码哨兵之后 cat 出来并用第二个哨兵收尾：保住 stdout/stderr 分离的同时，
 * 让 remote_ssh_exec 这类调用也走连接复用（首调用建连后毫秒级返回）。
 * 输出侧有硬上限 SESSION_MAX_STDOUT：哨兵出现前缓冲超限即重置会话，下次调用自动重建。
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
    /** 最近一段 stderr（防背压消费 + 会话关闭诊断）。 */
    this.errBuf = "";
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
    this.errBuf = "";
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
    // stderr 必须消费：不挂监听会让管道缓冲填满、远端 ssh 写 stderr 阻塞（会话假死）。
    // 保留最近 64KB 用于会话关闭时的诊断。
    h.stderr.on("data", (chunk) => {
      this.errBuf = (this.errBuf + chunk.toString("utf8")).slice(-65536);
    });
    const onEnd = () => {
      this.alive = false;
      const errMsg = "ssh 会话已关闭" + (this.errBuf.trim() ? ": " + stripPqBanner(this.errBuf).trim().slice(-300) : "");
      if (this.current) { this.current.reject(new Error(errMsg)); this.current = null; }
      while (this.queue.length) this.queue.shift().reject(new Error(errMsg));
    };
    h.stdout.on("end", onEnd);
    h.stdout.on("error", onEnd);
    h.done.then(() => { this.alive = false; }, () => { this.alive = false; });
    this.alive = true;
    this.lastUsed = Date.now();
  }

  _check() {
    if (!this.current) return;
    const item = this.current;
    if (!item.exitParsed) {
      // 找到主哨兵：解析退出码；split 模式还要等第二个哨兵（stderr 内容）
      const idx = this.buf.indexOf(this.sentinel);
      if (idx < 0) { this._enforceCap(); return; }
      const before = this.buf.slice(0, idx);
      const after = this.buf.slice(idx + this.sentinel.length);
      const nl = after.indexOf("\n");
      const codeStr = nl >= 0 ? after.slice(0, nl) : after;
      this.buf = nl >= 0 ? after.slice(nl + 1) : "";
      const exitCode = parseInt(codeStr, 10);
      item.exitCode = isNaN(exitCode) ? -1 : exitCode;
      item.stdout = before;
      item.exitParsed = true;
      if (!item.errSentinel) {
        this.current = null;
        item.resolve({ stdout: item.stdout, stderr: item.stderr, exitCode: item.exitCode });
        this._next();
        return;
      }
    }
    if (item.errSentinel) {
      // split 模式第二段：等 stderr 哨兵（可能已在缓冲里）
      const idx = this.buf.indexOf(item.errSentinel);
      if (idx < 0) { this._enforceCap(); return; }
      const errText = this.buf.slice(0, idx);
      const after = this.buf.slice(idx + item.errSentinel.length);
      const nl = after.indexOf("\n");
      this.buf = nl >= 0 ? after.slice(nl + 1) : "";
      item.stderr = errText.replace(/\n$/, "");
      this.current = null;
      item.resolve({ stdout: item.stdout, stderr: item.stderr, exitCode: item.exitCode });
      this._next();
    }
  }

  /** 单条命令输出超过硬上限：立即重置会话（下次调用自动重建），拒绝挂起/撑爆内存。 */
  _enforceCap() {
    if (!this.current || this.buf.length < SESSION_MAX_STDOUT) return;
    const item = this.current;
    this.current = null;
    item.reject(new Error("单条命令输出超过 " + SESSION_MAX_STDOUT + " 字节上限，会话已重置（若确实需要更大输出请拆分命令）"));
    this.alive = false;
    if (this.handle) { try { this.handle.terminate(); } catch (e) {} this.handle = null; }
    while (this.queue.length) this.queue.shift().reject(new Error("ssh 会话已重置"));
  }

  _next() {
    if (this.current || !this.alive || this.queue.length === 0) return;
    const item = this.queue.shift();
    item.exitParsed = false;
    item.stdout = "";
    item.stderr = "";
    item.exitCode = -1;
    item.errSentinel = item.split
      ? "DSHERR" + Math.random().toString(36).slice(2, 14) + Math.random().toString(36).slice(2, 8)
      : null;
    this.current = item;
    try {
      const errFile = "${TMPDIR:-/tmp}/.dsh-err-" + Math.random().toString(36).slice(2, 10);
      const exitMark = "printf '\\n" + this.sentinel + "%s\\n' $?";
      const errTail = "cat " + errFile + " 2>/dev/null; rm -f " + errFile + "; printf '\\n" + item.errSentinel + "ok\\n'";
      let toWrite;
      if (item.split) {
        // 分离 stderr 用双层子 shell：
        //   外层 ( ... ) 保证 printf 链自身不会受用户命令返回值影响；
        //   内层 ( { cmd ; } ) 隔离用户命令里的 exit/cd，绝不弄挂共享 bash 会话
        //   （exit 只会退出内层子 shell，后面照常打印哨兵与退出码）。
        if (item.stdinData !== undefined && item.stdinData !== null) {
          const delim = "DSHW" + Math.random().toString(36).slice(2, 14);
          toWrite = "( ( " + item.cmd + " <<'" + delim + "'\n" + String(item.stdinData) + "\n" + delim + "\n) 2>" + errFile + "; " + exitMark + "; " + errTail + " )\n";
        } else {
          toWrite = "( ( " + item.cmd + " ; ) 2>" + errFile + "; " + exitMark + "; " + errTail + " )\n";
        }
      } else if (item.stdinData !== undefined && item.stdinData !== null) {
        // 快速路径写操作：heredoc 传内容，2>&1 合并（成功时 stderr 为空，不影响解析）
        const delim = "DSHW" + Math.random().toString(36).slice(2, 14);
        toWrite = item.cmd + " <<'" + delim + "'\n" + String(item.stdinData) + "\n" + delim + "\n" + exitMark + "\n";
      } else {
        // 读/列举/搜索快速路径：2>&1 合并 stderr（成功时 stderr 为空）
        toWrite = "{ " + item.cmd + " ; } 2>&1\n" + exitMark + "\n";
      }
      this.handle.stdin.write(toWrite);
    } catch (e) {
      this.current = null;
      item.reject(e);
      this._next();
    }
  }

  async exec(cmd, stdinData, split) {
    await this.connect();
    this.lastUsed = Date.now();
    return new Promise((resolve, reject) => {
      this.queue.push({ cmd, stdinData, split: !!split, resolve, reject });
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

/** Windows 下优先解析系统自带 OpenSSH 的绝对路径：从 git-bash 启动 dsh web 时，
 *  子进程 PATH 会把 Git 自带的 MSYS2 ssh 排在系统 OpenSSH 之前（HOME/config/agent
 *  语义不同，导致密钥认证失败——issue：git-bash 启动场景）。System32\OpenSSH 是
 *  Win10 1809+ 的标准安装位置，不存在则回落 PATH（维持旧行为）。结果模块级缓存。 */
let cachedSshPath;
function sshExecutablePath() {
  if (cachedSshPath !== undefined) return cachedSshPath;
  if (process.platform === "win32") {
    const sysSsh = join(process.env.SystemRoot || "C:\\Windows", "System32", "OpenSSH", "ssh.exe");
    if (existsSync(sysSsh)) return (cachedSshPath = sysSsh);
  }
  return (cachedSshPath = "ssh");
}

function sshArgv(p, remoteCmd, tty, extraOpts) {
  const opts = [sshExecutablePath()];
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
  if (p.authMethod === "key" && p.keyPath) opts.push("-i", expandSshPath(p.keyPath));
  // 密钥认证的非交互连接（会话池 / 工具 / 同步）要求一次性无提示完成：
  // BatchMode 禁用 passphrase/确认交互（有口令的密钥立即报错而不是挂到超时），
  // PreferredAuthentications=publickey 跳过无谓的认证方法协商，缩短建连时间。
  if (!tty && p.authMethod === "key") {
    opts.push("-o", "BatchMode=yes");
    opts.push("-o", "PreferredAuthentications=publickey");
  }
  if (Array.isArray(extraOpts) && extraOpts.length) opts.push(...extraOpts);
  const target = String(p.user || "") + "@" + String(p.host || "");
  const head = (p.authMethod === "password" && p.password) ? ["sshpass", "-p", String(p.password)] : [];
  const argv = head.concat(opts, [target]);
  if (remoteCmd !== undefined) argv.push(remoteCmd);
  return argv;
}

/** 过滤 OpenSSH 客户端的“后量子 KEX”警告横幅（stderr 噪音，与认证成败无关，
 *  混进错误信息会误导用户以为是不支持加密算法）。 */
function stripPqBanner(text) {
  return String(text || "")
    .split("\n")
    .filter(function (line) {
      return !/^\s*\*\*\s*(WARNING: connection is not using a post-quantum|This session may be vulnerable to .?store now|The server may need to be upgraded)/i.test(line);
    })
    .join("\n");
}

async function runRemote(subprocess, p, remoteCmd, stdinData, maxBytes, extraOpts, timeoutMs) {
  const max = maxBytes || MAX_BYTES;
  const tms = resolveTimeoutMs(timeoutMs);
  let handle;
  try {
    handle = subprocess.spawn({
      argv: sshArgv(p, remoteCmd, false, extraOpts),
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
    // 命令级超时：挂起的命令会在 tms 后被终止（handle.terminate），不再无限等待。
    // 对超时命令刻意不做重试：重试一条挂起的命令只会再次挂起（issue #5）。
    outcome = await withTimeout(handle.done, tms, "ssh 命令", function () {
      try { handle.terminate(); } catch (e) {}
    });
  } catch (e) {
    if (e && e.isTimeout) {
      return { ok: false, exitCode: -1, signal: "", stdout: "", stderr: "", truncated: false, isTimeout: true, error: e.message };
    }
    return { ok: false, error: "执行失败: " + String(e && e.message ? e.message : e) };
  }
  const so = (handle.collected && handle.collected.stdout) ? handle.collected.stdout.readFrom(0) : { text: "", nextOffset: 0, lossy: false };
  const se = (handle.collected && handle.collected.stderr) ? handle.collected.stderr.readFrom(0) : { text: "", nextOffset: 0, lossy: false };
  const outText = so.text;
  const errText = stripPqBanner(se.text);
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
  const pk = profileKey(p);
  const key = pk + "|" + String(target);
  const epoch = cacheEpoch(pk);
  const hit = lruGet(treeCache, key);
  if (hit && hit.epoch === epoch && Date.now() - hit.at <= TREE_CACHE_TTL_MS) {
    return { ok: true, path: target, entries: hit.entries.slice() }; // TTL 内 0 RTT
  }
  if (hit && hit.epoch !== epoch) treeCache.delete(key);
  // cd 包进子 shell：列举完成后不污染共享会话 cwd（findings §4.4 —— 旧实现 cd 持久生效，
  // 会话内后续相对路径命令全部落空）。exit 只退出子 shell，哨兵协议不受影响。
  const script = "( cd " + shellQuotePath(target) + " 2>/dev/null || { echo '__DSH_ERR__ cannot cd'; exit 1; }; find . -maxdepth 1 -mindepth 1 -printf '%Y\\t%f\\t%s\\n' 2>/dev/null | sort )";
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
  lruPut(treeCache, key, { entries: entries, epoch: epoch, at: Date.now() }, TREE_CACHE_MAX);
  return { ok: true, path: target, entries: entries };
}

// ---------------------------------------------------------------------------
// 远程读取提速（t2）：单往返合并读 + raw 文本快路径 + mtime/size LRU 结果缓存
//
// 帧协议（沿用既有非 split 快速路径 "{ cmd ; } 2>&1" + 退出码哨兵；路径一律先
// f=<shellQuotePath> 再以 "$f" 引用，无任何 cwd 依赖）：
//   stdout 首行固定为  __DSH_ST__<size>:<mtime>   （stat 成功，均为十进制）
//   或               __DSH_ST__ERR:<单行摘要>     （stat 失败：摘要压成单行 ≤200 字符，
//                                                 整条命令以内建 false 收尾保证非零
//                                                 退出码 —— 绝不空内容假成功/挂起；
//                                                 不用 exit，因非 split 帧无子 shell 隔离）
//   载荷 = 首行 \n 之后：base64 模式 `base64 -w0`（size>4MB 先 `head -c 4MB` 截断），
//         raw 模式为文件原始字节（仅限文本扩展名白名单）。
//   `_` 不在 base64 字母表内 → base64 载荷不可能出现 `__DSH_ST__`，标记定位天然抗噪；
//   协议层固定在哨兵前补一个 \n（exitMark），raw 解析按“恰好去掉末尾一个 \n”还原。
// ---------------------------------------------------------------------------

const DSH_ST_MARK = "__DSH_ST__";
/** raw 快路径扩展名白名单（findings §3②）：只对按 UTF-8 文本处理的文件免 base64。
 *  字节长度或 \uFFFD 校验失败时自动回退 base64 重读，不劣于现状。 */
const RAW_TEXT_EXTS = new Set([
  ".txt", ".md", ".markdown", ".rst", ".log", ".csv", ".tsv",
  ".py", ".pyw", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".vue", ".svelte",
  ".json", ".jsonc", ".json5", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".env",
  ".sh", ".bash", ".zsh", ".fish", ".ps1", ".psm1", ".bat", ".cmd", ".sql",
  ".c", ".h", ".cpp", ".hpp", ".cc", ".hh", ".cxx", ".hxx", ".f", ".for", ".f90", ".f95",
  ".java", ".go", ".rs", ".rb", ".pl", ".pm", ".php", ".lua", ".r", ".jl", ".dart", ".kt",
  ".html", ".htm", ".css", ".scss", ".sass", ".less", ".xml", ".svg", ".xsl", ".proto",
  ".tex", ".bib", ".properties", ".gradle", ".cmake", ".mk", ".diff", ".patch", ".ipynb"
]);
/** 无扩展名 / 点开头的常读文本文件（按整名匹配，小写）。 */
const RAW_TEXT_NAMES = new Set([
  "makefile", "dockerfile", "license", "readme", "changelog", "authors", "contributors",
  ".gitignore", ".gitattributes", ".gitmodules", ".gitconfig", ".gitkeep", ".editorconfig",
  ".dockerignore", ".npmrc", ".nvmrc", ".bashrc", ".bash_profile", ".profile", ".vimrc", ".tmux.conf"
]);
/** 读结果 LRU：key = profileKey|path，TTL ≤5s；过期后 1 裸 RTT stat 复验 mtime+size。 */
const READ_CACHE_MAX = 32;
const READ_CACHE_TTL_MS = 5000;
/** 目录列举 LRU：key = profileKey|dir，TTL 5s。 */
const TREE_CACHE_MAX = 64;
const TREE_CACHE_TTL_MS = 5000;
/** 每个 profile 的缓存代（epoch）：插件侧任何变更（写/删/移/建目录/上传/syncUp/
 *  远程 exec/git）都 +1，条目按填充时代号校验 —— 兜底 mtime 秒级粒度的“同秒同 size”
 *  写、~/x 与 /home/u/x 路径字符串空间不一致、以及漏钩子场景（findings §4.3）。 */
const cacheEpochs = new Map();
const readCache = new Map();
const treeCache = new Map();

function profileKey(p) {
  // 认证信息变化时应重建会话/缓存：修改 keyPath/authMethod 后旧身份不能继续复用。
  return String(p.id) + "|" + String(p.host) + ":" + String(p.port || 22) + "|" + String(p.user || "") + "|" + String(p.authMethod || "key") + "|" + String(p.keyPath || "");
}

function cacheEpoch(pk) {
  let e = cacheEpochs.get(pk);
  if (!e) { e = 1; cacheEpochs.set(pk, e); }
  return e;
}

/** 只递增 epoch 不删条目：远程 exec / git 这类“可能改了任意文件”的入口调用。 */
function bumpCacheEpoch(p) {
  const pk = profileKey(p);
  cacheEpochs.set(pk, cacheEpoch(pk) + 1);
}

function lruGet(map, key) {
  const v = map.get(key);
  if (v === undefined) return undefined;
  map.delete(key);
  map.set(key, v); // LRU touch
  return v;
}

function lruPut(map, key, val, max) {
  map.delete(key);
  map.set(key, val);
  while (map.size > max) map.delete(map.keys().next().value);
}

/** 读缓存字节预算（review m1）：单条 >1MiB 不缓存、总量 ≤32MB，防止大文件驻留
 *  造成 GC 压力拖慢整个宿主进程。超预算时从最旧条目开始逐出。 */
const READ_CACHE_MAX_ENTRY_BYTES = 1024 * 1024;
const READ_CACHE_TOTAL_BYTES = 32 * 1024 * 1024;
function readCachePut(key, entry, max) {
  entry.bytes = Buffer.byteLength(entry.content, "utf8");
  if (entry.bytes > READ_CACHE_MAX_ENTRY_BYTES) return; // 大文件不缓存（结果照常返回）
  lruPut(readCache, key, entry, max);
  let total = 0;
  for (const v of readCache.values()) total += v.bytes || 0;
  while (total > READ_CACHE_TOTAL_BYTES && readCache.size > 1) {
    const oldest = readCache.keys().next().value;
    total -= readCache.get(oldest).bytes || 0;
    readCache.delete(oldest);
  }
}

function normalizeCachePath(path) {
  let s = String(path || "");
  while (s.length > 1 && s.charCodeAt(s.length - 1) === 47) s = s.slice(0, -1);
  return s;
}

function posixDirname(path) {
  const s = normalizeCachePath(path);
  const i = s.lastIndexOf("/");
  if (i < 0) return ".";
  if (i === 0) return "/";
  return s.slice(0, i);
}

/** 文件读取缓存失效（统一入口之一；pk 为 profileKey 字符串）。
 *  subtree=true 同时失效 path 子树（rm -rf / mv 目录场景）。 */
function invalidateReadCache(pk, path, opts) {
  const sub = !!(opts && opts.subtree);
  const target = pk + "|" + normalizeCachePath(path);
  for (const k of Array.from(readCache.keys())) {
    if (k === target || (sub && k.startsWith(target + "/"))) readCache.delete(k);
  }
}

/** 目录列举缓存失效（同语义，作用于目录键）。 */
function invalidateTreeCache(pk, dir, opts) {
  const sub = !!(opts && opts.subtree);
  const target = pk + "|" + normalizeCachePath(dir);
  for (const k of Array.from(treeCache.keys())) {
    if (k === target || (sub && k.startsWith(target + "/"))) treeCache.delete(k);
  }
}

/** 收敛失效入口：所有可能改变远端文件/目录的插件入口都调用它 ——
 *  文件缓存（exact + 可选子树）+ 列举缓存（被改目录本身 + 其父目录）+ 整代 epoch+1。 */
function invalidateRemoteCaches(p, path, opts) {
  bumpCacheEpoch(p);
  const pk = profileKey(p);
  const target = normalizeCachePath(path);
  if (!target) return;
  invalidateReadCache(pk, target, opts);
  invalidateTreeCache(pk, target, opts);
  invalidateTreeCache(pk, posixDirname(target), { subtree: false });
}

/** 整个 profile 的缓存清空（syncUp 批量覆盖远端后调用）。 */
function clearCachesForProfile(p) {
  const pk = profileKey(p);
  cacheEpochs.set(pk, cacheEpoch(pk) + 1);
  for (const k of Array.from(readCache.keys())) { if (k.startsWith(pk + "|")) readCache.delete(k); }
  for (const k of Array.from(treeCache.keys())) { if (k.startsWith(pk + "|")) treeCache.delete(k); }
}

function isRawTextPath(path) {
  const base = String(path || "").split(/[\\/]/).pop() || "";
  const lower = base.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot > 0 && RAW_TEXT_EXTS.has(lower.slice(dot))) return true;
  if (RAW_TEXT_NAMES.has(lower)) return true;
  if (dot === 0 && RAW_TEXT_EXTS.has(lower)) return true; // .gitignore 这类整名即后缀
  return false;
}

/** 远端错误摘要：压成单行、去重空白、≤300 字符（远端侧已 cut -c1-200，这里再兜底）。 */
function sanitizeErrLine(s) {
  const t = String(s || "").replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
  return t.slice(0, 300);
}

/**
 * 解析 __DSH_ST__ 帧。stdout 首行必须严格以标记开头（登录噪声场景按旧行为降级，
 * framed=false → 整段按旧协议处理，绝不误切）。stat 值异常（非数字/缺冒号）一律走
 * err 分支，禁止 NaN 继续传播。首行之后即载荷（文件内容不会出现在标记行之前：
 * 命令先 printf 标记，head/base64/cat 在其后输出）。
 */
function parseStatFrame(stdout) {
  const out = String(stdout || "");
  const nl = out.indexOf("\n");
  const first = nl >= 0 ? out.slice(0, nl) : out;
  const rest = nl >= 0 ? out.slice(nl + 1) : "";
  if (!first.startsWith(DSH_ST_MARK)) {
    return { framed: false, err: null, size: null, mtime: null, rest: out };
  }
  const body = first.slice(DSH_ST_MARK.length);
  if (body.startsWith("ERR:")) {
    return { framed: true, err: sanitizeErrLine(body.slice(4)) || "远端读取失败", size: null, mtime: null, rest: rest };
  }
  const ci = body.indexOf(":");
  if (ci < 0) return { framed: true, err: "stat 标记解析异常", size: null, mtime: null, rest: rest };
  const sizeStr = body.slice(0, ci);
  const mtimeStr = body.slice(ci + 1);
  if (!/^\d*$/.test(sizeStr) || !/^\d*$/.test(mtimeStr) || (sizeStr === "" && mtimeStr === "")) {
    return { framed: true, err: "stat 标记数值异常", size: null, mtime: null, rest: rest };
  }
  return {
    framed: true,
    err: null,
    size: sizeStr === "" ? null : parseInt(sizeStr, 10),
    mtime: mtimeStr === "" ? null : parseInt(mtimeStr, 10),
    rest: rest
  };
}

/** 帧命令共享段：stat(size mtime) + 标记行。stat 失败 → ERR 标记 + false（非零收尾）。 */
function statFrameSnippet() {
  return "if st=$(stat -c'%s %Y' -- \"$f\" 2>&1); then printf '" + DSH_ST_MARK + "%s:%s\\n' \"${st%% *}\" \"${st#* }\"; ";
}

function errSnippet() {
  return "else printf '" + DSH_ST_MARK + "ERR:%s\\n' \"$(printf '%s' \"$st\" | tr '\\r\\n' '  ' | cut -c1-200)\"; false; fi";
}

/** 复验命令（过期缓存条目的 mtime+size 校验）：1 裸 RTT，无内容传输。 */
function buildStatCommand(path) {
  return "f=" + shellQuotePath(path) + "; " + statFrameSnippet() + errSnippet();
}

/** 合并读命令：一次往返同时拿 size/mtime 与内容；>4MB 保留 head -c 截断语义。
 *  raw=true 载荷为原始字节（仅白名单文本），否则 base64 -w0。 */
function buildReadCommand(path, raw) {
  const readPart = raw
    ? "if [ \"${st%% *}\" -gt " + MAX_BYTES + " ] 2>/dev/null; then head -c " + MAX_BYTES + " -- \"$f\"; else cat -- \"$f\"; fi"
    : "if [ \"${st%% *}\" -gt " + MAX_BYTES + " ] 2>/dev/null; then head -c " + MAX_BYTES + " -- \"$f\" | base64 -w0; else base64 -w0 -- \"$f\"; fi";
  return "f=" + shellQuotePath(path) + "; " + statFrameSnippet() + readPart + "; " + errSnippet();
}

function decodeBase64Text(b64) {
  const bytes = new Uint8Array(Buffer.from(String(b64).trim(), "base64"));
  let binary = false;
  const first = bytes.subarray(0, 8000);
  for (let i = 0; i < first.length; i++) { if (first[i] === 0) { binary = true; break; } }
  return { text: new TextDecoder().decode(bytes), binary: binary };
}

/** raw 载荷字节级校验：去掉协议层补的末尾 \n 后，字节数必须等于 size，且不含
 *  \uFFFD（会话层 chunk.toString("utf8") 有损解码的痕迹）。任一不符 → 返回 null，
 *  由调用方回退 base64 重读。二进制探测语义与旧实现一致（前 8000 含 NUL → binary）。 */
function decodeRawText(rest, size) {
  if (size === null || size === undefined) return null;
  if (!rest.endsWith("\n")) return null; // 协议保证哨兵前有一个分隔 \n
  const rawText = rest.slice(0, -1);
  const expected = Math.min(size, MAX_BYTES);
  if (Buffer.byteLength(rawText, "utf8") !== expected) return null;
  if (rawText.indexOf("\uFFFD") >= 0) return null;
  return { text: rawText, binary: rawText.slice(0, 8000).indexOf("\u0000") >= 0 };
}

function readResultOk(path, text, binary, truncated) {
  return { ok: true, path: path, content: text, binary: binary, truncated: truncated };
}

async function remoteReadFile(runner, p, path) {
  if (!path) return { ok: false, error: "path 为必填项" };
  const pk = profileKey(p);
  const key = pk + "|" + String(path);
  const epoch = cacheEpoch(pk);
  const hit = lruGet(readCache, key);
  if (hit && hit.epoch === epoch) {
    if (Date.now() - hit.at <= READ_CACHE_TTL_MS) {
      return readResultOk(path, hit.content, hit.binary, hit.truncated); // TTL 内 0 RTT
    }
    // TTL 过期：1 裸 RTT 复验 mtime+size，未变则免内容重传（findings §3③）
    const rv = await runner(p, buildStatCommand(path), undefined, MAX_BYTES);
    if (rv.ok) {
      const rst = parseStatFrame(rv.stdout);
      if (rst.framed && rst.err !== null) {
        readCache.delete(key); // 文件已消失/不可 stat：全量读也只会得到同样错误
        return { ok: false, error: rst.err };
      }
      if (rst.framed && rst.size === hit.size && rst.mtime === hit.mtime) {
        hit.at = Date.now();
        readCachePut(key, hit, READ_CACHE_MAX);
        return readResultOk(path, hit.content, hit.binary, hit.truncated);
      }
    }
    // 复验失败/文件已变更 → 落到全量合并读
  } else if (hit) {
    readCache.delete(key); // 旧代条目（epoch 已推进）直接丢弃
  }
  const isRaw = isRawTextPath(path);
  let r = await runner(p, buildReadCommand(path, isRaw), undefined, MAX_BYTES);
  let st = parseStatFrame(r.stdout);
  if (isRaw && r.ok && st.framed && st.err === null) {
    const rawOk = decodeRawText(st.rest, st.size);
    if (rawOk) {
      const truncated = st.size !== null && st.size > MAX_BYTES;
      if (!r.truncated) {
        readCachePut(key, { content: rawOk.text, binary: rawOk.binary, truncated: truncated, size: st.size, mtime: st.mtime, epoch: epoch, at: Date.now() }, READ_CACHE_MAX);
      }
      return readResultOk(path, rawOk.text, rawOk.binary, truncated || !!r.truncated);
    }
    // raw 校验失败（二进制冒充文本/截断断字/异常）→ base64 重读，不劣于现状
    r = await runner(p, buildReadCommand(path, false), undefined, MAX_BYTES);
    st = parseStatFrame(r.stdout);
  }
  if (!r.ok) {
    readCache.delete(key);
    let msg = String(r.error || r.stderr || "").trim();
    if (st.framed) msg = st.err !== null ? st.err : sanitizeErrLine(st.rest);
    return { ok: false, error: msg || "读取失败" };
  }
  if (st.framed && st.err !== null) {
    // 帧内错误但退出码 0（异常远端）：按错误处理，绝不返回空内容假成功
    return { ok: false, error: st.err };
  }
  let decoded;
  try {
    decoded = decodeBase64Text(st.framed ? st.rest : r.stdout);
  } catch (e) {
    return { ok: false, error: "解码失败: " + String(e) };
  }
  const truncated = st.framed && st.size !== null && st.size > MAX_BYTES;
  if (st.framed && !r.truncated) {
    readCachePut(key, { content: decoded.text, binary: decoded.binary, truncated: truncated, size: st.size, mtime: st.mtime, epoch: epoch, at: Date.now() }, READ_CACHE_MAX);
  }
  return readResultOk(path, decoded.text, decoded.binary, truncated || !!r.truncated);
}

async function remoteWriteFile(runner, p, path, content) {
  if (!path) return { ok: false, error: "path 为必填项" };
  const c = content !== undefined ? String(content) : "";
  if (c.length > MAX_BYTES) {
    return { ok: false, exitCode: -1, stdout: "", stderr: "", error: "写入内容超过 " + MAX_BYTES + " 字节上限", truncated: false };
  }
  // base64 -d 写入（heredoc stdin）：heredoc 帧固定补一个尾随 \n，base64 解码会忽略它，
  // 从而字节级精确 —— 修复旧 `cat > file` 写法“每次保存尾随 +1 字节”的 quirk
  // （findings §3⑦），且对 NUL/二进制安全。内容 ≤4MB → base64 ≤5.6MB，内存可控。
  const r = await runner(p, "base64 -d > " + shellQuotePath(path), Buffer.from(c, "utf8").toString("base64"), MAX_BYTES, true);
  // 写后失效：成功与否都失效（失败的写也可能已截断旧文件）。
  invalidateRemoteCaches(p, path, { subtree: false });
  return r;
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
  if (opts.include) parts.push("--include=" + shellQuote(String(opts.include)));
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

/** 侧栏文件名搜索要剪掉的噪声目录：定义见下方 REF_EXCLUDED_DIRS 之后
 *  （模块级 const 不能引用尚未初始化的绑定 —— 曾因展开 REF_EXCLUDED_DIRS 触发 TDZ，
 *   导致整个插件树加载失败，故这里只留说明，实体定义放在其依赖之后）。 */

/**
 * 在远端按 glob 模式查找文件（find -name）。find 已递归；pattern 为 basename 通配
 * （如 .py 后缀），自动剥离前导双星号-斜杠与星号-斜杠以适配 POSIX find -name。
 *
 * 选项：
 * - `relative`：用 `-printf '%P\n'` 输出**相对起始目录**的路径（issue #13：侧栏文件名搜索
 *   要 cwd 相对路径；默认仍输出 find 原样的绝对路径，供 remote_ssh_glob 工具使用）。
 * - `sorted !== false`：管道里加 `sort`。搜索路径必须关掉它 —— `sort` 会缓冲**全部** find
 *   输出后才吐第一行，使 `head` 的提前短路完全失效（issue #13 实测：一个大型远程项目工作区
 *   5 分钟都跑不完，UI 一直「加载中…」，还占住池化会话阻塞其他操作）。
 * - `pruneNoise`：遍历前剪掉 REMOTE_SEARCH_SKIP_DIRS。
 * - `maxDepth`：`-maxdepth N`（浅层优先搜索用；不设则全深度）。
 * - `timeBudgetSec`：远端墙钟预算（`timeout`/`gtimeout`，存在才用），到点杀掉 find 并返回
 *   **已收集到的部分结果** + truncated，避免把用户吊死在一次遍历上。
 * - `timeoutMs`：SSH 层命令超时（默认沿用全局 120s）。
 */
async function remoteGlob(runner, p, pattern, path, opts) {
  opts = opts || {};
  const target = path || p.remoteRoot || "~";
  let pat = String(pattern || "").trim();
  pat = pat.replace(/^(\*\*\/|\*\/)+/, "");
  const max = parseInt(String(opts.maxResults || 500), 10) || 500;
  const depth = parseInt(String(opts.maxDepth || 0), 10) || 0;
  const fmt = opts.relative ? "%P" : "%p";
  const prune = opts.pruneNoise
    ? "\\( " + Array.from(REMOTE_SEARCH_SKIP_DIRS).map((n) => "-name " + shellQuote(n)).join(" -o ") + " \\) -prune -o "
    : "";
  const findCmd = "find " + shellQuotePath(target) + " " + (depth > 0 ? "-maxdepth " + depth + " " : "")
    + prune + "-name " + shellQuote(pat) + " -printf '" + fmt + "\\n' 2>/dev/null";
  const pipeline = findCmd + (opts.sorted === false ? "" : " | sort") + " | head -n " + max;
  let cmd = pipeline;
  const budget = parseInt(String(opts.timeBudgetSec || 0), 10) || 0;
  if (budget > 0) {
    // timeout 是 GNU coreutils（Linux 常见），macOS 需 gtimeout；都没有时退回无预算版本，
    // 由 SSH 层超时兜底（此时不会拿到部分结果）。
    cmd = [
      "T=$(command -v timeout || command -v gtimeout || true)",
      "if [ -n \"$T\" ]; then",
      "\"$T\" " + budget + " " + pipeline,
      "else",
      pipeline,
      "fi"
    ].join("\n");
  }
  const r = await runner(p, cmd, undefined, MAX_BYTES, false, opts.timeoutMs);
  const files = String(r && r.stdout ? r.stdout : "").split("\n").filter(function (s) { return !!s; });
  // 预算到点（timeout → 124）或被 kill 时，stdout 里已有部分结果：照常返回并标记 truncated，
  // 让用户看到「部分结果」而不是一个错误或永久加载。
  if (r && r.ok === false && files.length === 0) {
    return { ok: false, pattern: pattern, path: target, files: [], truncated: false, error: (r && r.error) || "glob failed" };
  }
  const budgetHit = !!(r && (r.ok === false || r.exitCode === 124 || r.timeout));
  return { ok: true, pattern: pattern, path: target, files: files, truncated: !!((r && r.truncated) || budgetHit || files.length >= max), error: "" };
}

/**
 * tar-over-ssh 双向同步（借鉴 flymysql dsh-remote 的 SFTP 镜像同步，但复用现有 ssh.exe + tar，
 * 不引入 ssh2 依赖）。用流式管道把一条 ssh 的 stdout 喂给本地 tar 的 stdin（反之亦然），
 * 不经过 4MB Buffer 上限。
 */
function spawnOne(subprocess, argv, stdio, cwd) {
  return subprocess.spawn({ argv: argv, cwd: cwd || process.cwd(), stdio: stdio, graceMs: 60000 });
}

/** 侧栏文件名搜索的预算与缓存（issue #13 实测：一个大型远程项目工作区 `find` 5 分钟都跑不完，
 *  UI 一直「加载中…」，而且池化 SSH 会话被这条命令占住，其他操作一起卡）。
 *
 *  实测该工作区：顶层仅 12 个条目、命中集中在 depth 1–3（0.02–0.42s），depth 4 起耗时跳到 3s+
 *  且不再有新命中——`find` 是深度优先，巨型子目录会吃光预算，连顶层文件都轮不到。
 *  因此分两趟：先浅层（快、通常已够）；**浅层一无所获才同步等深挖**，有结果时深挖转后台预热
 *  缓存（否则常见查询都要多等一趟 ≤5s 的深挖，实测「有点慢」）。两趟都受远端墙钟预算约束。 */
const REF_SEARCH_MAX_MATCHES = 200;        // 与上游 DEFAULT_MAX_MATCHES 一致
const REF_SEARCH_SHALLOW_DEPTH = 3;        // 第一趟深度
const REF_SEARCH_SHALLOW_BUDGET_SEC = 3;   // 第一趟墙钟预算
const REF_SEARCH_DEEP_DEPTH = 8;           // 第二趟深度（仅在浅层未找满时）
const REF_SEARCH_DEEP_BUDGET_SEC = 5;      // 第二趟墙钟预算
const REF_SEARCH_TIMEOUT_MS = 15000;       // SSH 层超时（单趟预算 + 余量），避免占住池化会话
const REF_SEARCH_TTL_MS = 30000;           // 相同 query 的短缓存（连打键盘/重复打开搜索框时省一次遍历）
const remoteSearchCache = new Map();     // key -> { at, epoch, result }
const remoteSearchInflight = new Map();  // key -> Promise（并发合并同一 query）

/** 远端文件名搜索：浅层优先 + 按需深挖 + 剪噪声目录 + 无 sort（head 可提前短路）+ 部分结果降级。 */
async function remoteSearch(runner, profile, remoteRoot, query) {
  const pk = profileKey(profile);
  const key = pk + "|" + String(remoteRoot || "~") + "|" + String(query || "");
  const epoch = cacheEpoch(pk);
  const hit = remoteSearchCache.get(key);
  if (hit && hit.epoch === epoch && Date.now() - hit.at <= REF_SEARCH_TTL_MS) return hit.result;
  let inflight = remoteSearchInflight.get(key);
  if (!inflight) {
    inflight = (async () => {
      try {
        const q = String(query || "");
        const common = {
          relative: true,
          sorted: false,
          pruneNoise: true,
          maxResults: REF_SEARCH_MAX_MATCHES,
          timeoutMs: REF_SEARCH_TIMEOUT_MS
        };
        const first = await remoteGlob(runner, profile, "*" + q + "*", remoteRoot, Object.assign({}, common, {
          maxDepth: REF_SEARCH_SHALLOW_DEPTH,
          timeBudgetSec: REF_SEARCH_SHALLOW_BUDGET_SEC
        }));
        const files = (first && first.files) || [];
        let truncated = !!(first && first.truncated);
        let error = first && first.ok ? "" : (first && first.error) || "search failed";
        // 深挖策略（延迟关键）：**有结果就立刻返回**，深挖转后台预热缓存。
        // 此前条件是「浅层命中 < 200 就深挖」，而文件名片段极少能命中 200 个 → 几乎每次查询都要
        // 再等一趟最多 5s 的深挖（实测浅层 0.96s + 深挖 ≤5s ≈ 最多 6s，用户反馈「有点慢」）。
        // 现在：浅层一无所获时才同步等深挖（此时用户没别的可看）；否则后台跑，同一 query 的
        // 后续请求/重复打开搜索框会命中更全的缓存结果。
        const deepOpts = Object.assign({}, common, {
          maxDepth: REF_SEARCH_DEEP_DEPTH,
          timeBudgetSec: REF_SEARCH_DEEP_BUDGET_SEC
        });
        const warmDeepPass = () => {
          Promise.resolve()
            .then(() => remoteGlob(runner, profile, "*" + q + "*", remoteRoot, deepOpts))
            .then((deep) => {
              if (!deep || !deep.ok || !deep.files || deep.files.length === 0) return;
              if (cacheEpoch(pk) !== epoch) return; // 期间发生过写/exec：结果已过期，不写入
              const cur = remoteSearchCache.get(key);
              const merged = new Set((cur && cur.result && cur.result.files) || files);
              for (const f of deep.files) merged.add(f);
              remoteSearchCache.set(key, {
                at: Date.now(),
                epoch: epoch,
                result: {
                  ok: true,
                  pattern: "*" + q + "*",
                  path: remoteRoot,
                  files: Array.from(merged).slice(0, REF_SEARCH_MAX_MATCHES).sort(),
                  truncated: !!(deep.truncated || merged.size >= REF_SEARCH_MAX_MATCHES),
                  error: ""
                }
              });
            })
            .catch(() => {});
        };
        if (first && first.ok && files.length === 0) {
          // 浅层零命中：同步等深挖（用户此时没有可看的结果）
          const deep = await remoteGlob(runner, profile, "*" + q + "*", remoteRoot, deepOpts);
          const seen = new Set(files);
          for (const f of ((deep && deep.files) || [])) { if (!seen.has(f)) { seen.add(f); files.push(f); } }
          truncated = truncated || !!(deep && deep.truncated);
          if (deep && !deep.ok && files.length === 0) error = deep.error || error;
        } else if (first && first.ok && files.length > 0 && files.length < REF_SEARCH_MAX_MATCHES) {
          warmDeepPass(); // 后台预热：不增加本次响应延迟（浅层已满额时无需再深挖）
        }
        const result = {
          ok: files.length > 0 || !!(first && first.ok),
          pattern: "*" + q + "*",
          path: remoteRoot,
          files: files.slice(0, REF_SEARCH_MAX_MATCHES).sort(),
          truncated: truncated || files.length >= REF_SEARCH_MAX_MATCHES,
          error: files.length > 0 ? "" : error
        };
        if (result.ok) remoteSearchCache.set(key, { at: Date.now(), epoch, result: result });
        return result;
      } finally {
        remoteSearchInflight.delete(key);
      }
    })();
    remoteSearchInflight.set(key, inflight);
  }
  return await inflight;
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
  if (sshOut.exitCode === 0 && tarOut.exitCode === 0) return { ok: true, error: "", mirrorPath: mirrorPath };
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
  if (tarOut.exitCode === 0 && sshOut.exitCode === 0) {
    // 批量覆盖远端文件：清空该 profile 的读/列举缓存（findings §4.3a）
    clearCachesForProfile(p);
    return { ok: true, error: "", remotePath: remotePath };
  }
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
    truncated: !!r.truncated,
    isTimeout: !!r.isTimeout
  };
}

// ---------------------------------------------------------------------------
// HTTP 工具
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 浏览器信任判定（DNS-rebinding / 跨站防线，**不是**认证）
//
// 与 /api 网关、better-sidebar 的 fence 同源：Host 头为 loopback，或命中宿主
// ctx.webRuntime.trustedHosts（启动时采样的局域网 IP 字面量 + `--trusted-host`）。
// 实现逐条对照 @deepseek-ai/dsh-client-connection 的 api-request-trust.ts
// （better-sidebar 的 src/trust-fence.ts 是同一份拷贝，BSD-3-Clause —— 上游未导出这些
// helper，故按同样方式在此复刻），差异只有：本插件额外要求 x-requested-with（PR #4 的
// CSRF 加固），且把拒绝原因回传给调用方以便给出准确文案（issue #12：此前无论何种原因都
// 报 "missing x-requested-with header"，把排查方向带偏）。
// ---------------------------------------------------------------------------

/** Host 头 authority 的规范化 URL；不可解析时返回 undefined。 */
function parseAuthority(authority) {
  try {
    return new URL("http://" + String(authority));
  } catch (e) {
    return undefined;
  }
}

/** hostname 是否指向本机 loopback（localhost / [::1] / 127.x.x.x）。
 *  额外放行 0.0.0.0：它是本插件历史行为，且浏览器实际不会把它当目的地址发送。 */
function isLoopbackHostname(hostname) {
  if (hostname === "localhost" || hostname === "[::1]" || hostname === "0.0.0.0") return true;
  const parts = String(hostname).split(".");
  return parts.length === 4
    && parts[0] === "127"
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/** authority 的规范形式：写了端口则 hostname:port，否则仅 hostname。 */
function canonicalAuthority(entry, entryUrl) {
  const port = entryUrl.port !== "" ? entryUrl.port : new URL("https://" + String(entry)).port;
  return port === "" ? entryUrl.hostname : entryUrl.hostname + ":" + port;
}

/** 请求 authority 是否命中 trustedHosts（条目带端口则精确比对 host，否则只比 hostname）。 */
function isTrustedAuthority(hostUrl, trustedHosts) {
  return (trustedHosts || []).some((entry) => {
    const entryUrl = parseAuthority(entry);
    if (entryUrl === undefined) return false;
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host;
  });
}

/** 本插件额外要求的非简单头（PR #4 的 CSRF 加固）。 */
function hasRequestedWithHeader(req) {
  return String(req.headers["x-requested-with"] || "").trim() === "XMLHttpRequest";
}

/** 判定一次请求是否可信：返回 "ok" 或具体拒绝原因（供调用方给出准确文案）。 */
function trustVerdict(req, trustedHosts) {
  const host = req.headers["host"];
  if (!host) return "no-host";
  const hostUrl = parseAuthority(host);
  if (hostUrl === undefined) return "bad-host";
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return "bad-host";
  if (req.headers["sec-fetch-site"] === "cross-site") return "cross-site";
  // Origin 围栏：浏览器带 Origin 时必须与本请求 hostname 一致（比较 hostname 而非 host ——
  // 部分 Chromium（Edge 151）对非默认端口的 loopback 页面会把 Origin 序列化成不带端口）。
  // 无 Origin 视为通过（Host 围栏已限定 authority）；字面量 "null"（沙箱 iframe / file:）拒绝。
  const origin = req.headers["origin"];
  if (origin === undefined) return "ok";
  try {
    return new URL(origin).hostname === hostUrl.hostname ? "ok" : "bad-origin";
  } catch (e) {
    return "bad-origin";
  }
}

/** 拒绝原因 → 面向用户/模型的文案（issue #12：区分「缺头」与「Host 不可信」）。 */
function trustErrorMessage(reason) {
  switch (reason) {
    case "header": return "missing x-requested-with header";
    case "cross-site": return "cross-site request refused";
    case "bad-origin": return "origin does not match the request host";
    case "no-host": return "missing Host header";
    default:
      return "untrusted host: this deployment only serves loopback or hosts trusted by the DSH web runtime "
        + "(start DSH with --trusted-host <host[:port]>, or expose it through your remote-access setup)";
  }
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
      error: { type: "string" },
      truncated: { type: "boolean", required: true },
      isTimeout: { type: "boolean", required: true }
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
    "- `remote_ssh_kill`      — force-close pooled SSH sessions (hung-command recovery) / 强制关闭池化 SSH 会话（挂起命令恢复）",
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
// @ 文件引用补全的远端支持（issue #10）
//
// 「@」补全由宿主 ctx.fileReferences 服务提供（官方 provider：@deepseek-ai/dsh-file-reference-local），
// 它只遍历**本地磁盘**——远程工作区会话里，会话 cwd 是本地镜像目录，于是候选只有镜像里那几个文件
// （镜像通常只有本插件写入的 README.md 与 .remote-ssh.json）。这条链路不经过任何 HTTP 路由
// （客户端经 remote gateway 调 ctx.fileReferences.list），所以只能用服务层方案：
// 包装已注册的服务实例，远程工作区自己算候选，其余一律委托回原实现（本地索引/模糊排序零改动）。
//
// 查询语义与本地 provider 完全对齐（对照 dsh-file-reference-local 的 WorkspaceFileSearch）：
//   - 空查询或含 "/"：目录列举（隐藏文件仅在小片段以 . 开头时可见；排除目录剪枝）
//   - 纯片段：全量模糊搜索（子序列评分 + 目录加权 + 长度/字典序 tiebreak）
// 索引来源对远端做了取舍：git 仓库用 `git ls-files --cached --others --exclude-standard`
// （实测 0.1s / 尊重 .gitignore / 含未跟踪），非 git 退化为有界 find（maxdepth 5），
// 结果按 workspace 缓存并挂到既有 cacheEpoch 上，写/exec 后自动失效。
// ---------------------------------------------------------------------------

/** 与本地 provider 的 maxResults 默认值一致。 */
const REF_MAX_RESULTS = 20;
/** 索引条目上限（本地默认 5 万；远端按传输与内存预算收紧）。 */
const REF_MAX_ENTRIES = 20000;
/** 索引缓存 TTL：过期后仍先用旧索引作答，重建在后台进行（与本地 provider 的陈旧索引策略一致）。 */
const REF_INDEX_TTL_MS = 60000;
/** 单次查询等待索引的预算：超过就返回旧索引/空，绝不把光标卡在 SSH 上。 */
const REF_QUERY_BUDGET_MS = 900;
/** 后台建索引的预算。 */
const REF_INDEX_BUILD_TIMEOUT_MS = 20000;
/** 索引回退 find 的深度上限（原为 5，在巨型目录上 5 层遍历会跑不完——实测 >180s）。 */
const REF_INDEX_FIND_MAXDEPTH = 3;
/** 远端各步的墙钟预算（秒）：完整 git → 仅索引 git → find 回退，合计 14s < 上面的 20s 构建预算。 */
const REF_INDEX_GIT_FULL_BUDGET_SEC = 6;
const REF_INDEX_GIT_CACHED_BUDGET_SEC = 3;
const REF_INDEX_FIND_BUDGET_SEC = 5;
/** 排除目录：与 @deepseek-ai/dsh-file-reference-local 的 DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES 逐条一致。 */
const REF_EXCLUDED_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "out", "coverage", "target",
  ".next", ".nuxt", ".turbo", ".venv", "__pycache__", ".pytest_cache",
  ".mypy_cache", ".gradle"
]);

/** 侧栏文件名搜索要剪掉的噪声目录（上游 SEARCH_SKIP_DIRS 与本地索引排除表的并集）。
 *  在远端遍历前剪枝，避免把配额与时间花在依赖/构建产物上。
 *  **必须定义在 REF_EXCLUDED_DIRS 之后**：模块级 const 的展开会在模块求值期立即读取该绑定。 */
const REMOTE_SEARCH_SKIP_DIRS = new Set([
  ...REF_EXCLUDED_DIRS,
  ".pnpm-store", ".yarn", ".turbopack", ".output", ".cache", ".parcel-cache", ".umi", ".umi-production"
]);
const refIndexCache = new Map();  // key = profileKey|root -> { at, epoch, entries }
const refIndexBuilds = new Map(); // key -> Promise<entries>（同一 workspace 只建一次）
const refTruncationWarned = new Set(); // 已就索引截断告警过的 workspace（避免每次重建都刷日志）

/** 拆分 @ 查询：返回 { directory, fragment, isDirectoryQuery }（与本地 list() 的分支判据一致）。 */
function refSplitQuery(rawQuery) {
  const query = String(rawQuery == null ? "" : rawQuery).replace(/\\/g, "/");
  const slash = query.lastIndexOf("/");
  if (query === "" || slash >= 0) {
    return {
      directory: slash < 0 ? "" : query.slice(0, slash + 1),
      fragment: slash < 0 ? "" : query.slice(slash + 1),
      isDirectoryQuery: true
    };
  }
  return { directory: "", fragment: query, isDirectoryQuery: false };
}

/** 子序列评分（对照本地 subsequenceScore：按命中字符的间隔惩罚）。 */
function refSubsequenceScore(target, query) {
  let targetIndex = 0;
  let gap = 0;
  for (const character of query) {
    const found = target.indexOf(character, targetIndex);
    if (found < 0) return undefined;
    gap += found - targetIndex;
    targetIndex = found + 1;
  }
  return Math.max(0, 100 - gap);
}

/** 候选评分（逐字对照本地 scoreCandidate 的常量：1000/900/700/500/300 + 目录 25）。 */
function refScoreCandidate(candidate, query) {
  if (query === "") return 0;
  const path = String(candidate.path).toLowerCase();
  const name = path.slice(path.lastIndexOf("/") + 1);
  const needle = String(query).toLowerCase();
  const directoryBonus = candidate.kind === "directory" ? 25 : 0;
  if (name === needle) return 1000 + directoryBonus;
  if (name.startsWith(needle)) return 900 + directoryBonus;
  if (name.includes(needle)) return 700 + directoryBonus;
  if (path.includes(needle)) return 500 + directoryBonus;
  const subsequence = refSubsequenceScore(path, needle);
  return subsequence === undefined ? undefined : 300 + subsequence + directoryBonus;
}

/** 排序（逐字对照本地 rankCandidates：评分降序 → 目录优先 → 路径短优先 → 字典序）。 */
function refRankCandidates(candidates, query, limit) {
  const ranked = [];
  for (const candidate of candidates) {
    const score = refScoreCandidate(candidate, query);
    if (score !== undefined) ranked.push({ candidate, score });
  }
  const kindRank = (kind) => (kind === "directory" ? 0 : 1);
  const compareText = (l, r) => (l < r ? -1 : l > r ? 1 : 0);
  ranked.sort((left, right) =>
    right.score - left.score ||
    kindRank(left.candidate.kind) - kindRank(right.candidate.kind) ||
    (query === "" ? 0 : left.candidate.path.length - right.candidate.path.length) ||
    compareText(left.candidate.path, right.candidate.path));
  return ranked.slice(0, limit).map((entry) => entry.candidate);
}

/** 隐藏文件可见性（对照本地 visibleForGlobalQuery）。 */
function refVisibleForGlobalQuery(path, query) {
  if (query.startsWith(".") || query.includes("/.")) return true;
  return !String(path).split("/").some((segment) => segment.startsWith("."));
}

/** 解析索引输出（`<type>\t<path>` 逐行；git 分支只有 f，目录由父路径合成）。 */
function refParseIndexOutput(text) {
  const files = new Set();
  const dirs = new Set();
  const excludedSegment = (p) => p.split("/").some((seg) => REF_EXCLUDED_DIRS.has(seg));
  for (const line of String(text || "").split("\n")) {
    if (!line) continue;
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const type = line.slice(0, tab);
    const path = line.slice(tab + 1).replace(/\r$/, "");
    if (!path || excludedSegment(path)) continue;
    if (type === "d") dirs.add(path);
    else if (type === "f") files.add(path);
    // 其它类型（符号链接等）跳过：与本地 provider 只收 isFile/isDirectory 一致
  }
  for (const path of Array.from(files)) {
    let i = path.indexOf("/");
    while (i > 0) {
      const dir = path.slice(0, i);
      if (excludedSegment(dir)) break;
      dirs.add(dir);
      i = path.indexOf("/", i + 1);
    }
  }
  const out = [];
  for (const d of Array.from(dirs).sort()) out.push({ path: d, kind: "directory" });
  for (const f of Array.from(files).sort()) out.push({ path: f, kind: "file" });
  return out.length > REF_MAX_ENTRIES ? out.slice(0, REF_MAX_ENTRIES) : out;
}

/** 由 REF_EXCLUDED_DIRS 生成远端 grep 的排除正则（单一事实来源）。
 *  只匹配「完整路径段」（`(^|/)node_modules(/|$)`），因此 `distribution/` 这类前缀相同、
 *  但并非排除目录的路径不会被误伤。 */
function refExcludeRegex() {
  const alts = Array.from(REF_EXCLUDED_DIRS)
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  return "(^|/)(" + alts + ")(/|$)";
}

/** 远端建索引命令：git 仓库优先（尊重 .gitignore），跑不完/为空时回退到有界 find。
 *
 *  ① 排除必须发生在 `head` **之前**（issue #10 实测反馈）：`git ls-files --cached --others`
 *  的输出**不是全局字典序**——未跟踪文件按 readdir 顺序先输出，`node_modules/` 这类目录
 *  可能占满前两万行，把 `head` 的配额吃光，导致 `AGENTS.md`、`src/**` 等真实文件被整段切掉
 *  （实测仓库：node_modules 18,880 条 = 84.5%，`AGENTS.md` 落在第 20417 行）。
 *  ② 每一步都要有**墙钟预算**（用户实测反馈：某个远程项目里 `@文件名` 完全没有候选，
 *  而 `@` 单独输入正常 —— 因为模糊查询走索引、目录列举不走）：`git ls-files --others`
 *  需要遍历整棵工作树枚举未跟踪文件，在巨型目录上**根本跑不完**（实测 10s 被超时杀掉、
 *  零输出），于是索引为空。现在：完整 git（6s）→ 仅索引 git（3s，恒定快）→ 有界 find
 *  （`maxdepth 3` + 5s，实测该目录 921 条 / 0.65s），三级合计 ≤14s < 20s 构建预算。
 *  客户端的 excludedSegment 仍保留作双保险（见 refParseIndexOutput）。 */
function refIndexCommand(root) {
  const target = shellQuotePath(root || "~");
  const prune = Array.from(REF_EXCLUDED_DIRS).map((n) => "-name " + shellQuote(n)).join(" -o ");
  const cap = REF_MAX_ENTRIES + 1;
  const gitPipe = "| grep -vE '" + refExcludeRegex() + "' | head -n " + cap;
  const findFallback = "find . -mindepth 1 -maxdepth " + REF_INDEX_FIND_MAXDEPTH
    + " \\( " + prune + " \\) -prune -o -printf '%y\\t%P\\n' 2>/dev/null | head -n " + cap;
  return [
    "cd " + target + " 2>/dev/null || exit 3",
    "T=$(command -v timeout || command -v gtimeout || true)",
    "G=",
    "if [ -d .git ] && command -v git >/dev/null 2>&1; then",
    "  if [ -n \"$T\" ]; then G=$(\"$T\" " + REF_INDEX_GIT_FULL_BUDGET_SEC + " git ls-files --cached --others --exclude-standard 2>/dev/null " + gitPipe + "); else G=$(git ls-files --cached --others --exclude-standard 2>/dev/null " + gitPipe + "); fi",
    "  if [ -z \"$G\" ]; then",
    "    if [ -n \"$T\" ]; then G=$(\"$T\" " + REF_INDEX_GIT_CACHED_BUDGET_SEC + " git ls-files --cached 2>/dev/null " + gitPipe + "); else G=$(git ls-files --cached 2>/dev/null " + gitPipe + "); fi",
    "  fi",
    "fi",
    "if [ -n \"$G\" ]; then printf '%s\\n' \"$G\" | sed 's/^/f\t/'; else",
    "  if [ -n \"$T\" ]; then \"$T\" " + REF_INDEX_FIND_BUDGET_SEC + " " + findFallback + "; else " + findFallback + "; fi",
    "fi"
  ].join("\n");
}

// ---------------------------------------------------------------------------
// fs.search 的返回契约（issue #13）
//
// better-sidebar 客户端契约（v0.13.0 起至今未变，其 client-registry 注释原文：
// "matches are cwd-relative '/'-separated paths"）：
//     fs.search → { matches: string[], truncated: boolean }
// 而本插件此前的两条分支只返回 { entries: [{path,isDir}], truncated } —— 客户端在渲染阶段
// 读 results.matches.length / results.matches.map(...)，undefined 直接抛 TypeError，
// 被 RenderBoundary 兜住 → 整个「文件」页签变成错误条（本地会话也复现，因为拦截是无条件的）。
// 现在统一经 fsSearchResult() 产出：matches 必须存在且为 cwd 相对、'/' 分隔的字符串数组；
// entries（绝对路径 + isDir）保留作向前兼容。
// ---------------------------------------------------------------------------

/** 把绝对路径裁成相对 base 的 POSIX 路径；不在 base 之下时回退为归一化后的绝对路径。 */
function toPosixRelative(base, target) {
  const t = String(target == null ? "" : target).replace(/\\/g, "/");
  const b = String(base == null ? "" : base).replace(/\\/g, "/").replace(/\/+$/, "");
  if (!b) return t;
  // Windows 盘符路径大小写不敏感；POSIX 保持大小写敏感
  const fold = /^[a-z]:\//i.test(b);
  const tt = fold ? t.toLowerCase() : t;
  const bb = fold ? b.toLowerCase() : b;
  if (tt === bb) return "";
  if (tt.startsWith(bb + "/")) return t.slice(b.length + 1);
  return t;
}

/** 组装 fs.search 的响应：matches 永远存在且为字符串数组（客户端会直接 .length / .map）。 */
function fsSearchResult(matches, entries, truncated) {
  return {
    matches: Array.isArray(matches) ? matches.filter((m) => typeof m === "string" && m !== "") : [],
    entries: Array.isArray(entries) ? entries : [],
    truncated: !!truncated
  };
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

function apply(ctx, config) {
  const subprocess = ctx.subprocess;
  const workspaceRegistry = ctx.workspaceRegistry;
  const terminals = new Map();
  let nextTerminalId = 1;

  // ---- 宿主信任源（issue #12）----
  // ctx.webRuntime.trustedHosts 是 DSH 官方运行时能力：启动时采样的局域网 IP 字面量
  // 加 `--trusted-host` 指定的 authority，`/api` 网关的 fence 正以它为准。
  // 按请求实时读取（服务值可被替换，无需重启插件）；服务缺失时保持 loopback-only，
  // 行为与 2.4.9 完全一致 —— 因此用软注入（ctx.inject）而非硬 inject：万一将来宿主
  // 改名/移除该服务，插件仍能挂载，只是远程访问退回本机可用。
  let webRuntimeFace = null;
  ctx.inject(["webRuntime"], (sctx) => {
    try { webRuntimeFace = (sctx && sctx.webRuntime) || (sctx && typeof sctx.get === "function" ? sctx.get("webRuntime") : null) || null; } catch (e) { webRuntimeFace = null; }
  });
  function trustedHostsNow() {
    try {
      const list = webRuntimeFace && webRuntimeFace.trustedHosts;
      return Array.isArray(list) ? list : [];
    } catch (e) {
      return [];
    }
  }

  /** 一次请求的信任判定：返回 "ok" 或拒绝原因（"header" / "bad-host" / …）。 */
  function requestTrust(req, requireRequestedWith) {
    const verdict = trustVerdict(req, trustedHostsNow());
    if (verdict !== "ok") return verdict;
    if (requireRequestedWith && !hasRequestedWithHeader(req)) return "header";
    return "ok";
  }

  /** 统一的 403 输出（带准确原因，避免把 Host 不可信误报成缺头）。 */
  function denyRequest(res, reason) {
    writeJson(res, 403, { ok: false, error: { code: reason === "header" ? "csrf" : "forbidden", message: trustErrorMessage(reason) } });
  }

  // ---- 持久 SSH 会话池（连接复用，避免每次操作都做完整 SSH 握手）----
  const sessions = new Map(); // profileKey -> CommandSession
  const SESSION_IDLE_MS = 10 * 60 * 1000;
  // profileKey 已上移模块层（读缓存/列举缓存与失效逻辑共用同一身份键，定义见 remoteReadFile 上方）。
  function getSession(p) {
    const key = profileKey(p);
    let s = sessions.get(key);
    if (!s) { s = new CommandSession(subprocess, p); sessions.set(key, s); }
    return s;
  }
  /** 把 SSH 常见失败翻译成带修复建议的中文提示。 */
  function sshErrorHint(text) {
    const t = stripPqBanner(String(text || ""));
    if (/remote port forwarding failed for listen port (\d+)/i.test(t)) {
      const m = t.match(/remote port forwarding failed for listen port (\d+)/i);
      return "SSH 端口转发失败（本地端口 " + m[1] + " 已被占用）。这通常由 ~/.ssh/config 里的 RemoteForward 造成：远端该端口被上次会话占用时，ExitOnForwardFailure yes 会让 ssh 直接退出。本插件已对该连接加 ClearAllForwardings，若仍出现请检查 ssh config。原始信息: " + t.trim().slice(0, 300);
    }
    if (/permission denied \(publickey/i.test(t)) return "公钥认证失败（服务器拒绝了公钥）。请依次检查：① keyPath 指向的私钥是否正确、是否带口令——测试连接以批处理模式运行无法交互输口令，可先 ssh-add 加载或改用无口令密钥；② 远端是否收录对应公钥——Windows 主机且目标用户在 Administrators 组时需写入 C:\\ProgramData\\ssh\\administrators_authorized_keys；③ profile 的用户名写法与手动连接是否一致（user / .\\user / user@domain 在 Windows sshd 中解析不同）。原始信息: " + t.trim().slice(0, 300);
    if (/connection refused/i.test(t)) return "连接被拒绝：请确认远端 sshd 已启动且端口正确。原始信息: " + t.trim().slice(0, 300);
    if (/connection timed out|timed out/i.test(t)) return "连接超时：请确认网络可达、端口开放，或检查 ProxyJump 配置。原始信息: " + t.trim().slice(0, 300);
    if (/could not resolve hostname/i.test(t)) return "无法解析主机名：请检查连接配置中的 host 拼写。原始信息: " + t.trim().slice(0, 300);
    return t.trim().slice(0, 500);
  }

  /** 池化执行：复用持久会话；连接层失败（exit 255）或会话异常时清理会话并经一次性连接重试。
   *  split=true 时 stderr 与 stdout 分离返回（命令走双哨兵协议）。
   *  timeoutMs 为命令级超时（issue #5）：超时即丢弃整个池化会话——挂起的远端命令
   *  仍占着共享 bash 进程，队列后续命令都会被它卡住，唯一可靠恢复是终止 SSH 重建。 */
  async function runPooled(p, cmd, stdinData, maxBytes, split, timeoutMs) {
    const tms = resolveTimeoutMs(timeoutMs);
    const dropSession = () => {
      const key = profileKey(p);
      const old = sessions.get(key);
      if (old) { old.close(); sessions.delete(key); }
    };
    try {
      const s = getSession(p);
      const r = await withTimeout(s.exec(cmd, stdinData, split), tms, "池化命令", function () {
        dropSession();
      });
      const stderr = split ? String(r.stderr || "") : "";
      if (r.exitCode === 0) return { ok: true, exitCode: 0, stdout: r.stdout, stderr: stderr, error: "", truncated: false };
      // exit 255 = ssh 连接层失败（非远程命令失败）：会话作废，下次调用重建。
      if (r.exitCode === 255) dropSession();
      const errSource = String(stderr || r.stdout || "");
      const error = r.exitCode === 255
        ? sshErrorHint(errSource)
        : (errSource.trim().slice(0, 500) || ("ssh 退出码 " + r.exitCode));
      return { ok: false, exitCode: r.exitCode, stdout: r.stdout, stderr: stderr, error: error, truncated: false };
    } catch (e) {
      dropSession();
      // 超时不走一次性连接回退：重试一条挂起的命令只会再次挂起（issue #5）。
      if (e && e.isTimeout) {
        return { ok: false, exitCode: -1, stdout: "", stderr: "", truncated: false, isTimeout: true, error: e.message };
      }
      // 会话挂了 —— 清理并回退到一次性连接（相当于自动重连一次）
      const r2 = await runRemote(subprocess, p, cmd, stdinData, maxBytes, undefined, tms);
      if (!r2.ok && r2.exitCode === 255) r2.error = sshErrorHint(r2.stdout || r2.stderr || r2.error);
      return r2;
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
    // settings 命名空间直接传插件 id（匹配 /^[a-z][a-z0-9-]*$/）。不再依赖
    // @deepseek-ai/dsh-settings 的 legacy `settingsNamespace` 构造器（该导出仅为
    // alpha.2 之前的插件保留，未来可能移除）；恒等语义下两种写法存储键完全一致。
    const scope = sctx.settings.register(NS, PrefsSchema);
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

  /** 清理远程工作区的原生注册与本地镜像目录（删除工作区或级联删除 profile 时调用）。 */
  async function cleanupWorkspace(ws) {
    if (!ws || !ws.mirrorPath) return;
    if (workspaceRegistry) {
      try {
        const entity = await workspaceRegistry.resolveByPath(ws.mirrorPath);
        if (entity) await workspaceRegistry.delete(entity.id);
      } catch (e) {}
    }
    try { await rm(ws.mirrorPath, { recursive: true, force: true }); } catch (e) {}
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
      const orphaned = settingsFace.read().workspaces.filter((w) => w.profileId === id);
      const workspaces = settingsFace.read().workspaces.filter((w) => w.profileId !== id);
      await settingsFace.updateProfiles(profiles);
      await settingsFace.updateWorkspaces(workspaces);
      // 级联清理：相关远程工作区的原生注册与本地镜像目录一并删除，不留孤儿。
      for (const ws of orphaned) await cleanupWorkspace(ws);
      return { ok: true, profiles: profiles, workspaces: workspaces };
    },
    testConnection: async (args) => {
      const p = getProfile(args && args.id);
      if (!p) return { ok: false, error: "未找到连接配置" };
      // 认证探测只用跨平台 echo：Windows host 无 uname/pwd，且默认 shell 语义各异
      // （旧命令尾部 uname -a 会让认证成功的 Windows host 也误报失败）。
      const r = await runRemote(subprocess, p, "echo __DSH_OK__", undefined, 16 * 1024);
      if (r.ok) return r;
      const baseErr = sshErrorHint([r.error, stripPqBanner(r.stderr).trim()].filter(Boolean).join(" ") || ("ssh 退出码 " + r.exitCode));
      // 认证类失败：带 ssh -v 重跑一次握手 + 认证，抽取关键诊断行
      // （私钥加载 / 公钥提供 / 服务器拒绝方法），定位 Windows 常见坑。
      let error = baseErr;
      if (/permission denied|publickey/i.test(baseErr + " " + stripPqBanner(r.stderr))) {
        const diag = await runRemote(subprocess, p, "exit 0", undefined, 16 * 1024, ["-v"]);
        const diagText = String(diag.stderr || "")
          .split("\n")
          .filter(function (l) {
            return /debug1: (Offering public key|Authentications that can continue|Server accepts key|Trying private key|no such identity)|Load key|Permission denied|passphrase/i.test(l);
          })
          .join("\n")
          .slice(0, 1200);
        if (diagText) error = baseErr + "\n\nssh -v 诊断:\n" + diagText;
      }
      return { ok: false, exitCode: r.exitCode, signal: r.signal, stdout: r.stdout, stderr: r.stderr, truncated: r.truncated, error: error };
    },
    listWorkspaces: async () => ({ ok: true, workspaces: settingsFace.read().workspaces }),
    createRemoteWorkspace: async (args) => {
      const a = args || {};
      const p = getProfile(a.profileId);
      if (!p) return { ok: false, error: "未找到连接配置" };
      if (!a.remotePath) return { ok: false, error: "remotePath 为必填项" };
      const wsId = "w" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      // 默认标题取远程路径最后一段目录名（如 ~/proj/DSH_Test → DSH_Test）；
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
          const wsTitle = title; // 图标语义由客户端「地球角标文件夹」图标承担，标题不再带 🌐 前缀
          const native = await workspaceRegistry.create(mirrorDir, wsTitle);
          workspaceId = native.id;
          // workspaceRegistry.create 仅首次创建时应用 title；已存在的旧工作区
          // （早期版本未传 title，标题卡在镜像目录名，如 wmirror1）会被直接
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
      await cleanupWorkspace(ws);
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
      // 走持久会话池（stderr 分离）：首调用建立连接后，后续调用毫秒级返回。
      // 远程命令可能改任意文件（插件不可见）→ 成功后整代失效读/列举缓存（findings §4.3a）；
      // 失败的命令通常无副作用，不 bump 以免无谓打断缓存（部分副作用由 ≤5s TTL 兜底）。
      const r = await runPooled(p, args.command, args.stdin, undefined, true);
      if (r.ok) bumpCacheEpoch(p);
      return r;
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
      const r = await runPooled(p, "mkdir -p " + shellQuotePath(args.path), undefined, undefined);
      invalidateRemoteCaches(p, args.path, { subtree: false }); // 父目录列举变化
      return r;
    },
    /** 本地（宿主机器）新建目录：供「添加工作区」目录选择器的**本地** tab 创建目录用（issue #11）。
     *  远程侧走上面的 mkdir；本地侧此前没有任何入口，用户只能离开 DSH 去系统文件管理器建。 */
    mkdirLocal: async (args) => {
      const p = String((args && args.path) || "").trim();
      if (!p) return { ok: false, error: "path 为必填项" };
      try {
        await mkdir(p, { recursive: true });
        return { ok: true, path: p };
      } catch (e) {
        return { ok: false, error: "创建目录失败: " + String(e && e.message ? e.message : e) };
      }
    },
    deleteFile: async (args) => {
      const p = resolveProfile(args);
      if (!p) return { ok: false, error: "需要 profileId 或 host+user" };
      if (!args || !args.path) return { ok: false, error: "path 为必填项" };
      const r = await runPooled(p, "rm -rf " + shellQuotePath(args.path), undefined, undefined);
      invalidateRemoteCaches(p, args.path, { subtree: true });
      return r;
    },
    move: async (args) => {
      const p = resolveProfile(args);
      if (!p) return { ok: false, error: "需要 profileId 或 host+user" };
      if (!args || !args.src || !args.dst) return { ok: false, error: "src 和 dst 为必填项" };
      const r = await runPooled(p, "mv " + shellQuotePath(args.src) + " " + shellQuotePath(args.dst), undefined, undefined);
      invalidateRemoteCaches(p, args.src, { subtree: true });
      invalidateRemoteCaches(p, args.dst, { subtree: true });
      return r;
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
      // CSRF 加固：/remote-ssh/api/* 仅由本插件客户端调用，强制校验其必带的
      // x-requested-with 头（跨站攻击者无法在 no-cors POST 中携带非简单头）。
      // 信任判定走宿主 webRuntime.trustedHosts（issue #12），失败时回传具体原因。
      const apiTrust = requestTrust(req, true);
      if (apiTrust !== "ok") { denyRequest(res, apiTrust); return; }
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
    name: "remote_ssh_kill",
    description: "强制关闭 Remote-SSH 插件的池化 SSH 会话（issue #5 的兜底恢复手段）。当某条远端命令挂起、或想强制断开并重新建立连接时使用：关闭某个连接配置的持久会话，或关闭全部会话。仅影响插件内部的命令会话与连接缓存，不影响交互式终端与已保存的连接配置；下次调用工具时会自动重建会话。Force-close pooled SSH sessions of the Remote-SSH plugin (recovery hatch for hung commands).",
    parameters: Object.assign({}, CONN_PARAMS, {
      all: { type: "boolean", description: "关闭全部 profile 的池化会话（此时忽略 profileId/host 等连接参数）。" }
    }),
    output: {
      schema: {
        type: "object", additionalProperties: false, properties: {
          ok: { type: "boolean", required: true },
          killed: { type: "number", required: true },
          active: { type: "number", required: true },
          message: { type: "string", required: true }
        }
      },
      render: textRender(function (a, v) { return v.message || (v.ok ? "ok" : "failed"); })
    },
    execute: async function (args, exec) {
      if (args && args.all) {
        const n = sessions.size;
        sessions.forEach(function (s) { try { s.close(); } catch (e) {} });
        sessions.clear();
        return { ok: true, killed: n, active: 0, message: "已关闭全部 " + n + " 个池化会话（下次调用工具时按需重建）。" };
      }
      const tc = toolContext(args, exec);
      if (!tc.profile) {
        return { ok: false, killed: 0, active: sessions.size, message: "需要 profileId 或 host+user（当前会话非远程工作区时必填），或传 all: true 关闭全部会话。" };
      }
      const key = profileKey(tc.profile);
      const s = sessions.get(key);
      if (s) { s.close(); sessions.delete(key); }
      return {
        ok: true,
        killed: s ? 1 : 0,
        active: sessions.size,
        message: s ? "已关闭该连接的池化会话（" + key + "）。" : "该连接当前没有活动会话。"
      };
    }
  });

  register({
    name: "remote_ssh_exec",
    description: "通过 SSH 在远程主机（超算/服务器）上执行一条命令。用 profileId 引用已保存配置，或直接给 host/user。在当前远程工作区会话中可不填连接参数，自动用该工作区的连接并在其远程目录下执行。返回 stdout/stderr/exitCode。命令默认 120 秒超时（环境变量 DSH_REMOTE_SSH_CMD_TIMEOUT_MS 可覆盖），超时后相关池化会话被自动丢弃重建，不影响后续命令；长时间任务（构建/训练）用 timeoutMs 显式放宽或置 0 禁用。Run a command on a remote host (HPC/server) over SSH; returns stdout/stderr/exitCode.",
    parameters: Object.assign({}, CONN_PARAMS, {
      command: { type: "string", required: true, description: "要执行的远程命令。" },
      stdin: { type: "string", description: "可选，写入远程命令的标准输入。" },
      timeoutMs: { type: "number", description: "命令执行超时（毫秒），默认 120000；0 表示禁用超时（长时任务显式放宽）。超时后该连接的池化会话会被丢弃并自动重建。" }
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
      // 走持久会话池（stderr 分离，双哨兵协议）：首次调用完成建连后，
      // 后续调用不再重复 TCP 握手 + 认证，单次耗时从秒级降到毫秒级；
      // 会话异常时 runPooled 自动重建并降级一次性连接。命令级超时（issue #5）：
      // 挂起的命令到点被丢弃（连带重置该池化会话），不会无限阻塞队列。
      // 远程命令可能改任意文件（插件不可见）→ 整代失效读/列举缓存（findings §4.3a）。
      const r = await runPooled(tc.profile, cmd, args.stdin, undefined, true, args.timeoutMs);
      bumpCacheEpoch(tc.profile);
      return normExec(r);
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
          error: { type: "string" }
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
          error: { type: "string" }
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
  // sync / push 共用的输出 schema（issue #14）：`error` **不能**标成必填 —— 成功路径本来就没有
  // error，标必填会让「推送成功」被判成 `returned invalid output`（模型看到失败、副作用却已落地，
  // 只能靠再跑一次 ls 才能确认）。同理成功路径会带上 remotePath / mirrorPath，必须在 schema 里声明
  // （additionalProperties: false 会拒掉未声明字段）。
  const syncOutput = {
    schema: { type: "object", additionalProperties: false, properties: {
      ok: { type: "boolean", required: true },
      remotePath: { type: "string" },
      mirrorPath: { type: "string" },
      error: { type: "string" }
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
          error: { type: "string" }
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
          error: { type: "string" }
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
      const rp = resolveRemotePath(args.path, tc.remotePath);
      const r = await runPooled(tc.profile, "mkdir -p " + shellQuotePath(rp), undefined, undefined);
      invalidateRemoteCaches(tc.profile, rp, { subtree: false }); // 父目录列举变化
      return normExec(r);
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
      const rp = resolveRemotePath(args.path, tc.remotePath);
      const r = await runPooled(tc.profile, "rm -rf " + shellQuotePath(rp), undefined, undefined);
      invalidateRemoteCaches(tc.profile, rp, { subtree: true });
      return normExec(r);
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
      const src = resolveRemotePath(args.src, tc.remotePath);
      const dst = resolveRemotePath(args.dst, tc.remotePath);
      const r = await runPooled(tc.profile, "mv " + shellQuotePath(src) + " " + shellQuotePath(dst), undefined, undefined);
      invalidateRemoteCaches(tc.profile, src, { subtree: true });
      invalidateRemoteCaches(tc.profile, dst, { subtree: true }); // dst 子树：mv file dir/ 会落入既有目录
      return normExec(r);
    }
  });

  // ---- 创建 shell wrapper（供 better-sidebar 的 shell 配置指向它，实现远程终端透明接入）----
  // wrapper 逻辑：读取当前工作目录下的 .remote-ssh.json，若存在且含 keyPath → exec ssh -tt
  // （并把终端 cd 到该工作区的 remotePath，与 VSCode Remote-SSH 行为一致）；
  // 否则降级到平台默认 shell（bash -l / powershell）——远程工作区但非密钥认证时打一行提示。
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
    "      // Windows 下优先解析系统自带 OpenSSH 绝对路径（避免 git-bash 启动时解析到 MSYS2 ssh）",
    "      const sysSsh = path.join(process.env.SystemRoot || 'C:\\\\Windows', 'System32', 'OpenSSH', 'ssh.exe');",
    "      const sshBin = fs.existsSync(sysSsh) ? sysSsh : 'ssh';",
    "      // ExitOnForwardFailure=no：ssh config 里的 RemoteForward 端口被占时终端仍能打开",
    "      const args = ['-tt', '-o', 'StrictHostKeyChecking=no', '-o', 'ExitOnForwardFailure=no', '-p', String(port), '-i', j.keyPath, j.user + '@' + j.host];",
    "      if (j.proxyJump) { args.splice(2, 0, '-J', j.proxyJump); }",
    "      // 终端落在工作区对应的远程目录（issue #7：此前不带远程命令，落点是远程 $HOME）。",
    "      // remotePath 的 ~ 必须交给【远端】shell 展开——本地 homedir 与远程不同，本地展开必错；",
    "      // cd 失败（目录被删/改名）回退 $HOME，保证终端仍能打开；",
    "      // exec 让远端只留一个交互式登录 shell，退出码语义与之前一致。",
    "      const remotePath = typeof j.remotePath === 'string' ? j.remotePath.trim() : '';",
    "      if (remotePath !== '') {",
    "        const expanded = remotePath === '~' ? '$HOME' : (remotePath.indexOf('~/') === 0 ? '$HOME/' + remotePath.slice(2) : remotePath);",
    "        args.push('cd \"' + expanded + '\" 2>/dev/null || cd \"$HOME\"; exec \"${SHELL:-/bin/bash}\" -l');",
    "      }",
    "      const ssh = spawn(sshBin, args, { stdio: 'inherit' });",
    "      ssh.on('exit', function(c) { process.exit(c == null ? 0 : c); });",
    "      return;",
    "    }",
    "    // 远程工作区但该连接不是密钥认证（如密码认证，keyPath 为空）：集成终端仅支持",
    "    // 密钥认证，这里显式提示一行，避免用户把本地 shell 误认为已连上远程。",
    "    process.stderr.write('[dsh-remote-ssh] 检测到远程工作区，但该连接不是密钥认证：集成终端仅支持密钥认证，已回退为本地 shell。\\n');",
    "    process.stderr.write('[dsh-remote-ssh] remote workspace detected, but this profile is not key-authenticated; the integrated terminal only supports key auth and fell back to a local shell.\\n');",
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

  // ---- 启动自愈：把既有远程工作区的原生标题统一为「远程路径最后一段」----
  // 早期版本 create 工作区时未传 title，DSH 用镜像目录 basename（wsId，如 wmirror1）
  // 作标题；workspaceRegistry.create 只对新建记录应用 title，旧记录会被原样返回。
  // 2.3.2 起标题不再带 🌐 前缀（图标由客户端地球角标文件夹 SVG 承担），自愈同时剥掉
  // 旧版遗留的 🌐 前缀。仅在标题等于已知旧形态时修复，不覆盖用户自定义标题。
  function healWorkspaceTitles() {
    const reg = workspaceRegistry;
    if (!reg || typeof reg.resolveByPath !== "function") return;
    const wsList = settingsFace.read().workspaces;
    for (const w of wsList) {
      if (!w || !w.mirrorPath || !w.remotePath) continue;
      const lastSeg = String(w.remotePath).replace(/\/+$/, "").split("/").pop();
      if (!lastSeg || lastSeg === "~" || lastSeg === ".") continue;
      const desired = lastSeg;
      const base = String(w.mirrorPath).split(/[\\/]/).filter(Boolean).pop();
      const legacy = new Set([base, "🌐 " + base, desired, "🌐 " + desired, "🌐 " + w.title]);
      (async () => {
        try {
          const ent = await reg.resolveByPath(w.mirrorPath);
          // 只在标题仍是已知旧形态（镜像目录名旧 bug / 🌐 前缀旧版）时修复，尊重自定义标题。
          if (ent && typeof ent.setTitle === "function" && legacy.has(ent.title)) {
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
      // 不在镜像目录下：剥掉可能的前导斜杠与盘符，按相对路径处理（此前会静默拼出错误路径）。
      rel = rel.replace(/^[A-Za-z]:/, "").replace(/^\/+/, "");
      try { ctx.logger?.debug("[dsh-remote-ssh] localToRemote: path outside mirror, treated as relative: " + localPath); } catch (e) {}
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

  // 本地 rename（对齐 better-sidebar 0.19 的 fs.rename 契约：单段名、不覆盖、返回新绝对路径）
  async function localRenameEntry(path, name) {
    if (!path) return { ok: false, error: "path 为必填项" };
    if (!name || name === "." || name === ".." || /[\\/]/.test(name)) {
      return { ok: false, error: "name 必须是单个路径段" };
    }
    if (basename(path) === name) return { ok: true, path: path };
    const dest = join(dirname(path), name);
    if (existsSync(dest)) return { ok: false, error: "\"" + name + "\" 已存在" };
    await rename(path, dest);
    return { ok: true, path: dest };
  }

  // 本地 remove（文件 unlink / 目录递归；lstat 判定，符号链接只删链接本身）
  async function localRemoveEntry(path) {
    if (!path) return { ok: false, error: "path 为必填项" };
    const st = await lstat(path);
    if (st.isDirectory()) await rm(path, { recursive: true, force: true });
    else await rm(path, { force: true });
    return { ok: true, path: path };
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
    const fsTrust = requestTrust(req, false);
    if (fsTrust !== "ok") { denyRequest(res, fsTrust); return; }
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
      try { ctx.logger?.debug("[dsh-remote-ssh] intercept " + method + ": sessionId=" + sessionId + " cwd=" + sessionCwd + " path=" + (payload && payload.path) + " remote=" + (remoteInfo ? "YES" : "NO")); } catch (e) {}
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
          // remoteSearch：相对路径（%P）+ 剪噪声目录 + 无 sort（head 提前短路）+ 8s 远端预算
          // + 15s SSH 超时 + 同 query 合并/短缓存（issue #13：大工作区此前会一直「加载中…」）。
          const rp = remoteInfo.remotePath;
          const r = await remoteSearch(runPooled, profile, rp, payload.query || "");
          const matches = (r.files || []).map(function (f) {
            return String(f).replace(/\\/g, "/").replace(/^\.\//, "");
          }).filter(function (f) { return f !== ""; });
          result = fsSearchResult(matches, matches.map(function (rel) {
            return { path: join(remoteBase, rel), isDir: false };
          }), r.truncated);
        } else if (method === "fs.rename") {
          // better-sidebar 0.19 新增端点：重命名必须落在远端，绝不能让本地镜像目录被改。
          const localPath = payload.path || "";
          const name = String(payload.name || "");
          if (!localPath) { writeJson(res, 400, { ok: false, error: { code: "bad-request", message: "path is required" } }); return; }
          if (!name || name === "." || name === ".." || /[\\/]/.test(name)) {
            writeJson(res, 400, { ok: false, error: { code: "bad-request", message: "name must be a single path segment" } }); return;
          }
          const srcRemote = localToRemote(localPath, remoteBase, remoteInfo.remotePath);
          if (srcRemote === remoteInfo.remotePath) {
            writeJson(res, 400, { ok: false, error: { code: "fs-error", message: "cannot rename the workspace root" } }); return;
          }
          const dstRemote = posixDirname(srcRemote) + "/" + name;
          const exists = await runPooled(profile, "test -e " + shellQuotePath(dstRemote), undefined, 4096);
          if (exists.ok) {
            writeJson(res, 409, { ok: false, error: { code: "fs-error", message: "\"" + name + "\" already exists" } }); return;
          }
          const mv = await runPooled(profile, "mv -f -- " + shellQuotePath(srcRemote) + " " + shellQuotePath(dstRemote), undefined, 4096);
          if (!mv.ok) {
            writeJson(res, 400, { ok: false, error: { code: "fs-error", message: String(mv.stderr || mv.error || "rename failed").trim().slice(0, 500) } }); return;
          }
          invalidateRemoteCaches(profile, srcRemote, { subtree: true });
          invalidateRemoteCaches(profile, dstRemote, { subtree: true });
          result = { path: join(dirname(localPath), name) };
        } else if (method === "fs.remove") {
          // better-sidebar 0.19 新增端点：删除同样必须在远端执行（本地镜像仅供注册工作区）。
          const localPath = payload.path || "";
          if (!localPath) { writeJson(res, 400, { ok: false, error: { code: "bad-request", message: "path is required" } }); return; }
          const srcRemote = localToRemote(localPath, remoteBase, remoteInfo.remotePath);
          if (srcRemote === remoteInfo.remotePath) {
            writeJson(res, 400, { ok: false, error: { code: "fs-error", message: "cannot remove the workspace root" } }); return;
          }
          const rmv = await runPooled(profile, "rm -rf -- " + shellQuotePath(srcRemote), undefined, 4096);
          if (!rmv.ok) {
            writeJson(res, 400, { ok: false, error: { code: "fs-error", message: String(rmv.stderr || rmv.error || "remove failed").trim().slice(0, 500) } }); return;
          }
          // 本地镜像若有同名副本一并清理（镜像不是事实来源，失败可忽略）。
          try { await rm(localPath, { recursive: true, force: true }); } catch (e) {}
          invalidateRemoteCaches(profile, srcRemote, { subtree: true });
          result = { path: localPath };
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
          // matches 必须是 cwd 相对、'/' 分隔的路径（better-sidebar 客户端直接 .map 渲染并据此打开）；
          // entries 保留绝对路径（本插件 fs.read 拦截据此映射回远端）。
          const r = await localSearchFiles(sessionCwd, payload.query || "");
          const entries = (r && r.entries) || [];
          result = fsSearchResult(entries.map(function (e) { return toPosixRelative(sessionCwd, e.path); }), entries, r && r.truncated);
        } else if (method === "fs.rename") {
          result = await localRenameEntry(payload.path, String(payload.name || ""));
        } else if (method === "fs.remove") {
          result = await localRemoveEntry(payload.path);
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

  // fs.rename / fs.remove 是 better-sidebar 0.19 新增端点：旧版客户端不会调用，
  // 注册它们对旧版无副作用；新版下远程工作区的重命名/删除才不会落到本地镜像。
  ["fs.tree", "fs.read", "fs.write", "fs.search", "fs.rename", "fs.remove"].forEach(function (m) {
    ctx.effect(() => ctx.webServer.register({
      kind: "exact",
      path: "/sidebar/api/" + m,
      handler: function (req, res) { return interceptFsHandler(req, res, m); }
    }), "dsh-remote-ssh: intercept /sidebar/api/" + m);
  });

  // ---- better-sidebar 0.15+ 文件上传：远程工作区目录直接 SSH 上传到远端 ----
  // better-sidebar 的上传 UI 把原始字节流 POST 到它自己的 /sidebar/upload 路由，
  // 由本插件客户端将远程镜像目录下的这类请求转发到 /remote-ssh/upload。
  const REMOTE_UPLOAD_LIMIT = 134217728; // 与 better-sidebar 的上传上限一致

  /** dir/cwd 是否位于某个远程工作区的本地镜像目录之下（大小写不敏感）。 */
  function matchRemoteWorkspace(dir, cwd) {
    const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const nd = norm(dir);
    const nc = norm(cwd);
    if (!nd && !nc) return null;
    const workspaces = settingsFace.read().workspaces || [];
    for (const w of workspaces) {
      const m = norm(w.mirrorPath);
      if (!m) continue;
      if ((nd && (nd === m || nd.startsWith(m + "/"))) || (nc && (nc === m || nc.startsWith(m + "/")))) return w;
    }
    return null;
  }

  // ---- P0: 远程工作区的 Git 面板重定向（git.* 走远端，本地照旧本机 git）----
  const GIT_METHODS = ["status", "diff", "log", "branch", "commit-diff", "show", "stage", "unstage", "commit", "checkout", "discard", "revert", "cherry-pick"];

  /** 本机 git 执行（better-sidebar 原行为）：失败抛 {code:'git-error',message}。 */
  async function runGitLocal(cwd, args) {
    let handle;
    try {
      handle = subprocess.spawn({
        argv: ["git", "-C", cwd, "--no-pager", "-c", "color.ui=false", ...args],
        cwd: process.cwd(),
        stdio: {
          stdin: "ignore",
          stdout: { maxBytes: 8 * 1024 * 1024, spill: { maxBytes: 8 * 1024 * 1024 } },
          stderr: { maxBytes: 512 * 1024, spill: { maxBytes: 512 * 1024 } }
        },
        graceMs: 30000
      });
    } catch (e) {
      throw { code: "git-error", message: "cannot run git: " + String(e && e.message ? e.message : e) };
    }
    const outcome = await handle.done.catch((e) => { throw { code: "git-error", message: String(e && e.message ? e.message : e) }; });
    const so = (handle.collected && handle.collected.stdout) ? handle.collected.stdout.readFrom(0) : { text: "", nextOffset: 0, lossy: false };
    const se = (handle.collected && handle.collected.stderr) ? handle.collected.stderr.readFrom(0) : { text: "", nextOffset: 0, lossy: false };
    if (outcome.exitCode !== 0) throw { code: "git-error", message: String(se.text || "").trim() || ("git exited with " + outcome.exitCode) };
    return so.text;
  }

  /** 远端 git 执行（远程工作区）：在 remoteDir 里跑同一 git 语义。 */
  const GIT_MUTATING_FIRST_TOKENS = new Set(["add", "reset", "commit", "checkout", "revert", "cherry-pick"]);
  async function runGitRemote(profile, remoteDir, args) {
    const quoted = args.map((a) => shellQuote(a)).join(" ");
    const r = await runPooled(profile, "git -C " + shellQuotePath(remoteDir) + " --no-pager -c color.ui=false " + quoted, undefined, 8 * 1024 * 1024);
    if (!r.ok) throw { code: "git-error", message: String(r.stdout || r.error || "").trim() || "remote git exited with " + r.exitCode };
    // 仅变更类子命令（stage→add / unstage→reset / commit / checkout / discard→checkout /
    // revert / cherry-pick）会改工作区文件 → 整代失效读/列举缓存；
    // status/diff/log/branch/show 等只读命令不再打断缓存（review m4）。
    if (GIT_MUTATING_FIRST_TOKENS.has(String(args[0] || ""))) bumpCacheEpoch(profile);
    return r.stdout;
  }

  function parsePorcelainZ(output) {
    const tokens = String(output).split("\0");
    const entries = [];
    let index = 0;
    while (index < tokens.length) {
      const token = tokens[index];
      index += 1;
      if (token === "") continue;
      const xy = token.slice(0, 2);
      const rest = token.slice(3);
      entries.push({ path: rest, xy: xy });
      if ((xy[0] === "R" || xy[0] === "C") && tokens[index] !== undefined && tokens[index] !== "") index += 1;
    }
    return entries;
  }

  function parseLogLines(output) {
    const rows = [];
    for (const line of String(output).split("\n")) {
      if (line === "") continue;
      const [hash, subject, author, date, hashFull, refs] = line.split("\x1f");
      if (hash === undefined || subject === undefined) continue;
      rows.push({ hash, subject, author: author ?? "", date: date ?? "", hashFull: hashFull ?? hash, refs: refs ?? "" });
    }
    return rows;
  }

  /** git.status 的完整实现（isRepo 检测 + 分支 + porcelain 解析），本地/远端共用。 */
  async function gitStatusImpl(run, dir) {
    let inside = "false";
    try { inside = String((await run(dir, ["rev-parse", "--is-inside-work-tree"])).trim()); } catch (e) { inside = "false"; }
    if (inside !== "true") return { isRepo: false, entries: [] };
    let branch = "HEAD";
    try { branch = String((await run(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()) || "HEAD"; } catch (e) {}
    let raw = "";
    try {
      raw = await run(dir, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"]);
    } catch (e) {
      return { isRepo: true, branch: branch, entries: [] };
    }
    return { isRepo: true, branch: branch, entries: parsePorcelainZ(raw) };
  }

  /** 解析一次 /sidebar/api/git.* 请求的上下文：远程工作区 → {profile, remoteDir}，否则 null。 */
  function gitContextOf(payload) {
    const sessionId = payload && payload.sessionId;
    const clientCwd = payload && payload.cwd;
    let cwd = clientCwd;
    if ((!cwd || cwd === "") && sessionId) {
      const sessions = ctx.get("sessions");
      const session = sessions ? sessions.get(sessionId) : null;
      cwd = session && session.header && session.header.cwd;
    }
    if (!cwd) return null;
    const ws = matchRemoteWorkspace(cwd, cwd);
    if (!ws) return null;
    const remoteInfo = readRemoteInfoSync(ws.mirrorPath);
    const profile = remoteInfo && getProfile(remoteInfo.profileId);
    if (!remoteInfo || !profile) return null;
    const remoteDir = localToRemote(cwd, ws.mirrorPath, remoteInfo.remotePath);
    return { profile: profile, remoteDir: remoteDir, cwd: cwd };
  }

  async function interceptGitHandler(req, res, method) {
    const gitTrust = requestTrust(req, false);
    if (gitTrust !== "ok") { denyRequest(res, gitTrust); return; }
    if (req.method !== "POST") { writeJson(res, 405, { ok: false, error: { code: "method-error", message: "method not allowed" } }); return; }
    let payload;
    try { payload = await readJsonBody(req); }
    catch (e) { writeJson(res, 400, { ok: false, error: { code: "bad-request", message: String(e && e.message ? e.message : e) } }); return; }
    try {
      const remote = gitContextOf(payload);
      // 本地会话没有 session/cwd 时无法判定工作目录 → 按本机 git 于 process.cwd() 处理。
      const cwd = remote ? remote.remoteDir : (payload && payload.cwd) || process.cwd();
      const run = remote
        ? (dir, args) => runGitRemote(remote.profile, remote.remoteDir, args)
        : (dir, args) => runGitLocal(cwd, args);
      let value;
      switch (method) {
        case "status":
          value = await gitStatusImpl(run, cwd);
          break;
        case "diff": {
          const p = payload;
          const path = p.path !== undefined ? String(p.path) : undefined;
          const staged = p.staged === true;
          const args = ["diff", "--no-ext-diff", "--no-color", "-U3"];
          if (staged) args.push("--cached");
          if (path !== undefined && path !== "") args.push("--", path);
          value = { diff: await run(cwd, args) };
          break;
        }
        case "log": {
          const p = payload;
          const count = typeof p.count === "number" && Number.isInteger(p.count) && p.count > 0 ? p.count : 30;
          const skip = typeof p.skip === "number" && Number.isInteger(p.skip) && p.skip >= 0 ? p.skip : 0;
          value = parseLogLines(await run(cwd, ["log", "-n", String(count), "--skip", String(skip), "--decorate=short", "--pretty=format:%h%x1f%s%x1f%an%x1f%ai%x1f%H%x1f%D"]));
          break;
        }
        case "branch": {
          let current = "HEAD";
          try { current = String((await run(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()) || "HEAD"; } catch (e) {}
          const raw = await run(cwd, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
          const names = String(raw).split("\n").filter((l) => l !== "");
          value = { current: current, names: names.includes(current) ? names : [current, ...names] };
          break;
        }
        case "commit-diff": {
          const hash = String(payload && payload.hash || "").trim();
          if (!hash) throw { code: "bad-request", message: "hash is required" };
          value = { diff: await run(cwd, ["show", "--no-ext-diff", "--no-color", "--format=", "-m", "--first-parent", hash]) };
          break;
        }
        case "show": {
          const p = payload;
          const rev = String(p && p.rev || "").trim();
          const path = String(p && p.path || "").trim();
          if (!rev || !path) throw { code: "bad-request", message: "rev and path are required" };
          let content = null;
          try { content = await run(cwd, ["show", rev + ":" + path]); } catch (e) { content = null; }
          value = { content: content };
          break;
        }
        case "stage": {
          const path = payload && payload.path !== undefined ? String(payload.path) : undefined;
          await run(cwd, ["add", "-A", ...(path !== undefined && path !== "" ? ["--", path] : [])]);
          value = { ok: true };
          break;
        }
        case "unstage": {
          const path = payload && payload.path !== undefined ? String(payload.path) : undefined;
          await run(cwd, ["reset", "-q", ...(path !== undefined && path !== "" ? ["--", path] : [])]);
          value = { ok: true };
          break;
        }
        case "commit": {
          const message = String(payload && payload.message || "").trim();
          if (!message) throw { code: "bad-request", message: "message is required" };
          await run(cwd, ["commit", "-m", message]);
          value = { ok: true };
          break;
        }
        case "checkout": {
          const branch = String(payload && payload.branch || "").trim();
          if (!branch) throw { code: "bad-request", message: "branch is required" };
          await run(cwd, ["checkout", branch]);
          value = { ok: true };
          break;
        }
        case "discard": {
          const path = String(payload && payload.path || "").trim();
          if (!path) throw { code: "bad-request", message: "path is required" };
          await run(cwd, ["checkout", "--", path]);
          value = { ok: true };
          break;
        }
        case "revert": {
          const hash = String(payload && payload.hash || "").trim();
          if (!hash) throw { code: "bad-request", message: "hash is required" };
          await run(cwd, ["revert", "--no-edit", hash]);
          value = { ok: true };
          break;
        }
        case "cherry-pick": {
          const hash = String(payload && payload.hash || "").trim();
          if (!hash) throw { code: "bad-request", message: "hash is required" };
          await run(cwd, ["cherry-pick", hash]);
          value = { ok: true };
          break;
        }
        default:
          writeJson(res, 404, { ok: false, error: { code: "not-found", message: "unknown git method " + method } }); return;
      }
      if (value === undefined) value = { ok: true };
      writeOk(res, value);
    } catch (e) {
      const code = (e && e.code) || "git-error";
      const message = (e && e.message) || String(e);
      writeJson(res, code === "bad-request" ? 400 : 500, { ok: false, error: { code: code, message: message } });
    }
  }

  GIT_METHODS.forEach(function (m) {
    ctx.effect(() => ctx.webServer.register({
      kind: "exact",
      path: "/sidebar/api/git." + m,
      handler: function (req, res) { return interceptGitHandler(req, res, m); }
    }), "dsh-remote-ssh: intercept /sidebar/api/git." + m);
  });

  /** 等待可写流 drain（带回退:已销毁则即时返回）。 */
  function awaitOnce(emitter, event) {
    return new Promise((resolve, reject) => {
      emitter.once(event, () => resolve());
      emitter.once("error", reject);
    });
  }

  /** 流式写入：把请求体直接管道到远端 `cat > target`（二进制安全、恒定内存）。 */
  async function streamRemoteUpload(profile, target, req, limit) {
    let handle;
    try {
      handle = subprocess.spawn({
        argv: sshArgv(profile, "cat > " + shellQuotePath(target), false),
        cwd: process.cwd(),
        stdio: {
          stdin: "pipe",
          stdout: { maxBytes: 64 * 1024, spill: { maxBytes: 64 * 1024 } },
          stderr: { maxBytes: 64 * 1024, spill: { maxBytes: 64 * 1024 } }
        },
        graceMs: 10000
      });
    } catch (e) {
      return { ok: false, code: "spawn-failed", message: "spawn 失败: " + String(e && e.message ? e.message : e), size: 0 };
    }
    let size = 0;
    let aborted = false;
    const onAbort = () => { aborted = true; try { handle.terminate(); } catch (e) {} };
    try {
      req.on("aborted", onAbort);
      req.on("close", () => { if (!req.complete) onAbort(); });
      for await (const chunk of req) {
        if (aborted) break;
        const b = Buffer.from(chunk);
        size += b.length;
        if (size > limit) { handle.terminate(); return { ok: false, code: "too-large", message: "upload exceeds the remote upload limit (" + limit + " bytes)", size: size }; }
        if (handle.stdin.destroyed) return { ok: false, code: "pipe-closed", message: "ssh stdin closed during upload", size: size };
        if (!handle.stdin.write(b)) await awaitOnce(handle.stdin, "drain");
      }
      if (aborted) return { ok: false, code: "aborted", message: "upload aborted", size: size };
      handle.stdin.end();
      const outcome = await handle.done;
      const so = (handle.collected && handle.collected.stdout) ? handle.collected.stdout.readFrom(0) : { text: "", nextOffset: 0, lossy: false };
      const se = (handle.collected && handle.collected.stderr) ? handle.collected.stderr.readFrom(0) : { text: "", nextOffset: 0, lossy: false };
      if (outcome.exitCode !== 0) {
        return { ok: false, code: "fs-error", message: String(se.text || "").trim() || ("ssh 退出码 " + outcome.exitCode), size: size };
      }
      return { ok: true, size: size, stdout: so.text, stderr: se.text };
    } catch (e) {
      try { handle.terminate(); } catch (e2) {}
      return { ok: false, code: "fs-error", message: String(e && e.message ? e.message : e), size: size };
    } finally {
      req.removeListener("aborted", onAbort);
    }
  }

  async function handleRemoteUpload(req, res) {
    const upTrust = requestTrust(req, false);
    if (upTrust !== "ok") { denyRequest(res, upTrust); return; }
    if (req.method !== "POST") { writeJson(res, 405, { ok: false, error: { code: "method-error", message: "method not allowed" } }); return; }
    try {
      const url = new URL(req.url || "/", "http://dsh.internal");
      const dir = url.searchParams.get("dir") || "";
      const relativePath = (url.searchParams.get("relativePath") || "").replace(/\\/g, "/");
      const cwd = url.searchParams.get("cwd") || "";
      if (!dir || relativePath.trim() === "") { writeJson(res, 400, { ok: false, error: { code: "bad-request", message: "dir and relativePath are required" } }); return; }
      const ws = matchRemoteWorkspace(dir, cwd);
      if (!ws) { writeJson(res, 400, { ok: false, error: { code: "fs-error", message: "not a remote workspace directory" } }); return; }
      const remoteInfo = readRemoteInfoSync(ws.mirrorPath);
      const profile = remoteInfo && getProfile(remoteInfo.profileId);
      if (!remoteInfo || !profile) { writeJson(res, 500, { ok: false, error: { code: "internal", message: "remote workspace profile not found" } }); return; }
      let rel = relativePath;
      if (rel.startsWith("/")) rel = rel.slice(1);
      if (rel.split("/").some((seg) => seg === "..")) { writeJson(res, 400, { ok: false, error: { code: "bad-request", message: "relativePath must stay below the upload directory" } }); return; }
      const remoteDir = localToRemote(dir, ws.mirrorPath, remoteInfo.remotePath);
      const target = remoteDir.replace(/\/+$/, "") + (rel ? "/" + rel : "");
      const parent = target.slice(0, Math.max(target.lastIndexOf("/"), 0));
      // 远端建父目录
      if (parent && parent !== remoteDir.replace(/\/+$/, "")) {
        const mk = await runPooled(profile, "mkdir -p " + shellQuotePath(parent), undefined, 65536);
        if (!mk.ok) { writeJson(res, 500, { ok: false, error: { code: "fs-error", message: String(mk.error || mk.stdout || "mkdir failed").trim() } }); return; }
      }
      // 流式上传（cat > target 直接吃 stdin，无 base64、无内存膨胀）
      const r = await streamRemoteUpload(profile, target, req, REMOTE_UPLOAD_LIMIT);
      if (!r.ok) {
        const status = r.code === "too-large" ? 413 : (r.code === "bad-request" ? 400 : 500);
        writeJson(res, status, { ok: false, error: { code: r.code, message: r.message } });
        return;
      }
      // 上传落盘：目标文件 + 父目录列举失效
      invalidateRemoteCaches(profile, target, { subtree: false });
      writeOk(res, { path: dir.replace(/\\/g, "/").replace(/\/+$/, "") + "/" + rel, size: r.size });
    } catch (e) {
      writeJson(res, 400, { ok: false, error: { code: "fs-error", message: String(e && e.message ? e.message : e) } });
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/remote-ssh/upload",
    handler: function (req, res) { return handleRemoteUpload(req, res); }
  }), "dsh-remote-ssh: /remote-ssh/upload route");

  // ---- P0: 远程文件下载 / 媒体预览（拦截 better-sidebar 的 /sidebar/file）----
  // better-sidebar 注册的是 prefix 路由，这里注册同路径 exact 路由优先匹配。
  const MEDIA_TYPES = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
    ".webp": "image/webp", ".svg": "image/svg+xml", ".bmp": "image/bmp", ".ico": "image/x-icon",
    ".avif": "image/avif", ".pdf": "application/pdf", ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8"
  };
  const REMOTE_DOWNLOAD_LIMIT = 64 * 1024 * 1024; // 远端内容走 base64 传输，设一个合理上限

  function mediaTypeForPath(path) {
    const ext = String(path || "").toLowerCase();
    const dot = ext.lastIndexOf(".");
    const key = dot >= 0 ? ext.slice(dot) : "";
    return MEDIA_TYPES[key] || "application/octet-stream";
  }

  /** 二进制安全地取回远端文件字节（base64 走 stdout，长度上限 maxBytes）。 */
  async function remoteFetchBytes(profile, remotePath, maxBytes) {
    // 先拿大小（stat），超限直接拒绝；base64 会膨胀 4/3，给 stdout 相应上限。
    const st = await runPooled(profile, "stat -c%s " + shellQuotePath(remotePath), undefined, 65536);
    if (!st.ok) return { ok: false, error: String(st.stdout || st.error || "stat failed").trim() };
    const size = parseInt(String(st.stdout).trim(), 10);
    if (isNaN(size)) return { ok: false, error: "cannot stat remote file size" };
    if (size > maxBytes) return { ok: false, error: "file too large (" + size + " bytes; limit " + maxBytes + ")" };
    const cap = Math.ceil(size * 1.5) + 4096;
    const r = await runPooled(profile, "base64 -w0 " + shellQuotePath(remotePath), undefined, cap);
    if (!r.ok) return { ok: false, error: String(r.stdout || r.error || "read failed").trim().slice(0, 500) };
    try {
      const buf = Buffer.from(String(r.stdout).replace(/\s+/g, ""), "base64");
      return { ok: true, buffer: buf };
    } catch (e) {
      return { ok: false, error: "decode failed: " + String(e) };
    }
  }

  async function handleSidebarFile(req, res) {
    const fileTrust = requestTrust(req, false);
    if (fileTrust !== "ok") { res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }); res.end(trustErrorMessage(fileTrust)); return; }
    if (req.method !== "GET") { res.writeHead(405); res.end(); return; }
    try {
      const url = new URL(req.url || "/", "http://dsh.internal");
      const sessionId = url.searchParams.get("sessionId");
      const rawPath = url.searchParams.get("path");
      const cwdParam = url.searchParams.get("cwd") || "";
      const download = url.searchParams.get("download") === "1";
      if (!sessionId || !rawPath) { res.writeHead(400); res.end("sessionId and path are required"); return; }
      const ws = matchRemoteWorkspace(rawPath, cwdParam);
      if (ws) {
        // ---- 远程工作区：SSH 拉取远程文件 ----
        const remoteInfo = readRemoteInfoSync(ws.mirrorPath);
        const profile = remoteInfo && getProfile(remoteInfo.profileId);
        if (!remoteInfo || !profile) {
          writeJson(res, 500, { ok: false, error: { code: "internal", message: "remote workspace profile not found" } });
          return;
        }
        const remotePath = localToRemote(rawPath, ws.mirrorPath, remoteInfo.remotePath);
        const r = await remoteFetchBytes(profile, remotePath, REMOTE_DOWNLOAD_LIMIT);
        if (!r.ok) {
          writeJson(res, 400, { ok: false, error: { code: "fs-error", message: r.error || "read failed" } });
          return;
        }
        const body = r.buffer;
        const headers = {
          "content-type": mediaTypeForPath(remotePath),
          "cache-control": "no-cache"
        };
        if (download) headers["content-disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(String(remotePath).split("/").pop() || "download")}`;
        res.writeHead(200, headers);
        res.end(body);
        return;
      }
      // ---- 本地工作区：沿用 better-sidebar 原行为（读本地文件）----
      let cwd = cwdParam;
      if (!cwd && sessionId) {
        const sessions = ctx.get("sessions");
        const session = sessions ? sessions.get(sessionId) : null;
        cwd = session && session.header && session.header.cwd;
      }
      const info = await stat(rawPath).catch((e) => { throw new Error("cannot read: " + String(e && e.message ? e.message : e)); });
      if (!info.isFile() || info.size > 20 * 1024 * 1024) { res.writeHead(400); res.end("not a file or too large"); return; }
      const body = await readFile(rawPath);
      const headers = {
        "content-type": mediaTypeForPath(rawPath),
        "cache-control": "no-cache"
      };
      if (download) headers["content-disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(rawPath.split(/[\\/]/).pop() || "download")}`;
      res.writeHead(200, headers);
      res.end(body);
    } catch (e) {
      res.writeHead(400);
      res.end(String(e && e.message ? e.message : e));
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/sidebar/file",
    handler: function (req, res) { return handleSidebarFile(req, res); }
  }), "dsh-remote-ssh: intercept /sidebar/file");

  // ---- @ 文件引用补全：远程工作区走 SSH（issue #10）----
  // 包装宿主 ctx.fileReferences 服务实例：远程工作区自己算候选，其余委托回原实现。
  // 不替换 composition row（file-reference-local）也不需要新的 @deepseek-ai 运行时依赖：
  // 本地会话的索引/模糊排序保持原样，零回归风险。
  /** 远端目录列举（复用 remoteListDir 的 LRU 缓存），语义对齐本地 listDirectory。 */
  async function remoteRefListDirectory(profile, root, displayDirectory, fragment) {
    const dirRel = String(displayDirectory || "").replace(/\/+$/, "");
    if (dirRel.split("/").some((seg) => seg && REF_EXCLUDED_DIRS.has(seg))) return [];
    const base = String(root || "~").replace(/\/+$/, "") || "~";
    const remoteDir = dirRel ? base + "/" + dirRel : base;
    const r = await remoteListDir(runPooled, profile, remoteDir);
    if (!r.ok) return [];
    const out = [];
    for (const e of r.entries || []) {
      const name = String(e && e.name ? e.name : "");
      if (!name) continue;
      const isDir = e.type === "directory";
      if (name.startsWith(".") && !String(fragment || "").startsWith(".")) continue;
      if (isDir && REF_EXCLUDED_DIRS.has(name)) continue;
      out.push({ path: String(displayDirectory || "") + name, kind: isDir ? "directory" : "file" });
    }
    return refRankCandidates(out, String(fragment || ""), REF_MAX_RESULTS);
  }

  /** 远端 workspace 索引：缓存 + 后台重建；单次查询只等 REF_QUERY_BUDGET_MS。 */
  async function refIndexFor(profile, root) {
    const pk = profileKey(profile);
    const key = pk + "|" + String(root || "~");
    const epoch = cacheEpoch(pk);
    const hit = refIndexCache.get(key);
    if (hit && hit.epoch === epoch && Date.now() - hit.at <= REF_INDEX_TTL_MS) return hit.entries;
    let build = refIndexBuilds.get(key);
    if (!build) {
      build = (async () => {
        try {
          const r = await runPooled(profile, refIndexCommand(root), undefined, MAX_BYTES, false, REF_INDEX_BUILD_TIMEOUT_MS);
          const stdout = r && r.stdout ? String(r.stdout) : "";
          const entries = refParseIndexOutput(stdout);
          // 截断信号（issue #10 实测反馈建议）：命令按上限 +1 行取样，若有效行数超过上限，
          // 说明索引被 head 截断、模糊搜索可能漏文件——打一条 warn，避免用户只看到「搜不到」。
          const rawLines = stdout.split("\n").filter((line) => line.indexOf("\t") > 0).length;
          if (rawLines > REF_MAX_ENTRIES && !refTruncationWarned.has(key)) {
            refTruncationWarned.add(key);
            try {
              ctx.logger?.warn("[dsh-remote-ssh] 文件引用索引已达上限（" + REF_MAX_ENTRIES + " 条，实际 " + rawLines + "+）："
                + "远端 " + String(root || "~") + " 的文件过多，@ 补全可能漏掉部分文件；"
                + "可在远端 .gitignore 中忽略构建产物/虚拟环境目录以缩小索引");
            } catch (e) {}
          }
          // 只有成功（或确实拿到了输出）才写缓存：cd 失败/断连时不能把空索引缓存 60 秒
          if (r && (r.ok || stdout.length > 0)) {
            refIndexCache.set(key, { at: Date.now(), epoch, entries });
          }
          return entries;
        } catch (e) {
          return (hit && hit.entries) || [];
        } finally {
          refIndexBuilds.delete(key);
        }
      })();
      refIndexBuilds.set(key, build);
    }
    try {
      return await withTimeout(build, REF_QUERY_BUDGET_MS, "文件引用索引", null);
    } catch (e) {
      // 超时：先用陈旧索引作答（与本地 provider 的「陈旧索引照常回答、重建在后台」一致）
      return (hit && hit.entries) || [];
    }
  }

  /** 远程 @ 补全：查询语义与本地一致（目录查询 vs 模糊查询）。 */
  async function remoteRefList(profile, root, query, signal) {
    if (signal && signal.aborted) return [];
    const split = refSplitQuery(query);
    if (split.isDirectoryQuery) {
      return await remoteRefListDirectory(profile, root, split.directory, split.fragment);
    }
    const entries = await refIndexFor(profile, root);
    if (entries.length) {
      const visible = entries.filter((e) => refVisibleForGlobalQuery(e.path, split.fragment));
      return refRankCandidates(visible, split.fragment, REF_MAX_RESULTS);
    }
    // 索引尚未就绪时不能直接给空列表 —— 那正是「@文件名 没有候选、而 @ 单独输入正常」的观感
    // （用户实测反馈：某个远程项目里模糊查询全空）。原因：大仓库里索引的 git 那一步会吃满预算
    // （实测 6.7s 才建好），而单次查询只等 REF_QUERY_BUDGET_MS=900ms。
    // 这里用与侧栏搜索同一套**有界 find** 兜底：剪噪声目录 + 无 sort + 浅层深度 + 墙钟预算（实测 0.65s）。
    const r = await remoteGlob(runPooled, profile, "*" + split.fragment + "*", root, {
      relative: true,
      sorted: false,
      pruneNoise: true,
      maxResults: REF_MAX_RESULTS,
      maxDepth: REF_INDEX_FIND_MAXDEPTH,
      timeBudgetSec: REF_INDEX_FIND_BUDGET_SEC,
      timeoutMs: 10000
    });
    if (!r || !r.files || !r.files.length) return [];
    const quick = r.files.map(function (f) {
      return { path: String(f).replace(/\\/g, "/").replace(/^\.\//, ""), kind: "file" };
    }).filter(function (e) { return e.path !== "" && refVisibleForGlobalQuery(e.path, split.fragment); });
    return refRankCandidates(quick, split.fragment, REF_MAX_RESULTS);
  }

  /** 该 agent 是远程工作区会话则返回远端候选，否则返回 null（调用方委托原实现）。 */
  async function remoteRefListForAgent(agent, query, signal) {
    const session = agent && agent.session;
    const cwd = session && session.header && session.header.cwd;
    if (!cwd) return null;
    const info = readRemoteInfoSync(cwd);
    if (!info || !info.host || !info.user || !info.keyPath) return null;
    const profile = getProfile(info.profileId);
    if (!profile) return null;
    return await remoteRefList(profile, info.remotePath || "~", query, signal);
  }

  /** 包装服务实例；返回恢复函数（失败返回 null）。 */
  function installFileReferenceBridge(sctx) {
    const svc = sctx && typeof sctx.get === "function" ? sctx.get("fileReferences") : sctx && sctx.fileReferences;
    if (!svc || typeof svc.list !== "function") return null;
    const original = svc.list.bind(svc);
    const patched = async function (agent, query, signal) {
      try {
        const remote = await remoteRefListForAgent(agent, query, signal);
        if (remote !== null) return remote;
      } catch (e) {
        // 任何异常都降级到本地实现：补全不该因为远端问题而不可用
      }
      return original(agent, query, signal);
    };
    try {
      svc.list = patched;
    } catch (e) {
      return null;
    }
    return function restoreFileReferenceList() {
      try { if (svc.list === patched) svc.list = original; } catch (e) {}
    };
  }

  let restoreFileReferences = null;
  ctx.inject(["fileReferences"], (sctx) => {
    restoreFileReferences = installFileReferenceBridge(sctx);
    if (!restoreFileReferences) {
      try { ctx.logger?.warn("[dsh-remote-ssh] fileReferences 服务不可包装，@ 补全在远程工作区仍只覆盖本地镜像"); } catch (e) {}
    }
  });

  // ---- 清理 ----
  ctx.effect(() => () => {
    if (restoreFileReferences) { try { restoreFileReferences(); } catch (e) {} restoreFileReferences = null; }
    clearInterval(idleTimer);
    sessions.forEach(function (s) { try { s.close(); } catch (e) {} });
    sessions.clear();
    terminals.forEach(function (s) { try { s.handle.terminate(); } catch (e) {} });
    terminals.clear();
  });
}

export { Config, apply, inject, name };
