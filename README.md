# Vibex PCA

Vibex PCA is the Windows and Linux edition of Vibex: a desktop workstation for Claude Code, with terminals, a side browser, servers, notes and an MCP server. It is an Electron app.

It is based on [Vibex](https://github.com/uwussimo/vibex) for macOS (MIT).

## Where things are

| Path | What it holds |
|---|---|
| `electron/` | The app: source, tests, build and release scripts. Start with `electron/README.md`. |
| `.github/workflows/` | The three CI workflows. All jobs run on GitHub-hosted runners. |
| `Vibex/Resources/Fonts/` | Google Sans and Google Sans Code, with their SIL Open Font License texts. |
| `docs/` | The app icon. |
| `scripts/icons.txt` | The list of icon names that the build reads. |

## Build and test

```
cd electron
npm ci
npm run typecheck
npm test
```

`npm run dist:win` and `npm run dist:linux` make the installers.

## Site values

The source holds no address of a real server. `electron/src/main/site.ts` holds made-up values, and the tests use them. A release build reads the real values of a team from `electron/site.local.json`, which is never committed. `electron/site.example.json` shows its shape.

## Licences

- The code: MIT, see `LICENSE`.
- The fonts: SIL Open Font License 1.1, see the two `OFL-*.txt` files beside them.
- The icons: Untitled UI icons. Their licence does not allow anyone to publish the icon files, so this repository does not hold them. The build fetches them from npm (`@untitledui/icons`) and generates a module that git ignores. Read their licence before you publish an installer: https://www.untitledui.com/license

## Security

Do not add a self-hosted runner to a workflow that a pull request starts. Report a security problem in private, through the "Report a vulnerability" button of the Security tab.
