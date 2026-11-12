# PCA edition files

This folder ships beside the app (electron-builder `extraResources`, folder `pca`). The app reads it; it never changes it.

- `skills/<name>/SKILL.md`: the PCA skills pack. Setup, row "PCA skills", copies it into the personal Claude skills folder (`~/.claude/skills`, or `CLAUDE_CONFIG_DIR`) when the person presses Install. A name that exists is skipped and left as it is.
- `managed-settings.json`: a sample of Claude Code managed settings. The app does not install it. An administrator does (see below).

## Skills in the pack

| Skill | What it does |
|---|---|
| `linear-end-of-session` | Writes what a session did to the Linear issue. Roles and ids only. |
| `pca-memory-and-notes` | Says where notes and memory live in Vibex and how to write facts, not chat. |

Left out on purpose: skills that need a team's own rules. No public document in this repository holds such rules, and a skill must not invent them.

## Managed settings sample

Managed settings are the highest level of Claude Code settings. A person cannot override them. JSON has no comments, so each key is explained here.

| Key | Value | Why |
|---|---|---|
| `permissions.disableBypassPermissionsMode` | `"disable"` | Turns off the mode that runs every tool without asking. Vibex also sets this key for Claude on a server (`src/main/servers.ts`). |
| `disableAutoMode` | `"disable"` | Removes auto mode, so Claude asks as it does in the default mode. Vibex also uses it for Claude on a server. |
| `permissions.deny` | The rules below | Claude's file tools cannot read these paths, and neither can the file commands Claude Code recognizes in Bash (`cat`, `head`, `tail`, `sed`, `tee`) or a redirection. Deny rules win over allow rules. |
| `forceLoginMethod` | `"claudeai"` | Allows sign-in with a claude.ai account only (not a Claude Console account). This key does not stop a shared login; the team's own rule does. |
| `env.DISABLE_TELEMETRY` | `"1"` | Turns off usage statistics. |
| `env.DISABLE_ERROR_REPORTING` | `"1"` | Turns off error reports to the vendor. |

The deny rules, by what they protect:

- `Read(**/.env)`, `Read(**/.env.*)`, `Read(**/secrets/**)`: environment files and `secrets` folders at any depth under the project. They replace the rules with `./`, which covered only the project root.
- `Read(~/.ssh/**)`: this person's ssh keys.
- `Read(~/.config/Vibex PCA/**)`, `Read(~/AppData/Roaming/Vibex PCA/**)`: the app's own profile folder on Linux and Windows. It holds saved server secrets in encrypted form.

What this does not stop, in plain words: a Bash command that reads files without naming them (`grep -r pattern .`), and any program Claude writes and runs (`python -c ...`). Only a sandbox stops those, and `sandbox` does not run on Windows, so this sample leaves it out. Treat these rules as a seatbelt, not a wall.

How sure we are: each key above was read on 2026-10-31 in Anthropic's settings reference (https://code.claude.com/docs/en/settings-reference.md) and the permissions page (https://code.claude.com/docs/en/permissions.md). No Claude Code run has loaded this file yet. After you install it, run `/status` in Claude Code to see the settings it loaded. Setup in the app does not show whether the file is installed.

## How an administrator installs the sample

Setup in the app shows the same steps for the current system. The file must be named `managed-settings.json` and placed here:

| System | Folder |
|---|---|
| Windows | `C:\Program Files\ClaudeCode\` |
| Linux | `/etc/claude-code/` |
| macOS | `/Library/Application Support/ClaudeCode/` |

1. Open a terminal as administrator (Windows: "Run as administrator"; Linux and macOS: `sudo`).
2. Create the folder if it is missing.
3. Copy `managed-settings.json` into it.
4. Start Claude Code again, and run `/status` to check that the settings loaded.

To remove it, delete the file.
