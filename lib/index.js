/**
 * dsh-remote-ssh — Host 半边（静态 DSH Web 插件）
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
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Plugin identity for cordis.yml rows. */
const name = "dsh-remote-ssh";
/** Services required before mounting. */
const inject = ["webServer", "subprocess", "tools"];
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
  remoteRoot: z.string().default("~")
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

function sshArgv(p, remoteCmd, tty) {
  const opts = ["ssh"];
  if (tty) opts.push("-tt");
  opts.push("-p", String(p.port || 22));
  opts.push("-o", "StrictHostKeyChecking=accept-new");
  opts.push("-o", "ConnectTimeout=15");
  opts.push("-o", "ServerAliveInterval=30");
  opts.push("-o", "ServerAliveCountMax=3");
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

async function remoteListDir(subprocess, p, path) {
  const target = path || p.remoteRoot || "~";
  const script = "cd " + shellQuotePath(target) + " 2>/dev/null || { echo '__DSH_ERR__ cannot cd'; exit 1; }; find . -maxdepth 1 -mindepth 1 -printf '%Y\\t%f\\t%s\\n' 2>/dev/null | sort";
  const r = await runRemote(subprocess, p, script, undefined, MAX_BYTES);
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

async function remoteReadFile(subprocess, p, path) {
  if (!path) return { ok: false, error: "path 为必填项" };
  const r = await runRemote(subprocess, p, "base64 -w0 " + shellQuotePath(path), undefined, MAX_BYTES);
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

async function remoteWriteFile(subprocess, p, path, content) {
  if (!path) return { ok: false, error: "path 为必填项" };
  const c = content !== undefined ? String(content) : "";
  return await runRemote(subprocess, p, "cat > " + shellQuotePath(path), c, MAX_BYTES);
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
  const workspaceRegistry = ctx.get("workspaceRegistry");
  const terminals = new Map();
  let nextTerminalId = 1;

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
        remoteRoot: p.remoteRoot || "~"
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
      const title = a.title || (p.name + ":" + a.remotePath);
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
      let workspaceId = null;
      if (workspaceRegistry) {
        try {
          const native = await workspaceRegistry.create(mirrorDir, "🌐 " + title);
          workspaceId = native.id;
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
      return await remoteListDir(subprocess, p, args && args.path);
    },
    readFile: async (args) => {
      const p = resolveProfile(args);
      if (!p) return { ok: false, error: "需要 profileId 或 host+user" };
      return await remoteReadFile(subprocess, p, args && args.path);
    },
    writeFile: async (args) => {
      const p = resolveProfile(args);
      if (!p) return { ok: false, error: "需要 profileId 或 host+user" };
      return await remoteWriteFile(subprocess, p, args && args.path, args && args.content);
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
      const r = await remoteListDir(subprocess, tc.profile, resolveRemotePath(args.path, tc.remotePath));
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
      const r = await remoteReadFile(subprocess, tc.profile, resolveRemotePath(args.path, tc.remotePath));
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
      return normExec(await remoteWriteFile(subprocess, tc.profile, resolveRemotePath(args.path, tc.remotePath), args.content));
    }
  });

  // ---- 清理 ----
  ctx.effect(() => () => {
    terminals.forEach(function (s) { try { s.handle.terminate(); } catch (e) {} });
    terminals.clear();
  });
}

export { Config, apply, inject, name };
