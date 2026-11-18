const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

function setup({ saveDialog, writeFile, usageReport, readUsage, removeUsage } = {}) {
  const windows = [];
  const handlers = new Map();
  let child;
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
        promises: {
          writeFile,
          readFile: readUsage || (async () => JSON.stringify(usageReport || {
            modelMetrics: {},
            aiCreditsStatus: 'unavailable',
          })),
          unlink: removeUsage || (async () => {}),
        },
      };
      if (name === 'child_process') return {
        spawn: (...args) => {
          spawnArgs = args;
          child = new EventEmitter();
          child.stdout = new PassThrough();
          child.stderr = new PassThrough();
          return child;
        },
      };
      return require(name);
    },
    __dirname: path.join(__dirname, '..', 'src'),
    process: { platform: 'win32' },
  });
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  vm.runInContext(`${source}\nglobalThis.api = { showActivity, appendActivity, askCopilot };`, context);
  return { ...context.api, windows, handlers, get child() { return child; }, get spawnArgs() { return spawnArgs; } };
}

function writeEvent(app, type, data, extra = {}) {
  app.child.stdout.write(JSON.stringify({ type, data, ...extra }) + '\n');
}

function usageElements() {
  return Object.fromEntries([
    'total', 'input', 'output', 'credits', 'requests', 'details', 'status',
  ].map((name) => [`usage-${name}`, {}]));
}

function idleUsageBridge() {
  return {
    usage: async () => ({ sessionId: 'test-session', turns: 0, totals: null }),
    onUsageChange: () => () => {},
  };
}

test('tracks cumulative session tokens and billing across prompts without double counting agents or caches', async () => {
  const report = {
    totalNanoAiu: 1250000000,
    aiCreditsStatus: 'complete',
    totalPremiumRequestCost: 0.5,
    modelMetrics: {
      sol: { usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 60, cacheWriteTokens: 10, reasoningTokens: 5 } },
      other: { usage: { inputTokens: 50, outputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 0, reasoningTokens: 2 } },
    },
    agentMetrics: { main: { modelMetrics: { sol: { usage: { inputTokens: 100 } } } } },
  };
  const removed = [];
  const app = setup({
    readUsage: async () => JSON.stringify(report),
    removeUsage: async (file) => removed.push(file),
  });
  app.showActivity();
  const snapshot = () => app.handlers.get('activity:usage')({ sender: app.windows.at(-1).webContents });
  assert.equal(snapshot().totals, null);
  assert.throws(() => app.handlers.get('activity:usage')({ sender: {} }), /only available/);
  for (let turn = 1; turn <= 2; turn++) {
    const reply = app.askCopilot('Work');
    assert.equal(snapshot().updating, true);
    assert.match(app.spawnArgs[0], /"--usage-output-file" "[^"]+maple-usage-[^"]+\.json"/);
    writeEvent(app, 'assistant.message', { content: 'Done' });
    app.child.emit('close', 0);
    assert.equal(await reply, 'Done');
    const usage = snapshot();
    assert.equal(usage.turns, turn);
    assert.equal(usage.updating, false);
    assert.equal(usage.error, null);
    assert.equal(usage.totals.inputTokens, report.modelMetrics.sol.usage.inputTokens + 50);
    assert.equal(usage.totals.outputTokens, 30);
    assert.equal(usage.totals.cacheReadTokens, 80);
    assert.equal(usage.totals.reasoningTokens, 7);
    assert.equal(usage.totals.aiCredits, 1.25);
    assert.equal(usage.totals.premiumRequests, 0.5);
    report.modelMetrics.sol.usage.inputTokens = 200;
  }
  assert.equal(removed.length, 2);
  assert.notEqual(removed[0], removed[1]);
  const sessionId = snapshot().sessionId;
  app.windows[0].emit('closed');
  app.showActivity();
  assert.equal(snapshot().sessionId, sessionId);
  assert.equal(snapshot().totals.inputTokens, 250);
});

