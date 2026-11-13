# Vibex PCA release notes

Each version that goes on the update feed, newest first. This file is not in the app: the installer packs only `dist/` and `package.json`.

## 0.9.4

The first version from the public repository. It holds all of 0.9.3, which was built and never went on the feed, so a
person who has 0.9.2 gets both lists.

What changes for a person, compared with 0.9.3:

- A new project opens as a chat, full width. The chat layout keeps the column widths that the person set.
- A chat in a server project runs Claude Code on the team server, and asks the server whether the folder is trusted.
- A file sent in a server chat goes to the team's file store before the message. A refused login shows the login's own words.
- A failed or hung update waits for the person's own check, and does not try again by itself.
- Windows: on the first start of a new install, Claude Code gets the key of the Vibex tools at the first try. Before, it could be refused in the first seconds after the start.

Nothing changes for a person in these: the addresses of the team's servers now come into the app from a file at build time,
and the memory criterion of the proof is measured as private memory.

## 0.9.3 (built on the owner's build host)

The first version built with `scripts/release.sh --fence`, because GitHub-hosted jobs were refused at that time.
It goes on the feed only after a hand test on a Windows PC (`--publish-kept`).

What changes for a person, compared with 0.9.2:

- A key file saved as `$HOME\.ssh\...`, `${HOME}\...`, `$env:USERPROFILE\...` or `%USERPROFILE%\...` works on Windows (PR #67).
- A server folder that does not exist says which folder, and what to do next, in both tabs (PR #67).
- A saved server password or key passphrase is used only after Windows Hello confirms it (PR #68).
- Claude jobs on a server keep their token after a restart (PR #70).
- A page that does not load shows plain words and Try Again, and the address bar still says why (PRs #71 and #76).
- Close, quit and update ask first only when work runs (PR #72).

Not in 0.9.3: the updater change of PR #69. It comes in a later version.
