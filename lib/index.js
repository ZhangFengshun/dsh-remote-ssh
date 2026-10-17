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
// 必须用 DSH 分支的 schemastery：只有它实现 `.volatile()`（Config 字段需要该标记，
// 否则新版 Loader 的 volatile-commit 路径不会提交，写入会"报成功但值不变"）。
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { mkdir, rm, writeFile, readFile, opendir, stat, open, rename, readdir, lstat, cp } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { join, dirname, basename } from "node:path";
import { parse as parseYaml } from "yaml";

/** Plugin identity for cordis.yml rows. */
const name = "@zhangfengshun/dsh-remote-ssh";
/** Services required before mounting. */
const inject = ["webServer", "subprocess", "tools", "workspaceRegistry"];
// `Config` 的定义在下方 PrefsSchema 之后（必须引用它，见那里的说明）。

const NS = "dsh-remote-ssh";
const MAX_BYTES = 4 * 1024 * 1024;
/** 持久会话单条命令的 stdout 缓冲硬上限（防止大文件/海量输出撑爆内存）。 */
const SESSION_MAX_STDOUT = 8 * 1024 * 1024;
const API_BASE = "/remote-ssh/api/";

// ---------------------------------------------------------------------------
// 同步安全（issue #20）
//
// 旧实现的三个问题（issue #20 用真实函数 + 真实子进程在有界 fixture 上观测到）：
//   1. `remoteSyncDown` **先 `rm -rf` 镜像、再全树拉取**：拉取一旦失败，镜像里那批
//      「只存在于本地」的文件（例如 >4 MiB 的写入被 MAX_BYTES 守卫拦下、宿主只打了一行 warn）
//      就被永久销毁，且没有任何提示；
//   2. 两个方向都只 tar 一个 `.`：没有排除规则、没有子路径、没有体积上限、没有确认 ——
//      远端根是「代码 + 数据集」的混合目录时，一次调用就是一次全量复制；
//   3. `remoteSyncUp` 会把镜像根里**由插件自己写入**的 `README.md` / `.remote-ssh.json`
//      一并解到远端根目录。
//
// 现在的顺序保证（不变式）：**体积哨兵 → 解包到临时目录 → （整树时）比对「仅存在于镜像
// 的文件」→ 原子替换 → 恢复占位文件**。任何一步失败，旧镜像都原样保留。
// ---------------------------------------------------------------------------
const SYNC_MAX_BYTES_DEFAULT = (() => {
  const v = parseInt(process.env.DSH_REMOTE_SSH_SYNC_MAX_BYTES, 10);
  return Number.isFinite(v) && v > 0 ? v : 2 * 1024 * 1024 * 1024;   // 体积哨兵默认上限 2 GiB
})();
const SYNC_TIMEOUT_MS_DEFAULT = (() => {
  const v = parseInt(process.env.DSH_REMOTE_SSH_SYNC_TIMEOUT_MS, 10);
  return Number.isFinite(v) && v >= 0 ? v : 10 * 60 * 1000;          // 同步墙钟预算默认 10 分钟
})();
const SYNC_PROBE_TIMEOUT_MS = 15000;   // 远端体积探测预算（超时即保守拒绝）
const SYNC_SCAN_BUDGET_MS = 8000;      // 「仅存在于镜像」比对的墙钟预算
const SYNC_SCAN_MAX_FILES = 20000;     // 同上：最多 stat 多少个镜像条目
const SYNC_LIST_CAP = 20;              // 报错里最多列出的路径条数
const SYNC_TMP_PREFIX = ".dsh-sync-tmp-";
const SYNC_OLD_PREFIX = ".dsh-sync-old-";
/** 镜像根占位 README 的首行指纹（用于识别「插件自有文件」，避免推进远端/误判为数据）。 */
const MIRROR_README_SENTINEL = "# 🌐 Remote Workspace / 远程工作区";
// ---- 远端 tar 的字符集方案（issue #22）------------------------------------
// Windows 自带的 bsdtar 读 ustar 名时按**本地 ANSI 代码页**解码（中文机器 = CP936/GBK），而远端
// GNU tar 对短的非 ASCII 名写出的是**裸 UTF-8 字节的 ustar 头**（typeflag='0'、无 PAX、无字符集
// 声明）—— 于是 `报告_2026Q1.csv` 被静默改写成 `鎶ュ憡_2026Q1.csv`（exit 0、stderr 为空），
// 再 push 一次就把乱码名固化到远端。该 bsdtar 构建又没有 `--hdrcharset`
// （实测 `Option --hdrcharset=UTF-8 is not supported`），所以只能让**远端**改用 PAX 格式：
// `path=` 记录携带 UTF-8 名，bsdtar 会优先采用它（GNU tar 1.35 + bsdtar 3.8.8 实测通过）。
// 体积：GNU tar 的 pax 默认给**每个**文件都写 mtime/atime 记录（实测 301 个 200 B 文件的树
// +97%）；加上 `delete=atime,delete=ctime,delete=mtime` 后只为真正需要的条目写记录，
// 实测体积与 ustar 完全相同（317,440 B）而名字已经正确 —— 故优先用这个变体。
const SYNC_PAX_MIN_ARGS = "--format=pax --pax-option=delete=atime,delete=ctime,delete=mtime";
const SYNC_PAX_PLAIN_ARGS = "--format=pax";   // 不支持 --pax-option 的 tar（例如 macOS 的 bsdtar）
const syncPaxCache = new Map();               // profileId → "min" | "pax" | "none"
/** PAX 方案开关：默认只在 Windows 本地启用（其它平台的 ANSI 代码页就是 UTF-8，本来不会乱码）。
 *  `DSH_REMOTE_SSH_SYNC_PAX`：off/none = 关闭；min/plain/1 = 强制；unset = auto。 */
function resolveSyncPaxPref() {
  const v = String(process.env.DSH_REMOTE_SSH_SYNC_PAX || "").trim().toLowerCase();
  if (v === "off" || v === "none" || v === "0") return "off";
  if (v === "min") return "min";
  if (v === "plain" || v === "pax" || v === "1") return "plain";
  return process.platform === "win32" ? "auto" : "off";
}

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
  mirrorPath: z.string().default(""),
  // 同步安全（issue #20）：范围控制与体积上限，随工作区持久化；工具/HTTP 调用可逐次覆盖。
  syncExclude: z.array(z.string()).default([]),   // 整树同步的排除规则（相对远端根）
  syncPaths: z.array(z.string()).default([]),     // 只同步这些子路径（留空 = 整树）
  syncMaxBytes: z.number().default(0),            // 体积哨兵上限，0 = 用全局默认（2 GiB）
  // 写回桥护栏（issue #24）：agent 的 write/edit 落本地镜像后要不要跟着推到远端。
  // 默认行为与 2.4.23 一致（推）；关掉或排除某些路径即可把"工作草稿"留在本地，
  // 不再无声地出现在共享集群的项目目录里。
  writeBack: z.boolean().default(true),           // false = 该工作区完全不做写回
  writeBackExclude: z.array(z.string()).default([]) // 镜像相对路径的排除规则（支持 * / ** / ?）
});
/** settings 命名空间的完整 schema。 */
const PrefsSchema = z.object({
  profiles: z.array(ProfileSchema).default([]),
  workspaces: z.array(WorkspaceSchema).default([]),
  // 终端 wrapper 要用的 node 可执行文件绝对路径（issue #23）：留空 = 自动解析。
  // DSH Desktop 按设计**不**把自带 node 放进子进程 PATH，于是生成出来的 wrapper 裸调
  // `node` 时会以 cmd 的原文报错（'node' is not recognized…）并立刻退出，集成终端在该
  // 场景下 100% 不可用。这里给一条显式通道；不给也能自动解析（见 resolveWrapperNode）。
  nodePath: z.string().default(""),
  // 写回桥推送失败时的处理（issue #24）：默认 "error" = 让模型看见；"log" = 只写日志（2.4.23 行为）。
  // 之所以只能二选一而不给"成功里附一条警告"：`write` 工具的输出 schema 是
  // additionalProperties:false 且 execute 自己重建返回对象（只取 path/operation/before/after），
  // 附加字段到不了模型；成功渲染又是固定信封（<path>/<type>/<content>），没有警告位。
  // 因此"失败可见"在本版 DSH 上唯一可用的通道就是工具报错 —— 消息里会写清本地写入是成功的。
  writeBackFailure: z.string().default("error"),
  // 写回**之前**的远端新鲜度检查（issue #24 护栏 B，2.4.25）：默认 true。
  // 共享集群上最常见的"另一个写入者"是自己刚跑完的作业 —— 作业改了远端，镜像还是旧版，
  // agent 再写一次就会静默覆盖。开着它时：推送成功后记下远端 size:mtime，下次推同一路径前
  // 复查，不一致就**不推**并报错（给出 remote_ssh_sync / remote_ssh_push 两条出路）。
  // 关掉（false 或 DSH_REMOTE_SSH_WRITEBACK_FRESHNESS=off）＝ 每次都无条件覆盖（2.4.24 行为）。
  writeBackFreshness: z.boolean().default(true)
});

/**
 * 本插件 loader 行的 Config schema。
 *
 * DSH 0.1.7-rc.2 起 `settings` 服务不再有 `register(ns, schema)`：用户偏好改为存放在
 * **本插件 loader 行的 Config** 里（读走 `settings.describe()` 按 entry id 取值，写走
 * `settings.update(ns, patch, revision)`）。此时 schema 字段**必须标 `.volatile()`** ——
 * Loader 的 volatile-commit 路径只遍历带该标记的引用；普通字段会让写入"报成功但值不变"
 * （better-sidebar 的 `config` 模块注释把这一点写得很明确，此处照同样做法）。
 *
 * `Config` 必须定义在 `PrefsSchema` **之后**（模块级 const 的展开在求值期读取该绑定）。
 */
const PrefsFieldNames = Object.keys(PrefsSchema.dict ?? {});
const Config = z.object(Object.fromEntries(
  PrefsFieldNames.map((key) => [key, PrefsSchema.dict[key].volatile()])
));

// ---------------------------------------------------------------------------
// settings 兼容层（DSH 0.1.7-rc.2 起 API 变更）
//
// 新版：`settings` 服务提供 `configure / describe / update / replace / mutate`，**没有**
// `register(ns, schema)`。用户偏好存放在**本插件 loader 行的 Config** 里，命名空间就是该行的
// entry id（我们 bundle patch 里是 `remote-ssh`，而旧 settings 的 section 名是包名
// `dsh-remote-ssh` —— 这正是旧数据不会被自动迁移的原因）。写走 `update(ns, patch, revision)`。
// 旧版（≤0.1.6，含 0.1.5-rc.x）：`register(NS, PrefsSchema)` + `scope.get()/update()`，仍然支持。
// ---------------------------------------------------------------------------

/** 本插件在当前 loader 里的 entry id（新版 settings 的命名空间）。 */
function ownEntryId(ctx, packageName) {
  let fallback;
  try {
    for (const entry of ctx.loader.entries()) {
      const options = entry && entry.options;
      const id = options && options.id;
      if (!options || options.name !== packageName || typeof id !== "string" || id === "") continue;
      if (entry.fiber === ctx.fiber) return id;
      if (entry.disabled !== true && fallback === undefined) fallback = id;
    }
  } catch (e) {
    return undefined;
  }
  return fallback;
}

/** 从退役 `settings.yaml` 文本里取出本插件的旧 section（只保留已声明字段）。 */
function parseLegacyPrefsSection(text, ns, declaredKeys) {
  let doc;
  try {
    doc = parseYaml(text);
  } catch (e) {
    return undefined;
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return undefined;
  const section = doc[ns];
  if (!section || typeof section !== "object" || Array.isArray(section)) return undefined;
  const declared = new Set(declaredKeys || []);
  const filtered = {};
  for (const [key, value] of Object.entries(section)) {
    if (declared.has(key)) filtered[key] = value;
  }
  return Object.keys(filtered).length > 0 ? filtered : undefined;
}

/** 读旧偏好：迁移会先把文档改名为 `settings.yaml.imported`，两个名字都要试。 */
async function readLegacyPrefs(homeDir, ns, declaredKeys, readFileFn) {
  if (!homeDir) return undefined;
  const read = typeof readFileFn === "function" ? readFileFn : async (p) => String(await readFile(p, "utf8"));
  for (const file of ["settings.yaml.imported", "settings.yaml"]) {
    let text;
    try {
      text = await read(join(homeDir, file));
    } catch (e) {
      continue;
    }
    const section = parseLegacyPrefsSection(text, ns, declaredKeys);
    if (section) return section;
  }
  return undefined;
}

/**
 * 解析一个偏好字段的取值。
 *
 * 新版（0.1.7-rc.2）里 Config 的 `.volatile()` 字段经 schema 验证后是**引用对象**
 * （不是普通数组），要用 `.get()` 取实时值 —— 只判断 `Array.isArray(config.profiles)`
 * 会永远读到空（issue #16 报告者明确提示过这一点）。这里同时兼容普通值与引用对象。
 */
function resolvePrefValue(candidate) {
  if (candidate == null) return candidate;
  if (Array.isArray(candidate)) return candidate;
  if (typeof candidate.get === "function") {
    try { return candidate.get(); } catch (e) { return undefined; }
  }
  if (typeof candidate === "object" && candidate.meta && candidate.meta.volatile === true && "value" in candidate) {
    return candidate.value;
  }
  return candidate;
}

/** 从 describe() 的值 / apply 的 config 里安全取数组（兼容 volatile 引用对象）。 */
function prefsArray(...candidates) {
  for (const candidate of candidates) {
    const value = resolvePrefValue(candidate);
    if (Array.isArray(value)) return value;
  }
  return [];
}

/**
 * 从 describe() 的值 / apply 的 config 里安全取**标量**偏好（兼容 volatile 引用对象）。
 *
 * 为什么需要它（issue #24 第二轮验收里举报人指出的"可达性"）：设置面板要能读写
 * `nodePath` / `writeBackFailure` / `writeBackFreshness` 这类标量字段，而 `settingsFace.read()`
 * 此前只回 `profiles` / `workspaces` 两项 —— 于是 `read().writeBackFailure` 永远是 undefined，
 * 用户在设置里写 `"log"` 也不生效（只有环境变量能改）。`false` 是合法取值，必须原样返回。
 */
function prefsScalar(fallback, ...candidates) {
  for (const candidate of candidates) {
    const value = resolvePrefValue(candidate);
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return fallback;
}

/** 一次性形状探针：把真实取值形状打进日志，便于日后一眼定位 schema/API 变更。
 *  设 `DSH_REMOTE_SSH_DEBUG_SHAPE=1` 时同时写入 `<profileHome>/dsh-remote-ssh-settings-shape.json`
 *  （CLI/后台实例的 logger 常看不到，文件是保底通道；默认不写任何文件）。 */
function describePrefsShape(rawConfig, form, log, homeDir) {
  try {
    const shape = {
      at: new Date().toISOString(),
      form: !!form,
      ns: form ? form.ns : null,
      revision: form ? form.revision : null,
      userKeys: form && form.user && typeof form.user === "object" ? Object.keys(form.user) : null,
      valueProfilesArray: Array.isArray(form && form.value && form.value.profiles),
      valueProfilesType: form && form.value && form.value.profiles ? typeof form.value.profiles : "absent",
      valueProfilesHasGet: !!(form && form.value && form.value.profiles && typeof form.value.profiles.get === "function"),
      configProfilesArray: Array.isArray(rawConfig && rawConfig.profiles),
      configProfilesType: rawConfig && rawConfig.profiles ? typeof rawConfig.profiles : "absent",
      configProfilesHasGet: !!(rawConfig && rawConfig.profiles && typeof rawConfig.profiles.get === "function"),
      configProfilesKeys: rawConfig && rawConfig.profiles && typeof rawConfig.profiles === "object" ? Object.keys(rawConfig.profiles).slice(0, 8) : null,
      // 直接用与 read() 相同的解析逻辑算一遍计数：定位"形状对了但结果仍为空"的情况
      resolvedProfiles: prefsArray(form && form.value && form.value.profiles, rawConfig && rawConfig.profiles).length,
      resolvedWorkspaces: prefsArray(form && form.value && form.value.workspaces, rawConfig && rawConfig.workspaces).length,
    };
    if (log && typeof log.info === "function") log.info("[dsh-remote-ssh] settings 形状探针: " + JSON.stringify(shape));
    if (process.env.DSH_REMOTE_SSH_DEBUG_SHAPE && homeDir) {
      try { writeFileSync(join(homeDir, "dsh-remote-ssh-settings-shape.json"), JSON.stringify(shape, null, 2), "utf8"); } catch (e) {}
    }
  } catch (e) {}
}

/**
 * 新版（0.1.7-rc.2+）settings 的读写外观：读优先取 `describe()`（按 entry id）的实时值，
 * 退回 `apply(ctx, config)` 的字段；写走 `update(entryId, patch, revision)`。
 */
function createNewSettingsFace(svc, entryId, rawConfig, log, migrated, homeDir) {
  const warn = function (msg) { try { if (log && typeof log.warn === "function") log.warn(msg); } catch (e) {} };
  const formOf = function () {
    try {
      return (svc.describe({ redactSecrets: true }) || []).find((d) => d && d.ns === entryId) || null;
    } catch (e) {
      warn("[dsh-remote-ssh] settings.describe 失败，本次按空配置处理: " + String(e && e.message ? e.message : e));
      return null;
    }
  };
  const valueOf = function () {
    const form = formOf();
    return form && form.value && typeof form.value === "object" ? form.value : null;
  };
  const write = async function (patch) {
    const form = formOf();
    await svc.update(entryId, patch, form ? form.revision : undefined);
  };
  let probed = false;
  return {
    formOf: formOf,
    face: {
      read: () => {
        // 只 describe 一次：既用于读数，也用于（首次）形状探针
        const form = formOf();
        const v = form && form.value && typeof form.value === "object" ? form.value : null;
        if (!probed) {
          probed = true;
          describePrefsShape(rawConfig, form, log, homeDir);
        }
        return {
          // 顺序：describe() 实时值 → apply(config) 的 volatile 引用 → 本次刚迁移进来的数据
          // （最后一项让「升级后第一次启动」立刻就能看到连接与工作区，不必等重启）
          profiles: prefsArray(v && v.profiles, rawConfig && rawConfig.profiles, migrated && migrated.profiles),
          workspaces: prefsArray(v && v.workspaces, rawConfig && rawConfig.workspaces, migrated && migrated.workspaces),
          // 标量偏好也一并回（issue #24 第二轮"可达性"）：设置面板要能显示/保存它们，
          // 更要紧的是 writeBackFailure / writeBackFreshness 的**运行时判断**读的就是这里。
          nodePath: String(prefsScalar("", v && v.nodePath, rawConfig && rawConfig.nodePath) || ""),
          writeBackFailure: String(prefsScalar("error", v && v.writeBackFailure, rawConfig && rawConfig.writeBackFailure) || "error"),
          writeBackFreshness: prefsScalar(true, v && v.writeBackFreshness, rawConfig && rawConfig.writeBackFreshness) !== false
        };
      },
      updateProfiles: (profiles) => write({ profiles: profiles }),
      updateWorkspaces: (workspaces) => write({ workspaces: workspaces }),
      updatePrefs: (patch) => write(patch)
    }
  };
}

/**
 * 一次性迁移旧 `settings.yaml` 里的 `dsh-remote-ssh` section。
 *
 * 旧版的 section 键是**包名**，而新版迁移按 **entry id** 导入，所以这一节会被留在
 * 重命名后的 `settings.yaml.imported` 里。只在用户层仍为空时导入 —— 绝不覆盖升级后
 * 设置的值；返回结果字符串便于日志与测试断言。
 */
async function migrateLegacyPrefs(opts) {
  const { svc, entryId, formOf, homeDir, ns, declaredKeys, log } = opts;
  const form = formOf();
  const user = form && form.user;
  if (user && typeof user === "object" && Object.keys(user).length > 0) return "already-configured";
  if (!homeDir) return "no-profile-home";
  const legacy = await readLegacyPrefs(homeDir, ns, declaredKeys, opts.readFileFn);
  if (!legacy) return "no-legacy-section";
  await svc.update(entryId, legacy);
  // 让调用方把刚导入的值放进内存兜底（第一次启动即可用，不必等重启）
  try { if (typeof opts.onImported === "function") opts.onImported(legacy); } catch (e) {}
  try { if (log && typeof log.info === "function") log.info("[dsh-remote-ssh] 已迁移旧设置: " + Object.keys(legacy).join(", ")); } catch (e) {}
  return "imported";
}

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
 * 只读 git 命令的远端环境（口径同 better-sidebar `readGit`）：固定 locale、禁惰性抓取、
 * 禁终端提示、不写 index 锁。git.status / git.graph 的远端脚本共用。
 */
const GIT_READ_ENV = "LC_ALL=C GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0 GIT_NO_LAZY_FETCH=1";
/** git.* 接管里的业务错误（带错误码，interceptGitHandler 的 catch 负责映射 HTTP 码）。 */
function gitReplyFail(message, code) {
  throw { code: code || "bad-request", message: message };
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
  // 性能 t3：非 tty 通道开启 SSH 内建压缩 —— 文件树/文件读取的 base64/文本载荷在高延迟
  // 公网链路（超算登录节点）上压缩收益显著（源码类 50%+），密文/二进制收益为零但无害；
  // tty（交互终端）保持默认，不给交互通道引入任何变量。
  if (!tty) opts.push("-o", "Compression=yes");
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

/** 诊断行白名单：这些行承载一手证据（认证方式、私钥加载、拒绝原因），任何降噪都必须保留。 */
const SSH_DIAG_LINE = /\b(debug\d+:|warning:|permission denied|authentications that can continue|offering public key|server accepts key|trying private key|no such identity|identity file|load key|passphrase|connection (refused|timed out|closed|reset)|could not resolve hostname|host key verification|banner)\b/i;

/** 服务端预认证登录横幅（sshd 的 `Banner` / `/etc/ssh/banner.txt`，常带二维码、框线画）降噪：
 *  它在**认证之前**由远端打印，与成败无关，却会把真正的诊断行挤出错误信息的截断窗口 ——
 *  用户会误以为「是扫码导致的连接失败」（issue #19）。
 *  判据：整行几乎只有装饰字符（框线 / 方块 / ASCII 画）时丢弃；诊断行与短行一律保留。 */
function stripLoginBanner(text) {
  let dropped = 0;
  const lines = String(text || "").split("\n").filter(function (line) {
    const s = line.trim();
    if (s === "") return true;                 // 空行留给后续压缩
    if (SSH_DIAG_LINE.test(s)) return true;    // 诊断行永远保留
    if (s.length < 12) return true;            // 短行可能是错误摘要，保留
    let art = 0;
    for (const ch of s) {
      if (/[\s\u2500-\u257F\u2580-\u259F]/.test(ch) || "#*+=_|/\\-~^<>.:;,\u2022\u25a0\u25a1".indexOf(ch) >= 0) art++;
    }
    if (art / s.length >= 0.85) { dropped++; return false; }
    return true;
  });
  const out = lines.join("\n");
  return dropped > 0 ? out + "\n（已省略服务端登录横幅 " + dropped + " 行：它在认证前打印，与本机认证结果无关）" : out;
}

/** 找出「配置的私钥文件不可读」的一手证据（issue #19 的真实根因，却只是 stderr 里一行 Warning）。
 *  返回 { path, line } 或 null。 */
function findMissingIdentityFile(text) {
  const t = String(text || "");
  const warn = /(Warning:\s*)?Identity file\s+"?([^"\n]+?)"?\s+not accessible[^\n]*/i.exec(t);
  if (warn) return { path: warn[2], line: warn[0].trim() };
  const dbg = /debug\d+:\s*no such identity:\s*(\S+?):?(?:\s|$)/i.exec(t);
  if (dbg) return { path: dbg[1], line: dbg[0].trim() };
  return null;
}

/** 远端允许的认证方式：优先取最终那行 `Permission denied (publickey,password,...)`，
 *  退而取 `Authentications that can continue: ...`。 */
function offeredAuthMethods(text) {
  const t = String(text || "");
  const denied = /permission denied \(([^)]*)\)/i.exec(t);
  if (denied && denied[1].trim()) return denied[1].trim();
  const cont = /authentications that can continue:\s*([^\n]*)/i.exec(t);
  return cont ? cont[1].trim() : "";
}

/** 给用户看的「原始信息」片段：**诊断行优先**，其余文本只在没有诊断行时兜底 ——
 *  避免二维码横幅把关键证据挤出 300 字截断窗口（issue #19）。 */
function sshExcerpt(text, limit) {
  const max = limit || 300;
  const lines = String(text || "").split("\n").map(function (l) { return l.trim(); }).filter(Boolean);
  const diag = [];
  for (const l of lines) if (SSH_DIAG_LINE.test(l) && diag.indexOf(l) < 0) diag.push(l);
  const picked = diag.length ? diag.slice(0, 8).join(" | ") : lines.join(" | ");
  return picked.length > max ? picked.slice(0, max) + "…" : picked;
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

/** find -printf '%Y\t%f\t%s\n' 的逐行结果 → { name, type, size }[]（单目录列举与批量列举共用）。 */
function collectFindEntries(lines, entries) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 2) continue;
    const nm = parts[1];
    if (nm === "." || nm === "..") continue;
    entries.push({ name: nm, type: parts[0] === "d" ? "directory" : "file", size: parts[2] ? (parseInt(parts[2], 10) || 0) : 0 });
  }
  return entries;
}

/** 目录在前、同类型按名字排序（与 better-sidebar 的 listDirectory 一致）。 */
function sortFindEntries(entries) {
  entries.sort(function (a, b) {
    return a.type === b.type ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : (a.type === "directory" ? -1 : 1);
  });
  return entries;
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
  const entries = sortFindEntries(collectFindEntries(String(r.stdout || "").split("\n"), []));
  lruPut(treeCache, key, { entries: entries, epoch: epoch, at: Date.now() }, TREE_CACHE_MAX);
  return { ok: true, path: target, entries: entries };
}

// ---------------------------------------------------------------------------
// 批量远端列举：一次 SSH 往返拿回 N 个目录（better-sidebar 0.23+ 的 fs.trees 端点）
//
// 背景（2026-09-29 用户报告「远程项目的侧边栏文件树显示本地目录」）：
//   · better-sidebar ≤ 0.22.1：文件树每展开一层发一次 `fs.tree`（N 次 POST）；
//   · better-sidebar 0.23/0.24 起：改为一次 `fs.trees` 批量请求「可见集」
//     （工作区根 + 所有已展开目录，≤64 条），客户端按返回的 level.path 落缓存。
//   本插件只注册了 `fs.tree` 的 exact 路由，于是 0.24 的树列举**绕过了拦截**、
//   落到 better-sidebar 自己的本地实现 → 文件树/打开文件都指向本地镜像目录。
//
// 实现上沿用 remoteListDir 的 find -printf 编码：逐目录打印标记行再列举，一次往返
// 拿回全部结果（保持上游「一次请求」的意图，而不是退化成 N 次 SSH）。某一层 cd 失败
// 只让该层带 error，整批仍然成功 —— 与上游的 levels-per-error 语义一致。
// ---------------------------------------------------------------------------
const BATCH_LEVEL_MARK = "__DSH_LVL__";
const BATCH_LEVEL_ERR = "__DSH_LVLERR__";

