# Vibex PCA (Windows and Linux)

Vibex PCA is the Windows and Linux edition of Vibex. It is one window
with three columns: Claude on the left (a native chat, or Claude Code in a terminal tab), a side browser in the middle, and a command terminal on the right. Around them are
the project rail, the activity bar and the sections the macOS Vibex has: Files and Git, Agents, Notes, Skills, MCP servers, Run,
Servers (ssh logins, Claude on a server, port forwards), Setup and Usage. Claude Code drives the app through the `vibex` MCP server.

Each person signs in to Claude Code with their own subscription. The app has no shared login and keeps none.

## What the PCA edition adds

All of it waits for a click. Nothing changes a person's Claude settings or skills by itself.

- **PCA server.** While no saved server is the PCA host, the Servers section offers a profile named "PCA" (port 22, Claude allowed,
  ask before each change). The person types their own user name. No user name, key or password is shipped.
- **PCA skills.** Setup has a "PCA skills" row. Install copies the pack from `pca/skills/` into the personal Claude skills folder.
  A skill that exists is left as it is, and a second click changes nothing.
- **Managed settings.** `pca/managed-settings.json` is a sample with safe defaults; `pca/README.md` explains each key. Setup shows
  how an administrator installs it. The app never installs it, because that needs administrator rights.

## Install

Windows: follow [INSTALL-WINDOWS.md](INSTALL-WINDOWS.md) (a one-page guide for a person who is not an engineer).
Linux: install the `.deb` (`sudo apt install ./Vibex-PCA-<version>-linux-amd64.deb`) or run the `.AppImage`. Git, OpenSSH and Claude Code
must be on the computer; the Setup tab checks them and shows the next step.

The installers of a release are on the update feed: `scripts/release.sh` (or `--publish-kept`) prints the link for a hand install. After a
hosted build, a copy is on the draft GitHub Release of the tag `vibex-pca-v<version>`; after a build on the owner's own build host, the copy is on the owner's Mac. The person who manages the team hands them out. A run of
the workflow keeps no installer as a run artifact, because anyone can download the artifacts of a public repository.

The first PC of a kind: [WINDOWS-FIRST-RUN.md](WINDOWS-FIRST-RUN.md), a 15-minute check of what no test can see.

## Updates

An AppImage and an NSIS install update themselves from a fixed address (`publish` in `electron-builder.yml`). They look every 6 hours and
at Help, Check for Updates…. A new version downloads by itself, and a "Restart to Update" button shows in the title bar. If the person never
presses it, the update installs at the next quit. On Windows the install is silent and per user: no wizard, no UAC question, and it starts the
app again after a restart. A `.deb` does not update itself, and Setup says so: install each newer `.deb` by hand, or use the AppImage, which
updates itself. A release reaches the address only by the owner's `scripts/release.sh <version>` or `scripts/release.sh --publish-kept <version>`; no
workflow does it.

## What is left out

- **Simulator** (the iOS Simulator column): macOS only.
- **Design** (the design view): not ported.
- **`vibex_farm`** (the farm report tool of macOS Vibex): not ported. It is not in the tool list here.
- Also not here: the graph view of Notes, the skills marketplace (needs the network), and code signing.
- Skills that need a team's own rules: not written, because no public document holds such rules (see `pca/README.md`).

## What is unproven

- The suite runs on Linux in a container on a hosted runner (`.github/workflows/vibex-pca-fence.yml`), from source and on packages. The Windows paths run
  only in `.github/workflows/vibex-pca.yml`, on GitHub's runners, and as logic in `tests/windows-first.spec.ts`. No person has run this
  version on a Windows PC yet; [WINDOWS-FIRST-RUN.md](WINDOWS-FIRST-RUN.md) lists what to look at.
- The installers are not code signed. Windows SmartScreen warns on the first start, and Smart App Control blocks them; the install guide has both.
- The Claude Code keys in the managed settings sample need a check against the current Claude Code documentation (see `pca/README.md`).
- OpenSSH older than 8.4 (the one inside Windows 10 is 8.1) has no `SSH_ASKPASS_REQUIRE`; saved passwords are not used there (see Passwords below).
- Start time and memory on a team computer are not measured.
- A real PCA server login has not been tried; the tests use a made-up ssh server on 127.0.0.1.
- The native chat has not met a real Claude Code: the tests use `tests/fake-claude.cjs`, written from the Swift parser, and check the real program's `--help` only. See Native Claude chat.

