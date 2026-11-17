# Maple 🍁

Maple is a small, always-on-top desktop companion for Windows — a cute
autumn-fox sprite that sits in the corner of your screen, chats with you
through a typing box, and answers using the **GitHub Copilot CLI** running
locally on your machine. She can also edit her own source code and open
files/folders/webpages for you, all within tightly scoped permissions.

![Maple idle](src/assets/sprites/01-neutral.png)

## Features

- **Transparent, frameless, always-on-top window** that sits in a corner of
  your screen and can be dragged anywhere (clamped so she can never be
  dragged fully off-screen).
- **Chat box** below her with a speech bubble above that grows to fit longer
  replies, with a dismiss button and selectable/copyable text.
- **Sprite-based animation** with idle variety (blinking, tail-swishing,
  yawning, napping after inactivity), activity states (thinking / talking /
  listening), and reaction poses (happy, celebrating, confused, concerned,
  loving, etc.) picked automatically from the Copilot CLI's reply.
- **Powered by GitHub Copilot CLI** (`copilot` on your PATH) — each chat
  session keeps conversational context via `--resume`.
- **Self-editing**: Maple is granted `read`/`write` access scoped *only* to
  her own project folder, so she can patch her own source files when asked.
- **Safe desktop actions** via a tiny custom local MCP server
  (`src/mcp/actions-server.js`) that exposes exactly two tools:
  - `open_path` — open a file or folder in File Explorer (path must exist)
  - `open_url` — open an `http(s)://` URL in the default browser
  - General shell execution is explicitly denied (`--deny-tool shell`), so
    she cannot run arbitrary commands.
- **Click-through mode** (`Alt+Shift+C`) to let mouse clicks pass through her
  to whatever's underneath.
- **System tray** menu: show/hide (`Alt+Shift+M`), reset position
  (`Alt+Shift+R`), toggle click-through, quit.
- **Persistent memory**: Maple reads/writes `memory.md` in the project root
  to remember lasting preferences and ideas across conversations (see
  `AGENTS.md` for the rules she follows when doing so).

## Prerequisites

- **Windows 10/11**
- **[Node.js](https://nodejs.org/) 20+** (development only — not required
  for an end user running a packaged `.exe`, except for the Copilot CLI
  prerequisite below)
- **[GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli)**
  installed and on `PATH` as `copilot` (or `copilot.cmd`), and signed in
  (`copilot` will prompt you to `/login` on first run). Maple is a thin
  Electron shell around this CLI — **without it installed and authenticated,
  Maple cannot answer anything.**
- An active **GitHub Copilot subscription** (required by the CLI).

## Running from source

```powershell
git clone <this-repo-url>
cd desktop-mascot
npm install
npm start
```

Or just double-click `Start Autumn Sakura.bat`, which launches the app with
no visible console window.

## Packaging as a standalone .exe

This project is wired up with [electron-builder](https://www.electron.build/)
to produce a Windows installer:

```powershell
npm install
npm run dist
```

This produces an NSIS installer under `dist/`. Running `npm run dist:dir`
instead produces an unpacked folder you can run directly without building a
full installer (handy for quick testing).

> **Note:** Packaging bundles Maple's own code, not the GitHub Copilot CLI
> itself. Whoever runs the packaged app still needs `copilot` installed and
> signed in separately on their machine — see Prerequisites above.

## Project structure

```
src/
  main.js              Electron main process: window, tray, hotkeys,
                        position clamping/resizing, and the Copilot CLI
                        bridge (askCopilot).
  preload.js            contextBridge API exposed to the renderer.
  mcp/
    actions-server.js   Local MCP server: open_path / open_url tools only.
  renderer/
    index.html           Window markup (sprite, bubble, chat form, tray controls).
    renderer.js           Chat wiring, Copilot bridge calls, reaction picking.
    sprite.js             Sprite swapping state machine (idle cycle, reactions).
    style.css              Styling for the transparent window, bubble, chat input.
  assets/
    sprites/              23 PNG poses (idle, reactions, interactions).
    tray-icon.png          System tray icon.
build/
  icon.png               App icon used by electron-builder for the installer.
AGENTS.md                Rules Maple follows for reading/writing memory.md.
memory.md                Maple's own persisted notes across conversations.
```

## Security notes

Maple's Copilot CLI session is launched with a deliberately narrow set of
permissions on every call (see the comments in `src/main.js`):

- `--add-dir` scoped to this project folder only — she can't read/write
  files anywhere else on disk.
- `--allow-tool read` / `--allow-tool write` — lets her view and edit her
  own source.
- `--allow-tool mascot_actions` — the two safe tools above, nothing else.
- `--deny-tool shell` — **hard-blocks all shell command execution**,
  including commands Copilot might otherwise auto-run as "read-only".

If you extend Maple with more capabilities, keep this same pattern: add a
narrowly-scoped custom MCP tool rather than widening shell access.

## Known limitations / ideas for later

See `memory.md` for Maple's own running list of proposed-but-not-yet-built
ideas (voice input, email/Teams alerts, animated sprite transitions, a model
picker in the tray menu, etc.).

## License

MIT — see [LICENSE](LICENSE).