/** 批量列举：与 targets 等长、顺序一致的结果数组；命中 treeCache 的层 0 RTT。 */
async function remoteListDirsBatch(runner, p, targets) {
  const pk = profileKey(p);
  const epoch = cacheEpoch(pk);
  const now = Date.now();
  const out = new Array(targets.length);
  const pending = [];
  for (let i = 0; i < targets.length; i++) {
    const key = pk + "|" + String(targets[i]);
    const hit = lruGet(treeCache, key);
    if (hit && hit.epoch === epoch && now - hit.at <= TREE_CACHE_TTL_MS) out[i] = { ok: true, path: targets[i], entries: hit.entries.slice() };
    else {
      if (hit && hit.epoch !== epoch) treeCache.delete(key);
      pending.push(i);
    }
  }
  if (pending.length === 0) return out;
  const script = "( " + pending.map(function (i) {
    const q = shellQuotePath(targets[i]);
    return "printf '" + BATCH_LEVEL_MARK + "%s\\n' " + q +
      "; if cd " + q + " 2>/dev/null; then find . -maxdepth 1 -mindepth 1 -printf '%Y\\t%f\\t%s\\n' 2>/dev/null | sort; else echo '" + BATCH_LEVEL_ERR + "'; fi;";
  }).join(" ") + " )";
  const r = await runner(p, script, undefined, MAX_BYTES);
  if (!r.ok) {
    const err = (r.error || r.stderr || "").trim() || "读取目录失败";
    for (const i of pending) out[i] = { ok: false, error: err };
    return out;
  }
  // 按标记行分段：第 k 段对应 pending[k]（命令按同一顺序生成，无需再匹配路径文本）
  const segments = [];
  let cur = null;
  for (const line of String(r.stdout || "").split("\n")) {
    if (line.indexOf(BATCH_LEVEL_MARK) === 0) { cur = { error: "", entries: [] }; segments.push(cur); continue; }
    if (!cur) continue;
    if (line === BATCH_LEVEL_ERR) { cur.error = "读取目录失败"; continue; }
    collectFindEntries([line], cur.entries);
  }
  for (let k = 0; k < pending.length; k++) {
    const i = pending[k];
    const seg = segments[k];
    if (!seg || seg.error) { out[i] = { ok: false, error: (seg && seg.error) || "读取目录失败" }; continue; }
    const entries = sortFindEntries(seg.entries);
    lruPut(treeCache, pk + "|" + String(targets[i]), { entries: entries, epoch: epoch, at: Date.now() }, TREE_CACHE_MAX);
    out[i] = { ok: true, path: targets[i], entries: entries };
  }
  return out;
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
/** 远端 home 缓存（URL 打开用）：key = profileKey，TTL 10 分钟。
 *  VS Code 的 `ssh-remote+` URL 不经过 shell，`~` 不会被展开，必须在拼 URL 前换成绝对路径。 */
const REMOTE_HOME_TTL_MS = 600000;
/** 每个 profile 的缓存代（epoch）：插件侧任何变更（写/删/移/建目录/上传/syncUp/
 *  远程 exec/git）都 +1，条目按填充时代号校验 —— 兜底 mtime 秒级粒度的“同秒同 size”
 *  写、~/x 与 /home/u/x 路径字符串空间不一致、以及漏钩子场景（findings §4.3）。 */
const cacheEpochs = new Map();
const readCache = new Map();
const treeCache = new Map();
const remoteHomeCache = new Map();
/** git.status 响应 LRU（性能 t3）：远端一次 status 在大仓库（超算 zfs + untracked-files=all）
 *  实测 1.5~4s，而 0.28.0 客户端在文件操作后会 invalidate→立即重取同一仓库，同秒内反复打。
 *  TTL 内 0 RTT；epoch 感知 —— 任何写/删/移/exec/git 变更都 bumpCacheEpoch → 立即失效，
 *  所以缓存只在「没有任何写动作」的窗口内生效（与 readCache/treeCache 同一纪律）。
 *  只缓存远端分支：本机 git 是进程内子进程，本来就不是瓶颈。 */
const GIT_STATUS_CACHE_TTL_MS = 5000;
const GIT_STATUS_CACHE_MAX = 16;
const gitStatusCache = new Map();

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

/** 是否已是绝对路径（Windows 盘符、UNC 或 POSIX 斜杠开头）。 */
function isAbsoluteLocalPath(p) {
  return typeof p === "string" && (p.charAt(0) === "/" || /^[A-Za-z]:[\\/]/.test(p) || /^\\\\/.test(p));
}

/**
 * 把"可能是相对路径"的请求路径按**会话工作目录**归一 —— 语义对齐被接管的 dsh-better-sidebar 原实现
 * （`ensureWorkspacePath(sessionCwd / worktree 根, raw)`）：绝对路径原样返回，相对路径按会话 cwd 拼接。
 *
 * 为什么必须有（issue #25）：本插件以 `kind: "exact"` 接管了 `/sidebar/file` 与 `/sidebar/api/fs.*`，
 * **本地会话也走这里**；把相对路径原样交给 fs，Node 会按**插件宿主进程的 process.cwd()**
 * （pnpm profile 目录）解析 → `cannot read: ENOENT …\\.dsh\\profiles\\desktop\\tools\\x.py`。
 * 绝对路径不受影响，所以用户侧表现为"部分文件打不开"，几乎无法自查。
 * 写操作更危险：`fs.write` / `fs.remove` 拿到相对路径会在**插件宿主目录**里写/删。
 *
 * base 为空时**不猜**（返回 `resolved: false`，由调用方报一条能看懂的错误）——
 * 静默落到宿主目录正是这个 bug 的表现，绝不能保留成兜底。
 * base 必须是**绝对路径**：客户端传来的 cwd 不可信（上游 `sessionCwdOf` 用 `requireAbsolute()` 挡同样的事，
 * 连 `C:foo` 这种盘符相对形式都拒），否则 `join(相对 base, …)` 拼出来的仍是相对路径，fs 又会按
 * `process.cwd()` 解析 —— 等于把 bug 放回来。
 * 以 `~` 开头的一律原样返回：它不是本插件能解释的语义，交给 fs 报错，好过拼出 `base/~/x` 这种错路径。
 */
function resolveSessionPath(raw, base) {
  const p = raw === undefined || raw === null ? "" : String(raw);
  if (p === "") return { path: "", resolved: false, reason: "empty" };
  if (isAbsoluteLocalPath(p)) return { path: p, resolved: true, reason: "absolute" };
  if (p.charAt(0) === "~") return { path: p, resolved: false, reason: "unexpanded-tilde" };
  const b = base === undefined || base === null ? "" : String(base);
  if (b === "") return { path: p, resolved: false, reason: "no-base" };
  if (!isAbsoluteLocalPath(b)) return { path: p, resolved: false, reason: "relative-base" };
  return { path: join(b, p), resolved: true, reason: "joined" };
}

/** `resolveSessionPath` 失败时的用户可见说明（统一口径，便于测试与排查）。 */
function unresolvedPathMessage(raw, base, reason) {
  const where = String(raw || "");
  if (reason === "empty") return "path 为必填项";
  if (reason === "unexpanded-tilde") return "不支持的路径写法（不支持 ~ 展开）: " + where + "（请改用绝对路径）";
  if (reason === "relative-base") return "无法解析相对路径 \"" + where + "\"：工作目录 \"" + String(base == null ? "" : base) + "\" 不是绝对路径" +
    "。请改用绝对路径，或在请求里带上绝对的 cwd。";
  return "无法解析相对路径 \"" + where + "\"：请求里没有 cwd，也取不到会话的工作目录" +
    (base === undefined || base === null || base === "" ? "" : "（收到的工作目录为空）") +
    "。请改用绝对路径，或在请求里带上 cwd / sessionId。";
}

/**
 * 本地镜像根目录（`<home>/.dsh/remote-workspaces`）。远程工作区的镜像目录都建在它下面
 * （`mirrorDir = join(mirrorBaseDir(), wsId)`，见 addRemoteWorkspace）。集中一处，避免各写一遍后漂移。
 */
function mirrorBaseDir() {
  return join(homedir(), ".dsh", "remote-workspaces");
}

/**
 * 这个绝对路径是否落在**镜像根之下**（不论它是否还属于某个已注册的远程工作区）。
 *
 * 用途（2.4.29）：绝对路径 + 取不到会话 cwd + 前缀匹配不到已注册工作区时，宁可明确报错，
 * 也不要在镜像目录上"当成本地路径"读写 —— 那正是 issue #25 修掉的那类错位（写/删落在错地方）。
 */
function isUnderMirrorBase(absPath) {
  // Windows 路径大小写无关，POSIX 有关（与 localPathIdentity 同口径：不在 POSIX 上做小写化，
  // 否则 `.../Remote-Workspaces/...` 会被误判成镜像路径）。
  const fold = process.platform === "win32" ? (s) => s.toLowerCase() : (s) => s;
  const norm = (p) => fold(String(p || "").replace(/\\/g, "/").replace(/\/+$/, ""));
  const p = norm(absPath);
  if (p === "") return false;
  const base = norm(mirrorBaseDir());
  return p === base || p.startsWith(base + "/");
}

/**
 * 请求路径的**语法**分类（issue #26；纯函数，不查工作区）。
 * 返回 `"win-abs" | "win-unc" | "posix-abs" | "tilde" | "relative" | "empty"`。
 *
 * 为什么需要它：`isAbsoluteLocalPath()` 在 Windows 上把 `/tmp/x` 也判成绝对路径，但这三类
 * 绝对路径的归属完全不同 —— 盘符与 UNC 只可能是**本机**路径，以 `/` 开头（且不是 UNC）的则
 * 可能是**远端**路径。把它们混为一谈正是 issue #26 的成因：会话在远程工作区时，本机绝对路径
 * 被推到远端、远端绝对路径被再拼一次远端根。
 */
function classifyRequestPathSyntax(raw) {
  if (typeof raw !== "string" || raw === "") return "empty";
  if (/^[A-Za-z]:/.test(raw)) return "win-abs";                     // C:\… / C:/…（含盘符相对 C:foo）
  if (raw.startsWith("\\\\") || raw.startsWith("//")) return "win-unc";
  if (raw.startsWith("/")) return "posix-abs";                      // 远端绝对路径（在 Windows 本机没有对应文件）
  if (raw === "~" || raw.startsWith("~/") || raw.startsWith("~\\")) return "tilde";
  return "relative";
}

/** 是否"看起来就是一条远端绝对路径"（只对以 `/` 开头、且不是 UNC 的路径成立）。 */
function looksLikeRemoteAbsolutePath(raw) {
  return classifyRequestPathSyntax(raw) === "posix-abs";
}

// ---- better-sidebar 0.25.0 新端点的纯函数（规则与上游逐条对齐，便于单测）----
// 0.25.0 新增 fs.createFile 与 7 个 git.* 端点；其中 6 个与路径/仓库相关，必须由本插件接管
// （否则远程工作区会落到本地镜像上，见 CHANGELOG 2.4.28 与 MAINTENANCE 的"升级后必做对拍"）。

/** 上游 `ILLEGAL_FILE_NAME_CHARS`：Windows 文件名里不允许出现的字符。 */
const ILLEGAL_FILE_NAME_CHARS = /[<>:"|?*]/;

/**
 * 返回文件名里第一个"存不进文件系统"的字符，没有则 undefined。
 * 按码点迭代（不是按 UTF-16 下标），这样合法 emoji 名不会被误判成两个非法半字符。
 */
function firstIllegalNameChar(name) {
  for (const ch of String(name)) {
    if (ILLEGAL_FILE_NAME_CHARS.test(ch)) return ch;
    const cp = ch.codePointAt(0);
    if (typeof cp === "number" && cp < 32) return ch;
  }
  return undefined;
}

/**
 * Windows 保留设备名：每个目录下都保留，**带不带扩展名都算**
 * （`NUL.txt`、`NUL.tar.gz` 都指向设备，所以只看第一个点之前的段，大小写无关）。
 */
const RESERVED_FILE_NAMES = new Set(["con", "prn", "aux", "nul"].concat(
  Array.from({ length: 9 }, function (_, i) { return "com" + (i + 1); }),
  Array.from({ length: 9 }, function (_, i) { return "lpt" + (i + 1); })
));

/**
 * 新建文件名校验（对齐上游 `assertCreatableFileName` 的三条规则）：
 * 单段名 + 无非法字符 + 非 Windows 保留设备名。
 * 返回 "" 表示可用，否则返回**用户可见**的原因（上游文案，客户端会直接显示）。
 */
function creatableFileNameProblem(name) {
  const n = name === undefined || name === null ? "" : String(name);
  if (n === "" || n === "." || n === ".." || n.indexOf("/") >= 0 || n.indexOf("\\") >= 0) {
    return "name must be a single path segment";
  }
  const illegal = firstIllegalNameChar(n);
  if (illegal !== undefined) {
    return "name contains a character that is not allowed in a file name: " + JSON.stringify(illegal);
  }
  if (RESERVED_FILE_NAMES.has(n.split(".")[0].toLowerCase())) {
    return "\"" + n + "\" is a reserved device name on Windows";
  }
  return "";
}

/** 上游 `isoWithOffset`：`author-time` + `author-tz` → 带偏移的 ISO 串（无时区则用 Z）。 */
function isoWithOffset(seconds, timezone) {
  const zone = /^([+-])(\d{2})(\d{2})$/.exec(String(timezone || ""));
  const offsetMinutes = zone === null ? 0 : (zone[1] === "-" ? -1 : 1) * (Number(zone[2]) * 60 + Number(zone[3]));
  const shifted = new Date((seconds + offsetMinutes * 60) * 1000);
  function pad(value) { return String(value).padStart(2, "0"); }
  const stamp = shifted.getUTCFullYear() + "-" + pad(shifted.getUTCMonth() + 1) + "-" + pad(shifted.getUTCDate()) +
    "T" + pad(shifted.getUTCHours()) + ":" + pad(shifted.getUTCMinutes()) + ":" + pad(shifted.getUTCSeconds());
  return zone === null ? stamp + "Z" : stamp + zone[1] + zone[2] + ":" + zone[3];
}

/**
 * 上游 `parseBlamePorcelain`：`git blame --porcelain` 输出 → `[{hash, line, author, date, summary}]`。
 * 同一 commit 只有在**第一次**出现时解析 author/date/summary，后续行复用（上游的 `seen` 表语义，
 * porcelain 只在首个块里给完整信息），所以这里必须保持"先到先记"的写法。
 */
function parseBlamePorcelain(output) {
  const rows = [];
  const seen = new Map();
  const lines = String(output || "").split("\n");
  let index = 0;
  while (index < lines.length) {
    const header = /^([0-9a-f]{40,64}) \d+ (\d+)(?: \d+)?$/.exec(lines[index]);
    if (header === null) { index += 1; continue; }
    const hash = header[1];
    const line = Number(header[2]);
    index += 1;
    let author;
    let date;
    let summary;
    while (index < lines.length && lines[index].charAt(0) !== "\t") {
      const text = lines[index];
      index += 1;
      if (text.indexOf("author ") === 0) author = text.slice(7);
      else if (text.indexOf("author-time ") === 0) {
        const seconds = Number(text.slice(12));
        const zone = /^author-tz (.+)$/.exec(lines[index] === undefined ? "" : lines[index]);
        if (Number.isFinite(seconds)) date = isoWithOffset(seconds, zone === null ? "" : zone[1]);
      } else if (text.indexOf("summary ") === 0) summary = text.slice(8);
    }
    if (index < lines.length && lines[index].charAt(0) === "\t") index += 1;
    const known = seen.get(hash);
    if (known === undefined) {
      const record = { author: author === undefined ? "" : author, date: date === undefined ? "" : date, summary: summary === undefined ? "" : summary };
      seen.set(hash, record);
      rows.push({ hash: hash, line: line, author: record.author, date: record.date, summary: record.summary });
    } else {
      rows.push({ hash: hash, line: line, author: known.author, date: known.date, summary: known.summary });
    }
  }
  return rows;
}

/**
 * 上游 `parseWorktreeList`：`git worktree list --porcelain` → `[{path, branch, locked, prunable}]`。
 * `-z` 输出用 NUL 分隔、普通输出用换行，两种都能吃（上游同样按分隔符自适应）。
 */
function parseWorktreeList(output) {
  const rows = [];
  let path;
  let branch = "HEAD";
  let locked = false;
  let prunable = false;
  function flush() {
    if (path !== undefined) rows.push({ path: path, branch: branch, locked: locked, prunable: prunable });
    path = undefined;
    branch = "HEAD";
    locked = false;
    prunable = false;
  }
  const raw = String(output || "");
  const sep = raw.indexOf("\0") >= 0 ? "\0" : "\n";
  const framed = raw.endsWith(sep) ? raw : raw + sep;
  for (const line of framed.split(sep)) {
    if (line === "") flush();
    else if (line.indexOf("worktree ") === 0) path = line.slice(9);
    else if (line.indexOf("branch refs/heads/") === 0) branch = line.slice(18);
    else if (line === "locked" || line.indexOf("locked ") === 0) locked = true;
    else if (line === "prunable" || line.indexOf("prunable ") === 0) prunable = true;
  }
  return rows;
}

/**
 * `git status --porcelain=v1 -z` 的条目数（`git.worktrees` 的 `changes` 徽标）。
 * 改名/复制的记录占**两条** NUL 记录（`R  new\0old\0`），只算一条 —— 与上游
 * `status().entries.length` 的口径一致，所以必须吃掉原路径那条。
 */
function countStatusEntries(raw) {
  const s = String(raw || "");
  if (s === "") return 0;
  const tokens = s.split("\0");
  let count = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "" || !/^[ MADRCU?!]{2} /.test(t)) continue;
    count += 1;
    const x = t.charAt(0);
    const y = t.charAt(1);
    if (x === "R" || x === "C" || y === "R" || y === "C") i += 1;
  }
  return count;
}

/** 路径同一性（远端 POSIX 侧）：去掉尾部斜杠后逐字比较。 */
function posixPathIdentity(p) {
  return String(p || "").replace(/\/+$/, "");
}

/** 路径同一性（本机侧）：与上游 `pathIdentity` 同规则，Windows 下大小写无关。 */
function localPathIdentity(p) {
  const s = String(p || "").replace(/[\\/]+$/, "");
  return process.platform === "win32" ? s.toLowerCase() : s;
}

/**
 * 解析 better-sidebar 0.24 的 `open.external` URL（自定义协议：vscode://、cursor://、zed://…）。
 * 与上游 validateExternalUrl 同规则：必须是 `scheme://` 形态且不是 http/https
 * （http 类会被上游拒掉：那种 URL 只该开浏览器标签，不该走宿主打开器）。
 * 返回 { scheme, authority, path }（path 已百分号解码）或 null。
 */
function parseExternalUrl(raw) {
  const url = String(raw || "");
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)/i.exec(url);
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  if (scheme === "http" || scheme === "https") return null;
  let path = m[3] || "";
  try { path = decodeURIComponent(path); } catch (e) { /* 含裸 % 的路径：按原样处理 */ }
  return { scheme: scheme, authority: m[2] || "", path: path };
}

/**
 * 从 `vscode://file/C:/Users/...`（或 `vscode://file//home/u/...`）还原本地绝对路径。
 * 非 file 形态（如 vscode-remote、自定义 authority）返回 null —— 交给本机打开器原样处理。
 */
function localPathFromExternalUrl(parsed) {
  if (!parsed) return null;
  const auth = String(parsed.authority || "").toLowerCase();
  if (auth !== "" && auth !== "file" && auth !== "localhost") return null;
  let p = String(parsed.path || "");
  if (/^\/[A-Za-z]:[\\/]/.test(p)) p = p.slice(1); // /C:/Users/... → C:/Users/...
  if (p.startsWith("//")) p = p.slice(1);          // //home/u → /home/u（POSIX 形态）
  return p;
}

/**
 * VS Code Remote-SSH 的 host 段：优先取 ~/.ssh/config 里与本连接「同名或同 HostName + 同端口 + 用户兼容」
 * 的别名（别名能让 VS Code 复用 Port/User/IdentityFile/ProxyJump，端口非 22 或走跳板机时也能连上）。
 * 没有别名时，标准端口退化为 `user@host`；否则返回 null（调用方回退本机打开并告警）。
 */
function remoteEditorAuthority(profile, hosts) {
  const host = String((profile && profile.host) || "").toLowerCase();
  if (!host) return null;
  const port = Number((profile && profile.port) || 22);
  const user = String((profile && profile.user) || "").toLowerCase();
  for (const h of hosts || []) {
    const name = String((h && h.name) || "");
    if (!name) continue;
    const portOk = Number((h && h.port) || 22) === port;
    if (!portOk) continue;
    const cfgUser = String((h && h.user) || "").toLowerCase();
    if (cfgUser && user && cfgUser !== user) continue;
    const hostName = String((h && h.hostName) || "").toLowerCase();
    if (hostName === host || name.toLowerCase() === host) return name;
  }
  if (port === 22 && user) return user + "@" + String(profile.host);
  return null;
}

/**
 * 远端编辑器 URL：`<scheme>://vscode-remote/ssh-remote+<别名><远端路径>`。
 * 该形态正是 better-sidebar 客户端认定的「在客户端机器上打开」（shouldOpenExternalOnClient）。
 */
function remoteEditorUrl(scheme, authority, remotePath) {
  const p = "/" + String(remotePath || "").replace(/^\/+/, "");
  return String(scheme || "vscode") + "://vscode-remote/ssh-remote+" + String(authority || "") + encodeURI(p);
}

/**
 * 把工作区 remotePath 规范成 VS Code Remote-SSH URL 能用的路径。
 * URL **不经过 shell**，所以 `~` 不会被展开 —— 必须在这里换成远端 home；
 * 相对路径按「登录 shell 起始目录 = home」展开（与本插件其它命令的 cd 行为一致）。
 * `~user` 形态需要额外查询且极少用 → 返回 null，让调用方回退本机行为。
 */
function expandRemotePathForUrl(remotePath, home) {
  const p = String(remotePath || "");
  const base = home ? String(home).replace(/\/+$/, "") : "";
  if (!p) return base || null;
  if (p.startsWith("~")) {
    if (!(p === "~" || p.startsWith("~/"))) return null;
    if (!base) return null;
    const rest = p.slice(1).replace(/^\/+/, "");
    return rest ? base + "/" + rest : base;
  }
  if (p.startsWith("/")) return p;
  if (!base) return null;
  return base + "/" + p.replace(/^\/+/, "");
}

/**
 * 本机打开命令（与 better-sidebar 的 revealCommand / urlCommand 同形；argv 数组，无 shell 参与）。
 * kind = "reveal"（在系统文件管理器中定位）| "url"（交给协议处理器）。
 */
function openerCommand(kind, value, platform) {
  const v = String(value || "");
  if (kind === "reveal") {
    if (platform === "darwin") return { command: "open", args: ["-R", v] };
    if (platform === "win32") return { command: "explorer.exe", args: ["/select," + v] };
    return { command: "xdg-open", args: [posixDirname(v) || v] };
  }
  if (platform === "darwin") return { command: "open", args: [v] };
  if (platform === "win32") return { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", v] };
  return { command: "xdg-open", args: [v] };
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

/** 分页读命令（better-sidebar 0.26.1 的 fs.readPage）：一次往返拿 size/mtime + 该页字节。
 *  只读 offset 起的 pageBytes 字节（tail -c +N 是 1-based，故 +1），base64 与其他读命令一致；
 *  页尾回退到最后一个换行在**本地**做（远端只负责给字节），保证本地/远端两个分支返回同一形状。 */
function buildReadPageCommand(path, offset, pageBytes) {
  const start = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
  const readPart = "if [ \"${st%% *}\" -gt " + start + " ] 2>/dev/null; then tail -c +" + (start + 1) +
    " -- \"$f\" | head -c " + pageBytes + " | base64 -w0; fi";
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
 * 写回桥专用：把内容写到远端文件，**超过 4 MiB 也不再失败**（issue #24）。
 *
 * `remoteWriteFile` 有一条 `MAX_BYTES`（4 MiB）的硬上限 —— 对模型显式调用的
 * `remote_ssh_write` 是合理的契约，但写回桥是**后台**同步：日志、CSV、notebook 一旦越线，
 * 远端就静默没有这个文件（issue #24 的主线场景）。这里改成**分块** base64 追加：
 *   - 块大小取 3 MiB（3 的倍数 → 每块 base64 都不带 padding，可以直接切片拼接，
 *     拼出来的字节与整块编码逐字节相同）；
 *   - 先按 UTF-8 编码成 Buffer 再切**字节**（按 JS 码元切会劈开代理对，多字节字符会坏）；
 *   - 首块 `>`、后续 `>>`；任一块失败即返回失败（并作废缓存）；
 *   - 最后用 `wc -c` 校验远端字节数，防止"命令都成功但文件被截断"。
 * 小文件仍走原路径（一次 base64，行为与 2.4.23 完全一致）。
 */
async function remoteWriteFileChunked(runner, p, path, content) {
  if (!path) return { ok: false, error: "path 为必填项" };
  const c = content !== undefined ? String(content) : "";
  const buf = Buffer.from(c, "utf8");
  if (buf.length <= MAX_BYTES) return remoteWriteFile(runner, p, path, c);
  const CHUNK = 3 * 1024 * 1024;                      // 3 的倍数：base64 无 padding，可拼接
  for (let off = 0; off < buf.length; off += CHUNK) {
    const chunk = buf.subarray(off, Math.min(off + CHUNK, buf.length));
    const cmd = "base64 -d " + (off === 0 ? "> " : ">> ") + shellQuotePath(path);
    let r;
    try { r = await runner(p, cmd, chunk.toString("base64"), MAX_BYTES, true); } catch (e) {
      r = { ok: false, error: syncErrText(e) };
    }
    if (!r || !r.ok) {
      invalidateRemoteCaches(p, path, { subtree: false });
      return {
        ok: false, exitCode: (r && r.exitCode) || -1, stdout: "", stderr: (r && r.stderr) || "",
        error: "分块写入第 " + (Math.floor(off / CHUNK) + 1) + "/" + Math.ceil(buf.length / CHUNK) +
          " 块失败（远端文件可能已被截断）：" + String((r && (r.error || r.stderr)) || "未知错误").slice(0, 300)
      };
    }
  }
  // 校验：远端字节数必须与本地一致（分块写入最容易出的问题就是少一块/被截断）
  let st = null;
  try { st = await runner(p, "wc -c < " + shellQuotePath(path), undefined, MAX_BYTES, false); } catch (e) {}
  const got = st && st.ok ? parseInt(String(st.stdout || "").trim(), 10) : NaN;
  invalidateRemoteCaches(p, path, { subtree: false });
  if (!Number.isFinite(got)) return { ok: false, exitCode: -1, stdout: "", stderr: "", error: "分块写入后无法确认远端字节数（内容已全部发送，但完整性未验证）" };
  if (got !== buf.length) {
    return { ok: false, exitCode: -1, stdout: "", stderr: "", error: "分块写入后远端字节数不一致：远端 " + got + " 字节，本地 " + buf.length + " 字节" };
  }
  return { ok: true, exitCode: 0, stdout: "", stderr: "", error: "", chunked: true, bytes: buf.length };
}

/**
 * 写回**之前**的"远端新鲜度"记录 —— issue #24 护栏 B（2.4.25）。
 *
 * 问题（举报人给的现场，2026-10-11）：镜像 → 远端的写回是单向的。共享集群上最常见的
 * 写入者不是别人，而是**你自己刚跑完的作业**：作业在远端改了 `results/*.csv`，镜像里还是
 * 提交前的版本，agent 基于这份陈旧副本再写一次 —— 就直接把远端的新内容静默覆盖了。
 * 而且 `replaceIfVersion` 的版本比对针对的是**本地镜像**，模型看到的是"检查过、写入成功"，
 * 于是形成"看起来有保护"的错觉（这是举报人特别点出的一条）。
 *
 * 判据（按举报人的建议，**只在远端自己的时间轴上自比**，不与本地 mtime 比 —— 跨机时钟偏移
 * 与 tar/base64 重写都会让两条时间轴不可比）：
 *   ① 每次推送成功后，读一次远端 `stat -c'%s %Y'`，把 `size:mtime` 存进下面的 JSON；
 *   ② 下次推同一个路径前再读一次，与记录不同 ⇒ 远端被改过 ⇒ **不推送**，并把决定权交回模型
 *      （报错文案里给出 remote_ssh_sync / remote_ssh_push 两条出路）。
 * 顺带把 size 一起存：同秒内的改动多半会改长度，白拿一档更强的判据（举报人只提了 mtime）。
 *
 * 状态很轻（每路径一个字符串），放在 `~/.dsh/remote-ssh/writeback-mtimes.json`（与终端
 * wrapper 同目录）。**读不到就当作"没有记录"** —— 一律按"可以推"处理，绝不因为状态文件
 * 损坏而挡住正常写入；只有"读得到远端、且与记录不符"这一种情况才拦。
 * 处理 push / sync 之后要**忘掉**记录（见 forget 调用点）：那时镜像与远端已经一致。
 */
function freshnessFile(stateDir) { return join(stateDir, "writeback-mtimes.json"); }

let freshnessCache = null; // { file, data: { [profileId]: { [remotePath]: "size:mtime" } } }

function freshnessLoad(stateDir) {
  const file = freshnessFile(stateDir);
  if (freshnessCache && freshnessCache.file === file) return freshnessCache.data;
  let data = {};
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    if (j && typeof j === "object" && !Array.isArray(j)) data = j;
  } catch (e) {}
  freshnessCache = { file: file, data: data };
  return data;
}

function freshnessSave(stateDir, data) {
  const file = freshnessFile(stateDir);
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(file, JSON.stringify(data), "utf8");
    freshnessCache = { file: file, data: data };
  } catch (e) { freshnessCache = { file: file, data: data }; }
}

/** 取某路径上次推送后记录的 `size:mtime`；没有记录（或状态坏了）返回空串。 */
function freshnessGet(stateDir, profileId, remotePath) {
  try {
    const byProfile = freshnessLoad(stateDir)[profileId];
    const v = byProfile && byProfile[remotePath];
    return typeof v === "string" ? v : "";
  } catch (e) { return ""; }
}

function freshnessSet(stateDir, profileId, remotePath, stamp) {
  try {
    const data = freshnessLoad(stateDir);
    const byProfile = data[profileId] && typeof data[profileId] === "object" ? data[profileId] : {};
    byProfile[remotePath] = String(stamp);
    data[profileId] = byProfile;
    freshnessSave(stateDir, data);
  } catch (e) {}
}

function freshnessForget(stateDir, profileId, remotePath) {
  try {
    const data = freshnessLoad(stateDir);
    const byProfile = data[profileId];
    if (!byProfile || !(remotePath in byProfile)) return;
    delete byProfile[remotePath];
    freshnessSave(stateDir, data);
  } catch (e) {}
}

/** 忘掉整个 profile 的记录 —— 用在 push / sync 成功之后（那时镜像与远端已一致）。 */
function freshnessForgetProfile(stateDir, profileId) {
  try {
    const data = freshnessLoad(stateDir);
    if (!data[profileId]) return;
    delete data[profileId];
    freshnessSave(stateDir, data);
  } catch (e) {}
}

/**
 * 读远端的 `size:mtime`（`stat -c'%s %Y'`，与本插件既有的 stat 形状一致 ——
 * 远端要求 GNU 工具集，这一条 `find -printf` / `stat -c` 早就隐含了）。
 * 返回值三态，调用方必须区分，别把"读不到"当成"被改过"：
 *   { ok:true,  exists:true,  stamp:"12345:1760000000" }   —— 读到了
 *   { ok:true,  exists:false, err:"..." }                  —— 远端确实没有这个文件
 *   { ok:false, exists:false, err:"..." }                  —— 读失败（连接/权限），状态未知
 */
async function remoteMtimeInfo(runner, p, remotePath) {
  let r = null;
  try { r = await runner(p, "stat -c'%s %Y' " + shellQuotePath(remotePath), undefined, 65536, false); } catch (e) {
    return { ok: false, exists: false, stamp: "", err: syncErrText(e) };
  }
  const out = String((r && r.stdout) || "").trim();
  const errText = String((r && (r.stderr || r.error)) || "").trim();
  const m = /^(\d+)\s+(\d+)$/.exec(out);
  if (r && r.ok && m) return { ok: true, exists: true, stamp: m[1] + ":" + m[2], err: "" };
  if (/No such file|not found|cannot stat|cannot statx/i.test(errText + " " + out)) {
    return { ok: true, exists: false, stamp: "", err: errText.slice(0, 200) };
  }
  return { ok: false, exists: false, stamp: "", err: (errText || out).slice(0, 200) };
}

/**
 * 护栏 B 的判据本身（纯函数，便于单独验证）：把"上次推送后记录的 `size:mtime`"与"这次读到的
 * 远端状态"比一下。三态，**第三态最要紧**：
 *   - 相同          → 没被改过，照常推送
 *   - 不同 / 已消失 → 被别的写入者改过（或删了）→ 不推送，报告
 *   - 读失败        → **状态未知**，不能当成"被改过"：连接抖一下就把写入拦下来是错的
 */
function freshnessVerdict(prevStamp, before) {
  const prev = String(prevStamp || "");
  if (!prev) return { changed: false, unknown: false, why: "" };
  if (before && before.ok && before.exists) {
    if (String(before.stamp) === prev) return { changed: false, unknown: false, why: "" };
    return {
      changed: true, unknown: false,
      why: "远端 size:mtime 已变（我们上次推送后记录 " + prev + "，现在 " + before.stamp + "）"
    };
  }
  if (before && before.ok && !before.exists) {
    return { changed: true, unknown: false, why: "远端这份已经不存在了（我们上次推送过，之后被删除或改名）" };
  }
  return { changed: false, unknown: true, why: String((before && before.err) || "未知原因") };
}

/**
 * 护栏 B 的**处置**（纯函数，行为可单测）：把判据结果 + 失败模式翻译成"推 / 拦 / 抛"，
 * 并把要给人看的文本一并产出 —— 调用方只负责照做，不再自己拼文案。
 *   action: "push"（照常推送） | "block"（不推送）
 *   fail:   仅当 action === "block" 且模式为 error（= 把 message 抛给模型）
 * 为什么单独抽出来（issue #24 结案时举报人点出的"未覆盖"）：这段原先埋在 `apply()` 的闭包里，
 * 测试只能做源码形状断言 —— 而"log 模式下写入应当返回成功"这条**行为**从来没被观测过。
 * 抽成纯函数后，三态 × 两种模式都能在测试里直接跑（tests/fs-write-bridge.test.mjs 的 E5）。
 */
function freshnessGuardPlan(prevStamp, before, mode, remoteFile) {
  const verdict = freshnessVerdict(prevStamp, before);
  const file = String(remoteFile || "");
  if (!verdict.changed && !verdict.unknown) return { action: "push", verdict, logLine: "", message: "", fail: false };
  if (verdict.unknown) {
    // 读失败 = 状态未知 ≠ 被改过：照常推送，只留一行日志（把 flaky 连接变成"拦住写入"是错的）
    return {
      action: "push", verdict, fail: false, message: "",
      logLine: "[dsh-remote-ssh] 无法确认远端状态，本次仍推送: " + file + " — " + verdict.why
    };
  }
  return {
    action: "block", verdict, fail: mode === "error",
    logLine: "[dsh-remote-ssh] 远端已被改动，本次不推送（护栏 B）: " + file + " — " + verdict.why,
    message:
      "本地镜像已写入成功，但**没有推送到远端**：远端这一份自上次同步后已被改动。\n" +
      "  远端文件: " + file + "\n" +
      "  依据: " + verdict.why + "\n" +
      "  含义: 远端有别的写入者改过它（共享集群上最常见的不是别人，正是你自己刚跑完的作业）；\n" +
      "        直接推上去会静默覆盖那些改动，所以这里只报告、不动远端。\n" +
      "  处理: 先 remote_ssh_sync 把远端拉下来比对；确认要以本地为准，用 remote_ssh_push 覆盖。\n" +
      "  若希望每次都无条件覆盖，设置 writeBackFreshness: false（或环境变量\n" +
      "  DSH_REMOTE_SSH_WRITEBACK_FRESHNESS=off）。"
  };
}

/**
 * 把 plan 落成调用方要做的动作：`{ pushed, err }`。
 * 调用方据此"继续推送 / 静默返回 / 抛出" —— 判断都在这里，所以"log 模式下不抛"是**返回值**，
 * 而不是埋在闭包里的控制流（这正是举报人标为"未覆盖"的那条行为）。
 */
function applyFreshnessPlan(plan) {
  if (!plan || plan.action !== "block") return { pushed: true, err: null };
  if (!plan.fail) return { pushed: false, err: null };
  const err = new Error(plan.message);
  err.dshRemoteSshWriteBack = true;   // 写回桥只把带这个标记的错误继续上抛给模型
  return { pushed: false, err };
}

/**
 * 护栏 B 的完整检查：读记录 → stat 远端 → 判定 → 记日志。
 * `runner` / `stateDir` / `log` 都可注入，所以测试能用假 runner 走完整条链（含 log 模式不抛）。
 * 没有记录时**不花那次往返**，直接放行（首次推该路径、或状态文件被删）。
 */
async function freshnessGuardCheck(opts) {
  const o = opts || {};
  const log = typeof o.log === "function" ? o.log : null;
  const prevStamp = freshnessGet(o.stateDir, o.profileId, o.remoteFile);
  if (!prevStamp) return { action: "push", verdict: { changed: false, unknown: false, why: "" }, logLine: "", message: "", fail: false };
  const before = await remoteMtimeInfo(o.runner, o.profile, o.remoteFile);
  const plan = freshnessGuardPlan(prevStamp, before, o.mode, o.remoteFile);
  if (log && plan.logLine) { try { log(plan.logLine); } catch (e) {} }
  // log 模式（fail=false）下模型看不到工具报错，所以那份带补救步骤的长文案必须落在日志里，
  // 否则"只报告、不推送"就变成了"连报告都没有"。
  if (log && plan.action === "block" && !plan.fail && plan.message) { try { log(plan.message); } catch (e) {} }
  return plan;
}

/**
 * 把 glob 模式转成锚定整个路径的正则：`**` 跨目录、`*` 不跨目录、`?` 单字符（`/` 除外）。
 * 写回桥的 `writeBackExclude` 用它；语义与 shell 通配相近，但**整路径匹配**（不是子串）。
 */
function globToRegExp(pattern) {
  const src = String(pattern || "").replace(/\\/g, "/");
  let re = "";
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "*") {
      if (src[i + 1] === "*") { re += ".*"; i++; if (src[i + 1] === "/") i++; }   // ** 或 **/
      else re += "[^/]*";
    } else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$");
}

