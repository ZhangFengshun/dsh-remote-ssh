/**
 * @zhangfengshun/dsh-remote-ssh — Client 半边（静态 DSH Web 插件，浏览器 bundle）
 *
 * 通过 dsh-better-sidebar 的 `ctx.betterSidebar.registerTab` 注册两个侧边栏页签：
 *   - remssh:files  远程文件（文件浏览器 + 工作区选择）
 *   - remssh:term   远程终端（ssh -tt 管道终端）
 * 并在 DSH 设置页注册「远程连接」小节（settings.section）管理连接配置；
 * 同时接管原生「添加工作区」流程（directoryFlow 槽位，优先级 -1 覆盖内置选择器），
 * 提供「本地目录 / 远程目录」两选：远程分支创建本地镜像目录并注册为原生工作区。
 */
window.__ModuleLoader__.load({
  id: "@zhangfengshun/dsh-remote-ssh",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");
    var primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    var Modal = primitives.Modal;

    function h(tag, props) {
      var args = [tag, props];
      for (var i = 2; i < arguments.length; i++) args.push(arguments[i]);
      return React.createElement.apply(React, args);
    }

    var CSS =
      // 颜色全部使用 DSH 主题 token（--dsw-alias-*），跟随 body[data-ds-dark-theme] 自动切换明暗主题。
      ".rssh-row{margin:6px 0}.rssh-label{color:var(--dsw-alias-label-caption);font-size:11px;display:block;margin-bottom:2px}" +
      ".rssh-input{width:100%;box-sizing:border-box;background:var(--dsw-specific-input-major);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:4px;padding:5px 7px;margin:3px 0;font-size:12px}" +
      ".rssh-select{width:100%;box-sizing:border-box;background:var(--dsw-specific-input-major);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:4px;padding:5px 7px;margin:3px 0;font-size:12px}" +
      ".rssh-btn{background:var(--dsw-alias-button-ghost-active-fill);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:4px;padding:4px 9px;cursor:pointer;font-size:12px}" +
      ".rssh-btn:hover{background:var(--dsw-alias-button-ghost-active-hover)}.rssh-btn:disabled{opacity:.5;cursor:default}" +
      ".rssh-card{padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;margin:8px 0;background:var(--dsw-alias-bg-layer-2)}" +
      ".rssh-title{font-weight:600;font-size:13px}.rssh-sub{color:var(--dsw-alias-label-tertiary);font-size:11px}" +
      ".rssh-actions{margin-top:6px;display:flex;gap:5px;flex-wrap:wrap}" +
      ".rssh-tree-item{display:flex;align-items:center;gap:5px;padding:3px 5px;cursor:pointer;border-radius:3px}" +
      ".rssh-tree-item:hover{background:var(--dsw-alias-interactive-bg-hover)}" +
      ".rssh-tree-dir{color:var(--dsw-alias-state-business-primary)}.rssh-tree-file{color:var(--dsw-alias-label-primary)}" +
      ".rssh-tree-size{color:var(--dsw-alias-label-caption);font-size:11px;margin-left:auto}" +
      ".rssh-pathbar{display:flex;gap:4px;align-items:center;margin:4px 0}" +
      ".rssh-pathbar .rssh-input{flex:1;margin:0}" +
      ".rssh-content{white-space:pre-wrap;font-family:Consolas,monospace;font-size:12px;background:var(--dsw-alias-markdown-code-block);color:var(--dsw-alias-label-primary);padding:8px;border-radius:4px;margin-top:6px;max-height:400px;overflow:auto}" +
      ".rssh-terminal{background:var(--dsw-alias-markdown-code-block);color:var(--dsw-alias-label-primary);border-radius:4px;padding:6px;margin-top:8px;font-family:Consolas,monospace;font-size:12px}" +
      ".rssh-terminal-out{white-space:pre-wrap;max-height:320px;overflow:auto;min-height:120px;line-height:1.4}" +
      ".rssh-terminal-bar{display:flex;gap:5px;align-items:center;margin-bottom:4px}" +
      ".rssh-terminal-input-row{display:flex;gap:4px;margin-top:5px}.rssh-terminal-input-row .rssh-input{flex:1}" +
      ".rssh-ok{color:var(--dsw-alias-state-success-primary)}.rssh-err{color:var(--dsw-alias-state-error-primary)}.rssh-muted{color:var(--dsw-alias-label-tertiary);font-size:12px;padding:6px 0}" +
      ".rssh-empty{padding:12px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12px}" +
      ".rssh-flow-dialog{width:690px!important;max-width:94vw!important;min-width:460px;resize:horizontal;overflow:auto!important}" +
      // 添加工作区弹窗：上方本地/远程分段切换 + 路径栏 + 文件树
      ".rssh-seg{display:flex;gap:0;margin-bottom:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;overflow:hidden}" +
      ".rssh-seg-btn{flex:1;padding:7px 12px;text-align:center;cursor:pointer;font-size:12px;font-weight:500;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);border:none;transition:background .15s}" +
      ".rssh-seg-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}" +
      ".rssh-seg-btn.active{background:var(--dsw-alias-state-business-primary);color:#fff}" +
      ".rssh-pick-tree{border:1px solid var(--dsw-alias-border-l1);border-radius:4px;max-height:240px;overflow-y:auto;margin-top:4px;background:var(--dsw-alias-bg-layer-2)}" +
      ".rssh-pick-empty{padding:12px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:11px}" +
      // 设置面板导航：隐藏「远程连接」栏目左侧壳层硬编码的齿轮图标（本栏目 order=200 位于末尾）。
      ".VOzbGW_navList .VOzbGW_navCell:last-child .VOzbGW_navIcon{display:none}";

    // ---- 国际化（跟随 DSH 设置中的语言自动切换）----
    var NS = "dsh-remote-ssh";
    var zh = {
      "tabs.files": "远程文件",
      "tabs.term": "远程终端",
      "settings.nav": "🖥️ 远程连接",
      "settings.desc": "管理 Remote-SSH 的远程连接配置（SSH 密钥或密码认证）。",
      "settings.empty": "还没有连接配置。请在下方添加。",
      "settings.add": "添加连接",
      "settings.name": "名称",
      "settings.namePlaceholder": "如：我的超算",
      "settings.host": "主机 host",
      "settings.hostPlaceholder": "login.example.com",
      "settings.port": "端口 port",
      "settings.user": "用户名 user",
      "settings.userPlaceholder": "your-username",
      "settings.auth": "认证方式",
      "settings.key": "密钥 (推荐)",
      "settings.password": "密码 (需 sshpass)",
      "settings.keyPath": "私钥路径 keyPath",
      "settings.keyPathPlaceholder": "~/.ssh/id_rsa",
      "settings.passwordField": "密码 password",
      "settings.remoteRoot": "远程根目录 remoteRoot",
      "settings.proxyJump": "跳板机 ProxyJump",
      "settings.test": "测试连接",
      "settings.saved": "已保存",
      "settings.connOk": "连接成功",
      "settings.connFail": "连接失败: ",
      "settings.errSave": "保存失败",
      "common.selectProfile": "— 选择连接 —",
      "common.profile": "连接配置",
      "common.save": "保存",
      "common.open": "打开",
      "common.close": "关闭",
      "common.noEntries": "（无子目录）",
      "common.delete": "删除",
      "common.up": "⬆ 上级",
      "common.loading": "加载中…",
      "common.processing": "处理中…",
      "common.errList": "读取目录失败",
      "files.workspace": "远程工作区",
      "files.selectWorkspace": "— 选择工作区 —",
      "files.orProfile": "或直接选连接配置",
      "files.defaultDir": "默认目录（打开该工作区时进入的远程目录）",
      "files.reading": "读取中…",
      "files.errRead": "读取失败",
      "files.errSave": "保存失败",
      "files.errSaveDefaultDir": "保存默认目录失败",
      "files.binary": "二进制文件，无法预览",
      "term.title": "终端 {id}",
      "term.exited": " (已退出)",
      "term.connecting": "正在连接…",
      "term.noOutput": "(无输出)",
      "term.inputPlaceholder": "输入命令后回车…",
      "term.send": "发送",
      "term.needProfile": "请先选择连接配置",
      "term.newTerminal": "+ 新建终端",
      "term.emptyHint": "从上面的连接配置新建一个终端，直接操作远程环境。",
      "term.errSpawn": "启动终端失败",
      "picker.dir": "目录",
      "picker.choose": "选择此目录",
      "flow.localTitle": "选择本地目录",
      "flow.remoteTitle": "选择远程目录",
      "flow.localDir": "本地目录",
      "flow.remoteDir": "远程目录",
      "flow.addWsTitle": "添加工作区",
      "flow.localSeg": "📁 本地目录",
      "flow.remoteSeg": "🌐 远程目录",
      "flow.browse": "浏览",
      "flow.chooseRemote": "选择远程目录…",
      "flow.backLocal": "← 选择本地目录",
      "flow.errCreate": "创建远程工作区失败",
      "settings.importSshConfig": "从 ~/.ssh/config 导入…",
      "settings.importTitle": "导入 ~/.ssh/config 主机",
      "settings.noneFound": "未在 ~/.ssh/config 中发现可用主机",
      "settings.imported": "已导入 {n} 个连接",
      "sync.down": "⬇ 同步",
      "sync.up": "⬆ 推送",
      "sync.syncing": "同步中…",
      "sync.pushing": "推送中…",
      "sync.done": "同步完成",
      "sync.fail": "同步失败",
      "ops.search": "🔍 搜索",
      "ops.find": "按名查找",
      "ops.searchPh": "正则或关键词…",
      "ops.globPh": "*.py",
      "ops.newDir": "📁 新建目录",
      "ops.newDirPh": "目录名",
      "ops.rename": "✏ 重命名/移动",
      "ops.renamePh": "目标路径",
      "ops.delete": "🗑 删除",
      "ops.confirmDel": "确认删除远程文件/目录？（不可恢复）",
      "ops.grepTitle": "远程内容搜索 (grep)",
      "ops.globTitle": "按文件名查找 (glob)",
      "ops.mkdirTitle": "新建远程目录",
      "ops.moveTitle": "移动/重命名",
      "ops.deleteTitle": "删除远程文件/目录",
      "ops.noMatch": "无匹配",
      "ops.done": "操作完成",
      "ops.fail": "操作失败"
    };
    var en = {
      "tabs.files": "Remote Files",
      "tabs.term": "Remote Terminal",
      "settings.nav": "🖥️ Remote Connections",
      "settings.desc": "Manage Remote-SSH connection profiles (SSH key or password authentication).",
      "settings.empty": "No connection profiles yet. Add one below.",
      "settings.add": "Add Profile",
      "settings.name": "Name",
      "settings.namePlaceholder": "e.g. My HPC",
      "settings.host": "Host",
      "settings.hostPlaceholder": "login.example.com",
      "settings.port": "Port",
      "settings.user": "User",
      "settings.userPlaceholder": "your-username",
      "settings.auth": "Authentication",
      "settings.key": "Key (recommended)",
      "settings.password": "Password (requires sshpass)",
      "settings.keyPath": "Private key path (keyPath)",
      "settings.keyPathPlaceholder": "~/.ssh/id_rsa",
      "settings.passwordField": "Password",
      "settings.remoteRoot": "Remote root (remoteRoot)",
      "settings.proxyJump": "ProxyJump (jump host)",
      "settings.test": "Test Connection",
      "settings.saved": "Saved",
      "settings.connOk": "Connected",
      "settings.connFail": "Connection failed: ",
      "settings.errSave": "Save failed",
      "common.selectProfile": "— Select profile —",
      "common.profile": "Profile",
      "common.save": "Save",
      "common.open": "Open",
      "common.close": "Close",
      "common.noEntries": "(no subdirectories)",
      "common.delete": "Delete",
      "common.up": "⬆ Up",
      "common.loading": "Loading…",
      "common.processing": "Processing…",
      "common.errList": "Failed to list directory",
      "files.workspace": "Remote Workspace",
      "files.selectWorkspace": "— Select workspace —",
      "files.orProfile": "or pick a profile directly",
      "files.defaultDir": "Default directory (entered when opening this workspace)",
      "files.reading": "Reading…",
      "files.errRead": "Failed to read",
      "files.errSave": "Failed to save",
      "files.errSaveDefaultDir": "Failed to save default directory",
      "files.binary": "Binary file — preview not available",
      "term.title": "Terminal {id}",
      "term.exited": " (exited)",
      "term.connecting": "Connecting…",
      "term.noOutput": "(no output)",
      "term.inputPlaceholder": "Type a command and press Enter…",
      "term.send": "Send",
      "term.needProfile": "Select a profile first",
      "term.newTerminal": "+ New terminal",
      "term.emptyHint": "Create a terminal from the profile above to operate the remote environment.",
      "term.errSpawn": "Failed to start terminal",
      "picker.dir": "Directory",
      "picker.choose": "Choose this directory",
      "flow.localTitle": "Select Local Directory",
      "flow.remoteTitle": "Select Remote Directory",
      "flow.localDir": "Local directory",
      "flow.remoteDir": "Remote directory",
      "flow.addWsTitle": "Add Workspace",
      "flow.localSeg": "📁 Local",
      "flow.remoteSeg": "🌐 Remote",
      "flow.browse": "Browse",
      "flow.chooseRemote": "Choose remote directory…",
      "flow.backLocal": "← Choose local directory",
      "flow.errCreate": "Failed to create remote workspace",
      "settings.importSshConfig": "Import from ~/.ssh/config…",
      "settings.importTitle": "Import ~/.ssh/config hosts",
      "settings.noneFound": "No usable hosts found in ~/.ssh/config",
      "settings.imported": "Imported {n} connection(s)",
      "sync.down": "⬇ Sync",
      "sync.up": "⬆ Push",
      "sync.syncing": "Syncing…",
      "sync.pushing": "Pushing…",
      "sync.done": "Sync complete",
      "sync.fail": "Sync failed",
      "ops.search": "🔍 Search",
      "ops.find": "Find by name",
      "ops.searchPh": "regex or keyword…",
      "ops.globPh": "*.py",
      "ops.newDir": "📁 New dir",
      "ops.newDirPh": "dir name",
      "ops.rename": "✏ Rename/Move",
      "ops.renamePh": "target path",
      "ops.delete": "🗑 Delete",
      "ops.confirmDel": "Confirm delete remote file/dir? (irreversible)",
      "ops.grepTitle": "Remote content search (grep)",
      "ops.globTitle": "Find by name (glob)",
      "ops.mkdirTitle": "Create remote directory",
      "ops.moveTitle": "Move/Rename",
      "ops.deleteTitle": "Delete remote file/dir",
      "ops.noMatch": "No match",
      "ops.done": "Done",
      "ops.fail": "Operation failed"
    };
    var i18n = {
      t: function (key) { return key; },
      subscribe: function () { return function () {}; },
      getSnapshot: function () { return 0; }
    };
    function useT() {
      var state = React.useState(0);
      var force = state[1];
      React.useEffect(function () {
        return i18n.subscribe(function () { force(function (n) { return n + 1; }); });
      }, []);
      return i18n.t;
    }

    // ---- 跨会话切换的状态记忆（按 sessionId 分桶，模块级存活，页面刷新即失效）----
    var memoryBySession = {};
    function useSessionMemory(sessionId, key, initial) {
      var sid = sessionId || "global";
      var bucket = memoryBySession[sid] || (memoryBySession[sid] = {});
      var state = React.useState(function () {
        if (Object.prototype.hasOwnProperty.call(bucket, key)) return bucket[key];
        var init = typeof initial === "function" ? initial() : initial;
        return bucket[key] = init;
      });
      var value = state[0], setValue = state[1];
      React.useEffect(function () { bucket[key] = value; }, [value]);
      return [value, setValue];
    }

    // ---- 与 Host 半边的 JSON RPC ----
    async function api(method, args) {
      try {
        var r = await fetch("/remote-ssh/api/" + method, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(args || {})
        });
        var j = await r.json();
        if (j && j.ok) return j.value;
        return { ok: false, error: (j && j.error && j.error.message) || ("HTTP " + r.status) };
      } catch (e) {
        return { ok: false, error: String(e && e.message ? e.message : e) };
      }
    }

    // ---- 跨页签「打开工作区」的轻量共享选择 ----
    var sel = { workspaceId: null };
    var selListeners = [];
    function setSelWorkspace(id) { sel.workspaceId = id; selListeners.forEach(function (fn) { fn(); }); }
    function subscribeSel(fn) { selListeners.push(fn); return function () { var i = selListeners.indexOf(fn); if (i >= 0) selListeners.splice(i, 1); }; }

    // ---- 通用：拉取连接配置（refreshKey 变化时重新拉取，避免缓存过期）----
    function useProfiles(refreshKey) {
      var state = React.useState([]);
      var profiles = state[0], setProfiles = state[1];
      React.useEffect(function () {
        api("listProfiles").then(function (r) { if (r && r.ok) setProfiles(r.profiles || []); });
      }, [refreshKey]);
      return profiles;
    }

    function Field(props) {
      return h("div", { className: "rssh-row" },
        h("span", { className: "rssh-label" }, props.label),
        h("input", { className: "rssh-input", type: props.type || "text", value: props.value, placeholder: props.placeholder,
          onChange: function (e) { props.onChange(e.target.value); } })
      );
    }

    // ======================================================================
    // 远程操作弹窗（grep / glob / mkdir / move / delete）
    // ======================================================================
    function OpsModal(props) {
      var d = props.opsDlg;
      var t = props.t;
      var patchOps = props.patchOps;
      var runOps = props.runOps;
      var title = ({
        grep: t("ops.grepTitle"), glob: t("ops.globTitle"), mkdir: t("ops.mkdirTitle"),
        move: t("ops.moveTitle"), delete: t("ops.deleteTitle")
      })[d.type] || "";
      var isGrep = d.type === "grep";
      var isGlob = d.type === "glob";
      var isMove = d.type === "move";
      var isDel = d.type === "delete";
      // 结果渲染
      var resultEl = null;
      if (d.result) {
        var r = d.result;
        if (isGrep) {
          var ms = r.matches || [];
          resultEl = h("div", { style: { maxHeight: 260, overflow: "auto", marginTop: 8, fontSize: 11, whiteSpace: "pre-wrap", fontFamily: "monospace" } },
            !r.ok ? h("div", { className: "rssh-err" }, r.error || t("ops.fail")) :
            ms.length === 0 ? h("div", { className: "rssh-muted" }, t("ops.noMatch")) :
            ms.map(function (m, i) { return h("div", { key: i }, m.file + ":" + m.line + ": " + m.content); }),
            r.truncated ? h("div", { className: "rssh-muted" }, "…") : null
          );
        } else if (isGlob) {
          var fs2 = r.files || [];
          resultEl = h("div", { style: { maxHeight: 260, overflow: "auto", marginTop: 8, fontSize: 11, whiteSpace: "pre-wrap", fontFamily: "monospace" } },
            !r.ok ? h("div", { className: "rssh-err" }, r.error || t("ops.fail")) :
            fs2.length === 0 ? h("div", { className: "rssh-muted" }, t("ops.noMatch")) :
            fs2.map(function (f, i) { return h("div", { key: i }, f); })
          );
        } else {
          // exec 结果（mkdir/move/delete）
          resultEl = h("div", { style: { marginTop: 8 } },
            r.ok ? h("div", { className: "rssh-ok" }, t("ops.done") + (r.stderr ? "  " + String(r.stderr).slice(0, 200) : "")) :
            h("div", { className: "rssh-err" }, (r.error || r.stderr || t("ops.fail")))
          );
        }
      }
      return h(Modal, { open: true, onClose: props.close, title: title, closeLabel: t("common.close"), className: "rssh-flow-dialog" },
        h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
          h("input", { className: "rssh-input", value: d.p1, onChange: function (e) { patchOps({ p1: e.target.value }); }, placeholder: isGrep ? t("ops.searchPh") : (isGlob ? t("ops.globPh") : t("ops.newDirPh")) }),
          isGrep ? h("input", { className: "rssh-input", value: d.p2, onChange: function (e) { patchOps({ p2: e.target.value }); }, placeholder: "*.py (include)" }) : null,
          isMove ? h("input", { className: "rssh-input", value: d.p2, onChange: function (e) { patchOps({ p2: e.target.value }); }, placeholder: t("ops.renamePh") }) : null,
          h("div", { className: "rssh-actions" },
            h("button", { className: "rssh-btn", onClick: runOps, disabled: d.busy }, d.busy ? t("common.processing") : (isDel ? t("ops.delete") : t("common.save"))),
            h("button", { className: "rssh-btn", onClick: props.close, disabled: d.busy }, t("common.close"))
          ),
          resultEl
        )
      );
    }

    // ======================================================================
    // 远程文件页签
    // ======================================================================
    function FilesTab(props) {
      var t = useT();
      var sessionId = props.sessionId;
      var betterSidebar = props.betterSidebar;
      var [workspaces, setWorkspaces] = React.useState([]);
      var profiles = useProfiles();
      var [wsId, setWsId] = useSessionMemory(sessionId, "wsId", sel.workspaceId);
      var [profileId, setProfileId] = useSessionMemory(sessionId, "profileId", "");
      var [path, setPath] = useSessionMemory(sessionId, "path", "");
      var [entries, setEntries] = useSessionMemory(sessionId, "entries", []);
      var [err, setErr] = React.useState(null);
      var [loading, setLoading] = React.useState(false);
      var [defaultDir, setDefaultDir] = useSessionMemory(sessionId, "defaultDir", "");
      var [syncSt, setSyncSt] = React.useState(null); // { busy, msg, ok }
      var [opsDlg, setOpsDlg] = React.useState(null); // { type, p1, p2, result, busy }

      React.useEffect(function () {
        api("listWorkspaces").then(function (r) { if (r && r.ok) setWorkspaces(r.workspaces || []); });
        return subscribeSel(function () { setWsId(sel.workspaceId); });
      }, []);

      function load(targetProfile, targetPath) {
        setLoading(true); setErr(null);
        api("listDir", { profileId: targetProfile, path: targetPath }).then(function (r) {
          setLoading(false);
          if (r && r.ok) { setEntries(r.entries || []); setPath(r.path || targetPath); }
          else setErr((r && r.error) || t("common.errList"));
        });
      }

      // 工作区/配置选择变化时进入对应目录
      React.useEffect(function () {
        if (!wsId && !profileId) return;
        var pid = profileId;
        var rootPath = "";
        if (wsId) {
          var ws = workspaces.find(function (w) { return w.id === wsId; });
          if (ws) { pid = ws.profileId; rootPath = ws.remotePath; }
        }
        if (!pid) return;
        setProfileId(pid);
        load(pid, rootPath || undefined);
      }, [wsId, profileId, workspaces]);

      // 选中工作区时，把「默认目录」输入框同步为该工作区的 remotePath。
      React.useEffect(function () {
        if (wsId) {
          var ws = workspaces.find(function (w) { return w.id === wsId; });
          if (ws) setDefaultDir(ws.remotePath || "");
        }
      }, [wsId, workspaces]);

      function saveDefaultDir() {
        if (!wsId) return;
        api("updateWorkspace", { id: wsId, remotePath: defaultDir }).then(function (r) {
          if (r && r.ok) { setWorkspaces(r.workspaces || []); setErr(null); }
          else setErr((r && r.error) || t("files.errSaveDefaultDir"));
        });
      }

      function doSync(direction) {
        if (!wsId) return;
        var ws = workspaces.find(function (w) { return w.id === wsId; });
        if (!ws) return;
        setSyncSt({ busy: true, msg: direction === "down" ? t("sync.syncing") : t("sync.pushing"), ok: null });
        var method = direction === "down" ? "syncDown" : "syncUp";
        api(method, { workspaceId: wsId }).then(function (r) {
          if (r && r.ok) setSyncSt({ busy: false, msg: direction === "down" ? t("sync.done") : t("sync.done"), ok: true });
          else setSyncSt({ busy: false, msg: (r && r.error) || t("sync.fail"), ok: false });
        });
      }

      function activeProfileId() {
        if (wsId) {
          var ws = workspaces.find(function (w) { return w.id === wsId; });
          if (ws) return ws.profileId;
        }
        return profileId;
      }
      function opsBase() {
        if (wsId) {
          var ws = workspaces.find(function (w) { return w.id === wsId; });
          if (ws) return ws.remotePath || path || "~";
        }
        return path || "~";
      }
      function openOps(type) {
        var init = { type: type, p1: "", p2: "", result: null, busy: false };
        if (type === "mkdir") init.p1 = path ? (path.replace(/\/+$/, "") + "/") : "";
        if (type === "move") { init.p1 = path ? (path.replace(/\/+$/, "") + "/") : ""; init.p2 = path ? (path.replace(/\/+$/, "") + "/") : ""; }
        if (type === "delete") init.p1 = path ? (path.replace(/\/+$/, "") + "/") : "";
        setOpsDlg(init);
      }
      function patchOps(patch) {
        setOpsDlg(function (d) { var n = {}; for (var k in d) n[k] = d[k]; for (var k2 in patch) n[k2] = patch[k2]; return n; });
      }
      function runOps() {
        if (!opsDlg) return;
        var pid = activeProfileId();
        if (!pid) { patchOps({ result: { ok: false, msg: t("ops.fail") }, busy: false }); return; }
        var base = opsBase();
        var d = opsDlg;
        patchOps({ busy: true, result: null });
        function resolveP(p) {
          if (!p) return p;
          var c = String(p).charAt(0);
          if (c === "/" || c === "~") return p;
          return base.replace(/\/+$/, "") + "/" + p;
        }
        if (d.type === "grep") {
          api("grep", { profileId: pid, pattern: d.p1, path: base, include: d.p2 || undefined }).then(function (r) {
            patchOps({ busy: false, result: r });
          });
        } else if (d.type === "glob") {
          api("glob", { profileId: pid, pattern: d.p1, path: base }).then(function (r) {
            patchOps({ busy: false, result: r });
          });
        } else if (d.type === "mkdir") {
          api("mkdir", { profileId: pid, path: resolveP(d.p1) }).then(function (r) {
            patchOps({ busy: false, result: r });
            if (r && r.ok) { setErr(null); load(pid, path); }
          });
        } else if (d.type === "move") {
          api("move", { profileId: pid, src: resolveP(d.p1), dst: resolveP(d.p2) }).then(function (r) {
            patchOps({ busy: false, result: r });
            if (r && r.ok) { setErr(null); load(pid, path); }
          });
        } else if (d.type === "delete") {
          api("deleteFile", { profileId: pid, path: resolveP(d.p1) }).then(function (r) {
            patchOps({ busy: false, result: r });
            if (r && r.ok) { setErr(null); load(pid, path); }
          });
        }
      }

      function openEntry(e) {
        var base = path ? (path.replace(/\/+$/, "") + "/" + e.name) : e.name;
        if (e.type === "directory") {
          setPath(base);
          load(profileId, base);
        } else {
          // 用独立页签预览远程文件（与内置「文件」页签一致），而非在文件树下方预览。
          if (betterSidebar && betterSidebar.openTab) {
            betterSidebar.openTab({
              type: "remssh:editor",
              id: "remssh:editor:" + profileId + ":" + base,
              title: e.name,
              path: base,
              meta: { profileId: profileId, remotePath: base }
            }, { sessionId: sessionId });
          }
        }
      }

      function goUp() {
        if (!path) return;
        var parts = path.replace(/\/+$/, "").split("/");
        parts.pop();
        var up = parts.join("/") || "/";
        setPath(up);
        load(profileId, up);
      }

      return h("div", { style: { display: "flex", flexDirection: "column", flex: 1, minHeight: 0, overflow: "hidden" } },
        h("div", { style: { flex: "none" } },
          h("div", { className: "rssh-row" },
            h("span", { className: "rssh-label" }, t("files.workspace")),
            h("select", { className: "rssh-select", value: wsId || "", onChange: function (e) { setWsId(e.target.value); setProfileId(""); } },
              h("option", { value: "" }, t("files.selectWorkspace")),
              workspaces.map(function (w) { return h("option", { key: w.id, value: w.id }, w.title); })
            )
          ),
          h("div", { className: "rssh-row" },
            h("span", { className: "rssh-label" }, t("files.orProfile")),
            h("select", { className: "rssh-select", value: profileId, onChange: function (e) { setProfileId(e.target.value); setWsId(""); } },
              h("option", { value: "" }, t("common.selectProfile")),
              profiles.map(function (p) { return h("option", { key: p.id, value: p.id }, p.name); })
            )
          ),
          wsId ? h("div", { className: "rssh-row" },
            h("span", { className: "rssh-label" }, t("files.defaultDir")),
            h("div", { className: "rssh-pathbar" },
              h("input", { className: "rssh-input", value: defaultDir, onChange: function (e) { setDefaultDir(e.target.value); }, placeholder: "/home/user/project" }),
              h("button", { className: "rssh-btn", onClick: saveDefaultDir }, t("common.save"))
            )
          ) : null,
          h("div", { className: "rssh-pathbar" },
            h("input", { className: "rssh-input", value: path, onChange: function (e) { setPath(e.target.value); }, placeholder: "/home/user" }),
            h("button", { className: "rssh-btn", onClick: function () { load(profileId, path); } }, t("common.open")),
            h("button", { className: "rssh-btn", onClick: goUp }, t("common.up"))
          ),
          wsId ? h("div", { className: "rssh-pathbar" },
            h("button", { className: "rssh-btn", onClick: function () { doSync("down"); }, disabled: syncSt && syncSt.busy }, t("sync.down")),
            h("button", { className: "rssh-btn", onClick: function () { doSync("up"); }, disabled: syncSt && syncSt.busy }, t("sync.up")),
            syncSt ? h("span", { className: syncSt.ok === false ? "rssh-err" : (syncSt.ok ? "rssh-ok" : "rssh-muted"), style: { flex: 1, fontSize: 11 } }, syncSt.msg) : null
          ) : null,
          (wsId || profileId) ? h("div", { className: "rssh-pathbar", style: { flexWrap: "wrap" } },
            h("button", { className: "rssh-btn", onClick: function () { openOps("grep"); } }, t("ops.search")),
            h("button", { className: "rssh-btn", onClick: function () { openOps("glob"); } }, t("ops.find")),
            h("button", { className: "rssh-btn", onClick: function () { openOps("mkdir"); } }, t("ops.newDir")),
            h("button", { className: "rssh-btn", onClick: function () { openOps("move"); } }, t("ops.rename")),
            h("button", { className: "rssh-btn", onClick: function () { openOps("delete"); } }, t("ops.delete"))
          ) : null,
          loading ? h("div", { className: "rssh-muted" }, t("common.loading")) : null,
          err ? h("div", { className: "rssh-err", style: { whiteSpace: "pre-wrap" } }, err) : null,
          opsDlg ? h(OpsModal, { opsDlg: opsDlg, patchOps: patchOps, runOps: runOps, close: function () { setOpsDlg(null); }, t: t }) : null
        ),
        h("div", { style: { flex: 1, minHeight: 0, overflowY: "auto", marginTop: 6 } },
          entries.map(function (e) {
            return h("div", { key: e.name, className: "rssh-tree-item", onClick: function () { openEntry(e); } },
              h("span", { className: e.type === "directory" ? "rssh-tree-dir" : "rssh-tree-file" }, e.type === "directory" ? "📁 " + e.name : "📄 " + e.name),
              e.type === "file" ? h("span", { className: "rssh-tree-size" }, String(e.size)) : null
            );
          })
        )
      );
    }

    // ======================================================================
    // 远程文件编辑器页签：点击文件树中的文件后单开一栏预览/编辑（与内置「文件」页签一致）
    // ======================================================================
    function RemoteEditor(props) {
      var t = useT();
      var tab = props.tab || {};
      var ctx = props.ctx;
      var meta = tab.meta || {};
      var profileId = meta.profileId || "";
      var remotePath = tab.path || meta.remotePath || "";
      var [data, setData] = React.useState({ loading: true, content: "", binary: false, dirty: false, error: null });

      React.useEffect(function () {
        var alive = true;
        setData({ loading: true, content: "", binary: false, dirty: false, error: null });
        api("readFile", { profileId: profileId, path: remotePath }).then(function (r) {
          if (!alive) return;
          if (r && r.ok) setData({ loading: false, content: r.content || "", binary: !!r.binary, dirty: false, error: null });
          else setData({ loading: false, content: "", binary: false, dirty: false, error: (r && r.error) || t("files.errRead") });
        });
        return function () { alive = false; };
      }, [profileId, remotePath]);

      function save() {
        api("writeFile", { profileId: profileId, path: remotePath, content: data.content }).then(function (r) {
          if (r && r.ok) setData(Object.assign({}, data, { dirty: false, error: null }));
          else setData(Object.assign({}, data, { error: (r && r.error) || t("files.errSave") }));
        });
      }

      function close() {
        if (ctx && ctx.betterSidebar && tab.id) ctx.betterSidebar.closeTab(tab.id);
      }

      if (data.loading) return h("div", { className: "rssh-muted", style: { padding: 8 } }, t("files.reading"));
      if (data.error) return h("div", { className: "rssh-err", style: { padding: 8, whiteSpace: "pre-wrap" } }, data.error);
      if (data.binary) return h("div", { className: "rssh-muted", style: { padding: 8 } }, t("files.binary"));

      return h("div", { style: { display: "flex", flexDirection: "column", flex: 1, minHeight: 0, padding: 8, overflow: "hidden" } },
        h("div", { className: "rssh-pathbar", style: { flex: "none" } },
          h("span", { className: "rssh-title", style: { flex: 1, wordBreak: "break-all" } }, remotePath),
          h("button", { className: "rssh-btn", onClick: save }, t("common.save")),
          h("button", { className: "rssh-btn", onClick: close }, t("common.close"))
        ),
        h("textarea", { className: "rssh-content", style: { flex: 1, minHeight: 0, maxHeight: "none", width: "100%", boxSizing: "border-box", background: "var(--dsw-alias-markdown-code-block)", color: "var(--dsw-alias-label-primary)", border: "1px solid var(--dsw-alias-border-l2)" },
          value: data.content, onChange: function (e) { setData(Object.assign({}, data, { content: e.target.value, dirty: true })); } })
      );
    }

    // ======================================================================
    // 远程终端页签
    // ======================================================================
    function TerminalView(props) {
      var t = useT();
      var [data, setData] = React.useState("");
      var [status, setStatus] = React.useState("running");
      var [input, setInput] = React.useState("");
      var endRef = React.useRef(null);

      React.useEffect(function () {
        var timer = setInterval(function () {
          api("terminalRead", { id: props.id }).then(function (r) {
            if (r && r.ok) {
              if (r.data) setData(function (d) { return d + r.data; });
              if (r.status) setStatus(r.status);
            }
          });
        }, 200);
        return function () { clearInterval(timer); };
      }, [props.id]);

      React.useEffect(function () {
        if (endRef.current) endRef.current.scrollTop = endRef.current.scrollHeight;
      }, [data]);

      function send() {
        if (!input) return;
        api("terminalWrite", { id: props.id, data: input + "\r" });
        setInput("");
      }

      return h("div", { className: "rssh-terminal" },
        h("div", { className: "rssh-terminal-bar" },
          h("span", { style: { flex: 1, color: status === "running" ? "var(--dsw-alias-state-success-primary)" : "var(--dsw-alias-state-error-primary)" } }, t("term.title", { id: props.id }) + (status === "exited" ? t("term.exited") : "")),
          h("button", { className: "rssh-btn", onClick: function () { props.onClose(props.id); } }, t("common.close"))
        ),
        h("div", { className: "rssh-terminal-out", ref: endRef }, data || (status === "running" ? t("term.connecting") : t("term.noOutput"))),
        h("div", { className: "rssh-terminal-input-row" },
          h("input", { className: "rssh-input", value: input,
            onChange: function (e) { setInput(e.target.value); },
            onKeyDown: function (e) { if (e.key === "Enter") send(); },
            placeholder: t("term.inputPlaceholder") }),
          h("button", { className: "rssh-btn", onClick: send }, t("term.send"))
        )
      );
    }

    function TerminalTab(props) {
      var t = useT();
      var sessionId = props.sessionId;
      var profiles = useProfiles();
      var [profileId, setProfileId] = useSessionMemory(sessionId, "profileId", "");
      var [terms, setTerms] = useSessionMemory(sessionId, "terms", []);
      var [err, setErr] = React.useState(null);

      function spawn() {
        if (!profileId) { setErr(t("term.needProfile")); return; }
        setErr(null);
        api("spawnTerminal", { profileId: profileId }).then(function (r) {
          if (r && r.ok) setTerms(function (list) { return list.concat([{ id: r.id }]); });
          else setErr((r && r.error) || t("term.errSpawn"));
        });
      }

      function close(id) {
        api("terminalClose", { id: id });
        setTerms(function (list) { return list.filter(function (x) { return x.id !== id; }); });
      }

      return h("div", null,
        h("div", { className: "rssh-row" },
          h("span", { className: "rssh-label" }, t("common.profile")),
          h("select", { className: "rssh-select", value: profileId, onChange: function (e) { setProfileId(e.target.value); } },
            h("option", { value: "" }, t("common.selectProfile")),
            profiles.map(function (p) { return h("option", { key: p.id, value: p.id }, p.name); })
          )
        ),
        h("button", { className: "rssh-btn", onClick: spawn }, t("term.newTerminal")),
        err ? h("div", { className: "rssh-err", style: { marginTop: 6 } }, err) : null,
        terms.length === 0 ? h("div", { className: "rssh-empty" }, t("term.emptyHint")) : null,
        terms.map(function (term) { return h(TerminalView, { key: term.id, id: term.id, onClose: close }); })
      );
    }

    // ======================================================================
    // 目录选择器（供「添加工作区」弹窗流程使用：本地 browse / 远程 SSH）
    // ======================================================================
    // 本地目录列举：走 DSH browse 能力（无原生对话框时替代 pickDirectory）。
    function localListFn(workspaces, p) {
      return workspaces.listDirectory(p).then(function (r) {
        return {
          ok: true,
          path: r.path,
          entries: (r.entries || []).map(function (e) { return { name: e.name, type: "directory", path: e.path }; })
        };
      }).catch(function (e) {
        return { ok: false, error: String(e && e.message ? e.message : e) };
      });
    }

    // 远程目录列举：走本插件 SSH API，并为每条记录补全绝对 path。
    function remoteListFn(profileId, p) {
      return api("listDir", { profileId: profileId, path: p }).then(function (r) {
        if (!(r && r.ok)) return r;
        var parent = r.path || "";
        var entries = (r.entries || []).map(function (e) {
          return { name: e.name, type: e.type, path: (parent ? parent.replace(/\/+$/, "") + "/" : "") + e.name };
        });
        return { ok: true, path: r.path, entries: entries };
      });
    }

    // 计算父目录，兼容 Windows(\\) 与 POSIX(/) 分隔符。
    function parentOf(path) {
      if (!path) return null;
      var str = String(path).replace(/[\/\\]+$/, "");
      if (str === "") return null;
      var idx = Math.max(str.lastIndexOf("/"), str.lastIndexOf("\\"));
      if (idx < 0) return null;
      var parent = str.slice(0, idx);
      if (/^[A-Za-z]:$/.test(parent)) return parent + "\\";
      if (parent === "") return "/";
      return parent;
    }

    // 通用目录选择器：listFn(path) 返回 {ok, path, entries:[{name,type,path}]}。
    // resetKey 变化（如远程切换连接）时从根目录重新加载。
    function DirPicker(props) {
      var t = useT();
      var [path, setPath] = React.useState("");
      var [entries, setEntries] = React.useState([]);
      var [err, setErr] = React.useState(null);
      var [loading, setLoading] = React.useState(false);

      var listFnRef = React.useRef(props.listFn);
      listFnRef.current = props.listFn;

      function load(p) {
        setLoading(true); setErr(null);
        listFnRef.current(p).then(function (r) {
          setLoading(false);
          if (r && r.ok) { setEntries(r.entries || []); setPath(r.path || p || ""); }
          else setErr((r && r.error) || t("common.errList"));
        });
      }
      React.useEffect(function () { load(undefined); }, [props.resetKey]);

      function enterDir(e) { load(e.path); }
      function goUp() {
        var up = parentOf(path);
        if (up !== null) load(up);
      }

      // 打开按钮：按输入框路径加载该路径下的文件树。空路径时打开主目录。
      function open() {
        load(path || undefined);
      }

      // 路径栏：输入框（回车导航）+ 打开按钮（紧挨在右侧）+ 上级
      return h("div", null,
        h("div", { className: "rssh-pathbar" },
          h("input", { className: "rssh-input", value: path,
            onChange: function (e) { setPath(e.target.value); },
            onKeyDown: function (e) { if (e.key === "Enter") { e.preventDefault(); open(); } },
            placeholder: props.placeholder || t("picker.dir") }),
          h("button", { className: "rssh-btn", onClick: open, disabled: loading }, t("common.open")),
          h("button", { className: "rssh-btn", onClick: goUp }, t("common.up"))
        ),
        loading ? h("div", { className: "rssh-muted" }, t("common.loading")) : null,
        err ? h("div", { className: "rssh-err" }, err) : null,
        // 当前路径下的文件树（仅目录可进入）
        h("div", { className: "rssh-pick-tree" },
          (entries.filter(function (e) { return e.type === "directory"; })).length === 0 && !loading
            ? h("div", { className: "rssh-pick-empty" }, t("common.noEntries"))
            : entries.filter(function (e) { return e.type === "directory"; }).map(function (e) {
              return h("div", { key: e.path || e.name, className: "rssh-tree-item", onClick: function () { enterDir(e); } },
                h("span", { className: "rssh-tree-dir" }, "📁 " + e.name));
            })
        ),
        h("div", { className: "rssh-actions", style: { marginTop: 8 } },
          h("button", { className: "rssh-btn", disabled: !path || props.disabled, onClick: function () { props.onChoose(path); } }, t("picker.choose"))
        )
      );
    }

    function RemoteWorkspaceFlow(props) {
      var t = useT();
      var [mode, setMode] = React.useState("local");
      var profiles = useProfiles(props.open);
      var [profileId, setProfileId] = React.useState("");
      var [creating, setCreating] = React.useState(false);

      // 每次打开流程时重置为「本地目录」起始界面。
      React.useEffect(function () {
        if (props.open) { setMode("local"); setProfileId(""); }
      }, [props.open]);

      if (!props.open) return null;

      function chooseLocal(p) { props.onPicked(p); }

      function chooseRemote(remotePath) {
        setCreating(true);
        api("createRemoteWorkspace", { profileId: profileId, remotePath: remotePath }).then(function (r) {
          setCreating(false);
          if (r && r.ok && r.mirrorPath) props.onPicked(r.mirrorPath);
          else props.onError((r && r.error) || t("flow.errCreate"));
        });
      }

      var canClose = !creating && !props.busy;
      var isRemote = mode === "remote";

      // 统一弹窗：上方本地/远程分段切换 → 远程时显示连接选择 → 路径栏（浏览按钮紧挨右侧）→ 文件树
      return h(Modal, { open: true, onClose: function () { if (canClose) props.onCancel(); }, title: t("flow.addWsTitle"), closeLabel: t("common.close"), className: "rssh-flow-dialog" },
        h("div", { style: { padding: 8 } },
          creating || props.busy ? h("div", { className: "rssh-muted" }, t("common.processing")) : null,
          // 分段切换：本地 / 远程
          h("div", { className: "rssh-seg" },
            h("button", { className: "rssh-seg-btn" + (isRemote ? "" : " active"), onClick: function () { setMode("local"); }, disabled: !!props.busy || creating }, t("flow.localSeg")),
            h("button", { className: "rssh-seg-btn" + (isRemote ? " active" : ""), onClick: function () { setMode("remote"); }, disabled: !!props.busy || creating }, t("flow.remoteSeg"))
          ),
          // 远程模式：连接配置选择
          isRemote ? h("div", { className: "rssh-row" },
            h("span", { className: "rssh-label" }, t("common.profile")),
            h("select", { className: "rssh-select", value: profileId, onChange: function (e) { setProfileId(e.target.value); }, disabled: creating },
              h("option", { value: "" }, t("common.selectProfile")),
              profiles.map(function (p) { return h("option", { key: p.id, value: p.id }, p.name); })
            )
          ) : null,
          // 目录选择器：远程需选好连接后才显示
          isRemote
            ? (profileId ? h(DirPicker, { resetKey: profileId, placeholder: t("flow.remoteDir"), listFn: function (p) { return remoteListFn(profileId, p); }, onChoose: chooseRemote, disabled: creating })
               : h("div", { className: "rssh-pick-empty" }, t("common.selectProfile")))
            : h(DirPicker, { resetKey: "local", placeholder: t("flow.localDir"), listFn: function (p) { return localListFn(props.workspaces, p); }, onChoose: chooseLocal })
        )
      );
    }

    // ======================================================================
    // 设置页小节（连接配置管理）
    // ======================================================================
    function SettingsSection(props) {
      var t = useT();
      var [profiles, setProfiles] = React.useState([]);
      var [form, setForm] = React.useState({ name: "", host: "", port: "22", user: "", authMethod: "key", keyPath: "", password: "", remoteRoot: "~", proxyJump: "" });
      var [result, setResult] = React.useState(null);
      var [busy, setBusy] = React.useState(false);
      var [importDlg, setImportDlg] = React.useState(null);
      var set = function (k, v) { setForm(function (f) { var n = {}; for (var key in f) n[key] = f[key]; n[k] = v; return n; }); };

      function reload() { api("listProfiles").then(function (r) { if (r && r.ok) setProfiles(r.profiles || []); }); }
      React.useEffect(reload, []);

      function save() {
        setBusy(true); setResult(null);
        api("saveProfile", Object.assign({}, form, { port: parseInt(form.port, 10) || 22 })).then(function (r) {
          setBusy(false);
          if (r && r.ok) {
            setProfiles(r.profiles || []);
            setForm({ name: "", host: "", port: "22", user: "", authMethod: "key", keyPath: "", password: "", remoteRoot: "~", proxyJump: "" });
            setResult({ ok: true, msg: t("settings.saved") });
          } else setResult({ ok: false, msg: (r && r.error) || t("settings.errSave") });
        });
      }
      function test(p) {
        setBusy(true); setResult(null);
        api("testConnection", { id: p.id }).then(function (r) {
          setBusy(false);
          if (r && r.ok) setResult({ ok: true, msg: t("settings.connOk") + "\n" + (r.stdout || "") });
          else setResult({ ok: false, msg: t("settings.connFail") + ((r && r.error) || (r && r.stderr) || "") });
        });
      }
      function del(p) {
        api("deleteProfile", { id: p.id }).then(function (r) { if (r && r.ok) { setProfiles(r.profiles || []); } });
      }

      function openImport() {
        setImportDlg({ loading: true, hosts: [], selected: {} });
        api("listSshConfigHosts").then(function (r) {
          if (r && r.ok) {
            var hosts = r.hosts || [];
            var sel = {};
            hosts.forEach(function (h) { sel[h.name + "|" + h.hostName] = true; });
            setImportDlg({ loading: false, hosts: hosts, selected: sel });
          } else {
            setImportDlg({ loading: false, hosts: [], selected: {}, error: (r && r.error) || t("settings.noneFound") });
          }
        });
      }
      function toggleImport(key) {
        setImportDlg(function (d) {
          var sel = {}; for (var k in d.selected) sel[k] = d.selected[k];
          sel[key] = !sel[key];
          return Object.assign({}, d, { selected: sel });
        });
      }
      function doImport() {
        if (!importDlg) return;
        var picked = importDlg.hosts.filter(function (h) { return importDlg.selected[h.name + "|" + h.hostName]; });
        setBusy(true);
        var i = 0;
        function next() {
          if (i >= picked.length) {
            setBusy(false); setImportDlg(null);
            setResult({ ok: true, msg: t("settings.imported").replace("{n}", String(picked.length)) });
            reload();
            return;
          }
          var h = picked[i++];
          api("saveProfile", {
            name: h.name, host: h.hostName, port: h.port || 22, user: h.user || "",
            authMethod: "key", keyPath: h.identityFile || "", password: "", remoteRoot: "~", proxyJump: h.proxyJump || ""
          }).then(next);
        }
        next();
      }

      return h("div", null,
        h("p", { className: "rssh-muted" }, t("settings.desc")),
        profiles.map(function (p) {
          return h("div", { key: p.id, className: "rssh-card" },
            h("div", { className: "rssh-title" }, p.name),
            h("div", { className: "rssh-sub" }, (p.user || "") + "@" + (p.host || "") + ":" + (p.port || 22) + "  [" + (p.authMethod || "key") + "]"),
            h("div", { className: "rssh-actions" },
              h("button", { className: "rssh-btn", onClick: function () { test(p); }, disabled: busy }, t("settings.test")),
              h("button", { className: "rssh-btn", onClick: function () { del(p); } }, t("common.delete"))
            )
          );
        }),
        profiles.length === 0 ? h("div", { className: "rssh-empty" }, t("settings.empty")) : null,
        h("div", { className: "rssh-card" },
          h("div", { className: "rssh-title" }, t("settings.add")),
          Field({ label: t("settings.name"), value: form.name, onChange: function (v) { set("name", v); }, placeholder: t("settings.namePlaceholder") }),
          Field({ label: t("settings.host"), value: form.host, onChange: function (v) { set("host", v); }, placeholder: t("settings.hostPlaceholder") }),
          Field({ label: t("settings.port"), value: form.port, onChange: function (v) { set("port", v); } }),
          Field({ label: t("settings.user"), value: form.user, onChange: function (v) { set("user", v); }, placeholder: t("settings.userPlaceholder") }),
          h("div", { className: "rssh-row" },
            h("span", { className: "rssh-label" }, t("settings.auth")),
            h("select", { className: "rssh-select", value: form.authMethod, onChange: function (e) { set("authMethod", e.target.value); } },
              h("option", { value: "key" }, t("settings.key")),
              h("option", { value: "password" }, t("settings.password"))
            )
          ),
          form.authMethod === "key" ? Field({ label: t("settings.keyPath"), value: form.keyPath, onChange: function (v) { set("keyPath", v); }, placeholder: t("settings.keyPathPlaceholder") }) : null,
          form.authMethod === "password" ? Field({ label: t("settings.passwordField"), type: "password", value: form.password, onChange: function (v) { set("password", v); } }) : null,
          Field({ label: t("settings.remoteRoot"), value: form.remoteRoot, onChange: function (v) { set("remoteRoot", v); }, placeholder: "~/project" }),
          Field({ label: t("settings.proxyJump"), value: form.proxyJump, onChange: function (v) { set("proxyJump", v); }, placeholder: "bastion.example.com" }),
          h("div", { className: "rssh-actions" },
            h("button", { className: "rssh-btn", onClick: save, disabled: busy }, busy ? t("common.processing") : t("common.save")),
            h("button", { className: "rssh-btn", onClick: openImport, disabled: busy }, t("settings.importSshConfig"))
          )
        ),
        result ? h("div", { className: result.ok ? "rssh-ok" : "rssh-err", style: { whiteSpace: "pre-wrap", marginTop: 6 } }, result.msg) : null,
        importDlg ? h(Modal, { open: true, onClose: function () { if (!busy) setImportDlg(null); }, title: t("settings.importTitle"), closeLabel: t("common.close") },
          importDlg.loading ? h("div", { className: "rssh-muted" }, t("common.loading")) :
          importDlg.error ? h("div", { className: "rssh-err" }, importDlg.error) :
          (importDlg.hosts.length === 0 ? h("div", { className: "rssh-muted" }, t("settings.noneFound")) :
            h("div", null,
              importDlg.hosts.map(function (hh) {
                var key = hh.name + "|" + hh.hostName;
                return h("label", { key: key, className: "rssh-tree-item", style: { cursor: "pointer" } },
                  h("input", { type: "checkbox", checked: !!importDlg.selected[key], onChange: function () { toggleImport(key); } }),
                  h("span", { className: "rssh-tree-dir" }, hh.name),
                  h("span", { className: "rssh-sub" }, (hh.user || "?") + "@" + hh.hostName + ":" + (hh.port || 22) + (hh.proxyJump ? "  → " + hh.proxyJump : ""))
                );
              }),
              h("div", { className: "rssh-actions", style: { marginTop: 8 } },
                h("button", { className: "rssh-btn", onClick: doImport, disabled: busy }, busy ? t("common.processing") : t("common.save")),
                h("button", { className: "rssh-btn", onClick: function () { setImportDlg(null); }, disabled: busy }, t("common.close"))
              )
            )
          )
        ) : null
      );
    }

    // ======================================================================
    // apply
    // ======================================================================
    function apply(ctx) {
      var betterSidebar = ctx.betterSidebar;
      var slots = ctx.slots;
      var locale = ctx.locale;

      // 注册中英文词典并绑定当前语言；locale 切换时 i18n.subscribe 触发组件重渲染。
      if (locale) {
        ctx.effect(function () { return locale.register(NS, { zh: zh, en: en }); }, "dsh-remote-ssh: dictionaries");
        i18n.t = locale.bind(NS);
        i18n.subscribe = function (cb) { return locale.subscribe(cb); };
        i18n.getSnapshot = function () { return locale.getSnapshot(); };
      }

      ctx.effect(function () {
        var el = document.createElement("style");
        el.textContent = CSS;
        document.head.appendChild(el);
        return function () { if (el.parentNode) el.parentNode.removeChild(el); };
      });

      if (betterSidebar) {
        ctx.effect(function () {
          return betterSidebar.registerTab({
            id: "remssh:files",
            title: function () { return i18n.t("tabs.files"); },
            order: 90,
            single: true,
            icon: function () { return h("span", null, "🗂️"); },
            component: function (props) {
              var sid = props && props.scope ? props.scope.sessionId : null;
              return h(FilesTab, { key: "files:" + (sid || "global"), sessionId: sid, betterSidebar: props && props.ctx ? props.ctx.betterSidebar : null });
            }
          });
        });
        // 远程文件编辑器页签（隐藏页签，仅由文件树点击打开，每个远程文件单开一栏）。
        ctx.effect(function () {
          return betterSidebar.registerTab({
            id: "remssh:editor",
            title: function () { return i18n.t("tabs.files"); },
            hidden: true,
            dedupeKey: function (tab) { return (tab && tab.meta && tab.meta.profileId || "") + "\u0000" + (tab && tab.path || ""); },
            icon: function () { return h("span", null, "📄"); },
            component: function (props) {
              return h(RemoteEditor, { tab: props && props.tab, ctx: props && props.ctx, scope: props && props.scope });
            }
          });
        });
        ctx.effect(function () {
          return betterSidebar.registerTab({
            id: "remssh:term",
            title: function () { return i18n.t("tabs.term"); },
            order: 91,
            single: true,
            icon: function () { return h("span", null, "💻"); },
            component: function (props) {
              var sid = props && props.scope ? props.scope.sessionId : null;
              return h(TerminalTab, { key: "term:" + (sid || "global"), sessionId: sid });
            }
          });
        });
      }

      if (slots) {
        slots.inject("settings.section", function () {
          return slots.register({
            name: "settings.section",
            id: "remote-ssh",
            order: 200,
            label: function () { return i18n.t("settings.nav"); },
            locale: NS
          }, SettingsSection);
        });

        // 接管原生「添加工作区」流程：用明显更低的优先级覆盖内置的本地目录选择器，
        // 弹窗内提供「本地目录（DSH browse）/ 远程目录（SSH）」两种浏览。
        var flowInject = function () { return { workspaces: ctx.get("workspaces") }; };
        ctx.effect(function () {
          return slots.inject("conversation.hero.workspace.directoryFlow", function () {
            return slots.register({ name: "conversation.hero.workspace.directoryFlow", priority: -100, inject: flowInject }, RemoteWorkspaceFlow);
          });
        });
        ctx.effect(function () {
          return slots.inject("sidebar.workspaces.directoryFlow", function () {
            return slots.register({ name: "sidebar.workspaces.directoryFlow", priority: -100, inject: flowInject }, RemoteWorkspaceFlow);
          });
        });
      }
    }

    exports.apply = apply;
    exports.inject = ["betterSidebar", "slots", "locale"];
    return module.exports;
  }
});
