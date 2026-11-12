# First run on one Windows PC: a check

The tests cannot see these things, because no test runs on a real Windows screen. One person does this once, on one PC. Use made-up files only. Do not sign in to a real client server unless the person who manages the team says so.

Write down each answer as you go: the step number, then yes or no. If a step fails, take a screenshot and go to the next step.

## Before you start

1. Install the app with the steps in `INSTALL-WINDOWS.md`.
2. Write down what Smart App Control said: Off, On or Evaluation.
3. If it said On, write down what Windows did with the installer.
4. Write down if the blue SmartScreen box showed "Run anyway".

## Terminals

5. Open a new empty folder as a project.
6. Look at the right column: is there a prompt with text in it?
7. Look at the left column: is there text in it?
8. In the right column, type `dir` and press Enter. Does a list show?
9. Close that terminal tab. Does the tab close with no error box?
10. Press Ctrl+Shift+Y. Does the tab come back?
11. Open `%APPDATA%\Vibex PCA` in File Explorer.
12. Look for the file `vibex-errors.log`. Write down if it exists.

## Claude and terminal_run

13. Sign in to Claude in the left column with your own account.
14. Ask Claude: "Use terminal_run to run: Get-ChildItem | Format-Table Name, Length".
15. Read the answer: does it hold columns with the right names?
16. Ask Claude: "Use terminal_run to run: Write-Output 'two  spaces'". Write down the exact text.
17. Ask Claude: "With terminal_run, write Write-Output ok in test.ps1, then run it". Write down if PowerShell refused it.
18. Ask Claude: "List your vibex tools". Write down if the tools are there.

## Scaling at 125 % and 150 %

19. Open Settings, System, Display. Set Scale to 125 %.
20. Add a test server in Servers, with a host name from the team manager, not the PCA server.
21. Connect to it. Does a question about the host key show?
22. Hold the button for one second. Does it accept the hold?
23. Set Scale to 150 %.
24. Connect to the same server after you remove it from `known_hosts`, or to a second test server.
25. Hold the button for one second. Does it accept the hold?
26. Set Scale back to what it was.
27. Write down if the whole window fits on the screen, with the close button visible.

## A server login

28. Connect to the test server with a password.
29. Type the password in the box that Vibex shows, not in the tab.
30. Click OK with "Save" selected. Write down if the login passed.
31. Connect to the same server again. Write down if it logged in with no box.
32. Connect with a passphrase key, if there is a test key. Write down if a box asks.

If the Servers section says that ssh is too old, type at the prompt in the tab. Write that down too.

## An agent

33. Open a project that is a Git repository with one commit.
34. Start an agent with the task: Rename "a" to "b" in C++.
35. Look at the agent's Claude tab: does Claude read the task with both quotes?
36. Click Finish on that agent. Choose "Close and Finish".
37. Write down what the answer says, and if the folder is gone.

## A Cyrillic user name (only if there is a test account)

38. Sign in to Windows with a test account that has a Cyrillic name.
39. Install the app in that account.
40. Open a project. Is there text in both terminal columns?
41. Install Claude Code from Setup. Does the new Claude tab start?
42. Ask Claude: "List your vibex tools, then run pwd with terminal_run". Is the name readable?

## Four more that no test can see

43. Connect to the PCA server once. Write down if it connected or said "different host key".
44. Put a test `pre-commit` hook in `.git/hooks`. Commit in the Git section. Did the hook stay silent?
45. Install Git or Node while the app runs. Click the round arrow in Setup. Does a version show?
46. Ask Claude: "Use vibex_preview on the local file test.html". Does the page show?

## The Claude chat

This part uses a real Claude Code. When each answer here is yes, tell the person who manages the team: a chat can then become the default tab.