History: the first build, its hypothesis and its kill criteria are in [PROOF.md](PROOF.md).
Icons are Untitled UI (the same names as `../scripts/icons.txt`), generated at build time into `.generated/` and never committed
(their licence forbids redistribution). Fonts are Google Sans from `../Vibex/Resources/Fonts` (OFL).
The macOS Vibex app (Swift, `../Vibex`) is not changed.

## Site values

The team server address, the login name, the host key, the upload page and the update feed address are not in the source.
`src/main/site.ts` holds made-up example values, and `site.example.json` shows the shape of the real file.
A release build (`build.mjs --release`) reads the real values from `site.local.json`. Git never holds that file.
`VIBEX_PCA_SITE_FILE` can name another file. A test build and a development run keep the example values.
In CI, a tag build reads the values from the repository secret `VIBEX_PCA_SITE`.

## Run and test

```
npm ci
npm start            # build and open the app
npm test             # build and run the Playwright-for-Electron checks and the unit tests
npm run dist:win     # NSIS installer (on Windows)
npm run dist:linux   # AppImage and .deb (on Linux)
```

CI: `.github/workflows/vibex-pca.yml` first builds the NSIS installer, the AppImage and the `.deb` on `windows-latest` and `ubuntu-latest`
and keeps them, with `latest.yml`, in the cache of the run (not a run artifact). A second job installs them and runs the tests, and a red
test cannot take them back. On a tag, a third job puts them on a draft GitHub Release of the tag; it alone holds a write token, and it runs
no code of the repo. It starts on a pull request into `main` and on a tag `vibex-pca-v*`. A tag build reads the site values from the repository secret
`VIBEX_PCA_SITE`. All jobs run on GitHub-hosted runners. Nothing goes to the update address. The test reports are run artifacts for 3 days.

The fence (`vibex-pca-fence.yml`) is the Linux suite in a container on a hosted runner. It runs the suite from source, then builds the release package with its fuses on for `tests/release-gate.spec.ts`,
installs the `.deb` for the same test, and builds the proof package for `tests/package-smoke.spec.ts`.

## Layout

| File | What it does |
|---|---|
| `src/main/main.ts` | window, menu, IPC (accepted only from the app window), one browser and one tab set per project |
| `src/main/projects.ts` | the open projects, the recent folders, `<userData>/projects.json`, which project a tool call is for |
| `src/main/terminals.ts` | PTYs (node-pty, its own conpty.dll on Windows); each `terminal_run` is one command in a tab of its own, and nothing is typed into a shell |
| `src/main/windowsPath.ts` | the PATH from the registry at each Setup check and each new tab, so an install needs no restart |
| `src/main/faultGuard.ts` | a fault in the main process goes to `<userData>/vibex-errors.log` and one plain line, never to a box |
| `src/main/servers.ts` | ssh profiles from `<userData>/servers.json`, validated, run with system OpenSSH; the script on a server |
| `src/main/serverHub.ts` | a server project's tabs, token, commands, forwards and questions |
| `src/main/askpass.ts`, `askpassHelper.ts`, `native/askpass-win/` | ssh's prompts through SSH_ASKPASS; on Windows a native helper |
| `src/main/serverSecrets.ts` | saved passwords and passphrases, encrypted by safeStorage |
| `src/main/serverQuestions.ts` | the hold before a command, and one question on screen at a time |
| `src/main/serverPorts.ts` | port forwards and port detection |
| `src/main/serverTools.ts` | what Claude on a server may call, `server_list`, `server_connect` |
| `src/main/chat.ts` | the native chat tab: IPC, the check of each answer, the Inbox line |
| `src/main/chatModel.ts`, `chatEvents.ts`, `chatProcess.ts`, `chatTrust.ts`, `chatGate.ts` | one chat with no Electron in it: the session, the stream format, the program, trust, who may answer |
| `src/renderer/chat.ts`, `chatText.ts` | the chat in the column; the words of its cards and menus |
| `src/main/browser.ts` | side browser (WebContentsView) driven through the Chrome DevTools Protocol |
| `src/main/pageScripts.ts` | snapshot and ref actions, copied unchanged from `Vibex/Browser/Automation/SnapshotScript.swift` |
| `src/main/mcp.ts` | MCP server on 127.0.0.1 (default port 5150): bearer token, Host and Origin checks |
| `src/main/token.ts` | MCP key kept encrypted by the OS store (DPAPI, Keychain, libsecret), else in memory only |
| `src/renderer/frame.ts` | project rail, activity bar, sidebars, columns, welcome view |
| `src/renderer/renderer.ts` | xterm.js tabs and the address bar of the project on screen |