test('usage preserves reported zero, labels partial or unavailable costs, and rejects invalid token counts', async () => {
  for (const aiCreditsStatus of ['complete', 'partial', 'unavailable']) {
    const app = setup({
      usageReport: {
        modelMetrics: { sol: { usage: { inputTokens: -1, outputTokens: 0 } } },
        totalNanoAiu: 0,
        aiCreditsStatus,
        totalPremiumRequestCost: 0,
      },
    });
    app.showActivity();
    const reply = app.askCopilot('Work');
    writeEvent(app, 'assistant.message', { content: 'Done' });
    app.child.emit('close', 0);
    await reply;
    const { totals } = app.handlers.get('activity:usage')({ sender: app.windows[0].webContents });
    assert.equal(totals.inputTokens, null);
    assert.equal(totals.outputTokens, 0);
    assert.equal(totals.cacheReadTokens, null);
    assert.equal(totals.aiCreditsStatus, aiCreditsStatus);
    assert.equal(totals.aiCredits, aiCreditsStatus === 'unavailable' ? null : 0);
    assert.equal(totals.premiumRequests, 0);
  }
});

test('usage report failures are visible without losing the chat reply, and temporary reports are cleaned up', async () => {
  for (const readUsage of [
    async () => { throw new Error('Report missing'); },
    async () => 'not JSON',
    async () => '{"modelMetrics":[]}',
  ]) {
    let removed = false;
    const app = setup({ readUsage, removeUsage: async () => { removed = true; } });
    app.showActivity();
    const reply = app.askCopilot('Work');
    writeEvent(app, 'assistant.message', { content: 'Done' });
    app.child.emit('close', 0);
    assert.equal(await reply, 'Done');
    const usage = app.handlers.get('activity:usage')({ sender: app.windows[0].webContents });
    assert.match(usage.error, /Unable to update session usage:/);
    assert.equal(usage.updating, false);
    assert.equal(usage.totals, null);
    assert.equal(removed, true);
    assert.match(app.windows[0].messages.at(-1)[1], /Unable to update session usage/);
  }
  const app = setup({ removeUsage: async () => { throw new Error('Access denied'); } });
  app.showActivity();
  const reply = app.askCopilot('Work');
  writeEvent(app, 'assistant.message', { content: 'Done' });
  app.child.emit('close', 0);
  await reply;
  assert.match(app.handlers.get('activity:usage')({
    sender: app.windows[0].webContents,
  }).error, /Unable to remove temporary usage report: Access denied/);
});

test('streams bounded thinking summaries, commentary and tool progress separately from the reply', async () => {
  const app = setup();
  const progress = [];
  const reply = app.askCopilot('Work', (update) => progress.push(update));
  writeEvent(app, 'assistant.reasoning_delta', { reasoningId: 'r1', deltaContent: 'Checking' });
  writeEvent(app, 'assistant.reasoning_delta', { reasoningId: 'r1', deltaContent: ' ' });
  writeEvent(app, 'assistant.reasoning_delta', { reasoningId: 'r1', deltaContent: 'the files' });
  assert.equal(progress.at(-1).label, 'Thinking');
  assert.equal(progress.at(-1).text, 'Checking the files');
  writeEvent(app, 'assistant.reasoning', { content: 'Checking the files.' });
  assert.equal(progress.at(-1).text, 'Checking the files.');
  writeEvent(app, 'assistant.reasoning_delta', { reasoningId: 'r2', deltaContent: 'Next step' });
  assert.equal(progress.at(-1).text, 'Next step');
  writeEvent(app, 'tool.execution_start', { toolName: 'view' });
  assert.equal(progress.at(-1).text, 'Running view...');
  writeEvent(app, 'tool.execution_progress', { progressMessage: 'Reading the renderer' });
  assert.equal(progress.at(-1).text, 'Reading the renderer');
  writeEvent(app, 'tool.execution_complete', { success: false, error: { message: 'Access denied' } });
  assert.equal(progress.at(-1).text, 'Tool failed: Access denied');
  writeEvent(app, 'tool.execution_complete', { success: true });
  assert.equal(progress.at(-1).text, 'Tool finished. Continuing...');
  const count = progress.length;
  writeEvent(app, 'assistant.reasoning', { content: 'Nested' }, { agentId: 'agent-1' });
  writeEvent(app, 'assistant.message', { parentToolCallId: 't1', content: 'Nested' });
  writeEvent(app, 'assistant.reasoning_delta', {});
  assert.equal(progress.length, count);
  writeEvent(app, 'assistant.message_delta', { messageId: 'm1', deltaContent: 'x'.repeat(2000) });
  assert.equal(progress.at(-1).text.length, 1800);
  writeEvent(app, 'assistant.message_delta', { messageId: 'm2', deltaContent: 'New message' });
  assert.equal(progress.at(-1).text, 'New message');
  writeEvent(app, 'assistant.message', { content: 'Done' });
  app.child.emit('close', 0);
  assert.equal(await reply, 'Done');
});