47. Open a new empty folder as a project.
48. Click the speech bubble at the top of the left column. Does a chat tab open?
49. Click "Open Claude in Terminal" on the trust card.
50. Answer the question about the folder in that terminal tab.
51. Click the chat tab, then "Check Again". Did the card go?
52. Type "Say hello" in the chat and press Enter. Do words come bit by bit?
53. Type "Run dir" and press Enter. Does a blue card show the command?
54. Click "Allow". Did the command run?
55. Set Scale to 150 %.
56. Ask for another command, and click "Allow". Did the click count?
57. Set Scale back to what it was.
58. Ask for another command, and press Ctrl+Enter. Did the key count?
59. Copy a screenshot with Windows key + Shift + S.
60. Click the chat box and press Ctrl+V. Does a small picture show?
61. Ask Claude to use terminal_run to run dir. Does a tab show on the right?
62. Ask Claude to count slowly to 100, and press Esc. Does it stop?
63. Close the chat tab, then press Ctrl+Shift+Y. Does the conversation come back?
64. Look in Task Manager for `claude.exe`. Write down how many there are.
65. Quit Vibex PCA. Is any `claude.exe` left in Task Manager?
66. Open it again and type `/logout` in a terminal Claude tab.
67. Ask the chat something. Write down what it says.

## A quit, and a second start

68. Quit Vibex PCA.
69. Wait 30 seconds, then look in Task Manager for `Vibex PCA.exe`. Write down if it is gone.
70. Open Vibex PCA. Write down if the window opens.
71. Open Vibex PCA a second time. Does the same window come to the front, with no box?
72. If step 69 found a process, click the icon. Does a box say an older copy still runs?
73. If the box shows, click "End the Old Copy". Write down if Vibex PCA opens again.

## Make a Key

Use a test key name from the person who manages the team. Do this on a test account with no `pca_ed25519` file in `%USERPROFILE%\.ssh`.

74. Click "Servers" in the bar on the left.
75. Click "Add the PCA server". Write down if the button shows, also when another server is saved.
76. Type the test key name in the "Your key name" box.
77. Double-click "Make a Key". Does one line that starts with `ssh-ed25519` show, with no red text?
78. Open `%USERPROFILE%\.ssh`. Write down if `pca_ed25519` and `pca_ed25519.pub` exist.
79. Click "Make a Key" again. Is the line the same?
80. Click "Copy". Paste the line in Notepad. Is it one line?
81. Click "Save". Does a server named PCA show?
82. Does the button "Add the PCA server" now stay away?

## An update

This is the test of the update itself. It needs the person who manages the team to make two releases.

WARNING: Install release N by hand on this one PC only. A PC that has release N takes each later release within 6 hours, with no question. Other PCs have an older build with no update key, so they take nothing. Do not install release N on them until step 98 passes.

NOTE: If GitHub refuses hosted jobs, the person who manages the team runs `electron/scripts/release.sh --fence <N>`, then `--publish-kept <N>`, in place of each `release.sh <N>` below. The address for a hand install comes from `--publish-kept`.

83. The person who manages the team runs `electron/scripts/release.sh <N>`.
84. Ask that person for the address it prints for a hand install.
85. Download that installer on this one PC.
86. Install it with the steps in `INSTALL-WINDOWS.md`.
87. Open Vibex PCA, then open Setup. Write down the version. It must be N.
88. Tell the person who manages the team that the version shows.
89. That person runs `electron/scripts/release.sh <N+1>`, and tells you when it ends.
90. Close Vibex PCA, open it, and wait 1 minute. The check runs 10 seconds after a start.
91. Open Setup. Does the update row show a download, and then "Restart to Update"?
92. Write down how long the download took.
93. Click "Restart to Update". Does the window close, with no installer window and no question?
94. Wait 1 minute. Does the new version start by itself? If not, open it from the Start menu.
95. Open Setup. Write down the version. It must be N+1.
96. Open a project. Is there text in both terminal columns?
97. Look in Servers. Do your saved servers still show?
98. Quit Vibex PCA. Look in Task Manager. Is `Vibex PCA.exe` gone?

## Send back

Send this to the person who manages the team. Do not send passwords, keys or client data.

1. Your list of step numbers with yes or no.
2. The screenshots of each step that failed.
3. The file `%APPDATA%\Vibex PCA\vibex-errors.log`, if it exists. First read it, and remove private names.
4. Your Windows version from "About your PC".
5. The display scale you normally use, and the screen size.
6. How long the whole check took.