## Projects

One window holds all open projects; the rail picks the one on screen, as in macOS Vibex. macOS Vibex keeps one
native window per project because of AppKit; here one window is enough, so a switch costs no new renderer.

- A project is a folder. Its id is a hash of the real path.
- A project's Claude and terminal tabs start in its folder when it is first shown, so a restart with 6 saved
  projects starts one set of tabs, not 6. Its browser view starts with its first page.
- Panes, sidebar and column widths are saved per project; the rail and the sidebar width are for all projects.

A tool call acts on one project, chosen in this order: the `project_path` argument, then the `X-Vibex-Window`
header (Claude Code sends the `VIBEX_WINDOW` of the tab it started in). Anything else is refused and nothing acts,
also with one project open. macOS Vibex also matches the caller's process and folder; that needs a process scan per
platform and is not here yet. So a Claude outside a Vibex tab passes `project_path`, and `cd ../other && claude` in a
tab still acts on the tab's project. With several projects open, each result names the project that acted, so that
shows. A tool can add a project to the rail; it never changes the screen or the keyboard.

### Server projects

A tile can be a folder on a saved server: one tab with Claude on the server in that folder and one with a shell there. The
picker lists the folders in the login home, or takes a typed `~/...` or absolute path. Only a person opens one; no tool
can. A server that does not allow Claude asks first (Allow and Open), as in macOS Vibex.

Claude there has the Vibex tools, as in macOS (`Servers/CloudProject.swift`): each tab's ssh holds a reverse tunnel to the
MCP server here, with a token for this project only. The token is in that ssh's environment and goes to the server as
`LC_VIBEX_MCP_TOKEN` (`SendEnv`; a default sshd accepts `LC_*`). Claude gets `--mcp-config` with a reference to that variable,
and nothing is written to a file on the server. The token ends when the project closes. It opens only the tools in
`src/main/serverTools.ts`: never a tool that runs on this computer, opens another project or reads a path here. So
`terminal_run` runs on the server, and `local: true` is for a caller on this computer only.

`terminal_run` on a server is a login of its own in a tab the person watches, and it returns the exit code. macOS shares
one connection (ControlMaster), which Windows OpenSSH does not have; here every system does what macOS does for a server
with `confirmCommands`. A browser tool that names `http://localhost:<port>/...` forwards that server port to a free port
here. The internet and the project's forwards open; this computer's other services, its files and the LAN are refused.

## Server profiles

Add and edit servers in the app: the picker (Add Server, Edit Server) or the Servers section. The form writes
`<userData>/servers.json` (on Windows `%APPDATA%\Vibex PCA\servers.json`, on Linux `~/.config/Vibex PCA/servers.json`), mode 0600:

```json
[{ "name": "PCA", "host": "server.example", "user": "me", "port": 22, "authentication": "key", "identityFile": "~/.ssh/id_ed25519",
   "allowClaude": true, "projectPath": "~/app", "forward": [3000], "confirmCommands": false, "jump": "bastion" }]
```

A file that cannot be read is never overwritten; the form says so. A save keeps every other entry and key. Options that run
programs (`ProxyCommand`, `LocalCommand`, `KnownHostsCommand`, `PKCS11Provider`, `SecurityKeyProvider`) are refused.

- `allowClaude`: Claude may list this server, open a session to it and run in a project on it.
- `projectPath`: the folder the picker offers first. `forward`: server ports the Claude tab opens here.
- `confirmCommands`: Claude there asks before each change, and each `terminal_run`, from any caller, waits until the person
  holds Run for a second in the app. A command with a hidden character has no question: it is refused. A change of this
  field while a project is open refuses commands until the project is opened again.
- `jump`: another saved server to go through, with that server's own login.

### Passwords and passphrases

