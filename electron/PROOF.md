# Vibex PCA proof build: hypothesis and kill criteria

Written 2026-10-28, before the first CI run, so that the result cannot move the goal posts.

## Hypothesis

Electron can carry the Vibex core on Windows and Linux: a terminal tab that runs `claude`, an ssh tab
to a server, a side browser that Claude drives through MCP tools, and an installer a person can run.

## What the proof includes (and only this)

| Part | Proven by |
|---|---|
| Terminal tab (PowerShell on Windows, login shell on Linux) | tests 2, 5 |
| `claude` starts in the terminal | test 6 (Claude Code 2.1.296 installed on the runner) |
| ssh tab from a server profile, reconnect with Enter | tests 7, 11 (test ssh server on 127.0.0.1, key login) |
| Side browser driven by MCP tools | tests 8, 9 (navigate, snapshot, type, click, text, screenshot) |
| MCP server: token, Host and Origin checks | tests 3, 4 |
| Installers: NSIS .exe, .deb, AppImage | CI installs the .exe and the .deb and runs all tests on the installed app |
| Desktop conventions (UX laws, Apple HIG): one primary action, errors in plain words, every command in the menu bar, system light and dark | tests 7, 10, 13, 14 |
| The macOS Vibex look: three columns (Claude, browser, terminal), Untitled UI icons, Google Sans, Vibex palette | test 15 |

Not in the proof, on purpose: the other 28 of the 36 kept MCP tools, Notes, Agents, Go gate, Skills,
Source Control, the PCA server profile, Claude sign-in, code signing, auto-update.
Each one is step 2 or 3 of the port plan.

## Kill criteria: re-decide Electron versus Tauri if any one holds

1. A check from the table above cannot pass on GitHub `windows-latest` after 3 fix rounds.
2. Time from launch to a ready window is 15 s or more on a CI runner (test 12).
3. The app uses 800 MB of memory or more with one terminal, one ssh tab and one page open (test 12). The measure is
   private memory, summed over the app's processes: the private bytes on Windows, the Private lines of `/proc` on Linux.
   A working set counts shared pages once for each process, so its sum changes with the computer; it is recorded beside
   the judged number, and it is the judged number where private memory cannot be read.
   VS Code with a terminal is about 500-800 MB, so this is the ceiling of "normal" for the team.
4. An installer is 200 MB or larger (CI step "Check installer size").
5. The PTY needs a C++ compiler on the user's machine (today: no, node-pty ships prebuilt binaries).

Tauri's advantage is size and memory. If criteria 2-4 pass, that advantage does not pay for losing
xterm.js + node-pty, Chromium DevTools for the browser tools, and Playwright for Electron.

## Windows installer, measured (fence run 41176685833, 2026-10-31)

- Criterion 4: `Vibex-PCA-0.9.0-win-x64.exe` is 123,573,648 bytes, 117.8 MB. The limit is 200 MB, so it passes with 82.2 MB left.
- It is a cross-build under Wine in `electronuserland/builder:wine`. Nothing ran it on Windows. The job reads its bytes only (`scripts/check-windows-installer.cjs`).
- The cost on the runner: the image is 6,374,557,922 bytes. With it pulled, the disk had 1,710 MB free of 15,015 MB at the lowest point. The job removes the image at its end.

## Adoption

The technical criteria above say if Electron can carry the app. They do not say if the team wants it.
That question is open. It needs a person who installs the app and uses it on real work, and no test can answer it.

## Not proven here (needs a person)

- A real Windows 11 PC: SmartScreen and Smart App Control on an unsigned installer, Windows Defender,
  a Cyrillic or Uzbek user name in the profile path, and two monitors with different scaling.
- A real Linux desktop: the AppImage needs FUSE 2 (libfuse2) on Ubuntu 24.04; the .deb does not.
- Linux keyring: on the CI runner there is no keyring, so the MCP key lives in memory for the session.
  On a desktop with GNOME Keyring or KWallet it is kept encrypted.

## Two packaged builds (security review H2, M7)
- The release build has its Electron fuses on and takes no test switch. Playwright cannot drive it. `tests/release-gate.spec.ts` starts it as a plain process, with `VIBEX_RELEASE_EXECUTABLE`.
- The proof build (`npm run dist:proof`, folder `release-proof/`) is the same package with the switches and the inspector fuse on. The full suite runs on it with `VIBEX_APP_EXECUTABLE`. It is never released.
- `GO_REAL_FOCUS=1` runs the Go checks with the real window focus. If the runner gives no focus, the run prints a warning and skips those checks.
