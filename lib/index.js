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
/** 持久会话单条命令的 stdout 缓冲硬上限（防止大文件/海量输出撑爆内存）。 */
const SESSION_MAX_STDOUT = 8 * 1024 * 1024;
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
      const errMsg = "ssh 会话已关闭" + (this.errBuf.trim() ? ": " + this.errBuf.trim().slice(-300) : "");
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
  if (p.authMethod === "key" && p.keyPath) opts.push("-i", expandSshPath(p.keyPath));
  // 密钥认证的非交互连接（会话池 / 工具 / 同步）要求一次性无提示完成：
  // BatchMode 禁用 passphrase/确认交互（有口令的密钥立即报错而不是挂到超时），
  // PreferredAuthentications=publickey 跳过无谓的认证方法协商，缩短建连时间。
  if (!tty && p.authMethod === "key") {
    opts.push("-o", "BatchMode=yes");
    opts.push("-o", "PreferredAuthentications=publickey");
  }
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
  if (tarOut.exitCode === 0 && sshOut.exitCode === 0) {
    // 批量覆盖远端文件：清空该 profile 的读/列举缓存（findings §4.3a）
    clearCachesForProfile(p);
    return { ok: true, remotePath: remotePath };
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
  // profileKey 已上移模块层（读缓存/列举缓存与失效逻辑共用同一身份键，定义见 remoteReadFile 上方）。
  function getSession(p) {
    const key = profileKey(p);
    let s = sessions.get(key);
    if (!s) { s = new CommandSession(subprocess, p); sessions.set(key, s); }
    return s;
  }
  /** 把 SSH 常见失败翻译成带修复建议的中文提示。 */
  function sshErrorHint(text) {
    const t = String(text || "");
    if (/remote port forwarding failed for listen port (\d+)/i.test(t)) {
      const m = t.match(/remote port forwarding failed for listen port (\d+)/i);
      return "SSH 端口转发失败（本地端口 " + m[1] + " 已被占用）。这通常由 ~/.ssh/config 里的 RemoteForward 造成：远端该端口被上次会话占用时，ExitOnForwardFailure yes 会让 ssh 直接退出。本插件已对该连接加 ClearAllForwardings，若仍出现请检查 ssh config。原始信息: " + t.trim().slice(0, 300);
    }
    if (/permission denied \(publickey/i.test(t)) return "公钥认证失败：请检查 keyPath 私钥路径是否正确、远端 ~/.ssh/authorized_keys 是否包含对应公钥。原始信息: " + t.trim().slice(0, 300);
    if (/connection refused/i.test(t)) return "连接被拒绝：请确认远端 sshd 已启动且端口正确。原始信息: " + t.trim().slice(0, 300);
    if (/connection timed out|timed out/i.test(t)) return "连接超时：请确认网络可达、端口开放，或检查 ProxyJump 配置。原始信息: " + t.trim().slice(0, 300);
    if (/could not resolve hostname/i.test(t)) return "无法解析主机名：请检查连接配置中的 host 拼写。原始信息: " + t.trim().slice(0, 300);
    return t.trim().slice(0, 500);
  }

  /** 池化执行：复用持久会话；连接层失败（exit 255）或会话异常时清理会话并经一次性连接重试。
   *  split=true 时 stderr 与 stdout 分离返回（命令走双哨兵协议）。 */
  async function runPooled(p, cmd, stdinData, maxBytes, split) {
    const dropSession = () => {
      const key = profileKey(p);
      const old = sessions.get(key);
      if (old) { old.close(); sessions.delete(key); }
    };
    try {
      const s = getSession(p);
      const r = await s.exec(cmd, stdinData, split);
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
      // 会话挂了 —— 清理并回退到一次性连接（相当于自动重连一次）
      dropSession();
      const r2 = await runRemote(subprocess, p, cmd, stdinData, maxBytes);
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
          const wsTitle = title; // 图标语义由客户端「地球角标文件夹」图标承担，标题不再带 🌐 前缀
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
      // 走持久会话池（stderr 分离，双哨兵协议）：首次调用完成建连后，
      // 后续调用不再重复 TCP 握手 + 认证，单次耗时从秒级降到毫秒级；
      // 会话异常时 runPooled 自动重建并降级一次性连接。
      // 远程命令可能改任意文件（插件不可见）→ 整代失效读/列举缓存（findings §4.3a）。
      const r = await runPooled(tc.profile, cmd, args.stdin, undefined, true);
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

  // ---- 启动自愈：把既有远程工作区的原生标题统一为「远程路径最后一段」----
  // 早期版本 create 工作区时未传 title，DSH 用镜像目录 basename（wsId，如 wmt3tev5cdfge）
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
    if (!isTrusted(req)) { writeJson(res, 403, { ok: false, error: { code: "forbidden", message: "forbidden" } }); return; }
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
    if (!isTrusted(req)) { writeJson(res, 403, { ok: false, error: { code: "forbidden", message: "forbidden" } }); return; }
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
    if (!isTrusted(req)) { res.writeHead(403); res.end("forbidden"); return; }
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
