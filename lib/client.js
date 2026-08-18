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
      ".rssh-row{margin:6px 0}.rssh-label{color:#9aa0a6;font-size:11px;display:block;margin-bottom:2px}" +
      ".rssh-input{width:100%;box-sizing:border-box;background:#121316;color:#eee;border:1px solid #444;border-radius:4px;padding:5px 7px;margin:3px 0;font-size:12px}" +
      ".rssh-select{width:100%;box-sizing:border-box;background:#121316;color:#eee;border:1px solid #444;border-radius:4px;padding:5px 7px;margin:3px 0;font-size:12px}" +
      ".rssh-btn{background:#3a3d41;color:#eee;border:1px solid #555;border-radius:4px;padding:4px 9px;cursor:pointer;font-size:12px}" +
      ".rssh-btn:hover{background:#45494e}.rssh-btn:disabled{opacity:.5;cursor:default}" +
      ".rssh-card{padding:8px 10px;border:1px solid #333;border-radius:6px;margin:8px 0;background:#26282c}" +
      ".rssh-title{font-weight:600;font-size:13px}.rssh-sub{color:#9aa0a6;font-size:11px}" +
      ".rssh-actions{margin-top:6px;display:flex;gap:5px;flex-wrap:wrap}" +
      ".rssh-tree-item{display:flex;align-items:center;gap:5px;padding:3px 5px;cursor:pointer;border-radius:3px}" +
      ".rssh-tree-item:hover{background:#2f3237}" +
      ".rssh-tree-dir{color:#7ab0ff}.rssh-tree-file{color:#d7d7d7}" +
      ".rssh-tree-size{color:#6a7076;font-size:11px;margin-left:auto}" +
      ".rssh-pathbar{display:flex;gap:4px;align-items:center;margin:4px 0}" +
      ".rssh-pathbar .rssh-input{flex:1;margin:0}" +
      ".rssh-content{white-space:pre-wrap;font-family:Consolas,monospace;font-size:12px;background:#121316;padding:8px;border-radius:4px;margin-top:6px;max-height:400px;overflow:auto}" +
      ".rssh-terminal{background:#0d0e10;border-radius:4px;padding:6px;margin-top:8px;font-family:Consolas,monospace;font-size:12px}" +
      ".rssh-terminal-out{white-space:pre-wrap;max-height:320px;overflow:auto;min-height:120px;line-height:1.4}" +
      ".rssh-terminal-bar{display:flex;gap:5px;align-items:center;margin-bottom:4px}" +
      ".rssh-terminal-input-row{display:flex;gap:4px;margin-top:5px}.rssh-terminal-input-row .rssh-input{flex:1}" +
      ".rssh-ok{color:#4ade80}.rssh-err{color:#f87171}.rssh-muted{color:#9aa0a6;font-size:12px;padding:6px 0}" +
      ".rssh-empty{padding:12px;text-align:center;color:#9aa0a6;font-size:12px}" +
      ".rssh-flow-dialog{width:690px!important;max-width:94vw!important;min-width:460px;resize:horizontal;overflow:auto!important}" +
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
      "flow.chooseRemote": "选择远程目录…",
      "flow.backLocal": "← 选择本地目录",
      "flow.errCreate": "创建远程工作区失败"
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
      "flow.chooseRemote": "Choose remote directory…",
      "flow.backLocal": "← Choose local directory",
      "flow.errCreate": "Failed to create remote workspace"
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
    // 远程文件页签
    // ======================================================================
    function FilesTab(props) {
      var t = useT();
      var sessionId = props.sessionId;
      var [workspaces, setWorkspaces] = React.useState([]);
      var profiles = useProfiles();
      var [wsId, setWsId] = useSessionMemory(sessionId, "wsId", sel.workspaceId);
      var [profileId, setProfileId] = useSessionMemory(sessionId, "profileId", "");
      var [path, setPath] = useSessionMemory(sessionId, "path", "");
      var [entries, setEntries] = useSessionMemory(sessionId, "entries", []);
      var [err, setErr] = React.useState(null);
      var [loading, setLoading] = React.useState(false);
      var [openFile, setOpenFile] = useSessionMemory(sessionId, "openFile", null);
      var [defaultDir, setDefaultDir] = useSessionMemory(sessionId, "defaultDir", "");

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

      function openEntry(e) {
        var base = path ? (path.replace(/\/+$/, "") + "/" + e.name) : e.name;
        if (e.type === "directory") {
          setPath(base);
          load(profileId, base);
        } else {
          setOpenFile({ path: base, content: "", loading: true });
          api("readFile", { profileId: profileId, path: base }).then(function (r) {
            if (r && r.ok) setOpenFile({ path: base, content: r.content, binary: r.binary, dirty: false, loading: false });
            else setOpenFile({ path: base, content: "", error: (r && r.error) || t("files.errRead"), loading: false });
          });
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

      function saveFile() {
        if (!openFile) return;
        api("writeFile", { profileId: profileId, path: openFile.path, content: openFile.content }).then(function (r) {
          if (r && r.ok) setOpenFile(Object.assign({}, openFile, { dirty: false }));
          else setErr((r && r.error) || t("files.errSave"));
        });
      }

      return h("div", null,
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
        loading ? h("div", { className: "rssh-muted" }, t("common.loading")) : null,
        err ? h("div", { className: "rssh-err", style: { whiteSpace: "pre-wrap" } }, err) : null,
        h("div", { style: { marginTop: 6 } },
          entries.map(function (e) {
            return h("div", { key: e.name, className: "rssh-tree-item", onClick: function () { openEntry(e); } },
              h("span", { className: e.type === "directory" ? "rssh-tree-dir" : "rssh-tree-file" }, e.type === "directory" ? "📁 " + e.name : "📄 " + e.name),
              e.type === "file" ? h("span", { className: "rssh-tree-size" }, String(e.size)) : null
            );
          })
        ),
        openFile ? h("div", null,
          h("div", { className: "rssh-pathbar", style: { marginTop: 8 } },
            h("span", { className: "rssh-title", style: { flex: 1, wordBreak: "break-all" } }, openFile.path),
            h("button", { className: "rssh-btn", onClick: saveFile }, t("common.save")),
            h("button", { className: "rssh-btn", onClick: function () { setOpenFile(null); } }, t("common.close"))
          ),
          openFile.loading ? h("div", { className: "rssh-muted" }, t("files.reading")) :
          openFile.error ? h("div", { className: "rssh-err" }, openFile.error) :
          h("textarea", { className: "rssh-content", style: { width: "100%", boxSizing: "border-box", minHeight: 200, background: "#121316", color: "#eee", border: "1px solid #444" },
            value: openFile.content, onChange: function (e) { setOpenFile(Object.assign({}, openFile, { content: e.target.value, dirty: true })); } })
        ) : null
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
          h("span", { style: { flex: 1, color: status === "running" ? "#4ade80" : "#f87171" } }, t("term.title", { id: props.id }) + (status === "exited" ? t("term.exited") : "")),
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

      return h("div", { style: { border: "1px solid #333", borderRadius: 6, padding: 8, marginTop: 6 } },
        h("div", { className: "rssh-pathbar" },
          h("input", { className: "rssh-input", value: path, onChange: function (e) { setPath(e.target.value); }, placeholder: props.placeholder || t("picker.dir") }),
          h("button", { className: "rssh-btn", onClick: function () { load(path); } }, t("common.open")),
          h("button", { className: "rssh-btn", onClick: goUp }, t("common.up"))
        ),
        loading ? h("div", { className: "rssh-muted" }, t("common.loading")) : null,
        err ? h("div", { className: "rssh-err" }, err) : null,
        h("div", { style: { maxHeight: 180, overflow: "auto", marginTop: 4 } },
          entries.filter(function (e) { return e.type === "directory"; }).map(function (e) {
            return h("div", { key: e.path || e.name, className: "rssh-tree-item", onClick: function () { enterDir(e); } },
              h("span", { className: "rssh-tree-dir" }, "📁 " + e.name));
          })
        ),
        h("button", { className: "rssh-btn", style: { marginTop: 8 }, disabled: !path, onClick: function () { props.onChoose(path); } }, t("picker.choose"))
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

      if (mode === "remote") {
        return h(Modal, { open: true, onClose: function () { if (canClose) props.onCancel(); }, title: t("flow.remoteTitle"), closeLabel: t("common.close"), className: "rssh-flow-dialog" },
          h("div", { style: { padding: 8 } },
            creating || props.busy ? h("div", { className: "rssh-muted" }, t("common.processing")) : null,
            h("div", { className: "rssh-row" },
              h("span", { className: "rssh-label" }, t("common.profile")),
              h("select", { className: "rssh-select", value: profileId, onChange: function (e) { setProfileId(e.target.value); } },
                h("option", { value: "" }, t("common.selectProfile")),
                profiles.map(function (p) { return h("option", { key: p.id, value: p.id }, p.name); })
              )
            ),
            profileId ? h(DirPicker, { resetKey: profileId, placeholder: t("flow.remoteDir"), listFn: function (p) { return remoteListFn(profileId, p); }, onChoose: chooseRemote }) : null,
            h("div", { className: "rssh-actions", style: { marginTop: 8 } },
              h("button", { className: "rssh-btn", onClick: function () { setMode("local"); }, disabled: !!props.busy }, t("flow.backLocal"))
            )
          )
        );
      }

      return h(Modal, { open: true, onClose: function () { if (canClose) props.onCancel(); }, title: t("flow.localTitle"), closeLabel: t("common.close"), className: "rssh-flow-dialog" },
        h("div", { style: { padding: 8 } },
          props.busy ? h("div", { className: "rssh-muted" }, t("common.processing")) : null,
          h(DirPicker, { resetKey: "local", placeholder: t("flow.localDir"), listFn: function (p) { return localListFn(props.workspaces, p); }, onChoose: chooseLocal }),
          h("div", { className: "rssh-actions", style: { marginTop: 8 } },
            h("button", { className: "rssh-btn", onClick: function () { setMode("remote"); }, disabled: !!props.busy }, t("flow.chooseRemote"))
          )
        )
      );
    }

    // ======================================================================
    // 设置页小节（连接配置管理）
    // ======================================================================
    function SettingsSection(props) {
      var t = useT();
      var [profiles, setProfiles] = React.useState([]);
      var [form, setForm] = React.useState({ name: "", host: "", port: "22", user: "", authMethod: "key", keyPath: "", password: "", remoteRoot: "~" });
      var [result, setResult] = React.useState(null);
      var [busy, setBusy] = React.useState(false);
      var set = function (k, v) { setForm(function (f) { var n = {}; for (var key in f) n[key] = f[key]; n[k] = v; return n; }); };

      function reload() { api("listProfiles").then(function (r) { if (r && r.ok) setProfiles(r.profiles || []); }); }
      React.useEffect(reload, []);

      function save() {
        setBusy(true); setResult(null);
        api("saveProfile", Object.assign({}, form, { port: parseInt(form.port, 10) || 22 })).then(function (r) {
          setBusy(false);
          if (r && r.ok) {
            setProfiles(r.profiles || []);
            setForm({ name: "", host: "", port: "22", user: "", authMethod: "key", keyPath: "", password: "", remoteRoot: "~" });
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
          h("button", { className: "rssh-btn", onClick: save, disabled: busy }, busy ? t("common.processing") : t("common.save"))
        ),
        result ? h("div", { className: result.ok ? "rssh-ok" : "rssh-err", style: { whiteSpace: "pre-wrap", marginTop: 6 } }, result.msg) : null
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
              return h(FilesTab, { key: "files:" + (sid || "global"), sessionId: sid });
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