/** 镜像相对路径（POSIX 风格）是否命中任一排除模式；目录写法（结尾带 /）按前缀匹配。 */
function matchAnyGlob(patterns, relPosix) {
  const rel = String(relPosix || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!rel) return false;
  for (const raw of patterns || []) {
    const pat = String(raw || "").trim();
    if (!pat) continue;
    if (pat.endsWith("/")) { if (rel === pat.slice(0, -1) || rel.startsWith(pat)) return true; continue; }
    try { if (globToRegExp(pat).test(rel)) return true; } catch (e) {}
  }
  return false;
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

function syncErrText(e) { return String(e && e.message ? e.message : e); }

/** 人类可读体积（哨兵报错里用）。 */
function formatSyncBytes(n) {
  if (!Number.isFinite(n) || n < 0) return "?";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (i === 0 ? String(n) : v.toFixed(1)) + " " + units[i];
}

/** 相对路径归一化：拒绝绝对路径 / `~` / 含 `..` 的越界规则（丢弃，不进 tar 参数）。 */
function syncRelPath(raw) {
  let s = String(raw == null ? "" : raw).trim().replace(/\\/g, "/");
  while (s.indexOf("./") === 0) s = s.slice(2);
  s = s.replace(/\/+$/, "");
  if (!s || s === "." || s.charAt(0) === "/" || s.charAt(0) === "~" || s.split("/").indexOf("..") >= 0) return "";
  return s;
}

/** exclude 规则 → tar 参数（`--exclude=./x`，与 `tar cf - -C dir .` 的成员名对齐）。
 *
 *  ⚠️ 两个消费方的**引用语境不同**（issue #22 的教训，2.4.20 曾因此让 push 侧排除全部失效）：
 *  - `forShell: true` → 结果会被拼进**远端命令字符串**（sync 方向），必须 `shellQuote`：防注入、防通配。
 *  - `forShell: false`（argv 语境，push 方向的本地 tar）→ **绝不能加引号**：argv 不经 shell，
 *    引号会成为模式的字面字符，`--exclude='./x'` 匹配不到 `./x` 而**静默失效**
 *    （GNU tar 1.35 / bsdtar 3.8 对不匹配任何成员的 `--exclude` 都退出 0，所以完全看不出来）。
 *  同一份逻辑服务两个语境时必须显式区分，别让"顺手复用"跨过 shell 边界。 */
function syncTarExcludes(list, forShell) {
  const out = [];
  (Array.isArray(list) ? list : []).forEach(function (raw) {
    const s = syncRelPath(raw);
    if (!s) return;
    const pat = "./" + s;
    out.push("--exclude=" + (forShell ? shellQuote(pat) : pat));
  });
  return out;
}

/** paths（只同步这些子路径）→ 归一化数组；空数组 = 整树。 */
function syncTarPaths(list) {
  const out = [];
  (Array.isArray(list) ? list : []).forEach(function (raw) {
    const s = syncRelPath(raw);
    if (s && out.indexOf(s) < 0) out.push(s);
  });
  return out;
}

/** 是否为插件写入镜像根的占位 README（push 时要排除，避免污染远端根）。 */
function isMirrorPlaceholderReadme(text) {
  return String(text == null ? "" : text).indexOf(MIRROR_README_SENTINEL) === 0;
}

/** 体积上限解析：显式参数 > 工作区字段 > 环境变量/默认。 */
function resolveSyncMaxBytes(v) {
  const n = typeof v === "number" ? v : parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : SYNC_MAX_BYTES_DEFAULT;
}

/** 墙钟预算解析：显式参数 > 环境变量/默认；0 = 不限。 */
function resolveSyncTimeoutMs(v) {
  const n = typeof v === "number" ? v : parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : SYNC_TIMEOUT_MS_DEFAULT;
}

/** 远端体积探测（du -sb -c，最后一行是合计）。超时 / 无 du / 输出不可解析都返回 ok:false
 *  —— 调用方保守拒绝。`targets` 为相对远端根的子路径数组（空 = 整个 `remotePath`）：
 *  只测**即将同步的范围**，否则「我只想同步 src」会被整根的 46G 误伤。 */
async function probeRemoteBytes(runner, p, remotePath, targets, timeoutMs) {
  const list = (Array.isArray(targets) && targets.length) ? targets : ["."];
  const base = String(remotePath || ".").replace(/\/+$/, "");
  const what = list.map(function (s) {
    return s === "." ? shellQuotePath(base) : shellQuotePath(base + "/" + s);
  }).join(" ");
  let r;
  try {
    r = await runner(p, "du -sb -c -- " + what + " 2>/dev/null | tail -n 1 | cut -f1", undefined, undefined, false, timeoutMs);
  } catch (e) { return { ok: false, reason: "error", detail: syncErrText(e) }; }
  if (r && r.isTimeout) return { ok: false, reason: "timeout" };
  if (!r || !r.ok) return { ok: false, reason: "failed", detail: String((r && (r.error || r.stderr)) || "").slice(0, 200) };
  const n = parseInt(String((r && r.stdout) || "").trim(), 10);
  if (!Number.isFinite(n) || n < 0) return { ok: false, reason: "unparsable", detail: String((r && r.stdout) || "").trim().slice(0, 120) };
  return { ok: true, bytes: n };
}

function syncProbeReasonText(pr) {
  if (!pr) return "未知原因";
  if (pr.reason === "timeout") return "探测超时，远端目录很可能非常大";
  if (pr.reason === "failed") return "远端 du 不可用或目录不可读" + (pr.detail ? "：" + pr.detail : "");
  if (pr.reason === "unparsable") return "du 输出无法解析" + (pr.detail ? "：" + pr.detail : "");
  return pr.detail || "探测失败";
}

/** 探测远端 tar 能否按我们的方案写 PAX（issue #22）。探针**不遍历任何目录**：
 *  `tar <args> -cf /dev/null /dev/null` 只解析选项、往 /dev/null 写一个成员。
 *  结果按 profile 缓存（一次会话内不重复探测）。返回 "min" | "pax" | "none"。 */
async function probeRemotePax(runner, p, timeoutMs) {
  // 键里带上 host：用户把已有 profile 指向另一台机器时不会复用旧结论
  const key = String(((p && p.id) || "") + "|" + ((p && p.host) || ""));
  if (syncPaxCache.has(key)) return syncPaxCache.get(key);
  let mode = "none";
  const ladder = [["min", SYNC_PAX_MIN_ARGS], ["pax", SYNC_PAX_PLAIN_ARGS]];
  for (let i = 0; i < ladder.length; i++) {
    let r;
    try {
      r = await runner(p, "tar " + ladder[i][1] + " -cf /dev/null /dev/null 2>/dev/null",
        undefined, undefined, false, timeoutMs || SYNC_PROBE_TIMEOUT_MS);
    } catch (e) { r = null; }
    if (r && r.ok && !r.isTimeout) { mode = ladder[i][0]; break; }
  }
  syncPaxCache.set(key, mode);
  return mode;
}

/** 本轮同步要用的远端 tar 前缀参数（含尾随空格）。`pref` 来自 resolveSyncPaxPref()。 */
function syncPaxPrefix(mode) {
  if (mode === "min") return SYNC_PAX_MIN_ARGS + " ";
  if (mode === "pax") return SYNC_PAX_PLAIN_ARGS + " ";
  return "";
}

/** 「乱码名」预测：把正确名按 UTF-8 字节交给 GBK 解码 —— 正是 Windows bsdtar 读裸 UTF-8 ustar
 *  名的行为（`报告.csv` → `鎶ュ憡.csv`）。返回 null = 该名字不可能由这种解码产生
 *  （纯 ASCII、解码有丢字节、或运行时没有 GBK 解码表）→ 调用方一律保守处理。 */
function mojibakeName(name) {
  const s = String(name == null ? "" : name);
  if (!/[^\x00-\x7F]/.test(s)) return null;
  try {
    const m = new TextDecoder("gbk").decode(Buffer.from(s, "utf8"));
    if (!m || m === s || m.indexOf("\uFFFD") >= 0) return null;
    return m;
  } catch (e) { return null; }
}

/** 找出「镜像里是乱码名、新树里是对应正确名」的成对条目（issue #22 的旧数据迁移）。
 *  先把新树的乱码预测建表（只为含非 ASCII 的路径计算），再走一遍镜像，命中即为迁移对象。
 *  预算与上限沿用「仅存在于镜像」比对那一套，避免大镜像把同步拖死。 */
async function scanMojibakePairs(mirrorPath, tmpDir, budgetMs, maxFiles) {
  const deadline = Date.now() + (budgetMs || SYNC_SCAN_BUDGET_MS);
  const cap = maxFiles || SYNC_SCAN_MAX_FILES;
  const out = { pairs: [], truncated: false, ok: true };
  let seen = 0;
  const map = new Map();
  async function walkNew(rel) {
    let ents;
    try { ents = await readdir(join(tmpDir, rel), { withFileTypes: true }); } catch (e) { return; }
    for (const ent of ents) {
      if (seen >= cap || Date.now() > deadline) { out.truncated = true; return; }
      seen++;
      const child = rel ? rel + "/" + ent.name : ent.name;
      if (ent.isDirectory()) { await walkNew(child); continue; }
      const bad = mojibakeName(child);
      if (bad && !map.has(bad)) map.set(bad, child);
    }
  }
  await walkNew("");
  if (!map.size) return out;
  async function walkOld(rel) {
    let ents;
    try { ents = await readdir(join(mirrorPath, rel), { withFileTypes: true }); } catch (e) { return; }
    for (const ent of ents) {
      if (out.truncated) return;
      if (seen >= cap || Date.now() > deadline) { out.truncated = true; return; }
      seen++;
      const child = rel ? rel + "/" + ent.name : ent.name;
      if (ent.isDirectory()) { await walkOld(child); continue; }
      if (!ent.isFile()) continue;
      const good = map.get(child);
      if (good && !existsSync(join(tmpDir, child))) out.pairs.push({ bad: child, good: good });
    }
  }
  try { await walkOld(""); } catch (e) { out.ok = false; }
  return out;
}

/** 删除镜像里已确认是乱码名的条目，并向上清理空目录（局部同步用；整树同步由原子替换负责）。 */
async function removeMojibakeFiles(mirrorPath, pairs) {
  let removed = 0;
  for (const pr of pairs) {
    try { await rm(join(mirrorPath, pr.bad), { force: true }); removed++; } catch (e) {}
    let dir = dirname(pr.bad);
    while (dir && dir !== "." && dir !== "/") {
      try {
        const left = await readdir(join(mirrorPath, dir));
        if (left.length) break;
        await rm(join(mirrorPath, dir), { recursive: true, force: true });
      } catch (e) { break; }
      dir = dirname(dir);
    }
  }
  return removed;
}

/** 给一对管道进程加墙钟预算；超时则终止两端（否则 46G 的拉取既不会超时也无法从插件侧取消）。 */
function armPipeTimeout(handles, budgetMs) {
  const state = { timedOut: false };
  const ms = resolveSyncTimeoutMs(budgetMs);
  if (!(ms > 0)) return { state: state, clear: function () {} };
  const timer = setTimeout(function () {
    state.timedOut = true;
    handles.forEach(function (h) { try { if (h && typeof h.terminate === "function") h.terminate(); } catch (e) {} });
  }, ms);
  // 不 unref：预算到点必须真的能触发（unref 过的定时器在事件循环空转时会被跳过，
  // 而"两端进程都卡住且没有其它句柄"正是最需要它触发的场景）。done 结束后立刻 clear。
  return { state: state, clear: function () { clearTimeout(timer); } };
}

/** 跑一对 tar 管道进程（a.stdout → b.stdin），返回 { ok, error }。 */
async function runTarPipe(a, b, budgetMs, what) {
  const arm = armPipeTimeout([a, b], budgetMs);
  let pipeErr = "";
  try {
    if (a.stdout && b.stdin) a.stdout.pipe(b.stdin);
    else pipeErr = "stdout/stdin 管道不可用（subprocess 未暴露原始流）";
  } catch (e) { pipeErr = syncErrText(e); }
  let aOut, bOut;
  try { aOut = await a.done; } catch (e) { aOut = { exitCode: -1 }; }
  try { bOut = await b.done; } catch (e) { bOut = { exitCode: -1 }; }
  arm.clear();
  if (!arm.state.timedOut && aOut.exitCode === 0 && bOut.exitCode === 0) return { ok: true, error: "" };
  const parts = [];
  if (arm.state.timedOut) parts.push("超过墙钟预算 " + Math.round(resolveSyncTimeoutMs(budgetMs) / 1000) + " 秒，两端进程已终止");
  if (pipeErr) parts.push("管道: " + pipeErr);
  if (aOut.exitCode !== 0) parts.push(what.a + " 退出码 " + aOut.exitCode + (readCollected(a, "stderr") ? ": " + readCollected(a, "stderr").slice(0, 500) : ""));
  if (bOut.exitCode !== 0) parts.push(what.b + " 退出码 " + bOut.exitCode + (readCollected(b, "stderr") ? ": " + readCollected(b, "stderr").slice(0, 500) : ""));
  if (!parts.length) parts.push("远端可能缺少 tar，或本机无 tar.exe");
  return { ok: false, error: what.label + "失败: " + parts.join("；") };
}

/** 清理上次中断留下的临时/旧镜像目录（只动我们自己命名、且超过 maxAge 的）。 */
async function sweepStaleSyncDirs(mirrorPath, maxAgeMs) {
  const dir = dirname(mirrorPath);
  const base = basename(mirrorPath);
  let ents = [];
  try { ents = await readdir(dir); } catch (e) { return; }
  const now = Date.now();
  const prefixes = [SYNC_TMP_PREFIX + base + "-", SYNC_OLD_PREFIX + base + "-"];
  for (const nm of ents) {
    if (!prefixes.some(function (pre) { return nm.indexOf(pre) === 0; })) continue;
    const full = join(dir, nm);
    try { const st = await stat(full); if (now - st.mtimeMs < (maxAgeMs || 3600000)) continue; } catch (e) { continue; }
    try { await rm(full, { recursive: true, force: true }); } catch (e) {}
  }
}

/** 列出「只在 oldRoot、不在 newRoot」的文件（跳过插件自有占位文件）。有墙钟预算与条目上限。 */
async function scanMirrorOnly(oldRoot, newRoot, budgetMs, maxFiles) {
  const deadline = Date.now() + (budgetMs || SYNC_SCAN_BUDGET_MS);
  const cap = maxFiles || SYNC_SCAN_MAX_FILES;
  const out = { paths: [], total: 0, truncated: false };
  let seen = 0;
  async function walk(rel) {
    let ents;
    try { ents = await readdir(join(oldRoot, rel), { withFileTypes: true }); } catch (e) { return; }
    for (const ent of ents) {
      if (out.truncated) return;
      if (seen >= cap || Date.now() > deadline) { out.truncated = true; return; }
      seen++;
      const child = rel ? rel + "/" + ent.name : ent.name;
      if (ent.isDirectory()) { await walk(child); continue; }
      if (!ent.isFile()) continue;                                  // 符号链接/设备等不参与删除风险判定
      if (child === ".remote-ssh.json") continue;                    // 插件自有
      if (child === "README.md") {
        try {
          const head = (await readFile(join(oldRoot, child), "utf8")).slice(0, 200);
          if (isMirrorPlaceholderReadme(head)) continue;             // 插件写入的占位文件
        } catch (e) {}
      }
      if (existsSync(join(newRoot, child))) continue;
      out.total++;
      if (out.paths.length < SYNC_LIST_CAP) out.paths.push(child);
    }
  }
  await walk("");
  return out;
}

/** 原子替换镜像目录：mirror → old、tmp → mirror、成功后删 old；任一步失败则回滚并保留旧镜像。 */
async function swapMirrorDir(mirrorPath, tmpDir) {
  const dir = dirname(mirrorPath);
  const oldDir = join(dir, SYNC_OLD_PREFIX + basename(mirrorPath) + "-" + Date.now().toString(36) + "-" + process.pid);
  let moved = false;
  try {
    try { await rename(mirrorPath, oldDir); moved = true; }
    catch (e) { if (!e || e.code !== "ENOENT") throw e; }
    try { await mkdir(dir, { recursive: true }); } catch (e) {}
    await rename(tmpDir, mirrorPath);
  } catch (e) {
    if (!moved) return { ok: false, error: "替换镜像目录失败: " + syncErrText(e) };
    try { await rm(mirrorPath, { recursive: true, force: true }); } catch (e2) {}
    try { await rename(oldDir, mirrorPath); } catch (e3) {}
    return { ok: false, error: "替换镜像目录失败（旧镜像已回滚；若回滚也失败则它仍在 " + oldDir + "）: " + syncErrText(e) };
  }
  try { await rm(oldDir, { recursive: true, force: true }); } catch (e) {}
  return { ok: true, error: "" };
}

/** 替换镜像后恢复插件自有占位文件：`.remote-ssh.json`（wrapper/拦截器自识别）与占位 README。 */
async function restoreMirrorPlaceholders(mirrorPath, p, remotePath, hadPlaceholderReadme) {
  try {
    if (!existsSync(join(mirrorPath, ".remote-ssh.json"))) {
      const connInfo = {
        profileId: p.id, host: p.host, port: p.port || 22, user: p.user,
        keyPath: p.keyPath || "", proxyJump: p.proxyJump || "", remotePath: remotePath
      };
      await writeFile(join(mirrorPath, ".remote-ssh.json"), JSON.stringify(connInfo, null, 2), "utf8");
    }
  } catch (e) {}
  try {
    // 只有「旧镜像里确实有我们的占位 README」且「远端树里没有自己的 README.md」时才补写
    if (hadPlaceholderReadme && !existsSync(join(mirrorPath, "README.md"))) {
      await writeFile(join(mirrorPath, "README.md"), remoteWorkspaceReadme(p.name, remotePath), "utf8");
    }
  } catch (e) {}
}

/** 组装单次同步的选项：逐次参数 > 工作区持久化字段 > 全局默认（issue #20）。 */
function syncOptsFrom(ws, a) {
  const src = a || {};
  const paths = Array.isArray(src.paths) && src.paths.length ? src.paths : (ws && ws.syncPaths);
  const exclude = Array.isArray(src.exclude) && src.exclude.length ? src.exclude : (ws && ws.syncExclude);
  const hasMax = src.maxBytes !== undefined && src.maxBytes !== null && src.maxBytes !== "";
  const wsMax = ws && ws.syncMaxBytes ? ws.syncMaxBytes : undefined;
  return {
    paths: paths,
    exclude: exclude,
    force: src.force === true,
    maxBytes: hasMax ? src.maxBytes : wsMax,
    timeoutMs: src.timeoutMs,
    repairNames: src.repairNames === true      // issue #22：清理旧版本留下的乱码文件名（只影响镜像）
  };
}

/** 远端 → 本地镜像：解到临时目录，成功后原子替换（issue #20）。
 *  `opts`: { exclude?, paths?, force?, maxBytes?, timeoutMs?, repairNames? }
 *  —— `paths` 非空 = **局部更新**（只覆盖这些子路径，不删任何本地文件）；
 *     整树同步才会替换镜像，且替换前比对「只存在于镜像的文件」，除非显式 `force`。
 *  —— `repairNames`（issue #22）：清理旧版本在 Windows 上拉取留下的**乱码文件名**。 */
async function remoteSyncDown(subprocess, runner, p, remotePath, mirrorPath, opts) {
  if (!remotePath) return { ok: false, error: "remotePath 为必填项" };
  if (!mirrorPath) return { ok: false, error: "mirrorPath 为必填项" };
  const o = opts || {};
  const paths = syncTarPaths(o.paths);
  const excludes = syncTarExcludes(o.exclude, true);   // 拼进远端命令字符串：必须带 shell 引号
  const scoped = paths.length > 0;
  const limit = resolveSyncMaxBytes(o.maxBytes);
  const paxPref = resolveSyncPaxPref();
  const winLocal = process.platform === "win32";
  let paxMode = "off";
  let paxNotice = "";
  if (paxPref !== "off") {
    paxMode = paxPref === "auto" ? await probeRemotePax(runner, p, SYNC_PROBE_TIMEOUT_MS) : paxPref;
    if (paxMode === "none") {
      paxNotice = "远端 tar 不支持 --format=pax：若远端存在非 ASCII 文件名，" + (winLocal
        ? "在 Windows 上拉取会被按本地 ANSI 代码页静默改写（issue #22，内容不变、只有名字变），请升级远端 GNU tar。"
        : "本机平台不会因此乱码，故按原样拉取。");
    }
  }
  // 1) 体积哨兵：必须在**任何删除动作之前**跑（force = 调用方已显式承担全量复制）
  //    探测范围只覆盖本次要同步的内容：整树 = 远端根；paths = 那些子路径。
  let probedBytes = null;
  if (!o.force) {
    const pr = await probeRemoteBytes(runner, p, remotePath, scoped ? paths : null, SYNC_PROBE_TIMEOUT_MS);
    const subject = scoped ? "所选子路径（" + paths.join("、") + "）" : "远端 " + remotePath;
    if (!pr.ok) {
      return { ok: false, error: "已拒绝同步：无法在 " + Math.round(SYNC_PROBE_TIMEOUT_MS / 1000) + " 秒内确认" + subject + " 的体积（" + syncProbeReasonText(pr) +
        "）。" + (scoped ? "" : "整树同步会把远端全部内容拉到本机；") +
        "确认要执行请显式传 force: true" + (scoped ? "。" : "，或先用 paths 只同步需要的子路径。") };
    }
    if (pr.bytes > limit) {
      return { ok: false, error: "已拒绝同步：" + subject + " 约 " + formatSyncBytes(pr.bytes) + "，超过同步上限 " + formatSyncBytes(limit) +
        "。请用 paths 限定子路径、exclude 排除大目录，或显式传 force: true 承担全量复制。" };
    }
    probedBytes = pr.bytes;
  }
  // 2) 解到临时目录：旧镜像此时完全不动
  await sweepStaleSyncDirs(mirrorPath);
  const tmpDir = join(dirname(mirrorPath), SYNC_TMP_PREFIX + basename(mirrorPath) + "-" + Date.now().toString(36) + "-" + process.pid);
  try { await rm(tmpDir, { recursive: true, force: true }); } catch (e) {}
  try { await mkdir(tmpDir, { recursive: true }); } catch (e) {
    return { ok: false, error: "创建临时目录失败: " + syncErrText(e) };
  }
  let hadPlaceholderReadme = false;
  try { hadPlaceholderReadme = isMirrorPlaceholderReadme((await readFile(join(mirrorPath, "README.md"), "utf8")).slice(0, 200)); } catch (e) {}
  const COLLECT = { maxBytes: 1024 * 1024, spill: { maxBytes: 1024 * 1024 } };
  let sshH, tarH;
  try {
    // 注意 `-cf` 必须带横线：GNU tar 的"无横线旧式选项"只在**首参**生效，前面一旦有长选项
    // （--format=pax），`cf` 会被当成文件名 → "You must specify one of the '-Acdtrux'…"（实测 1.35）。
    // 带横线的 `-cf` 反而更可移植（POSIX 风格，GNU/bsdtar/busybox 都认）。
    const remoteCmd = "tar " + syncPaxPrefix(paxMode) + "-cf - " + excludes.join(" ") + (excludes.length ? " " : "") +
      "-C " + shellQuotePath(remotePath) + " " +
      (scoped ? paths.map(function (s) { return shellQuote(s); }).join(" ") : ".");
    sshH = spawnOne(subprocess, sshArgv(p, remoteCmd), {
      stdin: "ignore", stdout: "pipe", stderr: COLLECT
    });
    tarH = spawnOne(subprocess, ["tar", "xf", "-", "-C", tmpDir], {
      stdin: "pipe", stdout: "ignore", stderr: COLLECT
    });
  } catch (e) {
    try { await rm(tmpDir, { recursive: true, force: true }); } catch (e2) {}
    return { ok: false, error: "spawn 失败: " + syncErrText(e) };
  }
  const pipe = await runTarPipe(sshH, tarH, o.timeoutMs, { label: "同步", a: "ssh", b: "tar" });
  if (!pipe.ok) {
    try { await rm(tmpDir, { recursive: true, force: true }); } catch (e) {}
    return { ok: false, error: pipe.error + "（本地镜像未改动，已丢弃本次拉取的内容）" };
  }
  // 3) 整树替换前：确认不会销毁「只存在于镜像、远端没有」的文件
  let mojiRepaired = 0;
  let mojiNotice = "";
  if (!scoped && !o.force) {
    const only = await scanMirrorOnly(mirrorPath, tmpDir, SYNC_SCAN_BUDGET_MS, SYNC_SCAN_MAX_FILES);
    if (only.total > 0 || only.truncated) {
      // 3a) 先排除「旧版本留下的乱码名」这种伪本地独有文件（issue #22）
      //     只在"本来就要拒绝"这条路径上才走这遍扫描（对日常同步零成本）
      const moji = await scanMojibakePairs(mirrorPath, tmpDir, SYNC_SCAN_BUDGET_MS, SYNC_SCAN_MAX_FILES);
      // 只有当**全部**镜像独有文件都被证明是乱码名时才敢放行（否则仍有真实文件会被删掉）
      const allMoji = !!moji.pairs.length && !only.truncated && !moji.truncated && only.total === moji.pairs.length;
      if (allMoji && o.repairNames === true) {
        mojiRepaired = moji.pairs.length;      // 整树同步的原子替换会一并带走这些乱码名
        mojiNotice = "已确认 " + moji.pairs.length + " 个乱码文件名（旧版本在 Windows 上拉取非 ASCII 名所致）随替换一并移除，正确名以远端为准。";
      } else if (allMoji) {
        try { await rm(tmpDir, { recursive: true, force: true }); } catch (e) {}
        const shown = moji.pairs.slice(0, SYNC_LIST_CAP)
          .map(function (x) { return "`" + x.bad + "` → `" + x.good + "`"; }).join("、");
        return {
          ok: false,
          error: "已拒绝同步：镜像里有 " + moji.pairs.length + " 个**疑似旧版本乱码文件名**（Windows 上拉取非 ASCII 名所致，issue #22）：" + shown +
            (moji.pairs.length > SYNC_LIST_CAP ? " 等" : "") +
            "。它们不是真正独有的文件，而是同一批文件被改写后的名字。两种处理：① 重试并传 repairNames: true，让插件清理这些乱码名（内容以远端为准）；" +
            "② 或先在本地把它们改回正确名，再 remote_ssh_push 把改动推回去（能保住你在这份副本上做过的修改）。",
          onlyMirrorTotal: only.total,
          mojibakeNames: moji.pairs.slice(0, SYNC_LIST_CAP).map(function (x) { return x.bad; })
        };
      } else {
        try { await rm(tmpDir, { recursive: true, force: true }); } catch (e) {}
        const head = only.paths.length
          ? "（例如 " + only.paths.join("、") + (only.total > only.paths.length ? " 等" : "") + "）"
          : "";
        const why = only.total > 0
          ? "本次会把本地镜像替换为远端内容，将删除 " + only.total + " 个只存在于镜像、远端没有的文件" + head
          : "无法在预算内完成镜像比对（镜像目录很大），无法确认是否会删除本地独有文件";
        const hint = moji.pairs.length
          ? "其中 " + moji.pairs.length + " 个疑似旧版本的乱码文件名（issue #22），传 repairNames: true 可一并清理。"
          : "";
        const rej = {
          ok: false,
          error: "已拒绝同步：" + why + "。" + hint + "两种处理：① 先 remote_ssh_push 把它们补推到远端；② 确认放弃这些本地副本后，重试并显式传 force: true。",
          onlyMirrorTotal: only.total
        };
        if (only.paths.length) rej.onlyMirror = only.paths;
        return rej;
      }
    }
  }
  // 4) 落盘：局部更新（只覆盖指定子路径）或整树原子替换（失败自动回滚）
  if (scoped) {
    for (const rel of paths) {
      const from = join(tmpDir, rel);
      if (!existsSync(from)) continue;
      try { await cp(from, join(mirrorPath, rel), { recursive: true, force: true }); }
      catch (e) {
        try { await rm(tmpDir, { recursive: true, force: true }); } catch (e2) {}
        return { ok: false, error: "写入镜像失败（" + rel + "）: " + syncErrText(e) };
      }
    }
    // 4a) 局部同步不会替换镜像，所以要单独处理旧版本留下的乱码名（issue #22）。
    //     Windows 上一律查一遍（乱码只在这个平台产生）；其它平台仅在显式传 repairNames 时查。
    if (o.repairNames === true || winLocal) {
      const moji = await scanMojibakePairs(mirrorPath, tmpDir, SYNC_SCAN_BUDGET_MS, SYNC_SCAN_MAX_FILES);
      if (moji.pairs.length) {
        if (o.repairNames === true) {
          mojiRepaired = await removeMojibakeFiles(mirrorPath, moji.pairs);
          mojiNotice = "已清理 " + mojiRepaired + " 个旧版本乱码文件名（内容以远端为准）。";
        } else {
          const shown = moji.pairs.slice(0, SYNC_LIST_CAP).map(function (x) { return "`" + x.bad + "`"; }).join("、");
          const howMany = (moji.truncated ? "至少 " : "") + moji.pairs.length;
          mojiNotice = "⚠️ 镜像里还有 " + howMany + " 个旧版本乱码文件名（" + shown + (moji.pairs.length > SYNC_LIST_CAP ? " 等" : "") +
            "），它们是同一批文件被改写的名字；重试时传 repairNames: true 可清理（或先改回正确名再 push 以保住本地改动）。";
        }
      }
    }
    try { await rm(tmpDir, { recursive: true, force: true }); } catch (e) {}
  } else {
    const sw = await swapMirrorDir(mirrorPath, tmpDir);
    if (!sw.ok) {
      try { await rm(tmpDir, { recursive: true, force: true }); } catch (e) {}
      return { ok: false, error: sw.error };
    }
    await restoreMirrorPlaceholders(mirrorPath, p, remotePath, hadPlaceholderReadme);
  }
  const res = { ok: true, error: "", mirrorPath: mirrorPath };
  if (probedBytes !== null) res.bytes = probedBytes;
  if (scoped) res.paths = paths;
  if (mojiRepaired) res.repairedNames = mojiRepaired;
  if (paxNotice) res.notice = paxNotice;
  if (mojiNotice) res.notice = res.notice ? res.notice + " " + mojiNotice : mojiNotice;
  return res;
}

/** 本地镜像 → 远端：本地 tar 打包喂给远端 tar 展开。
 *  **始终**排除插件自有文件（`.remote-ssh.json`、占位 `README.md`）—— 旧实现会把它们一并解到
 *  **远端根目录**；`opts`: { exclude?, paths?, timeoutMs? }，`paths` 非空时只推这些子路径。 */
async function remoteSyncUp(subprocess, p, remotePath, mirrorPath, opts) {
  if (!remotePath) return { ok: false, error: "remotePath 为必填项" };
  if (!mirrorPath) return { ok: false, error: "mirrorPath 为必填项" };
  const o = opts || {};
  const paths = syncTarPaths(o.paths);
  const excludes = syncTarExcludes(o.exclude);   // argv 语境：裸模式，加引号会静默失效（issue #22）
  excludes.push("--exclude=./.remote-ssh.json");   // 连接信息（含路径/主机）绝不推到远端
  try {
    const head = (await readFile(join(mirrorPath, "README.md"), "utf8")).slice(0, 200);
    if (isMirrorPlaceholderReadme(head)) excludes.push("--exclude=./README.md");
  } catch (e) {}
  const operands = paths.length ? paths : ["."];
  const COLLECT = { maxBytes: 1024 * 1024, spill: { maxBytes: 1024 * 1024 } };
  let tarH, sshH;
  try {
    tarH = spawnOne(subprocess, ["tar", "cf", "-"].concat(excludes, ["-C", mirrorPath], operands), {
      stdin: "ignore", stdout: "pipe", stderr: COLLECT
    });
    sshH = spawnOne(subprocess, sshArgv(p, "tar xf - -C " + shellQuotePath(remotePath)), {
      stdin: "pipe", stdout: "ignore", stderr: COLLECT
    });
  } catch (e) {
    return { ok: false, error: "spawn 失败: " + syncErrText(e) };
  }
  const pipe = await runTarPipe(tarH, sshH, o.timeoutMs, { label: "推送", a: "tar", b: "ssh" });
  if (!pipe.ok) return { ok: false, error: pipe.error };
  // 批量覆盖远端文件：清空该 profile 的读/列举缓存（findings §4.3a）
  clearCachesForProfile(p);
  const res = { ok: true, error: "", remotePath: remotePath };
  if (paths.length) res.paths = paths;
  return res;
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
// agent 文件工具写回远端（issue #15）
//
// 远程工作区会话里 agent 的 write / edit 走**进程内** ctx.fs（base bundle 挂的是本地
// fs-sandbox：`@deepseek-ai/dsh-base/cordis.patch.yml` 的 `fs-sandbox` 行），因此只落在本地
// 镜像 —— 用户在远端机器上找不到文件，只能人工 push/scp。这条链路不经过任何 HTTP 路由，
// 与 #10（`fileReferences` 是进程内服务）同源不同面。
//
// 接法（刻意保守）：
//   - **原方法照旧调用**：镜像内容、沙箱围栏（sandboxPolicy）、写意图（createIfAbsent /
//     replaceIfVersion）与审计语义全部不变 —— 我们只读它的返回值（`outcome.after` 即写入后的
//     完整内容），不伪造 FsTarget、不改 resolve 行为；
//   - 成功后把**这一份内容定向推回远端对应的那个文件**（不是整镜像 tar —— 那会用旧镜像覆盖
//     远端其它文件）；
//   - 推失败只记一条 warn：本地写入已经成功，桥接层绝不让写操作变成失败。
// ---------------------------------------------------------------------------

/** 从文件路径向上找最近的「镜像根」（含 `.remote-ssh.json` 的目录）；有界 8 层。 */
function findMirrorRoot(filePath) {
  if (!filePath) return null;
  let dir = dirname(String(filePath));
  for (let i = 0; i < 8 && dir; i++) {
    try {
      const marker = join(dir, ".remote-ssh.json");
      if (existsSync(marker)) {
        const info = JSON.parse(readFileSync(marker, "utf8"));
        if (info && info.host && info.user && info.remotePath) return { root: dir, info: info };
      }
    } catch (e) {}
    const parent = dirname(dir);
    if (!parent || parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * 包装 ctx.fs 的 `writeText` / `editText`：原调用照旧，成功后回调 `onWritten(本地绝对路径, 写入后的内容)`。
 * 返回恢复函数；服务缺失/不可包装时返回 null（插件照常工作，只是不桥接）。
 */
function installFsWriteBridge(svc, hooks) {
  if (!svc || typeof svc.writeText !== "function") return null;
  const onWritten = hooks && typeof hooks.onWritten === "function" ? hooks.onWritten : null;
  if (!onWritten) return null;
  const log = (hooks && hooks.log) || null;
  const warn = function (msg) { try { if (log && typeof log.warn === "function") log.warn(msg); } catch (e) {} };
  const originalWrite = svc.writeText.bind(svc);
  const originalEdit = typeof svc.editText === "function" ? svc.editText.bind(svc) : null;
  const originalProcessPath = typeof svc.processPath === "function" ? svc.processPath.bind(svc) : null;

  /** target → 本地绝对路径：优先 processPath（后端执行世界的规范路径），退回 displayPath。 */
  function pathOf(target) {
    try { if (originalProcessPath) { const p = originalProcessPath(target); if (p) return String(p); } } catch (e) {}
    try { return target && target.displayPath ? String(target.displayPath) : ""; } catch (e) { return ""; }
  }
  /**
   * 同步到远端；**等待**它完成再返回（"写好了"就意味着远端也已有）。
   * 失败处理（issue #24）：标记过的失败（`dshRemoteSshWriteBack`）继续往上抛 —— 那是我们
   * 刻意要让模型看见的信号（工具报错是唯一可见通道）；其余异常仍只告警，不改变工具行为。
   */
  async function mirror(target, content) {
    if (typeof content !== "string") return;
    const abs = pathOf(target);
    if (!abs) return;
    try {
      await onWritten(abs, content);
    } catch (e) {
      if (e && e.dshRemoteSshWriteBack) throw e;
      warn("[dsh-remote-ssh] 文件同步到远端失败（本地镜像已写入）: " + String(e && e.message ? e.message : e));
    }
  }

  const patchedWrite = async function (target, content, expected, signal, sandboxPolicy) {
    const out = await originalWrite(target, content, expected, signal, sandboxPolicy);
    await mirror(target, out && typeof out.after === "string" ? out.after : content);
    return out;
  };
  const patchedEdit = originalEdit ? async function (target, edit, expected, signal, sandboxPolicy) {
    const out = await originalEdit(target, edit, expected, signal, sandboxPolicy);
    await mirror(target, out && typeof out.after === "string" ? out.after : undefined);
    return out;
  } : null;

  try {
    svc.writeText = patchedWrite;
    if (patchedEdit) svc.editText = patchedEdit;
  } catch (e) {
    return null;
  }
  return function restoreFsWriteBridge() {
    try { if (svc.writeText === patchedWrite) svc.writeText = originalWrite; } catch (e) {}
    try { if (patchedEdit && svc.editText === patchedEdit) svc.editText = originalEdit; } catch (e) {}
  };
}

// ---------------------------------------------------------------------------
// 终端 wrapper 的 node 解析（issue #23）
// ---------------------------------------------------------------------------

/**
 * 按「形状」在 `<baseDir>/<一层>/dependencies/node/bin/node[.exe]` 里找 node（issue #23 ⑥⑦）。
 *
 * 为什么不写死目录名：`dsh-runtimes\` 下那一层（本机是 `dsh-primary-runtime`）与应用
 * `resources\runtime\` 下那一层（本机是 `primary-runtime`）都是运行时**实例名**，随版本/安装
 * 方式可能变。所以只认形状，并把选择做成**确定的**：优先名字含 `primary` 的，其余按字典序 ——
 * 同一台机器每次都会选出同一个，不会因为目录枚举顺序而漂移。
 * 任何异常（目录不存在/无权限）都当作"没找到"，返回空串。
 */
function probeRuntimeNode(baseDir, win) {
  const fileName = win ? "node.exe" : "node";
  try {
    const names = readdirSync(baseDir, { withFileTypes: true })
      .filter(function (d) { return d && d.isDirectory(); })
      .map(function (d) { return d.name; })
      .sort(function (a, b) {
        const pa = /primary/i.test(a) ? 0 : 1;
        const pb = /primary/i.test(b) ? 0 : 1;
        return pa !== pb ? pa - pb : a.localeCompare(b);
      });
    for (const name of names) {
      const p = join(baseDir, name, "dependencies", "node", "bin", fileName);
      try { if (existsSync(p)) return p; } catch (e) {}
    }
  } catch (e) {}
  return "";
}

/**
 * 解析集成终端 wrapper 要用的 node 可执行文件 —— **不依赖 PATH**。
 *
 * 背景（issue #23）：两个薄壳此前都裸调 `node`。PATH 上没有 node 时（DSH **Desktop** 的
 * 默认状态：宿主按设计不把自带 node 放进子进程 PATH），wrapper 根本跑不起来，用户只看到
 * cmd 的 `'node' is not recognized…` 且窗口一闪而过 —— 与 SSH、密钥、远端配置全都无关。
 * 举报人已查证：`packageManager` 只覆盖包操作，桌面端「不把内嵌 node 前置到 PATH」是刻意
 * 的设计决定，且 `runtime\bin\node.cmd` 垫片依赖的 `DSH_DESKTOP_NODE_EXECUTABLE` 恰在子
 * 进程环境的脱敏名单里 —— 所以**插件侧不能把 node 解析寄托于 PATH**。
 *
 * 优先级（先命中先赢，且必须真实存在）：
 *   ① config.nodePath（设置里的显式配置，最权威；用户配一次即可）
 *   ② 环境变量 DSH_REMOTE_SSH_NODE
 *   ③ process.execPath —— **正在运行本插件代码的那个解释器**。这不是猜路径：宿主自己解析
 *      node 用的就是这个绝对路径。仅当文件名形如 node / node.exe 时才采用（桌面端若以
 *      Electron 可执行文件为主进程，execPath 会指向 app 本体，用它拉起只会再开一个 DSH）。
 *   ④ DSH_DESKTOP_NODE_EXECUTABLE（桌面端若把它暴露给宿主进程，白拿）
 *   ⑤ 与 ③ 同目录的 node(.exe)（同一处提取出的运行时通常并排放着）
 *   ⑥ `%DSH_HOME%\dsh-runtimes\*\dependencies\node\bin\node[.exe]`
 *      ⑦ `<应用安装目录>\resources\runtime\*\dependencies\node\bin\node[.exe]`
 *      —— 这两条是**最后兜底**，形状相同：只在前面都落空时才用，且一律 `existsSync` 验证。
 *      来历（issue #23 第二轮验收，2026-10-11）：举报人在**官方打包版**上实测前五条全落空
 *      （execPath 是 `DeepSeek Harness.exe` 过不了门控，`DSH_DESKTOP_NODE_EXECUTABLE` 宿主
 *      确实不导出，同目录没有 node），于是 `baked` 是空串、终端仍只能靠 PATH 回退 ——
 *      也就是说 2.4.24 把**失败变清楚了，但没有把失败消灭**。
 *      ⑥ 的根是宿主**正式导出**的 `DSH_HOME`（不是猜目录），⑦ 的根是**本进程自己的安装位置**
 *      （`process.execPath` 的父目录），两者都只多假设一层"运行时目录名"—— 而那一层用
 *      `probeRuntimeNode()` 按形状探测（优先含 `primary` 的名字），不写死具体名字。
 *      边界照实说：运行时目录名不保证稳定，所以这两条排在用户显式配置与解释器之后，
 *      失败也只是退回 ⑤ 之后的老行为（PATH + 可操作错误），不会比 2.4.24 更差。
 *
 * 全部落空时返回 bin=""，wrapper 运行时再尽力探测 PATH，仍不行则给出**可操作的错误**。
 * 若将来宿主给出稳定的 runtime 入口（例如把 `DSH_DESKTOP_NODE_EXECUTABLE` 传给宿主进程），
 * ⑥⑦ 可以整段删掉 —— 那才是"完全不依赖 PATH"的终点；在此之前，插件侧到此为止。
 */
function resolveWrapperNode(config) {
  const win = process.platform === "win32";
  const cands = [];
  const cfgPath = config && typeof config === "object" ? String(config.nodePath || "").trim() : "";
  if (cfgPath) cands.push([cfgPath, "设置里的 nodePath"]);
  const envPath = String(process.env.DSH_REMOTE_SSH_NODE || "").trim();
  if (envPath) cands.push([envPath, "环境变量 DSH_REMOTE_SSH_NODE"]);
  const exec = String(process.execPath || "");
  if (/[\\/]node(\.exe)?$/i.test(exec)) cands.push([exec, "当前进程的解释器（process.execPath）"]);
  const deskNode = String(process.env.DSH_DESKTOP_NODE_EXECUTABLE || "").trim();
  if (deskNode) cands.push([deskNode, "环境变量 DSH_DESKTOP_NODE_EXECUTABLE"]);
  if (exec) {
    try { cands.push([join(dirname(exec), win ? "node.exe" : "node"), "与当前进程解释器同目录的 node"]); } catch (e) {}
  }
  // ⑥ 宿主正式导出的 DSH_HOME 之下的运行时（举报人提议；根是官方变量，只有实例名靠形状探测）
  {
    const home = String(process.env.DSH_HOME || "").trim();
    if (home) {
      const p = probeRuntimeNode(join(home, "dsh-runtimes"), win);
      if (p) cands.push([p, "DSH_HOME 运行时目录里的 node"]);
    }
  }
  // ⑦ 本应用自己的安装目录（Desktop 打包版把运行时放在 resources\runtime\<实例>\…）；
  //    process.resourcesPath 是同一个位置的官方说法，Electron 主进程里才有，拿得到就用。
  if (exec) {
    try {
      const p = probeRuntimeNode(join(dirname(exec), "resources", "runtime"), win);
      if (p) cands.push([p, "应用安装目录 resources\\runtime 里的 node"]);
    } catch (e) {}
  }
  try {
    const res = String(process.resourcesPath || "");
    if (res) {
      const p = probeRuntimeNode(join(res, "runtime"), win);
      if (p) cands.push([p, "process.resourcesPath 运行时目录里的 node"]);
    }
  } catch (e) {}
  const tried = [];
  for (const pair of cands) {
    const p = pair[0];
    if (!p) continue;
    tried.push(p);
    try { if (existsSync(p)) return { bin: p, source: pair[1], tried: tried }; } catch (e) {}
  }
  return { bin: "", source: "", tried: tried };
}

/** POSIX 单引号字符串里转义（路径含 ' 时）。 */
function shSingleQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

/**
 * 生成两个薄壳：.cmd（Windows）与 POSIX sh。
 *
 * 与旧版的差别（issue #23）：
 *   - node 用**绝对路径**（plugin 加载时解析好写死），与同一份 wrapper 里 `ssh` 的做法同构
 *     （那里早就是 `sysSsh` 绝对路径 + 回退，理由同样是"裸名依赖 PATH 可能解析不到/解析错"）；
 *   - 写死的路径失效（被卸载/换机）时回退到 PATH 探测；
 *   - 两条都失败时打**可操作的**错误（指明是本插件的终端、桌面端为何没有 node、怎么配），
 *     并以 127 退出 —— 而不是把 cmd 的 `'node' is not recognized…` 原文糊到用户脸上。
 * POSIX 半边只用 shell 内建（`${0%/*}` / `command -v` / `exec`），连 `dirname` 都不依赖，
 * 这样把 PATH 清空也能跑通（测试就是这么验收的）。
 */
function wrapperShims(nodeBin) {
  const baked = String(nodeBin || "");
  const winCmd = [
    "@echo off",
    "rem DSH remote-ssh shell wrapper — delegates to the Node.js script next to it.",
    "rem issue #23: DSH Desktop does not put its bundled node on the child PATH (by design),",
    "rem so the absolute interpreter path resolved at plugin load is baked in below; PATH is",
    "rem only a fallback, and a missing node produces an actionable error instead of cmd's.",
    "setlocal",
    'set "DSH_NODE=' + baked.replace(/%/g, "%%") + '"',
    'if defined DSH_NODE if exist "%DSH_NODE%" goto :run',
    'set "DSH_NODE="',
    'for /f "delims=" %%N in (\'where node 2^>nul\') do if not defined DSH_NODE set "DSH_NODE=%%N"',
    "if defined DSH_NODE goto :run",
    "echo [dsh-remote-ssh] node not found: the integrated terminal runs this wrapper with node. 1>&2",
    "echo [dsh-remote-ssh] On DSH Desktop the host does not put its bundled node on PATH, by design. 1>&2",
    "echo [dsh-remote-ssh] Fix: set the plugin setting nodePath (or the environment variable 1>&2",
    "echo [dsh-remote-ssh] DSH_REMOTE_SSH_NODE) to the absolute path of node.exe. 1>&2",
    "exit /b 127",
    ":run",
    '"%DSH_NODE%" "%~dp0dsh-remote-shell.js"',
    "exit /b %ERRORLEVEL%",
    ""
  ].join("\r\n");
  const posixSh = [
    "#!/usr/bin/env bash",
    "# DSH remote-ssh shell wrapper (POSIX) — delegates to the Node.js script next to it.",
    "# issue #23: same ladder as the .cmd — baked absolute node, then PATH, then an",
    "# actionable error (PATH may legitimately have no node on DSH Desktop).",
    'case "$0" in',
    '  */*) DSH_SELF_DIR="${0%/*}" ;;',
    '  *)   DSH_SELF_DIR="." ;;',
    "esac",
    "DSH_NODE=" + shSingleQuote(baked),
    'if [ -n "$DSH_NODE" ] && [ -x "$DSH_NODE" ]; then',
    '  exec "$DSH_NODE" "$DSH_SELF_DIR/dsh-remote-shell.js"',
    "fi",
    'DSH_NODE="$(command -v node 2>/dev/null || true)"',
    'if [ -n "$DSH_NODE" ]; then',
    '  exec "$DSH_NODE" "$DSH_SELF_DIR/dsh-remote-shell.js"',
    "fi",
    'echo "[dsh-remote-ssh] node not found: the integrated terminal runs this wrapper with node." >&2',
    'echo "[dsh-remote-ssh] On DSH Desktop the host does not put its bundled node on PATH, by design." >&2',
    'echo "[dsh-remote-ssh] Fix: set the plugin setting nodePath (or DSH_REMOTE_SSH_NODE) to an absolute node path." >&2',
    "exit 127",
    ""
  ].join("\n");
  return { winCmd: winCmd, posixSh: posixSh };
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
  // 信任源 = 启动时采样的局域网 IP 字面量 + `--trusted-host` 指定的 authority；`/api` 网关的
  // fence 正以它为准。**0.2.1-rc.1 起服务从 ctx.webRuntime 迁到 ctx.webStartup**（webRuntime
  // 已被整个移除，asar 全树 0 命中）。两个都用软注入（ctx.inject）而不是硬 inject：
  //   · 新宿主 → webStartup.trustedHosts；
  //   · 旧宿主 → webRuntime.trustedHosts；
  //   · 两者都没有 → 保持 loopback-only（与 2.4.9 行为一致），插件照常挂载，只是远程访问退回本机。
  // 按请求实时读取（服务值可被替换，无需重启插件）。
  let webStartupFace = null;
  ctx.inject(["webStartup"], (sctx) => {
    try { webStartupFace = (sctx && sctx.webStartup) || (sctx && typeof sctx.get === "function" ? sctx.get("webStartup") : null) || null; } catch (e) { webStartupFace = null; }
  });
  let webRuntimeFace = null;
  ctx.inject(["webRuntime"], (sctx) => {
    try { webRuntimeFace = (sctx && sctx.webRuntime) || (sctx && typeof sctx.get === "function" ? sctx.get("webRuntime") : null) || null; } catch (e) { webRuntimeFace = null; }
  });
  function trustedHostsNow() {
    try {
      const fromStartup = webStartupFace && webStartupFace.trustedHosts;
      if (Array.isArray(fromStartup)) return fromStartup;
    } catch (e) { /* 落到旧服务 */ }
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
  // 键 = profileKey [+ "|git"]：git.* 端点用独立会话（性能 t3）。远端 git 在大仓库上
  // 一次 status/log 要数秒，与文件树/文件读共用一条会话时，点击目录会排在慢 git 后面；
  // 分开后两类流量互不排队，代价是每个 profile 多一条按需建立的连接（同为 ServerAlive 保活）。
  const sessions = new Map(); // sessionKey -> CommandSession
  const SESSION_IDLE_MS = 30 * 60 * 1000; // 10min→30min（性能 t3）：空闲关断太急会让每次"回来点两下"都重新付 1~2s 握手；死连接由 ServerAlive 90s 内探活 + runPooled 255 重建兜底
  // profileKey 已上移模块层（读缓存/列举缓存与失效逻辑共用同一身份键，定义见 remoteReadFile 上方）。
  function sessionKeyOf(p, role) {
    return profileKey(p) + (role ? "|" + role : "");
  }
  function getSession(p, role) {
    const key = sessionKeyOf(p, role);
    let s = sessions.get(key);
    if (!s) { s = new CommandSession(subprocess, p); sessions.set(key, s); }
    return s;
  }
  /** 把 SSH 常见失败翻译成带修复建议的中文提示。 */
  function sshErrorHint(text) {
    const t = stripLoginBanner(stripPqBanner(String(text || "")));
    // issue #19：先把一手证据摆到最前面 ——「配置的私钥文件根本不存在」是这类"认证失败"最常见的
    // 真实根因，而它此前只是 stderr 里一行 Warning，还常被服务端登录横幅（二维码）挤出截断窗口。
    const missing = findMissingIdentityFile(t);
    const methods = offeredAuthMethods(t);
    const interactive = /password|keyboard-interactive/i.test(methods)
      ? "\n另：远端还允许 " + methods + " 认证（扫码、动态口令/二次验证都属于这一类）。本插件的文件与工具能力走非交互公钥通道（BatchMode=yes + PreferredAuthentications=publickey），不会弹出扫码提示；需要交互式登录请用内置「终端」页签（ssh -tt 交互通道，可扫码/输密码），文件能力则请在远端 ~/.ssh/authorized_keys 收录对应公钥。"
      : "";
    if (missing) {
      return "配置的私钥文件不存在或不可读：" + missing.path + "（ssh: " + missing.line + "）。请把 keyPath 改成正确的私钥文件，或清空 keyPath 改为依赖 ssh-agent / ~/.ssh/config 里的 IdentityFile 后重试。" + interactive + " 原始信息: " + sshExcerpt(t);
    }
    if (/remote port forwarding failed for listen port (\d+)/i.test(t)) {
      const m = t.match(/remote port forwarding failed for listen port (\d+)/i);
      return "SSH 端口转发失败（本地端口 " + m[1] + " 已被占用）。这通常由 ~/.ssh/config 里的 RemoteForward 造成：远端该端口被上次会话占用时，ExitOnForwardFailure yes 会让 ssh 直接退出。本插件已对该连接加 ClearAllForwardings，若仍出现请检查 ssh config。原始信息: " + sshExcerpt(t);
    }
    if (/permission denied \(publickey/i.test(t)) return "公钥认证失败（服务器拒绝了公钥）。请依次检查：① keyPath 指向的私钥是否正确、是否带口令——测试连接以批处理模式运行无法交互输口令，可先 ssh-add 加载或改用无口令密钥；② 远端是否收录对应公钥——Windows 主机且目标用户在 Administrators 组时需写入 C:\\ProgramData\\ssh\\administrators_authorized_keys；③ profile 的用户名写法与手动连接是否一致（user / .\\user / user@domain 在 Windows sshd 中解析不同）。" + interactive + " 原始信息: " + sshExcerpt(t);
    if (/connection refused/i.test(t)) return "连接被拒绝：请确认远端 sshd 已启动且端口正确。原始信息: " + sshExcerpt(t);
    if (/connection timed out|timed out/i.test(t)) return "连接超时：请确认网络可达、端口开放，或检查 ProxyJump 配置。原始信息: " + sshExcerpt(t);
    if (/could not resolve hostname/i.test(t)) return "无法解析主机名：请检查连接配置中的 host 拼写。原始信息: " + sshExcerpt(t);
    return sshExcerpt(t, 500);
  }

  /** 池化执行：复用持久会话；连接层失败（exit 255）或会话异常时清理会话并经一次性连接重试。
   *  split=true 时 stderr 与 stdout 分离返回（命令走双哨兵协议）。
   *  timeoutMs 为命令级超时（issue #5）：超时即丢弃整个池化会话——挂起的远端命令
   *  仍占着共享 bash 进程，队列后续命令都会被它卡住，唯一可靠恢复是终止 SSH 重建。 */
  async function runPooled(p, cmd, stdinData, maxBytes, split, timeoutMs, role) {
    const tms = resolveTimeoutMs(timeoutMs);
    const skey = sessionKeyOf(p, role);
    const dropSession = () => {
      const old = sessions.get(skey);
      if (old) { old.close(); sessions.delete(skey); }
    };
    try {
      const s = getSession(p, role);
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

  // ---- settings 持久化（0.1.7-rc.2 新 API + ≤0.1.6 旧 API 双版本兼容）----
  let settingsFace = {
    read: () => ({ profiles: [], workspaces: [] }),
    updateProfiles: async () => {},
    updateWorkspaces: async () => {}
  };
  ctx.inject(["settings"], (sctx) => {
    const svc = sctx && sctx.settings ? sctx.settings : sctx;
    // 注意：Config 的 volatile 字段在 apply 的 config 里可能是**引用对象**（要 .get()），
    // 所以这里保留原始对象、由 prefsArray/resolvePrefValue 统一解析。
    const rawConfig = config && typeof config === "object" ? config : {};

    // ---- 新版（0.1.7-rc.2+）：数据在本插件 loader 行的 Config 里 ----
    if (svc && typeof svc.describe === "function" && typeof svc.update === "function") {
      const entryId = ownEntryId(ctx, name) || NS;
      try { ctx.effect(() => svc.configure({ auto: false }, ctx.fiber), "dsh-remote-ssh: settings page policy"); } catch (e) {}
      // 迁移成功后把数据放进这里兜底：新版 settings 的数据要在下一次启动才经 Config 生效，
      // 有了它「升级后第一次启动」就能立刻看到连接与工作区。
      const migrated = { profiles: null, workspaces: null };
      const profileHome = (ctx.profileContext && ctx.profileContext.home) || join(homedir(), ".dsh");
      const built = createNewSettingsFace(svc, entryId, rawConfig, ctx.logger, migrated, profileHome);
      settingsFace = built.face;
      // 一次性迁移旧 `settings.yaml` 的 section（旧 section 名是**包名**，新版按 entry id
      // 导入，所以它被留在 `settings.yaml.imported` 里）。等 loader 落定再写。
      Promise.resolve(ctx.loader && typeof ctx.loader.await === "function" ? ctx.loader.await() : undefined)
        .then(() => migrateLegacyPrefs({
          svc: svc,
          entryId: entryId,
          formOf: built.formOf,
          homeDir: (ctx.profileContext && ctx.profileContext.home) || join(homedir(), ".dsh"),
          ns: NS,
          declaredKeys: PrefsFieldNames,
          log: ctx.logger,
          onImported: (section) => {
            migrated.profiles = prefsArray(section && section.profiles);
            migrated.workspaces = prefsArray(section && section.workspaces);
          }
        }))
        .then((outcome) => {
          if (outcome === "already-configured" || outcome === "no-legacy-section") return;
          try { ctx.logger?.info?.("[dsh-remote-ssh] 旧设置迁移结果: " + outcome); } catch (e) {}
        })
        .catch((e) => {
          try { ctx.logger?.warn?.("[dsh-remote-ssh] 旧设置迁移失败（可重新添加连接；镜像目录与 .remote-ssh.json 未被改动）: " + String(e && e.message ? e.message : e)); } catch (e2) {}
        });
      return;
    }

    // ---- 旧版（≤0.1.6）：register(ns, schema) + scope.get()/update() ----
    if (svc && typeof svc.register === "function") {
      // settings 命名空间直接传插件 id（匹配 /^[a-z][a-z0-9-]*$/）。不再依赖
      // @deepseek-ai/dsh-settings 的 legacy `settingsNamespace` 构造器（该导出仅为
      // alpha.2 之前的插件保留，未来可能移除）；恒等语义下两种写法存储键完全一致。
      const scope = svc.register(NS, PrefsSchema);
      settingsFace = {
        read: () => {
          const v = scope.get();
          return {
            profiles: prefsArray(v && v.profiles),
            workspaces: prefsArray(v && v.workspaces),
            nodePath: String(prefsScalar("", v && v.nodePath) || ""),
            writeBackFailure: String(prefsScalar("error", v && v.writeBackFailure) || "error"),
            writeBackFreshness: prefsScalar(true, v && v.writeBackFreshness) !== false
          };
        },
        updateProfiles: async (profiles) => { await scope.update({ profiles: profiles }); },
        updateWorkspaces: async (workspaces) => { await scope.update({ workspaces: workspaces }); },
        updatePrefs: async (patch) => { await scope.update(patch); }
      };
      return;
    }

    // ---- 两条路都不可用：退回 apply() 的 config（只读）----
    settingsFace = {
      read: () => ({
        profiles: prefsArray(rawConfig.profiles),
        workspaces: prefsArray(rawConfig.workspaces),
        nodePath: String(prefsScalar("", rawConfig.nodePath) || ""),
        writeBackFailure: String(prefsScalar("error", rawConfig.writeBackFailure) || "error"),
        writeBackFreshness: prefsScalar(true, rawConfig.writeBackFreshness) !== false
      }),
      updateProfiles: async () => {},
      updateWorkspaces: async () => {},
      updatePrefs: async () => {}
    };
    try { ctx.logger?.warn("[dsh-remote-ssh] settings 服务既无新版 describe/update 也无旧版 register：连接与工作区配置将只读"); } catch (e) {}
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
      // keyPath 预检（issue #19）：私钥文件不在时先把这条一手证据说出来。不阻断后续探测 ——
      // ssh-agent 或 ~/.ssh/config 里的其它身份仍可能让连接成功，那种情况由成功路径带回 warning。
      let keyWarn = "";
      if (p.authMethod === "key" && p.keyPath) {
        try {
          const kp = expandSshPath(p.keyPath);
          if (!existsSync(kp)) keyWarn = "⚠️ 配置的私钥文件不存在：" + kp + "（若你依赖 ssh-agent 或 ~/.ssh/config 里的 IdentityFile，可清空 keyPath）";
        } catch (e) { /* 路径无法展开则跳过预检，不影响真实探测结果 */ }
      }
      // 认证探测只用跨平台 echo：Windows host 无 uname/pwd，且默认 shell 语义各异
      // （旧命令尾部 uname -a 会让认证成功的 Windows host 也误报失败）。
      const r = await runRemote(subprocess, p, "echo __DSH_OK__", undefined, 16 * 1024);
      if (r.ok) return keyWarn ? Object.assign({}, r, { warning: keyWarn }) : r;
      // 换行拼接 stderr：按行取诊断（sshExcerpt）才拿得到「Identity file … not accessible」这行。
      const rawErr = [r.error, r.stderr].filter(Boolean).join("\n");
      const baseErr = (keyWarn ? keyWarn + "\n" : "") + sshErrorHint(rawErr || ("ssh 退出码 " + r.exitCode));
      // 认证类失败：带 ssh -v 重跑一次握手 + 认证，抽取关键诊断行
      // （私钥加载 / 公钥提供 / 服务器拒绝方法），定位 Windows 常见坑。
      let error = baseErr;
      if (/permission denied|publickey/i.test(baseErr + " " + stripPqBanner(r.stderr))) {
        const diag = await runRemote(subprocess, p, "exit 0", undefined, 16 * 1024, ["-v"]);
        const diagText = String(diag.stderr || "")
          .split("\n")
          .filter(function (l) {
            // issue #19：把「Identity file … not accessible」也捞进来 —— 私钥文件不存在时 ssh
            // 只打这一行 Warning（不是 debug1: 行），此前正好被这个过滤器丢掉。
            return /debug1: (Offering public key|Authentications that can continue|Server accepts key|Trying private key|no such identity)|Identity file .*not accessible|Load key|Permission denied|passphrase/i.test(l);
          })
          .join("\n")
          .slice(0, 1200);
        if (diagText) error = error + "\n\nssh -v 诊断:\n" + diagText;
      }
      return { ok: false, exitCode: r.exitCode, signal: r.signal, stdout: r.stdout, stderr: r.stderr, truncated: r.truncated, error: error };
    },
    listWorkspaces: async () => ({ ok: true, workspaces: settingsFace.read().workspaces }),
    /**
     * 读全局偏好（issue #24 第二轮"可达性"）：设置面板要能显示与保存这三个字段。
     * 其中 `nodePath` 是 issue #23 的逃生舱 —— 终端起不来时用户必须能**在界面上**填它。
     */
    getPrefs: async () => {
      const v = settingsFace.read();
      return {
        ok: true,
        prefs: {
          nodePath: String(v.nodePath || ""),
          writeBackFailure: String(v.writeBackFailure || "error"),
          writeBackFreshness: v.writeBackFreshness !== false
        }
      };
    },
    /** 保存全局偏好（只接受这三个白名单键，避免客户端误写 profiles/workspaces）。 */
    savePrefs: async (args) => {
      const a = args || {};
      const patch = {};
      if (typeof a.nodePath === "string") patch.nodePath = a.nodePath.trim();
      if (typeof a.writeBackFailure === "string") {
        const m = a.writeBackFailure.trim().toLowerCase();
        patch.writeBackFailure = (m === "log" || m === "silent") ? "log" : "error";
      }
      if (typeof a.writeBackFreshness === "boolean") patch.writeBackFreshness = a.writeBackFreshness;
      if (!Object.keys(patch).length) return { ok: false, error: "没有可保存的字段" };
      await settingsFace.updatePrefs(patch);
      const v = settingsFace.read();
      return {
        ok: true,
        prefs: {
          nodePath: String(v.nodePath || ""),
          writeBackFailure: String(v.writeBackFailure || "error"),
          writeBackFreshness: v.writeBackFreshness !== false
        }
      };
    },
    /**
     * 更新单个远程工作区的写回护栏（issue #24 的 writeBack / writeBackExclude）。
     * 与 createRemoteWorkspace 一样走整表替换（settings 的 schema 是数组字段）。
     */
    updateWorkspaceGuards: async (args) => {
      const a = args || {};
      const id = a.id || a.workspaceId;
      const list = settingsFace.read().workspaces.slice();
      const i = list.findIndex((w) => w && w.id === id);
      if (i < 0) return { ok: false, error: "未找到远程工作区" };
      const next = Object.assign({}, list[i]);
      if (typeof a.writeBack === "boolean") next.writeBack = a.writeBack;
      if (Array.isArray(a.writeBackExclude)) {
        next.writeBackExclude = a.writeBackExclude.map((s) => String(s || "").trim()).filter(Boolean);
      }
      list[i] = next;
      await settingsFace.updateWorkspaces(list);
      return { ok: true, workspaces: settingsFace.read().workspaces };
    },
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
      // 根目录走 mirrorBaseDir()（与 fs 处理器的镜像判定同一处，避免两处各写一遍后漂移）。
      const mirrorDir = join(mirrorBaseDir(), wsId);
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
      // 同步安全（issue #20）：范围与体积上限随工作区持久化，逐次调用仍可覆盖
      if (Array.isArray(a.syncExclude)) ws.syncExclude = a.syncExclude.map(function (s) { return String(s); });
      if (Array.isArray(a.syncPaths)) ws.syncPaths = a.syncPaths.map(function (s) { return String(s); });
      if (a.syncMaxBytes !== undefined) {
        const n = parseInt(a.syncMaxBytes, 10);
        if (Number.isFinite(n) && n >= 0) ws.syncMaxBytes = n;
      }
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
      const wr = await remoteWriteFile(runPooled, p, args && args.path, args && args.content);
      // 插件自己显式写了远端 → 那一份就是"我们写的"，护栏 B 的记录作废（下次按当前状态重记）
      if (wr && wr.ok && args && args.path) freshnessForget(wrapperDir, p.id, args.path);
      return wr;
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
      // 同步安全（issue #20）：体积哨兵、范围控制、临时目录 + 原子替换都在 remoteSyncDown
      // 内部完成，成功后由它恢复 .remote-ssh.json 与占位 README（这里不再重复写）
      const rDown = await remoteSyncDown(subprocess, runPooled, p, ws.remotePath, ws.mirrorPath, syncOptsFrom(ws, a));
      // 拉下来之后镜像与远端一致 → 护栏 B 的记录作废（否则下一次写回会误报"远端被改过"）
      if (rDown && rDown.ok) freshnessForgetProfile(wrapperDir, p.id);
      return rDown;
    },
    /** 本地镜像 → 远端（按工作区）。 */
    syncUp: async (args) => {
      const a = args || {};
      const ws = settingsFace.read().workspaces.find((w) => w.id === (a.workspaceId || a.id));
      if (!ws) return { ok: false, error: "未找到远程工作区" };
      const p = getProfile(ws.profileId);
      if (!p) return { ok: false, error: "未找到连接配置" };
      // 始终排除插件自有文件（.remote-ssh.json / 占位 README），支持 paths/exclude（issue #20）
      const rUp = await remoteSyncUp(subprocess, p, ws.remotePath, ws.mirrorPath, syncOptsFrom(ws, a));
      // 推上去之后镜像与远端一致 → 护栏 B 的记录作废（这也是被拦下后的官方出路）
      if (rUp && rUp.ok) freshnessForgetProfile(wrapperDir, p.id);
      return rUp;
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
      const rp = resolveRemotePath(args.path, tc.remotePath);
      const wr = await remoteWriteFile(runPooled, tc.profile, rp, args.content);
      // 模型显式写了远端 → 那一份就是"当前版本"，护栏 B 的记录作废（避免下一次误报"远端被改过"）
      if (wr && wr.ok && rp) freshnessForget(wrapperDir, tc.profile.id, rp);
      return normExec(wr);
    }
  });

  // 同步：把远程工作区的文件同步到本地镜像目录（syncDown），或把本地镜像改动推回远端（syncUp）。
  // 借鉴 flymysql dsh-remote 的 rw_sync / rw_push，但用 tar-over-ssh 流式管道，不引入 ssh2。
  // issue #20：整树同步在远端根很大时等于一次全量复制 —— 描述必须写清语义（会替换本地镜像、
  // 有体积哨兵、可用 paths 收窄），否则模型和用户都只看到一句"同步"。
  const syncDesc = "按远程工作区同步文件：sync **整树**拉取远端到本地镜像目录（可用 paths 只同步子路径、" +
    "exclude 排除、force 显式承担全量；远端体积超过哨兵上限会被拒绝，镜像里独有的文件默认拒绝删除），" +
    "push 把本地镜像改动推回远端（自动排除插件自有的 .remote-ssh.json 与占位 README，不再污染远端根）。" +
    "用 workspaceId 指定工作区，或留空在当前远程工作区会话中自动识别。**读远端文件请用文件面板或 remote_ssh_cat，不要用 sync。**" +
    "⚠️ exclude 不会抑制被显式列进 paths 的路径（tar 对命令行点名的成员不做 --exclude 过滤）：要排除大目录，请把 paths 提到它的父目录。" +
    "在 Windows 上拉取时，插件会让远端用 PAX 格式打包（否则非 ASCII 文件名会被本地 tar 按 ANSI 代码页静默改写，issue #22）；远端 tar 不支持时会明确提示。" +
    "旧版本留下的乱码文件名可用 repairNames: true 清理。" +
    "Sync/push a remote workspace to its local mirror (or back). sync is whole-tree by default: paths/exclude narrow it, " +
    "a size sentinel refuses oversized roots, and mirror-only files are never deleted silently. Note: exclude does not filter " +
    "members listed explicitly in paths. Pass workspaceId, or omit it inside a remote-workspace session.";
  const syncParams = {
    workspaceId: { type: "string", description: "远程工作区 id（留空则在当前远程工作区会话中自动识别）。" },
    paths: { type: "array", items: { type: "string" }, description: "只同步这些子路径（相对远端根），例如 [\"src\",\"docs\"]；留空 = 整树。局部同步不删除镜像里的任何文件。注意：paths 里点名的路径不受 exclude 影响。" },
    exclude: { type: "array", items: { type: "string" }, description: "排除规则（相对远端根，支持 * 通配），例如 [\"data\",\"*.log\"]。⚠️ 不会排除被显式列进 paths 的成员（tar 语义）；不匹配任何内容的模式不报错也不提示。" },
    force: { type: "boolean", description: "显式确认：跳过体积哨兵与「仅存在于镜像的文件」保护（确认要整树全量复制时才用）。" },
    maxBytes: { type: "number", description: "本次同步的体积上限（字节），覆盖工作区设置与默认 2 GiB。" },
    timeoutMs: { type: "number", description: "本次同步的墙钟预算（毫秒），默认 600000；0 = 不限。" },
    repairNames: { type: "boolean", description: "清理旧版本（≤2.4.22）在 Windows 上拉取非 ASCII 名产生的乱码文件名（issue #22）。只在镜像里删除「已证明是某个远端正确名被 GBK 改写」的副本，内容以远端为准；默认 false。" }
  };
  // sync / push 共用的输出 schema（issue #14）：`error` **不能**标成必填 —— 成功路径本来就没有
  // error，标必填会让「推送成功」被判成 `returned invalid output`（模型看到失败、副作用却已落地，
  // 只能靠再跑一次 ls 才能确认）。同理成功路径会带上 remotePath / mirrorPath，必须在 schema 里声明
  // （additionalProperties: false 会拒掉未声明字段）。issue #20 又加了体积/范围/被拒清单字段。
  const syncOutput = {
    schema: { type: "object", additionalProperties: false, properties: {
      ok: { type: "boolean", required: true },
      remotePath: { type: "string" },
      mirrorPath: { type: "string" },
      error: { type: "string" },
      bytes: { type: "number" },
      onlyMirrorTotal: { type: "number" },
      onlyMirror: { type: "array", items: { type: "string" } },
      paths: { type: "array", items: { type: "string" } },
      mojibakeNames: { type: "array", items: { type: "string" } },
      repairedNames: { type: "number" },
      notice: { type: "string" }
    } },
    render: textRender(function (a, v) {
      if (!v.ok) return v.error || "同步失败";
      const what = v.mirrorPath ? "同步完成" : "推送完成";
      const size = v.bytes ? "（约 " + formatSyncBytes(v.bytes) + "）" : "";
      const scoped = v.paths && v.paths.length ? "（仅 " + v.paths.join("、") + "）" : "";
      return what + size + scoped + (v.notice ? "。" + v.notice : "");
    })
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
      // 同步安全（issue #20）：体积哨兵、范围控制、临时目录 + 原子替换都在 remoteSyncDown
      // 内部完成，成功后由它恢复 .remote-ssh.json 与占位 README（这里不再重复写）
      const rDown = await remoteSyncDown(subprocess, runPooled, p, ws.remotePath, ws.mirrorPath, syncOptsFrom(ws, args));
      // 拉取成功后镜像与远端一致 → 护栏 B 的记录作废
      if (rDown && rDown.ok) freshnessForgetProfile(wrapperDir, p.id);
      return rDown;
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
      // 始终排除插件自有文件（.remote-ssh.json / 占位 README），支持 paths/exclude（issue #20）
      const rUp = await remoteSyncUp(subprocess, p, ws.remotePath, ws.mirrorPath, syncOptsFrom(ws, args));
      // 推送成功后镜像与远端一致 → 护栏 B 的记录作废（这也是被护栏 B 拦下后的官方出路）
      if (rUp && rUp.ok) freshnessForgetProfile(wrapperDir, p.id);
      return rUp;
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
    "      // ⚠️ issue #21：'-o' 与其取值必须成对、不能从中间插入别的选项 —— 此前写成",
    "      // args.splice(2, 0, '-J', j.proxyJump)，插点正好落在 '-o' 与 'StrictHostKeyChecking=no'",
    "      // 之间，ssh 把 '-J' 当成 -o 的关键字（关键字小写化后即报文里的 \"-j\"），于是报",
    "      // 'command-line line 0: no argument after keyword \"-j\"' 并立即退出 255 —— 只要连接填了",
    "      // ProxyJump，内置终端就永远打不开。改为按顺序 push，选项之间不交叉。",
    "      const args = ['-tt', '-o', 'StrictHostKeyChecking=no', '-o', 'ExitOnForwardFailure=no'];",
    "      if (j.proxyJump) { args.push('-J', String(j.proxyJump)); }",
    "      args.push('-p', String(port), '-i', j.keyPath, j.user + '@' + j.host);",
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
  // issue #23：wrapper 必须能自己找到 node（桌面端 PATH 上没有 node 是常态），
  // 解析结果写死进薄壳，并在日志里留一行来源，便于排查"终端一闪而过"。
  const wrapperNode = resolveWrapperNode(config);
  if (wrapperNode.bin) {
    try { ctx.logger?.info?.("[dsh-remote-ssh] 终端 wrapper 使用的 node: " + wrapperNode.bin + "（来源：" + wrapperNode.source + "）"); } catch (e) {}
  } else {
    try {
      ctx.logger?.warn?.("[dsh-remote-ssh] 未能解析出 node 绝对路径（试过：" + wrapperNode.tried.join("、") +
        "），终端 wrapper 将回退到 PATH 查找；若桌面端 PATH 上没有 node，集成终端会提示如何设置 nodePath。");
    } catch (e) {}
  }
  const shims = wrapperShims(wrapperNode.bin);
  const winCmd = shims.winCmd;
  const posixSh = shims.posixSh;
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

  // 把本地镜像路径转换为远程路径。
  // 契约：**入参必须是本地镜像路径**。调用方（fs 处理器）在 2.4.30 起已按请求路径分类，
  // 远端绝对路径走 remotePathForRequest() 原样下发、本机路径根本不进远程分支 —— 所以下面的
  // else 兜底不该再被触发。真被触发说明又出现了同类误判（issue #26 的成因），因此这里用
  // **warn** 而不是 debug：debug 在默认日志里看不见，等于把错误藏起来。
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
      try {
        ctx.logger?.warn("[dsh-remote-ssh] localToRemote 收到镜像之外的路径（契约应为本地镜像路径，说明上游分类漏了）: " +
          localPath + "（按相对路径拼到 " + remoteBase + "）");
      } catch (e) {}
    }
    if (rel.startsWith("/")) rel = rel.slice(1);
    if (!rel) return remoteBase;
    // 拼接远程路径
    const rb = String(remoteBase).replace(/\/+$/, "");
    return rb + "/" + rel;
  }

  /**
   * 请求上下文里的会话工作目录：显式传入的 cwd 优先（客户端可能已按自己的语义算好），
   * 否则用 sessionId 查会话注册表。取不到就返回 ""，由调用方决定怎么报错 —— **不要回退到
   * process.cwd()**：那是插件宿主目录（pnpm profile），相对路径落到那里正是 issue #25 的现象。
   * 客户端的 cwd 只在**绝对路径**时采信（对齐上游 `sessionCwdOf` → `requireAbsolute()`：
   * 相对 cwd 拼出来的还是相对路径，等于把 bug 放回来）；不可信就继续查注册表。
   */
  function sessionCwdFrom(payload, explicit) {
    const direct = explicit !== undefined ? explicit : (payload && payload.cwd);
    if (direct !== undefined && direct !== null && String(direct) !== "" && isAbsoluteLocalPath(String(direct))) {
      return String(direct);
    }
    const sessionId = payload && payload.sessionId;
    if (!sessionId) return "";
    try {
      const sessions = ctx.get("sessions");
      const session = sessions ? sessions.get(sessionId) : null;
      const cwd = String((session && session.header && session.header.cwd) || "");
      return isAbsoluteLocalPath(cwd) ? cwd : "";
    } catch (e) { return ""; }
  }

  /**
   * 校验 better-sidebar 0.23+ `fs.trees` 的 paths 字段（上游语义：1..64 条非空字符串）。
   * 返回 { paths } 或 { error }（error 时按 bad-request 400 回复，与上游一致）。
   */
  function readPathsField(payload) {
    const raw = payload ? payload.paths : undefined;
    const list = Array.isArray(raw) ? raw.filter(function (v) { return typeof v === "string" && v !== ""; }) : [];
    if (list.length === 0) return { error: "paths must be a non-empty array" };
    if (list.length > 64) return { error: "too many paths (max 64)" };
    return { paths: list };
  }

  /**
   * 远端条目 → better-sidebar 条目形状（path 一律用本地镜像路径，保持客户端兼容：
   * 客户端只认镜像路径，fs.read/fs.write 再由本插件映射回远端）。
   */
  function sidebarEntriesFrom(remoteEntries, localCwd) {
    const entries = (remoteEntries || []).map(function (e) {
      return {
        name: e.name,
        path: join(localCwd, e.name),
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
    return entries;
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

  // better-sidebar 0.26.1 新增端点 fs.readPage：5 MiB 以上文件的**只读分页预览**。
  // 字段名与行为逐项对齐上游 readPage()（页大小 128 KiB、页尾回退到最后一个换行、
  // kind/text/offset/nextOffset/eof/size/mtimeMs/encoding）—— 消费方是上游的预览面板，字段名不能自创。
  // 页大小写成本地常量而不是模块级 const：本插件的多个测试沙箱按位置注入 READ_LIMIT/LIST_LIMIT，
  // 新增模块级名字会让沙箱里的引用变成 undefined。
  // 编码简化：与 localReadText 一致按 UTF-8 解码（上游另有宽字符编码探测，这里不重复实现）。
  async function localReadPage(path, offset) {
    const PAGE_BYTES = 131072;
    let info;
    try { info = await stat(path); }
    catch (e) { throw new Error("cannot read \"" + path + "\": " + String(e && e.message ? e.message : e)); }
    if (info.isDirectory()) throw new Error("\"" + path + "\" is a directory");
    const size = info.size;
    const start = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
    if (start >= size) {
      return { kind: "text", text: "", offset: start, nextOffset: size, eof: true, size: size, mtimeMs: info.mtimeMs, encoding: "utf8" };
    }
    const handle = await open(path, "r");
    try {
      const length = Math.min(PAGE_BYTES, size - start);
      const buffer = Buffer.alloc(length);
      const r = await handle.read(buffer, 0, length, start);
      let slice = buffer.subarray(0, r.bytesRead);
      let nextOffset = start + r.bytesRead;
      if (nextOffset < size) {
        // 回退到最后一个换行：整页没有换行时原样返回（由客户端按 nextOffset 拼接下一页）。
        const lastBreak = slice.lastIndexOf(10) + 1;
        if (lastBreak > 0) { slice = slice.subarray(0, lastBreak); nextOffset = start + lastBreak; }
      }
      return {
        kind: "text", text: slice.toString("utf8"), offset: start, nextOffset: nextOffset,
        eof: nextOffset >= size, size: size, mtimeMs: info.mtimeMs, encoding: "utf8"
      };
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

  // 本地 mkdir（对齐 better-sidebar 0.23+ 的 fs.mkdir 契约：单段名、不覆盖、返回新绝对路径）
  async function localMakeDir(parent, name) {
    if (!parent) return { ok: false, error: "path 为必填项" };
    if (!name || name === "." || name === ".." || /[\\/]/.test(name)) {
      // badRequest 标记 → 外层映射成 400 + code "bad-request"（上游对"形状不对"一律用这个码，
      // 客户端据此显示"哪条规则不对"，而不是笼统的 fs-error）。
      return { ok: false, error: "name 必须是单个路径段", badRequest: true };
    }
    const dest = join(parent, name);
    // exists 标记 → 外层映射成 409：上游 fs.mkdir / fs.rename / fs.createFile 对"已存在"都给 409，
    // 本插件的远程分支也一直是 409，本地分支此前误给 400（2.4.28 对齐）。
    if (existsSync(dest)) return { ok: false, error: "\"" + name + "\" 已存在", exists: true };
    await mkdir(dest);
    return { ok: true, path: dest };
  }

  // 本地 createFile（对齐 better-sidebar 0.25.0 的 fs.createFile 契约：单段名 + 非法字符/保留名校验、
  // 已存在不覆盖（409）、返回新文件的绝对路径）。空文件用 `wx` 原子创建，避免 check-then-write 竞态。
  async function localCreateFile(parent, name) {
    if (!parent) return { ok: false, error: "path 为必填项" };
    const problem = creatableFileNameProblem(name);
    if (problem) return { ok: false, error: problem, badRequest: true };
    const dest = join(parent, String(name));
    try {
      await writeFile(dest, "", { flag: "wx", encoding: "utf8" });
    } catch (e) {
      if (e && e.code === "EEXIST") return { ok: false, error: "\"" + String(name) + "\" already exists", exists: true };
      return { ok: false, error: "cannot create \"" + String(name) + "\": " + String(e && e.message ? e.message : e) };
    }
    return { ok: true, path: dest };
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
    return { path: localCwd, entries: sidebarEntriesFrom(r.entries, localCwd), truncated: false };
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

  // 远端分页读（better-sidebar 0.26.1 的 fs.readPage）：一次往返拿 size/mtime + 该页字节，
  // 页尾回退与解码在本地做 → 与本地分支 localReadPage 返回**同一个形状**。
  // 失败时返回 { ok:false, error }，由调用方映射成上游同款的 400 fs-error。
  async function remoteReadPageForSidebar(profile, remotePath, offset) {
    const PAGE_BYTES = 131072;
    const start = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
    const r = await runPooled(profile, buildReadPageCommand(remotePath, start, PAGE_BYTES), undefined, 1 << 20);
    if (!r || !r.ok) return { ok: false, error: (r && (r.error || r.stderr)) || "read failed" };
    const fr = parseStatFrame(r.stdout);
    if (!fr.framed) return { ok: false, error: "远端未返回 stat 标记（无法判定大小/页边界）" };
    if (fr.err) return { ok: false, error: fr.err };
    const size = fr.size === null ? 0 : fr.size;
    const mtimeMs = fr.mtime === null ? 0 : fr.mtime * 1000;
    if (start >= size) {
      return { ok: true, page: { kind: "text", text: "", offset: start, nextOffset: size, eof: true, size: size, mtimeMs: mtimeMs, encoding: "utf8" } };
    }
    const buf = Buffer.from(String(fr.rest || "").replace(/\s+/g, ""), "base64");
    let page = buf;
    let nextOffset = start + buf.length;
    if (nextOffset < size) {
      const lastBreak = buf.lastIndexOf(10) + 1;
      if (lastBreak > 0) { page = buf.subarray(0, lastBreak); nextOffset = start + lastBreak; }
    }
    return {
      ok: true,
      page: {
        kind: "text", text: page.toString("utf8"), offset: start, nextOffset: nextOffset,
        eof: nextOffset >= size, size: size, mtimeMs: mtimeMs, encoding: "utf8"
      }
    };
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
      // 获取会话 cwd（issue #25：这个值算出来就必须真用上，见下面的 localPathOf）
      const sessionId = payload && payload.sessionId;
      const sessionCwd = sessionCwdFrom(payload);
      // 如果 sessionCwd 还是空，尝试用 payload.path（绝对路径时它就在工作区内，可据此判定远程工作区）；
      // 相对路径不能用来判定工作区 —— 那正是 issue #25 里"相对路径落到插件宿主目录"的入口。
      //
      // ---- issue #26：走不走远端，由**请求路径本身**决定，不由会话 cwd 决定 ----
      // 会话 cwd 只能回答"相对路径该相对谁"，不能回答"这个绝对路径在远端"。"会话在远程工作区"
      // 被当成"这个路径在远端"，于是：本机绝对路径被推到远端（远端凭空多一层 /Users/…），
      // 远端绝对路径被再拼一次远端根（<root><root>/…）。两者都会**静默**落到错位置（写/删尤其危险）。
      const sessionHit = sessionCwd !== "" ? remoteWorkspaceForPath(sessionCwd) : null;
      const rawPaths = [];
      if (payload) {
        if (typeof payload.path === "string" && payload.path !== "") rawPaths.push(payload.path);
        // fs.trees 没有 path 字段（只有 paths[]），同样按路径本身判定
        if (Array.isArray(payload.paths)) {
          for (const p of payload.paths) if (typeof p === "string" && p !== "") rawPaths.push(p);
        }
      }
      const syntaxes = rawPaths.map(classifyRequestPathSyntax);
      // 每个路径的最终归属：
      //   mirror          已注册远程工作区的镜像成员（→ 远端，剥镜像前缀拼远端根）
      //   self-described  目录自带 .remote-ssh.json（→ 远端，保持 2.4.x 行为）
      //   remote-abs      已经是远端绝对路径（→ 远端，**原样下发**）
      //   local           本机绝对路径（盘符 / UNC）（→ 本地，即使会话在远程工作区）
      //   relative        （→ 按会话 cwd 决定）
      //   tilde / empty   （→ 交给下面原有逻辑，保持原有报错）
      const ownerships = rawPaths.map(function (raw, i) {
        const syn = syntaxes[i];
        if (syn === "empty" || syn === "tilde") return syn;
        if (syn === "relative") return "relative";
        // 绝对 / 盘符 / UNC：先看它是不是某个已注册工作区的镜像成员
        const hit = remoteWorkspaceForPath(raw);
        if (hit) return "mirror";
        if (isUnderMirrorBase(raw)) return "mirror-orphan";
        if (syn === "posix-abs") return "remote-abs";
        // 目录自带 .remote-ssh.json（未注册但自描述）：保持 2.4.x 的旧行为
        if (readRemoteInfoSync(raw)) return "self-described";
        // 盘符（含 `C:foo` 这种盘符相对）与 UNC：只可能是**本机**路径。
        // 注意分类按**语法**而不是 isAbsoluteLocalPath() —— `C:foo` 不是绝对路径，
        // 用后者会把它当相对路径拼到会话 cwd 上，又变成"按会话 cwd 决定归属"的老毛病。
        return "local";
      });
      const orphanPath = rawPaths[ownerships.indexOf("mirror-orphan")];
      if (orphanPath !== undefined) {
        // 在镜像根之下、却不属于任何已注册工作区（工作区被移除 / 镜像成了孤儿 / sessionId 过期）。
        // 这种路径**不可能是**合法的本地目标 —— 明确报错，绝不在镜像上执行读写（2.4.29 起，不回退）。
        writeJson(res, 400, {
          ok: false,
          error: {
            code: "bad-request",
            message: "路径 " + String(orphanPath) + " 位于远程工作区镜像目录下，但它不属于任何已注册的远程工作区" +
              "（镜像可能已失效，或该工作区已被移除）。为安全起见不在本地镜像上执行该操作：" +
              "请重新添加该远程工作区，或改用指向真实本地位置的绝对路径。",
          },
        });
        return;
      }
      const ownSet = new Set(ownerships.filter(function (o) {
        return o && o !== "empty" && o !== "tilde" && o !== "relative";
      }));
      if (ownSet.has("local") && (ownSet.has("mirror") || ownSet.has("self-described") || ownSet.has("remote-abs"))) {
        // 同一次请求里既给了本机路径又给了远端/镜像路径：两种归属无法在同一分支里都做对，
        // 猜一个就会让另一侧被静默忽略（issue #26 那类错位的老毛病）→ 明确报错，让用户分开操作。
        writeJson(res, 400, {
          ok: false,
          error: {
            code: "bad-request",
            message: "同一次请求里混用了本机路径与远程工作区路径（" + rawPaths.join(" / ") +
              "）：本机路径在远程工作区会话里不会走 SSH，混用会让其中一侧被静默忽略，请分开操作。",
          },
        });
        return;
      }
      const firstOwn = ownerships.find(function (o) { return o && o !== "empty"; });
      let remoteInfo = null;
      // remoteBase 必须是**工作区根**：拿更深的路径当基准，localToRemote() 会按那个子目录相对映射。
      let remoteBase = "";
      const mirrorIdx = ownerships.indexOf("mirror");
      const selfIdx = ownerships.indexOf("self-described");
      if (mirrorIdx >= 0) {
        const hit = remoteWorkspaceForPath(rawPaths[mirrorIdx]);
        remoteInfo = hit.info;
        remoteBase = hit.root;
      } else if (selfIdx >= 0) {
        remoteInfo = readRemoteInfoSync(rawPaths[selfIdx]);
        remoteBase = rawPaths[selfIdx];
      } else if (firstOwn === "local") {
        // 本机绝对路径（盘符 / UNC）：远端是 Linux，这类路径在远端没有意义 —— 走本地分支。
        remoteInfo = null;
      } else if (firstOwn === "remote-abs") {
        // 已经是远端绝对路径：只在"会话本身在远程工作区"时有意义（否则本机没有这种文件，如实报 ENOENT）。
        if (sessionHit) { remoteInfo = sessionHit.info; remoteBase = sessionHit.root; }
      } else if (sessionHit) {
        // 相对路径 / 请求里没有路径（fs.search 等）：按会话 cwd 决定，与 2.4.29 一致。
        remoteInfo = sessionHit.info;
        remoteBase = sessionHit.root;
      }
      // 相对路径的基准：会话 cwd 优先，远程分支再退到（一定是绝对路径的）镜像根。
      const pathBase = sessionCwd || remoteBase;
      /**
       * 请求路径归一（issue #25）：绝对路径原样返回；相对路径按会话 cwd / 镜像根解析；
       * 解析不了就**报错返回 null**（绝不回退 process.cwd() —— 那是插件宿主目录，
       * 相对路径落到那里会把文件面板/文件树指到 pnpm profile 里去，写操作还会改到那里）。
       */
      const localPathOf = (raw, base) => {
        const r = resolveSessionPath(raw, base);
        if (r.resolved) return r.path;
        writeJson(res, 400, { ok: false, error: { code: "bad-request", message: unresolvedPathMessage(raw, base, r.reason) } });
        return null;
      };
      try { ctx.logger?.debug("[dsh-remote-ssh] intercept " + method + ": sessionId=" + sessionId + " cwd=" + sessionCwd + " path=" + (payload && payload.path) + " remote=" + (remoteInfo ? "YES" : "NO")); } catch (e) {}
      let result;
      if (remoteInfo && remoteInfo.keyPath && remoteInfo.host && remoteInfo.user) {
        // ---- 远程工作区：走 SSH ----
        const profile = getProfile(remoteInfo.profileId);
        if (!profile) { writeJson(res, 500, { ok: false, error: { code: "internal", message: "remote profile not found: " + remoteInfo.profileId } }); return; }
        /**
         * 远端分支的路径映射（issue #26 现象 2）。远端分支的入参只可能是三种，顺序关键：
         *   ① 已经是**远端绝对路径**（`/mnt/…`、`/tmp/x.log`）→ **原样下发**，绝不再拼远端根
         *      （此前它会被当相对路径，拼成 `<root><root>/…`，必然打不开）；
         *   ② 镜像成员路径 → 剥镜像前缀拼远端根（2.4.29 的行为，保持）；
         *   ③ 相对路径 → 按工作区根解析（行为不变）。
         * 注意 ① 必须排除镜像成员：DSH 跑在 Linux 上时镜像路径本身就是 `/…` 形态。
         */
        const remotePathForRequest = function (resolvedLocal) {
          if (looksLikeRemoteAbsolutePath(resolvedLocal) &&
              !remoteWorkspaceForPath(resolvedLocal) && !isUnderMirrorBase(resolvedLocal)) {
            return String(resolvedLocal).replace(/\\/g, "/");
          }
          return localToRemote(resolvedLocal, remoteBase, remoteInfo.remotePath);
        };
        if (method === "fs.tree") {
          const localPath = localPathOf(payload.path || sessionCwd, pathBase); if (localPath === null) return;
          const rp = remotePathForRequest(localPath);
          result = await remoteListForSidebar(profile, rp, localPath);
        } else if (method === "fs.read") {
          const localPath = localPathOf(payload.path || sessionCwd, pathBase); if (localPath === null) return;
          const rp = remotePathForRequest(localPath);
          result = await remoteReadForSidebar(profile, rp);
        } else if (method === "fs.readPage") {
          // better-sidebar 0.26.1 新增端点（与 issue #27 同批发现）：按字节偏移分页读，供大文件只读预览。
          // 不接管的话上游会去读**本地镜像**那一份 —— 远端才是事实来源，预览会显示陈旧副本
          // （与 0.25.0 的 fs.createFile 同一类问题）。path 必填，不做"空路径"兜底。
          const localPath = localPathOf(payload.path, pathBase); if (localPath === null) return;
          const rp = remotePathForRequest(localPath);
          const pr = await remoteReadPageForSidebar(profile, rp, payload.offset);
          if (!pr.ok) { writeJson(res, 400, { ok: false, error: { code: "fs-error", message: String(pr.error || "cannot read") } }); return; }
          result = pr.page;
        } else if (method === "fs.write") {
          const localPath = localPathOf(payload.path || sessionCwd, pathBase); if (localPath === null) return;
          const rp = remotePathForRequest(localPath);
          result = await remoteWriteFile(runPooled, profile, rp, payload.content || "");
          // 用户在文件面板里显式保存 → 那一份就是"当前版本"，护栏 B 的记录作废
          if (result && result.ok && rp) freshnessForget(wrapperDir, profile.id, rp);
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
          const localPath = localPathOf(payload.path, pathBase); if (localPath === null) return;
          const name = String(payload.name || "");
          if (!name || name === "." || name === ".." || /[\\/]/.test(name)) {
            writeJson(res, 400, { ok: false, error: { code: "bad-request", message: "name must be a single path segment" } }); return;
          }
          const srcRemote = remotePathForRequest(localPath);
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
          const localPath = localPathOf(payload.path, pathBase); if (localPath === null) return;
          const srcRemote = remotePathForRequest(localPath);
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
        } else if (method === "fs.trees") {
          // better-sidebar 0.23+（实测 0.24.1）的批量列举：可见集一次请求。
          // 客户端按返回的 level.path 落缓存，所以 path 必须回显客户端给的路径。
          const req = readPathsField(payload);
          if (req.error) { writeJson(res, 400, { ok: false, error: { code: "bad-request", message: req.error } }); return; }
          // 相对路径同样按会话 cwd / 镜像根解析（issue #25）。解析不了的**只让那一条**报错
          // （客户端按 level 渲染，别让一条坏路径把整棵树拖成 400），且绝不把相对路径交给远端映射
          // —— 那会静默落到工作区根下的错误位置。
          const resolvedList = req.paths.map(function (raw) { return resolveSessionPath(raw, pathBase); });
          const listable = resolvedList.filter(function (r) { return r.resolved; }).map(function (r) { return r.path; });
          const listed = listable.length
            ? await remoteListDirsBatch(runPooled, profile, listable.map(function (lp) {
                return remotePathForRequest(lp);
              }))
            : [];
          let listedIdx = 0;
          result = { levels: resolvedList.map(function (r, i) {
            if (!r.resolved) return { path: req.paths[i], entries: [], truncated: false, error: unresolvedPathMessage(req.paths[i], pathBase, r.reason) };
            const lvl = listed[listedIdx++];
            if (!lvl || !lvl.ok) return { path: r.path, entries: [], truncated: false, error: (lvl && lvl.error) || "读取目录失败" };
            return { path: r.path, entries: sidebarEntriesFrom(lvl.entries, r.path), truncated: false };
          }) };
        } else if (method === "fs.mkdir") {
          // better-sidebar 0.23+ 新增端点：新建目录必须落在远端，否则用户以为建好了、
          // 实际只在本地镜像里多了一个空目录（0.24 之前没有该端点，不存在这个问题）。
          const parentLocal = localPathOf(payload.path || sessionCwd, pathBase); if (parentLocal === null) return;
          const dirName = String(payload.name || "");
          if (!dirName || dirName === "." || dirName === ".." || /[\\/]/.test(dirName)) {
            writeJson(res, 400, { ok: false, error: { code: "bad-request", message: "name must be a single path segment" } }); return;
          }
          const parentRemote = remotePathForRequest(parentLocal);
          const destRemote = String(parentRemote).replace(/\/+$/, "") + "/" + dirName;
          const exists = await runPooled(profile, "test -e " + shellQuotePath(destRemote), undefined, 4096);
          if (exists.ok) {
            writeJson(res, 409, { ok: false, error: { code: "fs-error", message: "\"" + dirName + "\" already exists" } }); return;
          }
          const mk = await runPooled(profile, "mkdir -- " + shellQuotePath(destRemote), undefined, 4096);
          if (!mk.ok) {
            writeJson(res, 400, { ok: false, error: { code: "fs-error", message: String(mk.stderr || mk.error || "mkdir failed").trim().slice(0, 500) } }); return;
          }
          // 父目录列举已变；本地镜像不创建（镜像不是事实来源，与 fs.write/上传一致）。
          invalidateRemoteCaches(profile, parentRemote, { subtree: false });
          result = { path: join(parentLocal, dirName) };
        } else if (method === "fs.createFile") {
          // better-sidebar 0.25.0 新增端点：新建空文件必须落在远端。不接管的话上游会在**本地镜像**里
          // 建文件 —— 用户在面板里看到"建好了"，远端却永远没有这个文件（与 0.24 的 fs.trees 同一类）。
          const parentLocal = localPathOf(payload.path || sessionCwd, pathBase); if (parentLocal === null) return;
          const fileName = String(payload.name || "");
          const nameProblem = creatableFileNameProblem(fileName);
          if (nameProblem) {
            writeJson(res, 400, { ok: false, error: { code: "bad-request", message: nameProblem } }); return;
          }
          const parentRemote = remotePathForRequest(parentLocal);
          const destRemote = String(parentRemote).replace(/\/+$/, "") + "/" + fileName;
          const exists = await runPooled(profile, "test -e " + shellQuotePath(destRemote), undefined, 4096);
          if (exists.ok) {
            writeJson(res, 409, { ok: false, error: { code: "fs-error", message: "\"" + fileName + "\" already exists" } }); return;
          }
          // `set -C`（noclobber）让重定向本身不覆盖已存在文件：即使上面那次探测之后有人抢先建了，
          // 这里也只会失败，不会把别人的文件清空。
          const made = await runPooled(profile, "(set -C; : > " + shellQuotePath(destRemote) + ")", undefined, 4096);
          if (!made.ok) {
            writeJson(res, 400, { ok: false, error: { code: "fs-error", message: String(made.stderr || made.error || "create file failed").trim().slice(0, 500) } }); return;
          }
          // 父目录列举已变（多了这个文件）；本地镜像不创建，与 fs.mkdir / fs.write 一致。
          invalidateRemoteCaches(profile, parentRemote, { subtree: false });
          result = { path: join(parentLocal, fileName) };
        } else {
          writeJson(res, 404, { ok: false, error: { code: "not-found", message: "unknown method " + method } }); return;
        }
      } else {
        // ---- 本地工作区：走本地 fs ----
        // 这里同样必须先归一（issue #25）：被 exact 接管后本地会话也走本函数，而本地分支此前把
        // 相对路径原样交给 fs，Node 按插件宿主进程的 process.cwd() 解析 —— 读不到文件还好，
        // fs.write / fs.remove 会在 pnpm profile 目录里写/删。
        if (method === "fs.tree") {
          // issue #27：「添加工作区 → 本地目录」弹窗首次打开会发 {sessionId:"", path:""} —— 在**只读的
          // 初始列举**里空路径是按设计的语义「打开主目录」（客户端 lib/client.js：「打开按钮：按输入框
          // 路径加载该路径下的文件树。空路径时打开主目录。」；localListDir() 本身也有
          // `if (!path) path = homedir()` 兜底，但 2.4.27 起走不到那里）。
          // 2.4.27 为修 issue #25 引入的 localPathOf() 对空路径一律 400，把这条初始列举一起拦了。
          // 放行范围**只限"连会话 cwd 都取不到"的空路径，且只限 fs.tree 这一个只读方法**：
          // 有 cwd 时仍按 cwd 列举；fs.read / fs.write / fs.rename / fs.remove / fs.mkdir /
          // fs.createFile 的必填校验与相对路径解析一行不动（那才是 #25 要防的对象）。
          const rawTreePath = payload.path || sessionCwd;
          if (!rawTreePath) {
            result = await localListDir("", LIST_LIMIT);
          } else {
            const p = localPathOf(rawTreePath, pathBase); if (p === null) return;
            result = await localListDir(p, LIST_LIMIT);
          }
        } else if (method === "fs.read") {
          const p = localPathOf(payload.path, pathBase); if (p === null) return;
          result = await localReadText(p, READ_LIMIT);
        } else if (method === "fs.readPage") {
          // 与上游一致：path 必填（没有 fs.tree 那种"空路径=主目录"的语义）；offset ≥ size → 空页 + eof。
          const p = localPathOf(payload.path, pathBase); if (p === null) return;
          try { result = await localReadPage(p, payload.offset); }
          catch (e) { writeJson(res, 400, { ok: false, error: { code: "fs-error", message: String(e && e.message ? e.message : e) } }); return; }
        } else if (method === "fs.write") {
          const p = localPathOf(payload.path, pathBase); if (p === null) return;
          result = await localWriteFile(p, payload.content || "");
        } else if (method === "fs.search") {
          // matches 必须是 cwd 相对、'/' 分隔的路径（better-sidebar 客户端直接 .map 渲染并据此打开）；
          // entries 保留绝对路径（本插件 fs.read 拦截据此映射回远端）。
          if (!sessionCwd) {
            writeJson(res, 400, { ok: false, error: { code: "bad-request", message: unresolvedPathMessage(payload.query, "", "no-base") } });
            return;
          }
          const r = await localSearchFiles(sessionCwd, payload.query || "");
          const entries = (r && r.entries) || [];
          result = fsSearchResult(entries.map(function (e) { return toPosixRelative(sessionCwd, e.path); }), entries, r && r.truncated);
        } else if (method === "fs.rename") {
          const p = localPathOf(payload.path, pathBase); if (p === null) return;
          result = await localRenameEntry(p, String(payload.name || ""));
        } else if (method === "fs.remove") {
          const p = localPathOf(payload.path, pathBase); if (p === null) return;
          result = await localRemoveEntry(p);
        } else if (method === "fs.trees") {
          // 本地工作区同样必须实现：本插件注册的是 exact 路由，未处理就会 404，
          // 反而把原本正常的本地文件树弄坏（0.24 客户端只走 fs.trees）。
          const req = readPathsField(payload);
          if (req.error) { writeJson(res, 400, { ok: false, error: { code: "bad-request", message: req.error } }); return; }
          const levels = [];
          for (const raw of req.paths) {
            const r = resolveSessionPath(raw, pathBase);
            if (!r.resolved) {
              // 客户端按返回的 path 落缓存，所以这里回显原始请求路径 + 一条可读的 error。
              levels.push({ path: raw, entries: [], truncated: false, error: unresolvedPathMessage(raw, pathBase, r.reason) });
              continue;
            }
            const lvl = await localListDir(r.path, LIST_LIMIT);
            if (lvl && lvl.ok === false) levels.push({ path: r.path, entries: [], truncated: false, error: lvl.error || "读取目录失败" });
            else levels.push({ path: r.path, entries: lvl.entries, truncated: !!lvl.truncated });
          }
          result = { levels: levels };
        } else if (method === "fs.mkdir") {
          const p = localPathOf(payload.path || sessionCwd, pathBase); if (p === null) return;
          result = await localMakeDir(p, String(payload.name || ""));
        } else if (method === "fs.createFile") {
          // better-sidebar 0.25.0 新增端点（本地分支）：同一套文件名校验与 409 语义。
          const p = localPathOf(payload.path || sessionCwd, pathBase); if (p === null) return;
          result = await localCreateFile(p, String(payload.name || ""));
        } else {
          writeJson(res, 404, { ok: false, error: { code: "not-found", message: "unknown method " + method } }); return;
        }
      }
      if (result && result.ok === false) {
        // 已存在 → 409，形状/参数不对 → 400 + code "bad-request"（都与上游一致；本插件远程分支
        // 一直如此，本地分支此前一律给 fs-error），其余失败 → 400 + fs-error。
        const code = result.exists === true ? 409 : 400;
        const wire = result.badRequest === true ? "bad-request" : "fs-error";
        writeJson(res, code, { ok: false, error: { code: wire, message: result.error || "operation failed" } });
      } else {
        writeOk(res, result);
      }
    } catch (e) {
      writeJson(res, 400, { ok: false, error: { code: "fs-error", message: String(e && e.message ? e.message : e) } });
    }
  }

  // fs.rename / fs.remove 是 better-sidebar 0.19 新增端点，fs.trees / fs.mkdir 是 0.23+ 新增端点：
  // 旧版客户端不会调用它们，注册对旧版无副作用；新版下远程工作区的列举/新建目录才不会落到本地镜像。
  // （0.24 起文件树改为批量 fs.trees，只注册 fs.tree 会让整棵树回落到宿主本地实现 —— issue 见 CHANGELOG 2.4.18）
  // fs.createFile 是 0.25.0 新增端点（同样必须接管，否则空文件只建在本地镜像里）。
  ["fs.tree", "fs.trees", "fs.read", "fs.readPage", "fs.write", "fs.search", "fs.rename", "fs.remove", "fs.mkdir", "fs.createFile"].forEach(function (m) {
    ctx.effect(() => ctx.webServer.register({
      kind: "exact",
      path: "/sidebar/api/" + m,
      handler: function (req, res) { return interceptFsHandler(req, res, m); }
    }), "dsh-remote-ssh: intercept /sidebar/api/" + m);
  });

  // ---- better-sidebar 0.24 的「打开方式 / 在文件管理器中显示」：远程工作区必须指向远端 ----
  // 上游把绝对路径直接交给本机打开器（Windows: explorer.exe /select,<path> 或
  // rundll32 url.dll,FileProtocolHandler <url>），而客户端只知道本地镜像路径 ——
  // 远程工作区里因此会打开「本地镜像目录」。这里把路径翻译成远端路径，改开
  // `vscode://vscode-remote/ssh-remote+<别名><远端路径>`（别名取自 ~/.ssh/config）。
  // 本地工作区行为与上游一致（同一套命令），不影响本机会话。
  const OPEN_EXTERNAL_METHOD = "open.external";

  /** 本机打开器（detached，不阻塞请求；失败只告警）。DSH_REMOTE_SSH_NO_LAUNCH=1 为测试用干跑开关。 */
  function launchExternal(kind, value) {
    const spec = openerCommand(kind, value, process.platform);
    const dry = String(process.env.DSH_REMOTE_SSH_NO_LAUNCH || "") === "1";
    if (dry) {
      try { ctx.logger?.info("[dsh-remote-ssh] open.external 干跑（未启动）: " + spec.command + " " + spec.args.join(" ")); } catch (e) {}
      return true;
    }
    try {
      const child = spawn(spec.command, spec.args, { detached: true, stdio: "ignore" });
      child.on("error", () => {});
      child.unref();
      try { ctx.logger?.info("[dsh-remote-ssh] open.external: " + kind + " → " + spec.command); } catch (e) {}
      return true;
    } catch (e) {
      try { ctx.logger?.warn("[dsh-remote-ssh] open.external 启动失败: " + String(e && e.message ? e.message : e)); } catch (e2) {}
      return false;
    }
  }

  /** 远端 home（`printf %s "$HOME"`，按 profile 缓存 10 分钟）—— 只用于把 `~` 展开成 URL 可用的绝对路径。 */
  async function remoteHomeDir(profile) {
    const key = profileKey(profile);
    const now = Date.now();
    const hit = remoteHomeCache.get(key);
    if (hit && now - hit.at < REMOTE_HOME_TTL_MS) return hit.home;
    const r = await runPooled(profile, 'printf %s "$HOME"', undefined, 4096);
    const home = r && r.ok ? String(r.stdout || "").trim().split(/\r?\n/).pop().trim() : "";
    if (!home || home.charAt(0) !== "/") return null;
    remoteHomeCache.set(key, { at: now, home: home });
    return home;
  }

  /** 远程工作区：把镜像路径翻译成远端路径并交给 VS Code Remote-SSH；成功返回 true。 */
  async function launchRemoteEditor(localPath, action, scheme) {
    const ws = matchRemoteWorkspace(localPath, null);
    if (!ws) return false;
    const profile = getProfile(ws.profileId);
    if (!profile) {
      try { ctx.logger?.warn("[dsh-remote-ssh] open.external: remote profile not found: " + ws.profileId); } catch (e) {}
      return false;
    }
    const cfg = await listSshConfigHosts();
    const authority = remoteEditorAuthority(profile, cfg && cfg.ok ? cfg.hosts : []);
    if (!authority) {
      try { ctx.logger?.warn("[dsh-remote-ssh] open.external: ~/.ssh/config 里没有与 " + profile.host + ":" + profile.port + " 匹配的主机别名，回退本机打开"); } catch (e) {}
      return false;
    }
    // reveal 语义 = 定位到所在目录：远端就打开该文件所在的远端目录。
    const raw = action === "reveal"
      ? posixDirname(localToRemote(localPath, ws.mirrorPath, ws.remotePath))
      : localToRemote(localPath, ws.mirrorPath, ws.remotePath);
    const needsHome = (s) => !String(s).startsWith("/");
    const home = needsHome(raw) ? await remoteHomeDir(profile) : null;
    const remotePath = expandRemotePathForUrl(raw, home);
    if (!remotePath) {
      try { ctx.logger?.warn("[dsh-remote-ssh] open.external: 无法把远端路径展开成绝对路径（remotePath=" + raw + "），回退本机打开"); } catch (e) {}
      return false;
    }
    return launchExternal("url", remoteEditorUrl(scheme || "vscode", authority, remotePath));
  }

  async function interceptOpenExternalHandler(req, res) {
    const openTrust = requestTrust(req, false);
    if (openTrust !== "ok") { denyRequest(res, openTrust); return; }
    if (req.method !== "POST") { writeJson(res, 405, { ok: false, error: { code: "method-error", message: "method not allowed" } }); return; }
    let payload;
    try { payload = await readJsonBody(req); }
    catch (e) { writeJson(res, 400, { ok: false, error: { code: "bad-request", message: String(e && e.message ? e.message : e) } }); return; }
    const badRequest = (message) => writeJson(res, 400, { ok: false, error: { code: "bad-request", message: message } });
    try {
      const action = payload && payload.action;
      if (action === "reveal") {
        // 相对路径先按会话 cwd 归一（issue #25）：原路由会先做这一步，本插件接管后此前直接 400。
        const rawRevealPath = String((payload && payload.path) || "");
        const revealBase = sessionCwdFrom(payload);
        const revealResolved = resolveSessionPath(rawRevealPath, revealBase);
        if (!revealResolved.resolved) { badRequest(unresolvedPathMessage(rawRevealPath, revealBase, revealResolved.reason)); return; }
        const localPath = revealResolved.path;
        if (await launchRemoteEditor(localPath, "reveal", "vscode")) { writeOk(res, { started: true, remote: true }); return; }
        writeOk(res, { started: launchExternal("reveal", localPath), remote: false }); return;
      }
      if (action === "url") {
        const rawUrl = String((payload && payload.url) || "");
        const parsed = parseExternalUrl(rawUrl);
        if (!parsed) { badRequest("url must be a custom-scheme URL"); return; }
        if (String(parsed.authority).toLowerCase() === "vscode-remote") {
          // 已是 Remote-SSH 形态：上游客户端会自行打开，走到宿主路由说明未配置 sshHost —— 原样交给协议处理器。
          writeOk(res, { started: launchExternal("url", rawUrl), remote: true }); return;
        }
        const localPath = localPathFromExternalUrl(parsed);
        if (localPath && await launchRemoteEditor(localPath, "url", parsed.scheme)) { writeOk(res, { started: true, remote: true }); return; }
        writeOk(res, { started: launchExternal("url", rawUrl), remote: false }); return;
      }
      badRequest('action must be "reveal" or "url"'); return;
    } catch (e) {
      writeJson(res, 500, { ok: false, error: { code: "internal", message: String(e && e.message ? e.message : e) } });
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/sidebar/api/" + OPEN_EXTERNAL_METHOD,
    handler: interceptOpenExternalHandler
  }), "dsh-remote-ssh: intercept /sidebar/api/" + OPEN_EXTERNAL_METHOD);

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

  /**
   * 按**前缀**把任意绝对路径匹配到已注册的远程工作区（2.4.29 加固）。
   *
   * 为什么需要：`readRemoteInfoSync(p)` 只读 `<p>/.remote-ssh.json`、**不向上遍历** —— 只有正好把
   * **工作区根**传进去才命中。真实客户端总带有效 sessionId（会话 cwd 就是镜像根）所以一直没暴露，
   * 但两种情况会漏：①会话是在工作区的**子目录**里启动的（会话 cwd 是子目录）；
   * ②客户端带了过期/未知 sessionId，于是回退到 `payload.path` 判定。漏判的后果是写/删**静默落在
   * 本地镜像上**（与 issue #25 同源）。
   *
   * 返回 `{ ws, info, root }`：`root` 是**工作区根**（不是传进来那个更深的路径）。调用方必须拿
   * `root` 当 remoteBase —— 否则 `localToRemote()` 会按子目录相对映射，文件落到远端错误的位置。
   */
  function remoteWorkspaceForPath(absPath) {
    if (!isAbsoluteLocalPath(absPath)) return null;
    const ws = matchRemoteWorkspace(String(absPath), "");
    if (!ws) return null;
    const info = readRemoteInfoSync(ws.mirrorPath);
    if (!info) return null;
    return { ws: ws, info: info, root: ws.mirrorPath };
  }

  // ---- P0: 远程工作区的 Git 面板重定向（git.* 走远端，本地照旧本机 git）----
  // 0.25.0 起客户端还会调用 blame / diff-head / worktrees / pull / push：
  // 它们都依赖会话仓库（blame/diff-head 解析文件路径、worktrees 列 worktree、pull/push 直接动仓库），
  // 远程工作区若不接管就会在本地镜像上跑 git，必须一并注册（见 CHANGELOG 2.4.28）。
  // 0.28.0 又新增 git.graph（提交图分页）—— 它同样只读会话仓库，必须一起接管（见 CHANGELOG 2.4.32）。
  // 未注册的只剩纯模型类端点（git.models / git.suggest-message / git.commit-model）——它们不碰仓库路径。
  const GIT_METHODS = ["status", "diff", "log", "branch", "commit-diff", "show", "stage", "unstage", "commit", "checkout", "discard", "revert", "cherry-pick", "blame", "diff-head", "worktrees", "pull", "push", "graph"];

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
    const r = await runPooled(profile, "git -C " + shellQuotePath(remoteDir) + " --no-pager -c color.ui=false " + quoted, undefined, 8 * 1024 * 1024, undefined, undefined, "git");
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
  // ---- better-sidebar 0.28.0 的 git.status 形状：porcelain=v2 + 分支身份 + numstat 分栏 ----
  //
  // 0.28.0 把 git.status 的取数从 `--porcelain=v1 -z` 换成
  // `status --porcelain=v2 --branch --ahead-behind -z --untracked-files=all`（一次读齐行 + 分支身份），
  // 并新增 upstream / ahead / behind / detached / operation 与条目级 staged / unstaged 行数
  // （上游注释：两栏"绝不合并"，合并会重复计行）。本插件接管着这个端点，
  // 若继续返回 v1 形状，远程工作区会**静默**缺这些字段（下游全是可选字段，不报错）。
  //
  // 有意差异：上游 `--ahead-behind` 需要 git ≥ 2.41。远程主机（尤其超算登录节点）可能更旧，
  // 所以这里依次降级 v2+ahead-behind → v2 → v1，保证面板不因 git 版本整体失败。
  const GIT_STATUS_LIMIT = 2000;
  /** 一次 numstat pathspec 的字节上限，超出则退化成全仓 diff（口径同上游）。 */
  const NUMSTAT_PATHSPEC_MAX_BYTES = 8000;
  const STATUS_MARK = "@@DSH_GS@@";

  /** `status --porcelain=v2 -z` → {isRepo, entries[{xy,path,origin?}], branch?, upstream?, ahead?, behind?, detached?}。 */
  function parsePorcelainV2Z(output) {
    const result = { isRepo: true, entries: [] };
    const fields = String(output).split("\0");
    for (let index = 0; index < fields.length; index += 1) {
      const field = fields[index];
      if (field === "") continue;
      if (field.startsWith("# ")) {
        if (field.startsWith("# branch.head ")) {
          const head = field.slice(14);
          result.detached = head === "(detached)";
          if (!result.detached) result.branch = head;
        } else if (field.startsWith("# branch.upstream ")) result.upstream = field.slice(18);
        else if (field.startsWith("# branch.ab ")) {
          const counts = /^# branch\.ab \+(\d+) -(\d+)$/.exec(field);
          if (counts !== null) {
            result.ahead = Number(counts[1]);
            result.behind = Number(counts[2]);
          }
        }
        continue;
      }
      if (field.startsWith("? ")) {
        result.entries.push({ xy: "??", path: field.slice(2) });
        continue;
      }
      if (!field.startsWith("1 ") && !field.startsWith("2 ") && !field.startsWith("u ")) continue;
      const fixed = field.startsWith("u ") ? 10 : field.startsWith("2 ") ? 9 : 8;
      const path = field.split(" ").slice(fixed).join(" ");
      if (path === "") continue;
      const entry = { xy: field.slice(2, 4).split(".").join(" "), path: path };
      if (field.startsWith("2 ")) {
        const origin = fields[index + 1];
        index += 1;
        if (origin !== undefined && origin !== "") entry.origin = origin;
      }
      result.entries.push(entry);
    }
    return result;
  }

  /** 行框 numstat 里的改名记法（`old => new` / `src/{a => b}/x`）折叠成"现在"的名字。 */
  function resolveNumstatPath(path) {
    const arrow = path.indexOf(" => ");
    if (arrow === -1) return path;
    const open = path.indexOf("{");
    if (open !== -1 && open < arrow) {
      const close = path.indexOf("}", arrow + 4);
      if (close !== -1) return path.slice(0, open) + path.slice(arrow + 4, close) + path.slice(close + 1);
    }
    return path.slice(arrow + 4);
  }

  /** `git diff --numstat`（-z 框或行框）→ path → 行数；二进制记 {binary:true}，改名归到新名（口径同上游）。 */
  function parseNumstat(output) {
    const counts = new Map();
    const text = String(output);
    const framed = text.indexOf("\0") >= 0;
    const records = text.split(framed ? "\0" : "\n");
    let index = 0;
    while (index < records.length) {
      const record = records[index];
      index += 1;
      if (record === "" || record === "\n") continue;
      const addedEnd = record.indexOf("\t");
      const deletedEnd = addedEnd === -1 ? -1 : record.indexOf("\t", addedEnd + 1);
      if (deletedEnd === -1) continue;
      const added = record.slice(0, addedEnd);
      const deleted = record.slice(addedEnd + 1, deletedEnd);
      let path = record.slice(deletedEnd + 1);
      if (framed && path === "") {
        const renamed = records[index + 1];
        index += 2;
        if (renamed === undefined) continue;
        path = renamed;
      } else if (!framed) {
        path = resolveNumstatPath(path);
      }
      if (path === "") continue;
      if (added === "-" || deleted === "-") { counts.set(path, { binary: true }); continue; }
      const additions = Number(added);
      const deletions = Number(deleted);
      if (!Number.isFinite(additions) || !Number.isFinite(deletions)) continue;
      counts.set(path, { additions: additions, deletions: deletions });
    }
    return counts;
  }

  /**
   * 需要进 numstat pathspec 的路径：除未跟踪外的所有条目 + 改名/copy 的 origin
   * （只留新名会让 git 认不出改名，行数会从 `0 0` 退化成整文件新增）。
   * `[]` = 没有任何 tracked 变更（两侧 diff 必空，可直接跳过）；undefined = 路径太多写不进命令行（退化成全仓）。
   */
  function statusPathspecOf(porcelainZ) {
    const paths = [];
    let bytes = 0;
    const add = function (path) {
      if (path === "") return true;
      bytes += Buffer.byteLength(path) + 1;
      if (bytes > NUMSTAT_PATHSPEC_MAX_BYTES) return false;
      paths.push(path);
      return true;
    };
    for (const entry of parsePorcelainV2Z(porcelainZ).entries) {
      if (entry.xy === "??") continue;
      if (!add(entry.path)) return undefined;
      if (entry.origin !== undefined && !add(entry.origin)) return undefined;
    }
    return paths;
  }

  /** 快照 + operation + 两侧 numstat → 最终响应（含 2000 行截断与条目级 staged/unstaged）。 */
  function finishStatusSnapshot(snapshot, operation, unstagedRaw, stagedRaw) {
    const stagedCounts = parseNumstat(stagedRaw);
    const unstagedCounts = parseNumstat(unstagedRaw);
    const truncated = snapshot.entries.length > GIT_STATUS_LIMIT;
    const bounded = truncated ? snapshot.entries.slice(0, GIT_STATUS_LIMIT) : snapshot.entries;
    const value = Object.assign({}, snapshot, { operation: operation });
    value.entries = bounded.map(function (entry) {
      const staged = stagedCounts.get(entry.path);
      const unstaged = unstagedCounts.get(entry.path);
      if (staged === undefined && unstaged === undefined) return entry;
      const merged = Object.assign({}, entry);
      if (staged !== undefined) merged.staged = staged;
      if (unstaged !== undefined) merged.unstaged = unstaged;
      return merged;
    });
    value.truncated = truncated;
    return value;
  }

  /** 本机：从 .git 目录推断进行中的操作（口径同上游 currentOperation：rebase / merge）。 */
  async function statusOperationLocal(run, dir) {
    let gitDir = "";
    try { gitDir = String(await run(dir, ["rev-parse", "--absolute-git-dir"])).trim(); } catch (e) { return undefined; }
    if (!gitDir) return undefined;
    try {
      const names = await readdir(gitDir);
      if (names.indexOf("rebase-merge") >= 0) return "rebase";
      if (names.indexOf("rebase-apply") >= 0) {
        const inner = await readdir(join(gitDir, "rebase-apply")).catch(function () { return []; });
        if (inner.indexOf("rebasing") >= 0) return "rebase";
      }
      return names.indexOf("MERGE_HEAD") >= 0 ? "merge" : undefined;
    } catch (e) { return undefined; }
  }

  /**
   * git.status 的远端实现：**一次 SSH 往返**拿齐 状态 / operation / 两侧 numstat
   * （旧的实现是 3 次往返，且永远拿不到 0.28.0 的新字段）。
   * 分段用 `@@DSH_GS@@` 标记；status 输出含 NUL，所以先落到远端临时文件再 cat，绝不经 shell 变量。
   */
  async function gitStatusRemote(remote) {
    const dir = shellQuotePath(remote.remoteDir);
    const gitIn = "git -C " + dir + " --no-pager --no-replace-objects -c color.ui=false ";
    const script = [
      "export " + GIT_READ_ENV,
      // 远端目录不在（工作区被删/改名）→ 当作"不是仓库"，与 graph 的 NOREPO 同一口径；
      // SSH 本身失败会在 runPooled 层被识别成 git-error，不会被这里吞掉。
      "cd " + dir + " 2>/dev/null || { printf '" + STATUS_MARK + " NOTREPO\\n'; exit 0; }",
      "if [ \"$(git -C . --no-pager -c color.ui=false rev-parse --is-inside-work-tree 2>/dev/null)\" != true ]; then printf '" + STATUS_MARK + " NOTREPO\\n'; exit 0; fi",
      "T=${TMPDIR:-/tmp}/dsh-rs-status.$$",
      "V=none",
      "if " + gitIn + "status --porcelain=v2 --branch --ahead-behind -z --untracked-files=all > \"$T\" 2>/dev/null; then V=v2",
      "elif " + gitIn + "status --porcelain=v2 --branch -z --untracked-files=all > \"$T\" 2>/dev/null; then V=v2nb",
      "elif " + gitIn + "status --porcelain=v1 -z --untracked-files=normal > \"$T\" 2>/dev/null; then V=v1",
      "fi",
      "printf '" + STATUS_MARK + " STATUS %s\\n' \"$V\"",
      // numstat 短路（性能 t3）：status 没有任何 tracked 变更时，两条全仓 `git diff --numstat`
      // 的输出必然为空，但它们仍各扫一遍整个工作树 —— 在超算 zfs 的大仓库上这一步占总耗时的
      // 一半以上（实测 XCALibreGPT：1.6~3.7s/次）。本地实现早有同款短路（pathspec=[] → 跳过，
      // 见 gitStatusImpl 与 B20 断言），这里把同一口径补到远端脚本。
      // N = tracked 变更记录数（v2 的 1/2/u + v1 的非 ?? 记录）；V=none 时 $T 不存在 → N 空 → 视为 0。
      // ⚠️ 计数必须在 `cat; rm` 之前 —— $T 删掉后 tr 无处可读（真 sh 验证 E2 逮住过这个时序 bug）。
      "N=0",
      "N=$(tr '\\000' '\\n' < \"$T\" 2>/dev/null | grep -c -v -e '^#' -e '^$' -e '^? ' 2>/dev/null)",
      "cat \"$T\"; rm -f \"$T\"",
      "if [ \"$V\" = v1 ]; then",
      "  printf '\\n" + STATUS_MARK + " BRANCH\\n'",
      "  " + gitIn + "rev-parse --abbrev-ref HEAD 2>/dev/null || true",
      "fi",
      "printf '\\n" + STATUS_MARK + " OP\\n'",
      "OP=",
      "GITDIR=$(" + gitIn + "rev-parse --absolute-git-dir 2>/dev/null) || GITDIR=",
      "if [ -n \"$GITDIR\" ]; then",
      "  if [ -d \"$GITDIR/rebase-merge\" ]; then OP=rebase",
      "  elif [ -d \"$GITDIR/rebase-apply\" ] && [ -f \"$GITDIR/rebase-apply/rebasing\" ]; then OP=rebase",
      "  elif [ -f \"$GITDIR/MERGE_HEAD\" ]; then OP=merge",
      "  fi",
      "fi",
      "printf '%s' \"$OP\"",
      "if [ \"${N:-0}\" -gt 0 ]; then",
      "  printf '\\n" + STATUS_MARK + " UNSTAGED\\n'",
      "  " + gitIn + "diff --numstat -z 2>/dev/null || true",
      "  printf '\\n" + STATUS_MARK + " STAGED\\n'",
      "  " + gitIn + "diff --cached --numstat -z 2>/dev/null || true",
      "fi",
      "printf '\\n" + STATUS_MARK + " END\\n'"
    ].join("\n");
    const r = await runPooled(remote.profile, script, undefined, 8 * 1024 * 1024, undefined, undefined, "git");
    if (!r || r.ok !== true) {
      throw { code: "git-error", message: String((r && (r.stdout || r.error)) || "").trim() || "remote git status failed" };
    }
    const sections = statusSections(r.stdout);
    if (Object.prototype.hasOwnProperty.call(sections.args, "NOTREPO")) return { isRepo: false, entries: [] };
    const variant = sections.args.STATUS || "none";
    if (variant === "none") return { isRepo: true, branch: "HEAD", entries: [] };
    const raw = sections.texts.STATUS || "";
    const snapshot = variant === "v1"
      ? { isRepo: true, branch: String(sections.texts.BRANCH || "").trim() || "HEAD", entries: parsePorcelainZ(raw) }
      : parsePorcelainV2Z(raw);
    const operation = String(sections.texts.OP || "").trim() || undefined;
    // v1 降级路径下 status 是整仓输出，numstat 没带 pathspec —— 路径仍按仓库根相对，能直接对上。
    return finishStatusSnapshot(snapshot, operation, sections.texts.UNSTAGED || "", sections.texts.STAGED || "");
  }

  /** 把 `@@DSH_GS@@ NAME [arg]` 分段输出切成 {args, texts}。 */
  function statusSections(text) {
    const args = {};
    const texts = {};
    let key = "";
    let arg = "";
    let lines = [];
    const flush = function () {
      if (key === "") return;
      args[key] = arg;
      texts[key] = lines.join("\n").replace(/\n+$/, "");
    };
    for (const line of String(text).split("\n")) {
      if (line.indexOf(STATUS_MARK) === 0) {
        flush();
        const parts = line.slice(STATUS_MARK.length).trim().split(" ");
        key = parts[0];
        arg = parts.length > 1 ? parts.slice(1).join(" ") : "";
        lines = [];
        continue;
      }
      lines.push(line);
    }
    flush();
    return { args: args, texts: texts };
  }

  /**
   * git.status 的本地实现，口径对齐 better-sidebar 0.28.0（见上方说明的降级链）。
   * 与上游的差异：本地直接用 status 里带出来的路径做 numstat pathspec（上游同款快路径），
   * 远端那条实现没有 pathspec（整仓 numstat），结果相同、只是多算一点。
   */
  async function gitStatusImpl(run, dir) {
    let inside = "false";
    try { inside = String((await run(dir, ["rev-parse", "--is-inside-work-tree"])).trim()); } catch (e) { inside = "false"; }
    if (inside !== "true") return { isRepo: false, entries: [] };
    let raw = "";
    try {
      raw = await run(dir, ["status", "--porcelain=v2", "--branch", "--ahead-behind", "-z", "--untracked-files=all"]);
    } catch (e) {
      try {
        raw = await run(dir, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]);
      } catch (e2) {
        // git < 2.11：没有 porcelain=v2 → 退回 v1 形状（新字段缺席，但面板仍然可用）
        let branch = "HEAD";
        try { branch = String((await run(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim() || "HEAD"); } catch (e3) {}
        let legacy = "";
        try { legacy = await run(dir, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"]); }
        catch (e4) { return { isRepo: true, branch: branch, entries: [] }; }
        return { isRepo: true, branch: branch, entries: parsePorcelainZ(legacy) };
      }
    }
    const snapshot = parsePorcelainV2Z(raw);
    const operation = await statusOperationLocal(run, dir);
    const pathspec = statusPathspecOf(raw);
    let unstagedRaw = "";
    let stagedRaw = "";
    if (pathspec === undefined || pathspec.length > 0) {
      const literal = pathspec === undefined ? [] : ["--literal-pathspecs"];
      const paths = pathspec === undefined ? [] : ["--", ...pathspec];
      try { unstagedRaw = await run(dir, [...literal, "diff", "--numstat", "-z", ...paths]); } catch (e5) {}
      try { stagedRaw = await run(dir, [...literal, "diff", "--cached", "--numstat", "-z", ...paths]); } catch (e6) {}
    }
    return finishStatusSnapshot(snapshot, operation, unstagedRaw, stagedRaw);
  }

  /**
   * git.worktrees 的完整实现（better-sidebar 0.25.0 新增端点；本地/远端共用）。
   * 口径与上游一致：不是仓库 → `[]`；过滤 prunable；`current` 用路径同一性判定；current 排最前；
   * `changes` = 该 worktree 的 status 条目数。
   *
   * 有意差异：上游对每个 worktree 调用完整的 `status()`（4 次 git 调用），在远程工作区里
   * 每个 worktree 就是 4 次 SSH 往返；这里每个 worktree 只跑一条 `status --porcelain=v1 -z`
   * （计数口径相同，改名记录同样只算一条）。
   *
   * `runIn(dir, args)` 必须**真正使用 dir**：worktree 的路径是每个 worktree 各自的根，
   * 不能用会话 cwd 顶替（本地是绝对路径，远端是远端路径，所以调用方另外给 identity 归一化）。
   */
  async function gitWorktreesImpl(runIn, dir, identity) {
    let inside = "false";
    try { inside = String((await runIn(dir, ["rev-parse", "--is-inside-work-tree"])).trim()); } catch (e) { inside = "false"; }
    if (inside !== "true") return [];
    let currentRoot = "";
    try { currentRoot = String((await runIn(dir, ["rev-parse", "--show-toplevel"])).trim()); } catch (e) { currentRoot = ""; }
    let raw = "";
    try { raw = await runIn(dir, ["worktree", "list", "--porcelain"]); } catch (e) { return []; }
    const listed = parseWorktreeList(raw).filter(function (entry) { return !entry.prunable; });
    const rows = [];
    for (const entry of listed) {
      let changes = 0;
      try { changes = countStatusEntries(await runIn(entry.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])); }
      catch (e) { changes = 0; }
      rows.push({
        path: entry.path,
        branch: entry.branch,
        current: currentRoot !== "" && identity(entry.path) === identity(currentRoot),
        changes: changes
      });
    }
    rows.sort(function (a, b) { return Number(b.current) - Number(a.current); });
    return rows;
  }

  /** 解析一次 /sidebar/api/git.* 请求的上下文：远程工作区 → {profile, remoteDir}，否则 null。 */
  function gitContextOf(payload) {
    const sessionId = payload && payload.sessionId;
    const clientCwd = payload && payload.cwd;
    const cwd = sessionCwdFrom(payload);
    if (!cwd) return null;
    const ws = matchRemoteWorkspace(cwd, cwd);
    if (!ws) return null;
    const remoteInfo = readRemoteInfoSync(ws.mirrorPath);
    const profile = remoteInfo && getProfile(remoteInfo.profileId);
    if (!remoteInfo || !profile) return null;
    const remoteDir = localToRemote(cwd, ws.mirrorPath, remoteInfo.remotePath);
    return { profile: profile, remoteDir: remoteDir, cwd: cwd, ws: ws, remoteInfo: remoteInfo };
  }

  // ---- better-sidebar 0.28.0 新增 git.graph：提交图分页（远程工作区必须接管）----
  // 上游口径（0.28.0 lib/index.js:4487-4663）：
  //   · 入参 { branch?, count = 50, cursor? }；branch 必须是 `refs/heads/…` / `refs/remotes/…` 全名；
  //     count 必须是安全整数且 ≥1，内部上限 200；cursor 是 base64url(JSON{version:1,fingerprint,offset})。
  //   · 返回 { isRepo, root?, entries[{hash,hashFull,parents,author,date,subject,message,refs}],
  //            branches[{ref,name,hashFull}], hasMore, nextCursor?, snapshot }。
  //   · 日志前后各取一次 refs 快照（for-each-ref + HEAD + symbolic-ref）算 sha256 指纹；
  //     期间历史变了 → graph-stale（HTTP 409）；分支 >1000 或翻页越过 10000 → graph-limit（400）。
  // 远程工作区若不接管，客户端会拿本地镜像里的仓库画提交图（与 2.4.28 同源的 bug）。
  const GRAPH_OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
  const GRAPH_MAX_OFFSET = 10000;
  const GRAPH_MAX_BRANCHES = 1000;
  const GRAPH_DEFAULT_COUNT = 50;
  const GRAPH_MAX_COUNT = 200;
  // 只读环境（禁 replace 对象由 gitIn 里的 --no-replace-objects 负责）用模块级 GIT_READ_ENV。
  const GRAPH_LOG_FORMAT = "%H%x00%P%x00%an%x00%ai%x00%s%x00%B%x00";
  const GRAPH_MARK = "@@DSH_GG@@";


  /** 解析并校验游标（口径与上游 cursorOf 一致，非法一律 bad-request）。 */
  function parseGraphCursor(value) {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string" || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) gitReplyFail("Invalid graph cursor");
    let parsed;
    try {
      parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    } catch (e) {
      gitReplyFail("Invalid graph cursor");
    }
    if (!parsed || parsed.version !== 1 || typeof parsed.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(parsed.fingerprint)
      || !Number.isSafeInteger(parsed.offset) || parsed.offset < 1 || parsed.offset > GRAPH_MAX_OFFSET) gitReplyFail("Invalid graph cursor");
    return { fingerprint: parsed.fingerprint, offset: parsed.offset };
  }

  function encodeGraphCursor(fingerprint, offset) {
    return Buffer.from(JSON.stringify({ version: 1, fingerprint: fingerprint, offset: offset })).toString("base64url");
  }

  /** for-each-ref 的 `%(refname)%00%(objectname)` 输出 → branches。 */
  function parseGraphRefs(raw) {
    const branches = [];
    for (const line of String(raw).trimEnd().split("\n")) {
      if (line === "") continue;
      const parts = line.split("\0");
      const ref = parts[0];
      const hashFull = parts[1];
      if (!ref || !hashFull || !GRAPH_OID.test(hashFull)) gitReplyFail("Invalid Git reference output", "git-error");
      branches.push({ ref: ref, name: ref.replace(/^refs\/(heads|remotes)\//, ""), hashFull: hashFull });
    }
    if (branches.length > GRAPH_MAX_BRANCHES) gitReplyFail("Too many branches for graph (limit 1000)", "graph-limit");
    return branches;
  }

  /** refs 快照（本地/远端共用）：branches + sha256 指纹 + tips + 引用装饰。 */
  function graphSnapshotOf(root, branch, rawRefs, rawHead, rawSymbolic) {
    const branches = parseGraphRefs(rawRefs);
    const head = String(rawHead || "").trim();
    const symbolicHead = String(rawSymbolic || "").trim();
    if (head && !GRAPH_OID.test(head)) gitReplyFail("Invalid HEAD", "git-error");
    if (!head && (!symbolicHead || branches.some(function (b) { return b.ref === symbolicHead; }))) gitReplyFail("Cannot resolve HEAD", "git-error");
    const fingerprint = createHash("sha256").update(JSON.stringify({
      root: root, branch: branch, branches: branches, head: head, symbolicHead: symbolicHead
    })).digest("hex");
    const selected = branch === undefined ? undefined : branches.find(function (b) { return b.ref === branch; });
    const tips = branch === undefined
      ? Array.from(new Set(branches.map(function (b) { return b.hashFull; }).concat(head ? [head] : []))).sort()
      : (selected ? [selected.hashFull] : []);
    const decorations = new Map();
    for (const item of branches) decorations.set(item.hashFull, (decorations.get(item.hashFull) || []).concat([item.name]));
    if (head) decorations.set(head, ["HEAD"].concat(decorations.get(head) || []));
    return { branches: branches, fingerprint: fingerprint, tips: tips, decorations: decorations, selected: selected };
  }

  /** `git log --format=%H%x00%P%x00%an%x00%ai%x00%s%x00%B%x00` 输出 → entries。 */
  function graphEntriesFromLog(raw, decorations) {
    const fields = String(raw).split("\0");
    const entries = [];
    for (let i = 0; i + 5 < fields.length; i += 6) {
      const hashFull = fields[i].trim();
      const parents = fields[i + 1].split(" ").filter(Boolean);
      if (!GRAPH_OID.test(hashFull) || parents.some(function (p) { return !GRAPH_OID.test(p); })) gitReplyFail("Invalid Git graph output", "git-error");
      entries.push({
        hash: hashFull.slice(0, 7),
        hashFull: hashFull,
        parents: parents,
        author: fields[i + 2],
        date: fields[i + 3],
        subject: fields[i + 4],
        message: fields[i + 5],
        refs: decorations.get(hashFull) || []
      });
    }
    return entries;
  }

  /**
   * git.graph 的实现主体（本地/远端共用），io 提供取数：
   *   io.begin()                → { isRepo, root, before:{refs,head,symbolic} }
   *   io.logWithSnapshot(r, args) → { log, after:{refs,head,symbolic} }（args 为 null 时只取 after 快照）
   *   io.displayRoot(root)      → 返回给客户端的 root（远端 → 本地镜像路径）
   */
  async function gitGraphPage(payload, io) {
    const p = payload || {};
    const branch = p.branch === undefined || p.branch === null ? undefined : String(p.branch);
    if (branch !== undefined && (branch.length > 1024 || !/^refs\/(heads|remotes)\/.+/.test(branch))) {
      gitReplyFail("Expected a full local or remote-tracking ref name");
    }
    const count = p.count === undefined || p.count === null ? GRAPH_DEFAULT_COUNT : p.count;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1) gitReplyFail("Invalid graph count");
    const limit = Math.min(count, GRAPH_MAX_COUNT);
    const cursor = parseGraphCursor(p.cursor);
    const begin = await io.begin();
    if (!begin.isRepo) {
      if (cursor) gitReplyFail("Graph repository changed; refresh", "graph-stale");
      return { isRepo: false, entries: [], branches: [], hasMore: false, snapshot: "" };
    }
    const root = begin.root;
    const before = graphSnapshotOf(root, branch, begin.before.refs, begin.before.head, begin.before.symbolic);
    if (cursor && cursor.fingerprint !== before.fingerprint) gitReplyFail("Graph changed; refresh", "graph-stale");
    if (branch !== undefined && !before.selected) gitReplyFail("Unknown graph branch");
    const offset = cursor ? cursor.offset : 0;
    const args = before.tips.length
      ? ["log", "--topo-order", "--no-decorate", "--no-show-signature", "--encoding=UTF-8",
        "--max-count=" + (limit + 1), "--skip=" + offset, "--format=" + GRAPH_LOG_FORMAT].concat(before.tips, ["--"])
      : null;
    const fetched = await io.logWithSnapshot(root, args);
    const entries = args ? graphEntriesFromLog(fetched.log, before.decorations) : [];
    const after = graphSnapshotOf(root, branch, fetched.after.refs, fetched.after.head, fetched.after.symbolic);
    if (after.fingerprint !== before.fingerprint) gitReplyFail("Graph changed; refresh", "graph-stale");
    const hasMore = entries.length > limit;
    if (hasMore && offset + limit > GRAPH_MAX_OFFSET) gitReplyFail("Graph history limit reached (10000)", "graph-limit");
    const value = {
      isRepo: true,
      root: io.displayRoot(root),
      entries: entries.slice(0, limit),
      branches: before.branches,
      hasMore: hasMore,
      snapshot: before.fingerprint
    };
    if (hasMore) value.nextCursor = encodeGraphCursor(before.fingerprint, offset + limit);
    return value;
  }

  /** 本机 git.graph：toplevel → 快照 → log → 再快照（口径与上游一致）。 */
  function graphLocalIo(cwd) {
    const read = async function (args, allowMissing) {
      try {
        return await runGitLocal(cwd, ["--no-replace-objects"].concat(args));
      } catch (e) {
        if (allowMissing) return "";
        throw e;
      }
    };
    const takeSnapshot = async function () {
      const refs = await read(["for-each-ref", "--sort=refname", "--format=%(refname)%00%(objectname)", "refs/heads/", "refs/remotes/"]);
      const head = String(await read(["rev-parse", "--verify", "--quiet", "HEAD"], true)).trim();
      const symbolic = String(await read(["symbolic-ref", "--quiet", "HEAD"], true)).trim();
      return { refs: refs, head: head, symbolic: symbolic };
    };
    return {
      begin: async function () {
        let raw = "";
        try {
          raw = await read(["rev-parse", "--show-toplevel"]);
        } catch (e) {
          const message = String(e && e.message ? e.message : e);
          if (!/^fatal: not a git repository(?: \(|:)/.test(message)) throw e;
          return { isRepo: false, root: "", before: null };
        }
        const root = String(raw).trim();
        if (!root) return { isRepo: false, root: "", before: null };
        return { isRepo: true, root: root, before: await takeSnapshot() };
      },
      logWithSnapshot: async function (root, args) {
        const log = args ? await read(args) : "";
        return { log: log, after: await takeSnapshot() };
      },
      displayRoot: function (root) { return root; }
    };
  }

  /** 把远端仓库根映射回本地镜像路径（客户端把返回的 root 当本机 repoRoot 用）。 */
  function mirrorRootOf(ws, remoteInfo, remoteRoot) {
    const remoteBase = String(remoteInfo.remotePath || "").replace(/\/+$/, "");
    const root = String(remoteRoot || "").replace(/\/+$/, "");
    if (!remoteBase || !root) return remoteRoot;
    if (root === remoteBase) return ws.mirrorPath;
    if (root.indexOf(remoteBase + "/") === 0) return join(ws.mirrorPath, root.slice(remoteBase.length + 1));
    // 远端仓库根在工作区之上（工作区是仓库子目录）：镜像里没有对应目录，退化成工作区镜像根，
    // 保证客户端拿到的仍是本机路径且跨页稳定。
    if (remoteBase.indexOf(root + "/") === 0) return ws.mirrorPath;
    return remoteRoot;
  }

  /** 远端 git.graph：两次 SSH 往返（toplevel+快照、log+快照），避免逐条命令往返。 */
  function graphRemoteIo(remote) {
    const dir = shellQuotePath(remote.remoteDir);
    const gitIn = function (target) {
      return "git -C " + target + " --no-pager --no-replace-objects -c color.ui=false ";
    };
    const refsCmd = function (target) {
      return gitIn(target) + "for-each-ref --sort=refname --format='%(refname)%00%(objectname)' refs/heads/ refs/remotes/";
    };
    const tail = function (target) {
      return [
        "printf '\\n" + GRAPH_MARK + " REFS\\n'",
        refsCmd(target),
        "printf '" + GRAPH_MARK + " HEAD\\n'",
        gitIn(target) + "rev-parse --verify --quiet HEAD || true",
        "printf '\\n" + GRAPH_MARK + " SYM\\n'",
        gitIn(target) + "symbolic-ref --quiet HEAD || true",
        "printf '\\n" + GRAPH_MARK + " END\\n'"
      ];
    };
    const parse = function (raw) {
      const sections = { root: "", refs: "", head: "", symbolic: "", log: "", noRepo: false };
      let current = "";
      for (const line of String(raw).split("\n")) {
        if (line.indexOf(GRAPH_MARK) === 0) {
          const rest = line.slice(GRAPH_MARK.length).trim();
          current = "";
          if (rest === "NOREPO") { sections.noRepo = true; continue; }
          if (rest.indexOf("ROOT ") === 0) { sections.root = rest.slice(5).trim(); continue; }
          if (rest === "REFS") current = "refs";
          else if (rest === "HEAD") current = "head";
          else if (rest === "SYM") current = "sym";
          else if (rest === "LOG") current = "log";
          continue;
        }
        if (current === "refs") sections.refs += line + "\n";
        else if (current === "head") sections.head += line + "\n";
        else if (current === "sym") sections.symbolic += line + "\n";
        else if (current === "log") sections.log += line + "\n";
      }
      return sections;
    };
    const exec = async function (script) {
      const r = await runPooled(remote.profile, script, undefined, 8 * 1024 * 1024, undefined, undefined, "git");
      if (!r.ok) throw { code: "git-error", message: String(r.stdout || r.error || "").trim() || "remote git exited with " + r.exitCode };
      return parse(r.stdout);
    };
    return {
      begin: async function () {
        const script = [
          "export " + GIT_READ_ENV,
          // 远端目录不在（工作区被删/改名）→ NOREPO（不是仓库），别让它变成 500
          "cd " + dir + " 2>/dev/null || { printf '" + GRAPH_MARK + " NOREPO\\n'; exit 0; }",
          "ROOT=$(" + gitIn(".") + "rev-parse --show-toplevel 2>/dev/null) || ROOT=",
          "if [ -z \"$ROOT\" ]; then printf '" + GRAPH_MARK + " NOREPO\\n'; exit 0; fi",
          "printf '" + GRAPH_MARK + " ROOT %s\\n' \"$ROOT\"",
          "printf '" + GRAPH_MARK + " REFS\\n'",
          refsCmd("\"$ROOT\""),
          "printf '" + GRAPH_MARK + " HEAD\\n'",
          gitIn("\"$ROOT\"") + "rev-parse --verify --quiet HEAD || true",
          "printf '\\n" + GRAPH_MARK + " SYM\\n'",
          gitIn("\"$ROOT\"") + "symbolic-ref --quiet HEAD || true",
          "printf '\\n" + GRAPH_MARK + " END\\n'"
        ].join("\n");
        const s = await exec(script);
        if (s.noRepo || !s.root) return { isRepo: false, root: "", before: null };
        return { isRepo: true, root: s.root, before: { refs: s.refs, head: s.head, symbolic: s.symbolic } };
      },
      logWithSnapshot: async function (root, args) {
        const quotedRoot = shellQuotePath(root);
        const logCmd = args
          ? gitIn(quotedRoot) + args.map(function (a) { return shellQuote(a); }).join(" ") + " || exit 4"
          : "true";
        const script = ["export " + GIT_READ_ENV, "printf '" + GRAPH_MARK + " LOG\\n'", logCmd]
          .concat(tail(quotedRoot)).join("\n");
        const s = await exec(script);
        return { log: s.log, after: { refs: s.refs, head: s.head, symbolic: s.symbolic } };
      },
      displayRoot: function (root) { return mirrorRootOf(remote.ws, remote.remoteInfo, root); }
    };
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
      // 本地会话：按请求里的 cwd / 会话 cwd 跑本机 git（issue #25 —— 此前 payload.cwd 缺失时
      // 退到 `process.cwd()`，那是插件宿主目录，git 面板会指向 pnpm profile 里的仓库；
      // 没有会话工作目录时宁可明确报错，也不要显示一个错的仓库）。
      const localCwd = remote ? "" : sessionCwdFrom(payload);
      if (!remote && !localCwd) {
        writeJson(res, 400, { ok: false, error: { code: "bad-request", message: "无法确定会话工作目录：请求里没有 cwd，也取不到 sessionId 对应的会话工作目录。git 面板需要它来定位仓库（请改用绝对路径 cwd，或带上有效的 sessionId）。" } });
        return;
      }
      const cwd = remote ? remote.remoteDir : localCwd;
      const run = remote
        ? (dir, args) => runGitRemote(remote.profile, remote.remoteDir, args)
        : (dir, args) => runGitLocal(cwd, args);
      let value;
      switch (method) {
        case "status":
          // 远端走一次 SSH 往返的批量实现（0.28.0 的 v2 形状要 4 项数据，逐项往返太贵）；
          // 本地走 gitStatusImpl（本机 git 便宜，且能用 pathspec 快路径）。
          // 性能 t3：远端结果进 5s TTL + epoch 感知缓存 —— 0.28.0 客户端在文件操作后
          // invalidate→立即重取同一仓库，同秒内的重复请求 0 RTT；任何写动作 bump epoch
          // → 缓存立即失效，不会把写后的旧状态回给面板。
          if (remote) {
            const ckey = profileKey(remote.profile) + "|gitstatus|" + remote.remoteDir;
            const cepoch = cacheEpoch(profileKey(remote.profile));
            const chit = lruGet(gitStatusCache, ckey);
            if (chit && chit.epoch === cepoch && Date.now() - chit.at <= GIT_STATUS_CACHE_TTL_MS) {
              value = chit.value;
              break;
            }
            if (chit && chit.epoch !== cepoch) gitStatusCache.delete(ckey);
            value = await gitStatusRemote(remote);
            lruPut(gitStatusCache, ckey, { value: value, epoch: cepoch, at: Date.now() }, GIT_STATUS_CACHE_MAX);
          } else {
            value = await gitStatusImpl(run, cwd);
          }
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
        // ---- better-sidebar 0.25.0 新增的 git.* 端点 ----
        // 不接管的话，远程工作区会在**本地镜像**上跑 git（镜像里通常没有 .git → 面板显示空/报错，
        // 而不是远端仓库的真实结果）；pull/push 更严重：它们会动到一个跟远端无关的仓库。
        case "blame": {
          const p = payload;
          const path = String(p && p.path || "").trim();
          if (!path) throw { code: "bad-request", message: "path is required" };
          const startLine = p && p.startLine;
          const endLine = p && p.endLine;
          if (!Number.isInteger(startLine) || startLine < 1 || !Number.isInteger(endLine) || endLine < 1) {
            throw { code: "bad-request", message: "\"startLine\" and \"endLine\" must be positive integer line numbers" };
          }
          if (endLine < startLine) throw { code: "bad-request", message: "\"endLine\" must not precede \"startLine\"" };
          let blamed = "";
          try {
            blamed = await run(cwd, ["blame", "--porcelain", "-L", String(startLine) + "," + String(endLine), "--", path]);
          } catch (e) {
            // 上游对 blame 失败是静默降级（未跟踪文件、浅克隆等都会失败），保持同一口径。
            value = { lines: [] };
            break;
          }
          value = { lines: parseBlamePorcelain(blamed) };
          break;
        }
        case "diff-head": {
          const path = String(payload && payload.path || "").trim();
          if (!path) throw { code: "bad-request", message: "path is required" };
          const headArgs = ["diff", "--no-ext-diff", "--no-color", "-U3", "HEAD", "--", path];
          try {
            value = { diff: await run(cwd, headArgs) };
          } catch (e) {
            // 上游回退：没有 HEAD（新仓库首个提交前）时改看暂存区。
            value = { diff: await run(cwd, ["diff", "--no-ext-diff", "--no-color", "-U3", "--cached", "--", path]) };
          }
          break;
        }
        case "worktrees": {
          // runIn 与上面的 run 不同：它**必须**尊重传入的目录（每个 worktree 各自的根）。
          const runIn = remote
            ? (dir2, args) => runGitRemote(remote.profile, dir2, args)
            : (dir2, args) => runGitLocal(dir2, args);
          value = await gitWorktreesImpl(runIn, cwd, remote ? posixPathIdentity : localPathIdentity);
          break;
        }
        case "pull": {
          await run(cwd, ["pull", "--ff-only"]);
          if (remote) {
            // 远端工作树被 pull 动过：列举缓存整棵失效，并清掉写回桥的"远端指纹"记录
            // （那些记录描述的是 pull 之前的远端内容，留着只会让下一次写回被误判成"远端已改动"）。
            invalidateRemoteCaches(remote.profile, remote.remoteDir, { subtree: true });
            freshnessForgetProfile(wrapperDir, remote.profile.id);
          }
          value = { ok: true };
          break;
        }
        case "push": {
          await run(cwd, ["push"]);
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
        case "graph":
          // better-sidebar 0.28.0 新增：提交图分页（远程工作区跑远端 git，本地照旧本机 git）。
          value = remote
            ? await gitGraphPage(payload, graphRemoteIo(remote))
            : await gitGraphPage(payload, graphLocalIo(cwd));
          break;
        default:
          writeJson(res, 404, { ok: false, error: { code: "not-found", message: "unknown git method " + method } }); return;
      }
      if (value === undefined) value = { ok: true };
      writeOk(res, value);
    } catch (e) {
      const code = (e && e.code) || "git-error";
      const message = (e && e.message) || String(e);
      // 与上游一致：graph-stale（分页期间历史变了）→ 409，graph-limit / bad-request → 400，其余 500。
      const status = code === "graph-stale" ? 409 : (code === "bad-request" || code === "graph-limit") ? 400 : 500;
      writeJson(res, status, { ok: false, error: { code: code, message: message } });
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
      // 相对路径必须按会话 cwd 解析（issue #25）。原实现是
      // `ensureWorkspacePath(activeWorktreeRootOf(ctx, sessionId, sessionCwd), raw)`；
      // 本插件接管 exact 路由后此前把 rawPath 直接交给 fs，于是相对路径由 Node 按插件宿主进程的
      // process.cwd()（pnpm profile 目录）解析 → `cannot read: ENOENT …\\profiles\\desktop\\…`。
      const cwd = sessionCwdFrom({ sessionId: sessionId }, cwdParam);
      const localPath = resolveSessionPath(rawPath, cwd);
      if (!localPath.resolved) {
        res.writeHead(400);
        res.end(unresolvedPathMessage(rawPath, cwd, localPath.reason));
        return;
      }
      const filePath = localPath.path;
      const info = await stat(filePath).catch((e) => { throw new Error("cannot read: " + String(e && e.message ? e.message : e)); });
      if (!info.isFile() || info.size > 20 * 1024 * 1024) { res.writeHead(400); res.end("not a file or too large"); return; }
      const body = await readFile(filePath);
      const headers = {
        "content-type": mediaTypeForPath(filePath),
        "cache-control": "no-cache"
      };
      if (download) headers["content-disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(filePath.split(/[\\/]/).pop() || "download")}`;
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
    // 2.4.29：会话 cwd 可能是工作区的**子目录** —— 按前缀匹配（精确匹配 `.remote-ssh.json` 会漏，
    // 漏了就退回本地实现，@ 引用只能搜到镜像目录，正是 issue #10 的现象）。
    const matched = remoteWorkspaceForPath(cwd);
    const info = matched ? matched.info : null;
    if (!info || !info.host || !info.user || !info.keyPath) return null;
    const profile = getProfile(info.profileId);
    if (!profile) return null;
    // 子目录会话要列的是**对应的远端子目录**，不是远端根。
    const remoteDir = localToRemote(cwd, matched.root, info.remotePath || "~");
    return await remoteRefList(profile, remoteDir || "~", query, signal);
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

  // ---- agent 文件工具写回远端（issue #15；护栏与失败可见性见 issue #24）----
  // ctx.fs 是进程内服务（agent 的 write/edit 走它），这里在原写入成功之后把同一份内容定向推到
  // 远端对应文件；非远程工作区路径（找不到 .remote-ssh.json）时什么都不做。
  //
  // issue #24 的三处改动：
  //   ① >4 MiB 的内容改走 remoteWriteFileChunked（旧版是确定性失败，且只落一行日志）；
  //   ② 每个工作区可关掉写回或排除若干路径（writeBack / writeBackExclude），
  //      免得草稿、临时脚本、抓取 dump 被无声推到共享集群的项目目录；
  //   ③ 推送失败默认**抛错**让模型看见（工具报错是本版 DSH 上唯一的模型可见通道，
  //      证据见 PrefsSchema.writeBackFailure 的注释）；消息里点明本地写入是成功的，
  //      并给出 remote_ssh_push 这条补救路径。设 writeBackFailure: "log" 可退回旧行为。
  async function mirrorWriteToRemote(absPath, content) {
    if (!absPath || typeof content !== "string") return;
    const hit = findMirrorRoot(absPath);
    if (!hit) return;                                   // 本地工作区 / 非镜像路径：不动
    const p = getProfile(hit.info.profileId);
    if (!p) return;
    const remoteFile = localToRemote(absPath, hit.root, hit.info.remotePath);
    if (!remoteFile || remoteFile === hit.info.remotePath) return;
    // 工作区设置（按镜像目录匹配）；读不到设置时按默认（推、无排除）处理
    let ws = null;
    try {
      const rel = String(absPath).replace(/\\/g, "/");
      const base = String(hit.root).replace(/\\/g, "/").replace(/\/+$/, "");
      const relPath = rel.slice(base.length).replace(/^\/+/, "");
      for (const w of settingsFace.read().workspaces || []) {
        if (!w || !w.mirrorPath) continue;
        if (String(w.mirrorPath).replace(/\\/g, "/").replace(/\/+$/, "") !== base) continue;
        ws = w;
        if (w.writeBack === false) {
          try { ctx.logger?.info?.("[dsh-remote-ssh] 该工作区已关闭写回（writeBack=false），本次不推送: " + relPath); } catch (e) {}
          return;
        }
        if (matchAnyGlob(w.writeBackExclude, relPath)) {
          try { ctx.logger?.info?.("[dsh-remote-ssh] 命中 writeBackExclude，本次不推送: " + relPath); } catch (e) {}
          return;
        }
        break;
      }
    } catch (e) {}
    // ---- 护栏 B（issue #24 第二轮）：推之前先看远端这一份有没有被别的写入者改过 ----
    // 判定（freshnessGuardPlan）与处置（applyFreshnessPlan）都在模块级纯函数里 —— 见测试 E5；
    // 这里只做接线。只在"有记录"时才多花一次往返：没有记录（首次推这个路径、或状态文件被删）
    // 一律放行 —— 宁可少拦一次，也不要因为状态问题挡住正常写入。
    const freshnessOn = writeBackFreshnessEnabled();
    if (freshnessOn) {
      const plan = await freshnessGuardCheck({
        runner: runPooled,
        profile: p,
        stateDir: wrapperDir,
        profileId: p.id,
        remoteFile,
        mode: writeBackFailureMode(),
        log: (m) => { try { ctx.logger?.warn?.(m); } catch (e) {} }
      });
      const guard = applyFreshnessPlan(plan);
      if (guard.err) throw guard.err;      // 默认模式：拦住 + 让模型看见原因
      if (!guard.pushed) return;           // log 模式：只留日志，本地写入照常算成功
    }
    // 远端父目录可能还不存在（新文件常落在新建目录里）
    const remoteDir = posixDirname(remoteFile);
    if (remoteDir && remoteDir !== remoteFile) {
      try { await runPooled(p, "mkdir -p " + shellQuotePath(remoteDir), undefined, undefined); } catch (e) {}
    }
    const r = await remoteWriteFileChunked(runPooled, p, remoteFile, content);
    if (r && r.ok) {
      // 推送成功后记下远端此刻的 size:mtime —— 下一次推同一路径时用它判断"远端有没有被别人改过"。
      if (freshnessOn) {
        const after = await remoteMtimeInfo(runPooled, p, remoteFile);
        if (after.ok && after.exists) freshnessSet(wrapperDir, p.id, remoteFile, after.stamp);
        else freshnessForget(wrapperDir, p.id, remoteFile);
      }
      try { ctx.logger?.info?.("[dsh-remote-ssh] agent 写入已同步到远端: " + remoteFile + (r.chunked ? "（分块写入 " + r.bytes + " 字节）" : "")); } catch (e) {}
      return;
    }
    const detail = String((r && (r.error || r.stderr)) || "未知错误").slice(0, 300);
    try { ctx.logger?.warn?.("[dsh-remote-ssh] agent 写入同步远端失败（本地镜像已写入，可用 remote_ssh_push 补推）: " + remoteFile + " — " + detail); } catch (e) {}
    // 失败可见性：默认抛给调用方（→ 工具报错 → 模型看得见）。想让本地写入"看起来永远成功"
    // 就设 writeBackFailure: "log"（或环境变量 DSH_REMOTE_SSH_WRITEBACK_FAILURE=log）。
    if (writeBackFailureMode() !== "error") return;
    const err = new Error(
      "本地镜像已写入成功，但同步到远端失败：\n" +
      "  远端文件: " + remoteFile + "\n" +
      "  原因: " + detail + "\n" +
      "  含义: 该文件在远端**可能不存在或不是最新**（本地镜像里的内容是完整的、已保存）。\n" +
      "  处理: 用 remote_ssh_push 补推该工作区；或重试本次写入。\n" +
      "  若希望失败只写日志、不影响工具返回，设置 writeBackFailure: \"log\"。"
    );
    err.dshRemoteSshWriteBack = true;
    throw err;
  }

  /** 写回失败模式：设置 writeBackFailure（"error" 默认 / "log"），环境变量可覆盖。 */
  function writeBackFailureMode() {
    const env = String(process.env.DSH_REMOTE_SSH_WRITEBACK_FAILURE || "").trim().toLowerCase();
    if (env === "log" || env === "silent" || env === "off") return "log";
    if (env === "error" || env === "throw") return "error";
    try {
      const v = String(settingsFace.read().writeBackFailure || "").trim().toLowerCase();
      if (v === "log" || v === "silent") return "log";
    } catch (e) {}
    return "error";
  }

  /**
   * 护栏 B 开关：设置 `writeBackFreshness`（默认 **true**），环境变量可强制开/关。
   * 默认开 —— 判错的代价不对称：漏报一次会丢掉远端内容，误报一次只是让模型多走一步
   * `remote_ssh_push`（举报人的判断，我同意）。
   */
  function writeBackFreshnessEnabled() {
    const env = String(process.env.DSH_REMOTE_SSH_WRITEBACK_FRESHNESS || "").trim().toLowerCase();
    if (env === "off" || env === "0" || env === "false" || env === "no") return false;
    if (env === "on" || env === "1" || env === "true") return true;
    try {
      const v = settingsFace.read().writeBackFreshness;
      if (v === false) return false;
      if (typeof v === "string" && /^(off|false|0|no)$/i.test(v.trim())) return false;
    } catch (e) {}
    return true;
  }

  let restoreFsWrite = null;
  ctx.inject(["fs"], (sctx) => {
    const svc = sctx && (sctx.fs || (typeof sctx.get === "function" ? sctx.get("fs") : null));
    restoreFsWrite = installFsWriteBridge(svc, { onWritten: mirrorWriteToRemote, log: ctx.logger });
    if (!restoreFsWrite) {
      try { ctx.logger?.warn("[dsh-remote-ssh] ctx.fs 不可包装：远程工作区里 agent 的 write/edit 仍只落本地镜像（需 remote_ssh_push）"); } catch (e) {}
    }
  });

  // ---- 清理 ----
  ctx.effect(() => () => {
    if (restoreFileReferences) { try { restoreFileReferences(); } catch (e) {} restoreFileReferences = null; }
    if (restoreFsWrite) { try { restoreFsWrite(); } catch (e) {} restoreFsWrite = null; }
    clearInterval(idleTimer);
    sessions.forEach(function (s) { try { s.close(); } catch (e) {} });
    sessions.clear();
    terminals.forEach(function (s) { try { s.handle.terminate(); } catch (e) {} });
    terminals.clear();
  });
}

export { Config, apply, inject, name };
