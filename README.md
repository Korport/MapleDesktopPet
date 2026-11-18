# Maple 🍁

Maple is a small, always-on-top desktop companion for Windows — a cute
autumn-fox sprite that sits in the corner of your screen, chats with you
through a typing box, and answers using the **GitHub Copilot CLI** running
locally on your machine. She can also edit her own source code and open
files/folders/webpages for you, all within tightly scoped permissions.

![Maple idle animation](src/assets/Maple-Animation-Pack/Maple-Animations/maple-idle.webp)

## Features

- **Transparent, frameless, always-on-top window** that sits in a corner of
  your screen and can be dragged anywhere (clamped so she can never be
  dragged fully off-screen).
- **Chat box** below her with a speech bubble above that grows to fit longer
  replies, with a dismiss button and selectable/copyable text.
- **Animated WebP sprites** from the Maple Animation Pack, played at 1.5x
  speed for idle, greeting, thinking, listening, and matching reactions
  (happy, celebrating, confused, and quick acknowledgements). States without
  a matching animation retain their PNG poses, including talking, yawning,
  stretching, and napping after inactivity. Reactions are picked automatically
  from the Copilot CLI's reply.
- **Powered by GitHub Copilot CLI** (`copilot` on your PATH) — each chat
  session keeps conversational context via `--resume`.
- **Self-editing**: Maple is granted `read`/`write` access scoped *only* to
  her own project folder, so she can patch her own source files when asked.
- **Local Office creation**: ask Maple to make editable PowerPoint (`.pptx`),
  Word (`.docx`), or Excel (`.xlsx`) files. Files are saved under your Windows
  Documents folder in `Maple`, with unique names so existing files are never
  overwritten. No Office installation, Cowork connection, or extra subscription
  is needed for file generation.
- **Safe desktop actions** via a tiny custom local MCP server
  (`src/mcp/actions-server.js`):
  - `open_path` — open a file or folder in File Explorer (path must exist)
  - `open_url` — open an `http(s)://` URL in the default browser
  - `git_commit_and_push` — stage, commit, and push her own code changes to
    GitHub via a fixed add/commit/push sequence (no raw git/shell access)
  - `run_tests` — run Maple's fixed test command
  - `restart_app` — request a self-restart to apply code changes
  - `create_office_file` — create local Word documents with headings,
    paragraphs, lists, and tables; widescreen PowerPoint slides with titles
    and bullets; or Excel workbooks with named sheets and typed cell values.
    Spreadsheet strings are not executed as formulas. This first version
    does not edit existing documents or support images, templates, charts,
    macros, or live work-data connections. Content is limited to 1 MB per file.
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
    actions-server.js   Narrowly scoped desktop-action MCP server.
    office-files.js     Local Office Open XML generation and creation tool.
  renderer/
    index.html           Window markup (sprite, bubble, chat form, tray controls).
    renderer.js           Chat wiring, Copilot bridge calls, reaction picking.
    sprite.js             Animated WebP playback and PNG pose state machine.
    style.css              Styling for the transparent window, bubble, chat input.
  assets/
    Maple-Animation-Pack/
      Maple-Animations/   Animated WebPs, APNG alternatives, and an HTML preview.
    sprites/              23 PNG poses for states without matching animations.
    tray-icon.png          System tray icon.
build/
  icon.png               App icon used by electron-builder for the installer.
AGENTS.md                Rules Maple follows for reading/writing memory.md.
memory.md                Maple's own persisted notes across conversations.
```

## Security notes

Maple's Copilot CLI session is launched with a deliberately narrow set of
permissions on every call (see the comments in `src/main.js`):

- `--add-dir` scoped to this project folder only for general file access.
  Office creation separately writes only to the Documents `Maple` folder
  through the narrowly scoped MCP tool; it does not grant general file access.
- `--allow-tool read` / `--allow-tool write` — lets her view and edit her
  own source.
- `--allow-tool mascot_actions` — the scoped tools above.
- `--deny-tool shell` — **hard-blocks all shell command execution**,
  including commands Copilot might otherwise auto-run as "read-only".

Git/GitHub access works the same way, deliberately *not* via raw shell
permissions. Copilot's permission matching only works at the subcommand
level (e.g. `shell(git push)`, `shell(git reset)`) — it cannot allow a
subcommand while denying one of its flags, so there is no way to permit
`git push` while blocking `git push --force` (same for `git reset` vs.
`git reset --hard`). Granting `shell(git:*)` would therefore have allowed
those destructive variants too. Instead, `git_commit_and_push` runs a single
fixed `add -A` → `commit -m <message>` → `push origin <current-branch>`
sequence via `execFile` (array argv, no shell parsing) — the commit message
is the only free-form input, and no flag the model could add is ever
forwarded to git. Force-pushing, resetting, and rewriting history are
simply not reachable through this tool, and raw shell `git`/`gh` remain
fully denied.

If you extend Maple with more capabilities, keep this same pattern: add a
narrowly-scoped custom MCP tool with a fixed command sequence rather than
widening shell access.

## Known limitations / ideas for later

See `memory.md` for Maple's own running list of proposed-but-not-yet-built
ideas (email/Teams notification integrations, a model picker in the tray menu,
etc.). Email and Teams alert animation assets are included in the animation
pack, but notification integrations are not implemented.

## License

MIT — see [LICENSE](LICENSE).
