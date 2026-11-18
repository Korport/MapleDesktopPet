const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

function setup({ saveDialog, writeFile } = {}) {
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
    dialog: { showSaveDialog: saveDialog },
    ipcMain: { on() {}, handle: (name, handler) => handlers.set(name, handler) },
  };
  const context = vm.createContext({
    require: (name) => {
      if (name === 'electron') return electron;
      if (name === 'fs') return {
        readFileSync: () => '{}',
        mkdirSync() {},
        writeFileSync() {},
        promises: { writeFile },
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

function writeEvent(app, type, data, extra = {}) {
  app.child.stdout.write(JSON.stringify({ type, data, ...extra }) + '\n');
}

test('streams CLI events and diagnostics live while returning only the final reply', async () => {
  const app = setup();
  app.showActivity();
  const reply = app.askCopilot('Make a deck');
  writeEvent(app, 'assistant.message', { content: 'I will make a deck.' });
  writeEvent(app, 'tool.execution_start', {
    toolCallId: 'tool-1', toolName: 'create_office_file', arguments: { title: 'Deck' },
  });
  writeEvent(app, 'tool.execution_complete', {
    toolCallId: 'tool-1', success: true, result: { content: 'Saved deck.pptx' },
  });
  writeEvent(app, 'assistant.message_delta', { deltaContent: 'Hello ' });
  writeEvent(app, 'assistant.message_delta', { deltaContent: 'fox \u{1f98a}' });
  app.child.stderr.write('Progress diagnostic');
  const live = app.windows[0].messages.at(-1)[1];
  assert.match(live, /Working/);
  assert.match(live, /tool.execution_start/);
  assert.match(live, /create_office_file/);
  assert.match(live, /Saved deck.pptx/);
  assert.match(live, /Hello fox \u{1f98a}/u);
  assert.match(live, /Progress diagnostic/);
  assert.match(app.spawnArgs[0], /"--stream" "on"/);
  assert.match(app.spawnArgs[0], /"--output-format" "json"/);
  assert.doesNotMatch(app.spawnArgs[0], /"-s"/);
  writeEvent(app, 'assistant.message', { content: 'Hello fox \u{1f98a}' });
  writeEvent(app, 'result', undefined, { exitCode: 0, usage: { totalTokens: 123 } });
  app.child.emit('close', 0);
  assert.equal(await reply, 'Hello fox \u{1f98a}');
  assert.match(app.windows[0].messages.at(-1)[1], /\[Finished\]/);
});

test('parses split JSON, CRLF and an unterminated final line without corrupting Unicode', async () => {
  const app = setup();
  app.showActivity();
  const reply = app.askCopilot('Hello');
  const event = Buffer.from(JSON.stringify({
    type: 'assistant.message', data: { content: 'Hello \u{1f98a}' },
  }));
  const split = event.indexOf(Buffer.from('\u{1f98a}')) + 1;
  app.child.stdout.write(event.subarray(0, split));
  app.child.stdout.write(event.subarray(split));
  app.child.stdout.write('\r\n');
  app.child.stdout.write('{"type":"result","exitCode":0}');
  app.child.emit('close', 0);
  assert.equal(await reply, 'Hello \u{1f98a}');
  assert.match(app.windows[0].messages.at(-1)[1], /\[result\]/);
});

test('keeps progress and subagent events out of the final chat reply', async () => {
  const app = setup();
  app.showActivity();
  const reply = app.askCopilot('Work');
  writeEvent(app, 'assistant.message', { content: 'Done' });
  writeEvent(app, 'assistant.message', { content: 'Subagent reply' }, { agentId: 'agent-1' });
  writeEvent(app, 'assistant.message', { content: 'Nested reply', parentToolCallId: 'tool-1' });
  writeEvent(app, 'tool.execution_progress', { toolCallId: 'tool-1', progressMessage: 'Still working' });
  app.child.emit('close', 0);
  assert.equal(await reply, 'Done');
  assert.match(app.windows[0].messages.at(-1)[1], /Still working/);
  assert.match(app.windows[0].messages.at(-1)[1], /Subagent reply/);
});

test('reports malformed events, missing replies and result failures instead of succeeding', async () => {
  for (const output of [
    'not JSON\n',
    '{"data":{}}\n',
    '{"type":"result","exitCode":0}\n',
    '{"type":"assistant.message","data":{"content":"Done"}}\n{"type":"result","exitCode":1}\n',
  ]) {
    const app = setup();
    app.showActivity();
    const reply = app.askCopilot('Work');
    app.child.stdout.write(output);
    app.child.emit('close', 0);
    await assert.rejects(reply, /Unable to read Copilot activity|without a final assistant message|exit code 1/);
    assert.match(app.windows[0].messages.at(-1)[1], /\[Failed:/);
    assert.doesNotMatch(app.windows[0].messages.at(-1)[1], /\[Finished\]/);
  }
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

test('downloads a UTF-8 snapshot without including output arriving during the save dialog', async () => {
  let resolveDialog;
  let dialogParent;
  let dialogOptions;
  const writes = [];
  const app = setup({
    saveDialog: (parent, options) => {
      dialogParent = parent;
      dialogOptions = options;
      return new Promise((resolve) => { resolveDialog = resolve; });
    },
    writeFile: async (...args) => { writes.push(args); },
  });
  app.showActivity();
  const text = 'Tool output \u{1f98a}\nPermission denied\n';
  app.appendActivity(text);
  const download = app.handlers.get('activity:download');
  const pending = download({ sender: app.windows[0].webContents });
  app.appendActivity('New activity');
  assert.equal(dialogParent, app.windows[0]);
  assert.match(dialogOptions.defaultPath, /Maple-activity-.*\.txt$/);
  resolveDialog({ canceled: false, filePath: 'C:\\Logs\\activity.txt' });
  const result = await pending;
  assert.equal(result.filePath, 'C:\\Logs\\activity.txt');
  assert.equal(result.canceled, false);
  assert.deepEqual(writes, [['C:\\Logs\\activity.txt', text, 'utf8']]);
});

test('canceling a download writes nothing and only the activity window can export', async () => {
  let dialogs = 0;
  let writes = 0;
  const app = setup({
    saveDialog: async () => { dialogs++; return { canceled: true }; },
    writeFile: async () => { writes++; },
  });
  const download = app.handlers.get('activity:download');
  await assert.rejects(download({ sender: {} }), /only available/);
  app.showActivity();
  await assert.rejects(download({ sender: {} }), /only available/);
  const result = await download({ sender: app.windows[0].webContents });
  assert.equal(result.canceled, true);
  assert.equal(dialogs, 1);
  assert.equal(writes, 0);
  const freshApp = setup();
  freshApp.showActivity();
  assert.equal(freshApp.handlers.get('activity:snapshot')({
    sender: freshApp.windows[0].webContents,
  }), '');
});

test('download reports dialog, destination and write failures', async () => {
  for (const options of [
    { saveDialog: async () => { throw new Error('Dialog failed'); } },
    { saveDialog: async () => ({ canceled: false }) },
    {
      saveDialog: async () => ({ canceled: false, filePath: 'C:\\Logs\\activity.txt' }),
      writeFile: async () => { throw new Error('Disk full'); },
    },
  ]) {
    const app = setup(options);
    app.showActivity();
    await assert.rejects(
      app.handlers.get('activity:download')({ sender: app.windows[0].webContents }),
      /Dialog failed|No destination|Disk full/,
    );
  }
});

test('late snapshot cannot overwrite live output and output is rendered as text', async () => {
  const elements = {
    output: { scrollHeight: 100 },
    follow: { checked: true, addEventListener() {} },
    status: {},
    download: { addEventListener() {} },
    'download-status': {},
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

test('download UI handles saving, cancellation and errors while live output continues', async () => {
  let click;
  let onChange;
  let resolveDownload;
  let rejectDownload;
  let calls = 0;
  const elements = {
    output: { scrollHeight: 100 },
    follow: { checked: true, addEventListener() {} },
    status: {},
    download: { addEventListener: (_event, callback) => { click = callback; } },
    'download-status': {},
  };
  const context = vm.createContext({
    document: { getElementById: (id) => elements[id] },
    window: {
      addEventListener() {},
      mapleActivity: {
        onChange: (callback) => { onChange = callback; return () => {}; },
        snapshot: async () => '',
        download: () => {
          calls++;
          return new Promise((resolve, reject) => {
            resolveDownload = resolve;
            rejectDownload = reject;
          });
        },
      },
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'activity.js'), 'utf8'), context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(elements.download.disabled, true);
  await click();
  assert.equal(calls, 0);
  onChange('Tool failed');
  assert.equal(elements.download.disabled, false);
  let pending = click();
  onChange('More output');
  assert.equal(elements.download.disabled, true);
  await click();
  assert.equal(calls, 1);
  resolveDownload({ canceled: false, filePath: 'C:\\Logs\\activity.txt' });
  await pending;
  assert.equal(elements.download.disabled, false);
  assert.match(elements['download-status'].textContent, /saved to C:\\Logs\\activity.txt/);
  onChange('Still working');
  assert.match(elements['download-status'].textContent, /saved to/);
  pending = click();
  resolveDownload({ canceled: true });
  await pending;
  assert.equal(elements['download-status'].textContent, 'Download canceled.');
  pending = click();
  rejectDownload(new Error('Permission denied'));
  await pending;
  assert.match(elements['download-status'].textContent, /Unable to save activity log: Permission denied/);
  assert.equal(elements.download.disabled, false);
});