test('preload forwards progress data without exposing IPC events and unsubscribes', () => {
  const ipc = new EventEmitter();
  let bridge;
  const context = vm.createContext({
    require: () => ({
      contextBridge: { exposeInMainWorld: (_name, api) => { bridge = api; } },
      ipcRenderer: ipc,
    }),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8'), context);
  const updates = [];
  const unsubscribe = bridge.onProgress((...args) => updates.push(args));
  const update = { label: 'Thinking', text: 'Checking files' };
  ipc.emit('mascot:progress', { sender: 'private' }, update);
  assert.deepEqual(updates, [[update]]);
  unsubscribe();
  assert.equal(ipc.listenerCount('mascot:progress'), 0);
});

test('thinking bubble updates safely, blocks overlapping prompts and yields to final replies or errors', async () => {
  for (const failed of [false, true]) {
    const elements = new Map();
    function element(id) {
      if (!elements.has(id)) {
        const classes = new Set(['hidden']);
        elements.set(id, {
          value: '', style: {}, events: {}, scrollHeight: 200,
          classList: {
            add: (name) => classes.add(name),
            remove: (name) => classes.delete(name),
            contains: (name) => classes.has(name),
          },
          addEventListener(name, callback) { this.events[name] = callback; },
          setAttribute(name, value) { this[name] = value; },
          querySelector: () => element('submit'),
        });
      }
      return elements.get(id);
    }
    let onProgress;
    let finish;
    let calls = 0;
    const frames = [];
    const states = [];
    const context = vm.createContext({
      document: { getElementById: element },
      window: {
        addEventListener() {},
        mascot: {
          onProgress: (callback) => { onProgress = callback; return () => {}; },
          askCopilot: () => {
            calls++;
            return new Promise((resolve, reject) => {
              finish = () => failed ? reject(new Error('Connection lost')) : resolve('All done');
            });
          },
        },
      },
      Sprite: { start() {}, setState: (state) => states.push(state), setAmplitude() {} },
      ResizeObserver: class { observe() {} },
      performance: { now: () => 0 },
      requestAnimationFrame: (callback) => frames.push(callback),
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'renderer.js'), 'utf8'), context);
    const submit = () => element('chat-form').events.submit({ preventDefault() {} });
    element('chat-input').value = 'First task';
    submit();
    assert.equal(element('thinking-bubble').classList.contains('hidden'), false);
    assert.match(element('thinking-text').textContent, /Connecting/);
    assert.equal(element('bubble').classList.contains('hidden'), true);
    assert.equal(element('submit').disabled, true);
    onProgress({ label: 'Thinking', text: '<script>plain text</script>' });
    assert.equal(element('thinking-text').textContent, '<script>plain text</script>');
    assert.equal(element('thinking-text').scrollTop, 200);
    element('chat-input').value = 'Queued draft';
    submit();
    assert.equal(calls, 1);
    assert.equal(element('chat-input').value, 'Queued draft');
    finish();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(element('thinking-bubble').classList.contains('hidden'), true);
    assert.equal(element('bubble-text').textContent, failed
      ? 'Error talking to Copilot: Connection lost' : 'All done');
    onProgress({ label: 'Working', text: 'Late event' });
    assert.equal(element('thinking-text').textContent, '<script>plain text</script>');
    frames.shift()(5000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(element('submit').disabled, false);
    assert.equal(element('chat-form')['aria-busy'], 'false');
    assert.equal(states.at(-1), failed ? 'confused' : 'happy');
    submit();
    assert.equal(calls, 2);
    assert.match(element('thinking-text').textContent, /Connecting/);
    finish();
    await new Promise((resolve) => setImmediate(resolve));
    frames.shift()(5000);
    await new Promise((resolve) => setImmediate(resolve));
  }
});

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
    ...usageElements(),
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
        ...idleUsageBridge(),
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
    ...usageElements(),
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
        ...idleUsageBridge(),
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

test('usage UI handles snapshot races, totals, partial costs, pending turns and unavailable data', async () => {
  const elements = {
    ...usageElements(),
    output: {},
    follow: { addEventListener() {} },
    status: {},
    download: { addEventListener() {} },
    'download-status': {},
  };
  let onUsageChange;
  let resolveUsage;
  const context = vm.createContext({
    document: { getElementById: (id) => elements[id] },
    window: {
      addEventListener() {},
      mapleActivity: {
        onChange: () => () => {},
        snapshot: async () => '',
        onUsageChange: (callback) => { onUsageChange = callback; return () => {}; },
        usage: () => new Promise((resolve) => { resolveUsage = resolve; }),
      },
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'activity.js'), 'utf8'), context);
  const usage = {
    sessionId: '<script>session</script>',
    turns: 2,
    totals: {
      inputTokens: 100, outputTokens: 20, cacheReadTokens: 80, reasoningTokens: 5,
      aiCredits: 1.25, aiCreditsStatus: 'partial', premiumRequests: 0,
    },
  };
  onUsageChange(usage);
  resolveUsage({ sessionId: 'stale', turns: 0, totals: null });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(elements['usage-total'].textContent, '120');
  assert.equal(elements['usage-credits'].textContent, '1.25 (partial)');
  assert.equal(elements['usage-requests'].textContent, '0');
  assert.match(elements['usage-details'].textContent, /<script>session<\/script>/);
  assert.match(elements['usage-details'].textContent, /Cache written: Unavailable/);
  onUsageChange({ ...usage, updating: true });
  assert.match(elements['usage-status'].textContent, /refresh when this reply finishes/);
  onUsageChange({ ...usage, error: 'Report missing' });
  assert.match(elements['usage-status'].textContent, /Report missing.*last successful report/);
  onUsageChange({ ...usage, totals: { aiCredits: 0.000000001 } });
  assert.equal(elements['usage-credits'].textContent, '<0.000001');
  assert.equal(elements['usage-total'].textContent, 'Unavailable');
  onUsageChange({ ...usage, totals: null });
  assert.equal(elements['usage-credits'].textContent, 'Unavailable');
});

test('usage preload exposes only usage data and removes its event listener', async () => {
  const ipc = new EventEmitter();
  ipc.invoke = async (channel) => channel;
  let bridge;
  const context = vm.createContext({
    require: () => ({
      contextBridge: { exposeInMainWorld: (_name, api) => { bridge = api; } },
      ipcRenderer: ipc,
    }),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'activity-preload.js'), 'utf8'), context);
  assert.equal(await bridge.usage(), 'activity:usage');
  const updates = [];
  const unsubscribe = bridge.onUsageChange((...args) => updates.push(args));
  const usage = { sessionId: 'session' };
  ipc.emit('activity:usage-changed', { sender: 'private' }, usage);
  assert.deepEqual(updates, [[usage]]);
  unsubscribe();
  assert.equal(ipc.listenerCount('activity:usage-changed'), 0);
});
