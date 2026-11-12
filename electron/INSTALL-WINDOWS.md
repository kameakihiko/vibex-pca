# Install Vibex PCA on Windows

This page is for a person who is not an engineer. It takes about 15 minutes. Do the steps in order.

## What you need

- A Windows 11 computer. Windows 10 also works.
- Your own Claude subscription. Each person uses their own. Never share a login.
- The newest installer file, from the person who manages the team. Its name is like `Vibex-PCA-0.9.0-win-x64.exe`, with another version number.

## Step 1. Check Smart App Control

Smart App Control blocks a program with no paid signature, and this installer has none yet. When it is on, Windows shows no "Run anyway".

1. Press the Windows key. Type "Smart App Control". Press Enter.
2. Read the setting. If it says "Off", go to step 2.
3. If it says "On" or "Evaluation", stop. Ask the person who manages the team before you change it.

WARNING: Do not turn it off by yourself. On some Windows versions you cannot turn it on again without a new Windows install.

## Step 2. Install Git

Vibex uses Git to show what Claude changed.

1. Open https://github.com/git-for-windows/git/releases/latest in your browser.
2. Under "Assets", click the file whose name ends in "64-bit.exe". Run the file you download.
3. Click "Next" on every page until you reach "Install". Click "Install", then "Finish".

## Step 3. Install Vibex PCA

1. Double-click the installer file.
2. Windows shows a blue box: "Windows protected your PC" (this is SmartScreen). This is normal. The installer has no paid signature yet.
3. Click "More info" in that box.
4. Click "Run anyway".
5. Click "Next" on each page, then "Install", then "Finish".

If the blue box does not show, go to the next step.

## Step 4. Open Vibex PCA and check Setup

1. Open "Vibex PCA" from the Start menu.
2. Click the note at the top that says "Claude Code is missing". The Setup list opens. If there is no note, go to step 6: Claude Code is there already.
3. Read the list. A green mark means ready.

## Step 5. Install Claude Code

1. In Setup, find "Claude Code". Click "Install Claude Code".
2. Choose a folder for your work, for example a new folder in Documents. Click "Open". Vibex opens that folder as your project. If a project is open already, Windows does not ask.
3. Look at the terminal on the right. The installer runs there. Wait until it stops.
4. Click the round arrow at the top of Setup. Its name is "Check again". Claude Code now shows a version number.
5. A new Claude tab opens in the left column, as a terminal. Claude asks you to sign in there.
6. Follow the page that opens in your browser. Use your own account.

If Git or SSH shows "Not found", follow the line under it, then click the round arrow. Vibex finds a new program with no restart. If it still shows "Not found", close Vibex PCA and open it again.

## Step 6. Use the Claude chat

The left column starts with Claude in a terminal. A chat is one click away, and this edition is still testing it.

1. Click the speech bubble at the top of the left column. A chat tab opens.
2. If a card says "has not been trusted", click "Open Claude in Terminal".
3. In the terminal tab, answer the question about the folder. Choose the "Yes" line.
4. Click the chat tab. Click "Check Again".
5. Type your question in the box at the bottom. Press Enter.
6. If the chat says "not signed in", click "Open Claude in Terminal".
7. In the terminal tab, type `/login`. Press Enter. Follow the page with your own account.
8. If a blue card asks to allow something, read all of it.
9. Click "Allow" or "Don't Allow". Only your own click counts.

You can also click the three dots at the top left. Click "Terminal", then "New Claude Chat".

## Step 7. Add the PCA server (optional)

A project on a server has no chat. Claude runs in a terminal tab on the server.

1. Click "Servers" in the bar on the left.
2. Click "Add the PCA server".
3. Type your key name in the "Your key name" box. The person who manages the team gives you this name. Do not make up a name.
4. Click "Make a Key". Vibex makes the `.ssh` folder if your PC has none. If you already have an ed25519 key, click "Pick a Key…" instead.
5. Click "Copy", and send that one line to the person who manages the team. It starts with `ssh-ed25519`.
6. Click "Save". Leave the other boxes as they are.
7. Wait until the person who manages the team tells you that your key is on the server.
8. Click "Connect PCA" in the title bar, at the top right of the window.

WARNING: Send only the one line from the "Copy" button. Never send the `pca_ed25519` file with no `.pub`. It is your private key, and it stays on this PC.

If you make a key by hand in PowerShell, make the folder first, or `ssh-keygen` stops with "Saving key ... failed: No such file or directory":

1. Run `New-Item -ItemType Directory -Force "$HOME\.ssh"`.
2. Run `ssh-keygen -t ed25519 -f "$HOME\.ssh\pca_ed25519"`.

If a login needs a password:

1. Type the password in the box that Vibex shows. Do not type it in the tab.
2. Select "Save" if you want Vibex to keep it. Windows encrypts it for your account.
3. Click "OK".

If the Servers section says that ssh is too old, Windows has OpenSSH older than 8.4 (Windows 10 has 8.1). Then ssh asks in the tab. Type the password there each time; Vibex keeps nothing.

Vibex uses a small program for this, `vibex-askpass.exe`, in its install folder. It has no paid signature, like the rest of Vibex. If Windows blocks it, the login fails. Tell the person who manages the team.

Vibex holds the PCA server's host key, so it does not ask you to compare a fingerprint. If another machine answers with a different key, Vibex stops the connection and says so. Then send no password, and tell the person who manages the team. The person who manages the team can give you the fingerprint of the key.

## Updates

This version updates itself. A new version downloads by itself, and a "Restart to Update" button shows at the top of the window when it is ready. Click it, or do nothing: it installs when you quit. It asks no questions and shows no wizard. If tabs run, Vibex PCA asks once before it restarts.

Versions built before the update key do not update themselves. Install this one by hand once.

## When something fails: send this back

Do not send passwords, keys, or any client data.

Send back (to the person who manages the team):

1. The step number where it stopped.
2. A screenshot of the whole screen. Press the Windows key + Shift + S, select the screen, and paste it in your message.
3. The words of any red text, copied exactly.
4. Your Windows version: press the Windows key, type "About your PC", and read "Windows specification".
5. The Vibex PCA version: open Setup and read it there. After an update, the installer file name shows an old version.
6. A screenshot of the Setup list after you click the round arrow.
7. What you did just before it failed.
8. The file `%APPDATA%\Vibex PCA\vibex-errors.log`, if it exists. Read it first, and remove private names.