ssh asks the app, never the terminal, through `SSH_ASKPASS` with `SSH_ASKPASS_REQUIRE=force` (`src/main/askpass.ts`). Text a
server prints cannot reach this path, and the app reads nothing on the screen. On Linux and macOS the helper is the app itself, in a
mode that only asks over the socket and prints the answer. It is never a batch file: `cmd.exe` parses a batch file's command line, and
a keyboard-interactive prompt is text from the server.

On Windows the helper is a small native program, `vibex-askpass.exe` (`native/askpass-win`), in the package's resources. Electron cannot
do it there: it writes a line end to its stdout before any code of the app runs, and ssh cuts an answer at the first line end. The
workflows build it from source with a pinned mingw-w64: no binary is in the repo. It has no C runtime, needs only `kernel32` and
`shell32`, has no console, and has ASLR and DEP on. It is unsigned, like the rest of this build.

A saved secret goes to a prompt that names that server's login or key, once per ssh; a second ask comes to a sheet. With
no saved secret, a sheet asks, and Save keeps it encrypted by `safeStorage` in `server-secrets.json`. A secret belongs to one
login: an entry that later names another host, port or user does not get it. With no real system store (Linux with only
`basic_text`), nothing is saved and the app asks each time. A host key question waits for a hold; the PCA server's pinned key comes first.

The person types at ssh's prompt in the tab, saved secrets are not used, and the Servers section says so, in these cases:

