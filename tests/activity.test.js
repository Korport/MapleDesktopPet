const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

function setup() {
  const windows = [];
  const handlers = new Map();
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let spawnArgs;
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.messages = [];
      this.webContents = { send: (...args) => this.messages.push(args) };
      windows.push(this);
    }
    isDestroyed() { return false; }
    isMinimized() { return false; }
    setMenuBarVisibility() {}
    loadFile(file) { this.file = file; }
    show() { this.shown = true; }
    focus() {}
  }
  const electron = {
    app: {
      setName() {},
      getPath: () => __dirname,
      whenReady: () => ({ then() {} }),
      on() {},
    },
    BrowserWindow,
    ipcMain: { on() {}, handle: (name, handler) => handlers.set(name, handler) },
  };
  const context = vm.createContext({
    require: (name) => {
      if (name === 'electron') return electron;
      if (name === 'fs') return {
        readFileSync: () => '{}',
        mkdirSync() {},
        writeFileSync() {},
      };
      if (name === 'child_process') return {
        spawn: (...args) => { spawnArgs = args; return child; },
      };
      return require(name);
    },
    __dirname: path.join(__dirname, '..', 'src'),
    process: { platform: 'win32' },
  });
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  vm.runInContext(`${source}\nglobalThis.api = { showActivity, appendActivity, askCopilot };`, context);
  return { ...context.api, windows, handlers, child, get spawnArgs() { return spawnArgs; } };
}

test('streams stdout and stderr live while preserving the original final reply', async () => {
  const app = setup();
  app.showActivity();
  const reply = app.askCopilot('Make a deck');
  app.child.stdout.write('Hello ');
  app.child.stdout.write(Buffer.from('fox \u{1f98a}'));
  app.child.stderr.write('Progress diagnostic');
  const live = app.windows[0].messages.at(-1)[1];
  assert.match(live, /Working/);
  assert.match(live, /Hello fox \u{1f98a}/u);
  assert.match(live, /Progress diagnostic/);
  assert.match(app.spawnArgs[0], /"--stream" "on"/);
  app.child.emit('close', 0);
  assert.equal(await reply, 'Hello fox \u{1f98a}');
  assert.match(app.windows[0].messages.at(-1)[1], /\[Finished\]/);
});

test('retains bounded output before opening and after reopening the window', () => {
  const app = setup();
  app.appendActivity('old' + 'x'.repeat(200000));
  app.showActivity();
  const snapshot = app.handlers.get('activity:snapshot');
  const text = snapshot({ sender: app.windows[0].webContents });
  assert.equal(text.length, 200000);
  assert.equal(text.startsWith('old'), false);
  app.showActivity();
  assert.equal(app.windows.length, 1);
  app.windows[0].emit('closed');
  app.showActivity();
  assert.equal(snapshot({ sender: app.windows[1].webContents }), text);
  assert.throws(() => snapshot({ sender: {} }), /only available/);
  assert.equal(app.windows[1].options.webPreferences.nodeIntegration, false);
});

test('records process failures and still rejects the chat request', async () => {
  const app = setup();
  app.showActivity();
  const reply = app.askCopilot('Test failure');
  app.child.stderr.write('Permission denied');
  app.child.emit('close', 1);
  await assert.rejects(reply, /Permission denied/);
  assert.match(app.windows[0].messages.at(-1)[1], /Process exited: 1/);
});

test('late snapshot cannot overwrite live output and output is rendered as text', async () => {
  const elements = {
    output: { scrollHeight: 100 },
    follow: { checked: true, addEventListener() {} },
    status: {},
  };
  let onChange;
  let resolveSnapshot;
  const context = vm.createContext({
    document: { getElementById: (id) => elements[id] },
    window: {
      addEventListener() {},
      mapleActivity: {
        onChange: (callback) => { onChange = callback; return () => {}; },
        snapshot: () => new Promise((resolve) => { resolveSnapshot = resolve; }),
      },
    },
  });
  const script = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'activity.js'), 'utf8');
  vm.runInContext(script, context);
  onChange('<script>untrusted output</script>');
  resolveSnapshot('stale output');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(elements.output.textContent, '<script>untrusted output</script>');
  assert.equal(elements.output.scrollTop, 100);
});
