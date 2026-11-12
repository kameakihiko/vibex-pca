# What has been carried between Swift Vibex and Vibex PCA

Maintained by the `vibex-pca-carry` skill. Read oldest first. One line per change: carry, shared, skip or later, with why.

- Last Swift commit read: aee4d1a
- Last upstream read: 2.5.0 (99c7973)

| Date | Change | Word | Why |
|---|---|---|---|
| 2026-10-31 | Updater (Support/Updater.swift) | carry | Owner's ask. Same rules: check at start and every 6 hours, Later installs at quit, a running tab is never cut. electron-updater replaces install.sh. |
| 2026-10-31 | Simulator | skip | No iOS work in this edition. Dropped in the port plan. |
| 2026-11-05 | Updater rules (Swift #60-#63) | carry R5, others hold | A failed or hung update waits for a person's own check; feed key pinned (updateSign.ts), no network before local gates, no key acts on Try Again. Upstream 6407797 self-quit: skip, quitAndInstall already quits after agreeToQuit asks. The hold is in memory: after a restart the cached download is offered once more (a restart is a person's act). |
| 2026-11-05 | Ask before stopping work (Swift #49 A1, A2) | partial | Close project, quit and update count only busy tabs; Windows cannot tell an idle server prompt, so server and agent tabs still count as busy. Counters, remove-agent, MCP remove, root command and git-conflict sub-changes: not carried in this pass. |
| 2026-11-05 | Browser failure page (Swift #49 A3) | carry | Plain words, no origin, no history item; Try Again is a click only. |
| 2026-11-05 | Presence gate before a saved secret (Swift #51) | carry | Windows Hello helper; no Hello, Linux or a helper failure means the person types the secret; one prompt per request, closed by 40 s, a refusal ends that ssh; nothing saved means no prompt; a refused port listing waits for Detect Ports or a new connection; a jump login waits 60 s; a refused detected-port forward pauses automatic forwarding the same way; quiet logins use BatchMode when this PC cannot confirm. Two prompts at once can get DEVICE_BUSY, which ends that ssh as not confirmed. |
| 2026-11-05 | Server Claude token survives a restart (Swift #64) | carry token, ports already stable | One token per project, encrypted with safeStorage; a closed project's token does not resolve. Tokens of removed servers stay in the file; pruning is a later change. |
| 2026-11-05 | servers.json entry with no id (Swift #58) | skip, guard test | PCA servers.json has no id field and keys by name; a test proves unknown keys survive a save. |