- OpenSSH older than 8.4, which has no `SSH_ASKPASS_REQUIRE` (Windows 10's own is 8.1). The app measures it with `ssh -V` at start.
- On Windows, a helper that is missing from the install.
- On Windows, an install path with letters outside ASCII on a disk with no short names. Windows ssh cannot start such a path (measured on
  OpenSSH_for_Windows_9.5p2: `CreateProcessW failed error:2`), so the app gives it the short form of the path instead.

Weaker than macOS: Node gives no peer process for a socket, so the check of the process chain is not here. Each ssh has its
own ticket instead, in that ssh's environment only. See the head of `src/main/askpass.ts`. Limits, named:

- A program of the same user can read ssh's environment, and can ask with that ticket, once for the saved secret.
- On Windows such a program can also replace the unsigned helper file. The asar integrity check does not cover it.
- The helper does not check who serves the pipe: the name comes from ssh's environment, so what can change it can do the above.

Measured on OpenSSH_for_Windows_9.5p2: with its stdin left open, 1 ssh in 20 did not end after the server ended the session (19 of 20, in 2 of 2 runs); with `-n`, 20 of 20. The folder list uses `-n`. A forward and the port listing keep stdin open by design, so on Windows the app may not see such a session end until the tab or the project closes.

### Ports

The Servers section lists forwards and the ports on the server, and takes a port by number. While a tab of the project runs,
one login lists the listening ports every 5 seconds (`ss`, `netstat` or `lsof`, a fixed read-only command). A new port is
forwarded to a free port on `127.0.0.1` here; the ports at the first listing are only offered. A person's Stop keeps detection
off that port. A server with `confirmCommands` has detection off by default, and a forward waits for the hold.

That login answers from saved secrets only and never asks. With no saved password it does not run; press Detect Ports. A login
nobody watches sends no empty password (`BatchMode`), and detection stops after 3 failed logins.

## Environment variables

Development runs and the proof build only; an installed app ignores all of them (`src/main/testSwitches.ts`):
`VIBEX_MCP_PORT` (default 5150, `0` = any free port), `VIBEX_USER_DATA` (profile folder),
`VIBEX_TOKEN_STORE=memory` (do not use the OS store), `VIBEX_AGENT_COMMAND` (what the Claude tab starts; default `claude`, empty = a plain shell), `VIBEX_TEST=1`, `VIBEX_GO_*`, `VIBEX_SECRET_CRYPT`, `VIBEX_CLAUDE_BIN`, `VIBEX_CHAT_BIN` and `VIBEX_CHAT_SCRIPT` (the program of a chat, and a script as its first argument), `VIBEX_CHAT_DEFAULT` (a Claude tab is a chat, for the tests of the chat), `VIBEX_CLAUDE_MISSING`, `VIBEX_REGISTER_CLAUDE`, `VIBEX_INSTALL_COMMAND` (what the Install Claude Code button types, so a test never runs the real installer). A portable run of an installed app uses `--user-data-dir=<folder>`.

## Refresh the page scripts from the Swift source

```
node -e 'const fs=require("fs");const b=[...fs.readFileSync("../Vibex/Browser/Automation/SnapshotScript.swift","utf8").matchAll(/#"""\n([\s\S]*?)\n\s*"""#/g)].map(m=>m[1].replace(/^    /gm,""));fs.writeFileSync("src/main/pageScripts.ts","// Ported unchanged from Vibex/Browser/Automation/SnapshotScript.swift (macOS Vibex), so refs and output match.\n// Regenerate with the one-liner in electron/README.md if the Swift source changes.\n\n/** Compact accessibility-style snapshot with element refs; everything lives under window.__vibex. */\nexport const SNAPSHOT = "+JSON.stringify(b[0])+";\n\n/** Ref-based actions: window.__vibex.click / type / press / scroll / text. */\nexport const ACTIONS = "+JSON.stringify(b[1])+";\n")'
```

Licence: MIT, as upstream Vibex (`../LICENSE`, shipped in the installers as `LICENSE.vibex.txt`).

## Native Claude chat

The chat (`src/main/chat.ts`, ported from `Vibex/Claude`) is open to everyone and is not yet the default. The speech bubble at the top of the left column, Terminal, New Claude Chat (Ctrl+Shift+U) and the palette open one. The `+`, New Claude Tab (Ctrl+Shift+N) and the first tab of a project stay a terminal.

`NATIVE_CHAT_IS_DEFAULT` in `src/main/chat.ts` decides that, and it is `false` until a person has answered yes to each step of "The Claude chat" in `WINDOWS-FIRST-RUN.md` with a real `claude.exe`. Set to `true`, a new Claude tab is a chat and the menu offers New Claude Terminal Tab instead.

Each chat runs the system `claude` with `-p --input-format stream-json --output-format stream-json`, in the project folder, by its full path and an argument list. No shell and no PowerShell are involved, on any system; macOS Vibex uses a login shell. On Windows only `claude.exe` counts, as in a terminal tab. The process starts at the first message, and the next message after a crash resumes the session. It has the tab's `VIBEX_WINDOW`, so `vibex_*` and `browser_*` act on this project, with the same `X-Vibex-Window` header as a terminal tab.

The app has no sign-in and stores no key. Each person uses their own Claude Code login. With none, the chat says to open a terminal Claude tab and type `/login`. `claude -p` skips Claude Code's trust question, so a folder that never passed it starts nothing: a card sends the person to a terminal tab to answer it.

A server project keeps its terminal Claude tab, because a chat runs Claude on this computer, as in macOS Vibex (`showsServerClaudeInstead`). New Claude Chat there opens a terminal and says why.

Who answers a card: only a person, in this window. The answer goes to main with how it was given, and main checks that against the window's own input (`input-event` and `before-input-event`): a click with a mouse that moved after the card came, 500 ms or more after the card came on screen, on that button (`chatGate.ts`, `windowPointer.ts`), or a real Ctrl+Return from an empty box. Main sends back Claude Code's own input and takes none from the window. Always Allow sends back the rules Claude Code suggests and nothing else: its other suggestions can change the mode or add folders. Going to Auto needs a click or a key a moment before too. No tool has a way there, a page in the side browser has no IPC, and a script in the window makes no input event. A program that injects OS-level input is not stopped, as for Go.

Claude's text goes through `renderer/markdown.ts`, which makes no element from its text. Only an http or https link is a link, and it opens in the side browser under the rule of a terminal link.

### Ported from the Swift chat, and left out

| Swift feature | Here |
|---|---|
| Stream format, streaming text, Markdown, tables | ported |
| Tool cards, their details, a screenshot in the card | ported |
| Approval, Always Allow, question and plan cards | ported, with the check above, which Swift does not need |
| Ask, Accept edits, Plan and Auto; Shift+Tab; the fallback from Auto | ported |
| Models and effort as Claude Code names them; `/model` | ported; a name that looks like a switch is refused |
| Slash commands with descriptions, the app's own commands, argument menus | ported |
| @ files, attachments (pick, drop, paste, shrink), history on Up and Down | ported |
| Recent conversations, `/resume`, Reopen Closed Tab | ported; nothing is sent again |
| Context meter and compact, Stop and Esc, working line, Follow Along | ported |
| Trust card, needs-terminal line, waiting in the Inbox and on the rail | ported |
| Agents strip | the pills only; Review and Merge stay in the Agents section |
| Agent's own chat in its worktree | left out: an agent runs in a terminal tab, as in the Agents section here |
| "Open in Terminal" that types the command | left out: the words come from Claude's text, so the tab opens and the person types it |
| Chat tabs back at the next start | left out: an empty chat lists the last conversations, one click away |
| Duplicate Tab, dock bounce | left out: the strip here has no tab menu; a system notification says what waits |
| Folded activity, a context chip, extra arguments | left out: only Design uses them |

Unproven: no real Claude Code has run in a chat, so a change in its stream format shows only there. On Windows, nothing here has run: `claude.exe` as a child, the forward slashes in its trust file, the end of its process tree, and a press at 125 % and 150 % (`WINDOWS-FIRST-RUN.md` has the steps).

## Notes

The Notes button lists the project's notes as the macOS app does (`Vibex/Notes`): Markdown files in the Claude memory store
(`<project>/.claude/memory`, else `<CLAUDE_CONFIG_DIR or ~/.claude>/projects/<slug>/memory`) and in one notes folder inside the vault
(Obsidian). A click opens a note in a document tab: preview, editor with autosave, `[[links]]`, tags, backlinks. Search needs every word;
`#tag` matches a tag. `.vibex.json` may set `memory`, `notes` (a suggestion) and `notesExclude`, as on macOS. Names that look like credentials
are never listed, searched or edited.

`<userData>/notes.json` holds the vault and the notes folder chosen per project; the vault is `~/Documents` unless it says
`{ "vault": "C:\\Users\\me\\Vault" }`. A save writes a temp file and renames it over the note; if the file changed on disk, nothing is
written and the person picks: replace, save a copy, or load the file. Left out: the graph view (macOS `NoteGraph*`, about 900 lines), the
vault git commit after a save, server projects' notes, "Open in Obsidian". The `notes_search` MCP tool has the macOS name and inputs.
## Auto-update

A release finds a newer version on the feed. The feed address in `electron-builder.yml` is made up (`https://updates.example.invalid/vibex-pca/`); the real one is `feedUrl` in the site file (see Site values). In a build, `node scripts/update-release.mjs set-feed` writes it into `electron-builder.yml`, and `node scripts/update-release.mjs feed` prints it. It reads `latest*.yml` and `latest*.yml.sig`, checks the Ed25519 signature against `PINNED_UPDATE_PUBLIC_KEY` in `src/main/updateSign.ts`, and only then lets the library read the feed and download. If the signature is absent or wrong, nothing downloads and the Setup row says so.

That constant holds the public half of the owner's key. The private half stays on his Mac, at `~/.config/vibex-pca/update-signing.pem`. No test and no workflow reads it. A proof build takes a made-up key by the test switch `VIBEX_UPDATE_TEST_KEY`, for the update proofs. A release has no such switch.

To publish, the owner runs `scripts/release.sh <version>` from his Mac, in the right-hand Vibex terminal, on the branch `main`. Running it is his go, and it asks nothing. The owner-only settings come from the environment or from `~/.config/vibex-pca/release.env` (`VIBEX_PCA_RELEASE_ENV` can name another file): `VIBEX_PCA_FEED_SSH` (the ssh login of the feed server), `VIBEX_PCA_FEED_DIR` (the folder on that server that holds the feed folder), `VIBEX_FENCE_HOST` (the ssh login of the owner's own Linux build host, needed only for `--fence`, no default) and `VIBEX_PCA_REPO` (default `kameakihiko/vibex-pca`). In step 1 it refuses a dirty tree, another branch, a tree that differs from GitHub, a version not above the feed's, a key that is not the pinned one, a `gh` that cannot read GitHub, and a commit with no green full run. A full run is the newest run of `vibex-pca.yml` from a pull request, for this exact commit: all 4 jobs and the long steps green (`FULL_RUN_STEPS` in `scripts/update-release.mjs`). The tag job alone is not enough, because it does not run the long suites. Above the tested commit, only two kinds of commit count as the same code: a commit of an earlier release that changed the version and nothing else, and a merge with the same files as the head it merged. The script says which run it read.

It then commits and tags `vibex-pca-v<version>`. If a push fails, it undoes only its own commit, tag and two version files. The tag starts the hosted job from the tag's own copy of the workflow. It waits, and it downloads the draft release of the tag, after it checks that the release names the run it waited for. The gate in `scripts/update-release.mjs` judges the installers that ship: it takes the app out of the NSIS installer and the `.deb`, and it reads what the hosted job took out of the AppImage, marked with the AppImage's hash. It refuses a proof build, test code, a wrong fuse or feed address, a wrong asar integrity, no helper, no conpty, and another key. `scripts/publish-update.sh` then signs, and uploads to a temp folder on the feed server. It gives the installers their new names, reads each one back over HTTPS, swaps each yml and signature by a rename, and reads those back too. If a yml reads wrong, the old pair comes back.

`scripts/release.sh --dry-run <tag>` checks and signs the draft release of a tag that exists, in a temp folder. It spends no version, commit, tag or job. A run id no longer works: a run keeps no installers. A tag made before the draft releases (`vibex-pca-v0.9.1`, `vibex-pca-v0.9.2`) has no release.

`scripts/release.sh --fence <version>` builds on the owner's own Linux build host (`VIBEX_FENCE_HOST`), for when GitHub refuses hosted jobs. Step 1 is the
same, with two changes. The test proof is the newest run of `vibex-pca-fence.yml` from a pull request, for this exact commit (with the same
two kinds of commit above it). Runs from before the uploads had `continue-on-error` show red jobs from a refused artifact upload, so the
script reads two steps, not the jobs: "Run the suite and the
package checks in a container, under Xvfb" in `linux-suite`, and "Cross-build the NSIS installer and read what it holds" in
`windows-installer` (`FENCE_RUN_STEPS` in `scripts/update-release.mjs`). Each must be green. Step 1 also reads the build host over ssh
(`VIBEX_FENCE_HOST`, no default). It refuses less than 9 GB free in `/home/ci` and a container that runs there now. The
script then makes the version commit and the tag on the Mac only. It sends that exact commit with `git archive` to a new folder under
`/home/ci`. It pulls the image and checks the room again (9 GB is an estimate; the `df` lines in `build.log` measure it). In the same ssh
call as the start, it refuses a running CI container. It starts `scripts/fence-release-build.sh` detached in `electronuserland/builder:wine`,
with the rootless Docker of the user `ci`, and labels `mu-ci-runner=1` and `mu-ci-name=vibex-pca-release`: the job runner on that host then starts no job and removes no container while the build runs. It follows the log with short ssh calls. A connection that drops is asked again, up to 10
times in a row. The exit code comes from `docker inspect`, or from `/out/exit-code` if the container is gone. That
script builds Linux first (AppImage, `.deb`, `latest-linux.yml`, the gate's files), then the Windows installer with its blockmap and
`latest.yml`, and it keeps every file the feed needs. The files come back to `~/.cache/vibex-pca/releases/<version>`, with `build.log`,
`proof.txt` and the image digest. The folder on the build host, the container and the image are always removed, also after a stop or a Ctrl-C.
If the build host cannot be reached at that moment, the script prints the folder and the image to remove by hand. If the Mac run dies with no chance to clean up (power loss, kill -9), the folder /home/ci/vibex-pca-release-<version> (several GB) stays on the build host, and the container stops itself after 2 hours: remove the folder by hand, because nothing else frees it. The script checks both versions, runs the gate
and signs. It writes the SHA-512 of each yml (the judged and signed file: signing does not change it) to `fence-release.txt`. Only then
does it push the commit and the tag, so a failed build, a failed gate or a Ctrl-C before the push spends no version. The tag also starts the hosted job,
which GitHub refuses; nothing waits for it. The script stops before the upload and prints the path of the `.exe` for the hand test on a
Windows PC. After that test, `scripts/release.sh --publish-kept <version>` uploads the kept copy. It checks the key and the feed, refuses a
version that is not above the feed, needs both yml files and `fence-release.txt`, refuses a yml whose SHA-512 differs from the one
written there, and needs the tag on GitHub at the commit the copy was built from. It runs the gate again, and it uploads as step 7 and 8 of a hosted release do.

Two limits of `--fence`. The image is the floating tag `electronuserland/builder:wine`, not pinned: the test run on the hosted runner and the release build may use different images, and `fence-release.txt` records the digest of the one that built. The Linux packages from `--fence` are
checked by the gate only: no one runs them before they reach the feed.

"Nothing went to the feed" shows only for a stop before the upload. After that, the script says what the feed holds, what is left in its folder, and the command that puts it right.

What stays after a release: the installers of the last 2 versions (older ones leave, on the feed server), the folder `.previous-<version>` with the old yml pair (until the next release), and the signed copy on the Mac in `~/.cache/vibex-pca/releases/<version>` (until the next release that ends well).

### A first release: a stage note, not a second feed

The installed builds have no update key, so they take nothing from the feed. Only a PC with a hand-installed release takes updates. So the first walk reaches one PC if the owner hand-installs on one PC. That is the stage. A second feed for a test PC would need a build with another address, and then the walk would test another build than the one that ships. Follow "An update" in `WINDOWS-FIRST-RUN.md`. Hand-install on the other PCs only after that walk passes. From then on, each release reaches each PC within 6 hours, with no stage.

### A bad release

A bad release cannot go down. The script, the check in the app and the library all refuse a lower version. To go back:

1. Stop it from reaching more PCs. From the repository folder, run `electron/scripts/publish-update.sh --put-back <bad version>`. The old yml pair goes back on the feed. A PC that has downloaded the bad version already still installs it at the next quit.
2. Make the branch hold the last good code. Run `git revert <the bad commits>` on a new branch, and open a pull request into `main`.
3. Wait for the full run of that pull request to pass, then merge it.
4. Run `electron/scripts/release.sh <version above the bad one>`. This takes one more hosted job, about 30 minutes. If GitHub refuses
   hosted jobs, run `--fence <version>`, then `--publish-kept <version>` after a hand test.
5. Check one PC: open Setup and read the version.
6. If the bad version stops the app in its first 10 seconds, that PC never checks again. Install the new version on it by hand: the script prints the address.

Three kinds of build exist (`src/main/testSwitches.ts`). `npm run build` makes a test build. Each electron-builder run makes a fresh release build first, whatever `dist/` holds; that bundle has no test code. `npm run dist:proof` is for CI only.

## What a program of this user can do

Vibex PCA does not protect against a program that already runs as the same person on the same computer. Such a program can get the MCP key by running the app with `--mcp-headers` (Claude Code needs that switch, and no check can tell the two apart). It can change the app's files in a per-user install, because no code signature exists yet: asar integrity (on for Windows and macOS, and absent from Electron on Linux) checks the asar against the binary, and the program can change the binary too. It can send mouse input, so a hold on Go is no proof against it. The Go hold protects against Claude, pages and servers, not against local malware. The release build holds no test switches and no debugging port, whatever its file is called.

## Agents, Go and Inbox

Ported from `Vibex/Agents`, `Vibex/Go` and `Vibex/Inbox` (`src/main/agentsGo.ts`, `agents.ts`, `go.ts`, `goDesk.ts`, `inbox.ts`; `src/renderer/agents.ts`, `go.ts`, `inbox.ts`).

- **Agents** (sidebar section `agents`): a Claude in its own git worktree, in a new Claude tab named `<project> - <agent>`. The worktrees live in `<userData>/Agents/<project id>/`. Finish merges the branch into the project's branch and removes the worktree; Remove deletes a clean worktree. A dirty worktree stays, with a plain reason. git runs with an argument list.
- **Waiting badge and Inbox**: the app puts six Claude Code hooks in Claude's `settings.json` (marker `VIBEXPCA_HOOK_URL`; the person's own hooks stay; the first change keeps `settings.json.vibex-backup`; the Inbox switch removes them and keeps them off). A hook posts to a local address with its own random key. The rail tile counts what waits (hook questions and Go requests). `vibex_notify` adds a toast and an Inbox line.
- **Go**: `vibex_request_go` and `vibex_go_status`. The panel is a document tab. Only a hold on Go (or a click on Not now) with the mouse answers; the main process checks its own record of the window's mouse input (`input-event`), so no tool, no page and no script in the window can. Every answer is logged and signed in `<userData>/go-log.json`. A restart makes an old answer `unverified`, never a go. It does not stop a program that injects OS-level mouse input; macOS Vibex checks the process that sent the event, and Windows and Linux give no such field.
- Tests: `npm test -- tests/agents-go.spec.ts`. They set `VIBEX_GO_ASSUME_FRONT=1`, because other programs on a shared computer take the window focus; `GO_REAL_FOCUS=1` runs them with the real focus.
