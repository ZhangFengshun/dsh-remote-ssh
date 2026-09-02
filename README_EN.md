# @zhangfengshun/dsh-remote-ssh

English | [中文](./README.md)

A **DSH** plugin like **VSCode Remote-SSH**: connect to remote HPC / servers via SSH, and directly operate remote files and terminals within DSH's built-in **Files** and **Terminal** sidebar tabs.

## Features

| Feature | Description |
| --- | --- |
| 🔌 SSH Connection | Key / password auth, ProxyJump bastion, one-click import from `~/.ssh/config` |
| 📂 Remote Files | Built-in **Files** tab reads/writes remote files directly via SSH — no sync needed |
| 💻 Remote Terminal | Built-in **Terminal** tab auto-detects remote workspaces, opens SSH interactive shell |
| 🌐 Remote Workspace | Select a remote directory to create a native workspace, one-click enter |
| 🤖 Model Tools | 12 `remote_ssh_*` tools, session-aware with auto-filled connection params |

## Installation

```bash
dsh plugin --profile <name> add @zhangfengshun/dsh-remote-ssh@2.3.0
```

> **Restart DSH** after installation. `@zhangfengshun/dsh-remote-ssh` must come **after** `dsh-better-sidebar` in the bundles list.

## Usage

1. **Settings → 🖥️ Remote SSH** → Add a connection (host/port/user/key) → Click "Test Connection"
2. **Add Workspace** → Choose "Select Remote Directory…" → Pick a connection → Browse and select
3. Open the built-in **Files** tab → Remote files shown directly, edits save back to remote
4. Open the built-in **Terminal** tab → Auto SSH to remote host (key auth only)

## Model Tools

| Tool | Purpose |
| --- | --- |
| `remote_ssh_profiles` | List saved connections + current session's remote workspace context |
| `remote_ssh_exec` | Execute remote command |
| `remote_ssh_ls` | List remote directory |
| `remote_ssh_cat` | Read remote file |
| `remote_ssh_write` | Write remote file |
| `remote_ssh_grep` | Search remote file contents |
| `remote_ssh_glob` | Find remote files by glob |
| `remote_ssh_mkdir` | Create remote directory |
| `remote_ssh_delete` | Delete remote file/directory |
| `remote_ssh_move` | Move/rename |
| `remote_ssh_sync` | Sync remote to local mirror |
| `remote_ssh_push` | Push local mirror back to remote |

In a remote-workspace session, `profileId` and other connection params can be omitted.

## How It Works

The plugin registers 4 exact routes (`/sidebar/api/fs.tree`, `fs.read`, `fs.write`, `fs.search`) that intercept better-sidebar's prefix route. When the session cwd contains `.remote-ssh.json`, requests go through SSH; otherwise local fs. The client sees local mirror paths — the Host transparently translates them to remote paths.

A shell wrapper (`~/.dsh/remote-ssh/dsh-remote-shell[.cmd]`) detects the workspace's `.remote-ssh.json` and auto-launches `ssh -tt`, making the built-in **Terminal** tab transparently connect to remote.

## Caching & Consistency

Remote reads and directory listings are cached host-side (LRU 32/64 entries, TTL 5s): re-opening or switching back to a tab within the TTL costs 0 network round-trips; after expiry a lightweight mtime+size revalidation runs first, and unchanged files are served without re-transfer. Write, delete, move, mkdir, upload, push (syncUp), remote exec and git-panel operations automatically invalidate the affected cache entries.

Known limitations:

- Files changed from the integrated terminal (`ssh -tt`) or by other remote processes rely on TTL + revalidation and may be stale for up to **5 seconds**;
- The pooled `/sidebar/file` download path has an effective limit of ≈**6.29MB**; larger files automatically fall back to a one-shot connection download (succeeds, with one extra reconnect);
- Binary content masquerading with a text extension costs one extra base64 fallback round-trip (results are still correct).

## ❤️ Happy Qixi

This project is a Qixi Festival gift for **zhangyi**.

May it connect us as closely as it connects to distant supercomputers. Happy Qixi ❤️

—— August 18, 2026

## License

[MIT](./LICENSE)
