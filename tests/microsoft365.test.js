const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { Microsoft365, validateConfig, graphUrl } = require('../src/microsoft365');

const config = {
  clientId: '11111111-1111-1111-1111-111111111111',
  tenantId: '22222222-2222-2222-2222-222222222222',
  email: true, teams: true,
};
const device = {
  device_code: 'private-device-code', user_code: 'USERCODE',
  verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900, interval: 5,
};
const token = { access_token: 'private-access-token', refresh_token: 'private-refresh-token', expires_in: 3600 };
const timestamp = (offset = 0) => new Date(Date.UTC(2026, 10, 18, 20) + offset).toISOString();
const mail = (id, offset) => ({ id, receivedDateTime: timestamp(offset) });
const chat = (id, offset, author = 'other', extra = {}) => ({
  id: `chat-${id}`, lastMessagePreview: {
    id, createdDateTime: timestamp(offset), messageType: 'message',
    from: { user: { id: author } }, body: { content: 'PRIVATE MESSAGE CONTENT' }, ...extra,
  },
});

function setup() {
  const responses = [];
  const requests = [];
  const states = [];
  const alerts = [];
  const timers = new Map();
  let time = Date.parse(timestamp());
  let timerId = 0;
  const service = new Microsoft365({
    fetch: async (url, options) => {
      requests.push({ url, options });
      assert.ok(responses.length, `Unexpected request to ${url}`);
      const { data, status = 200, retry = null, pending } = responses.shift();
      if (pending) return pending;
      return { ok: status < 400, status, json: async () => data, headers: { get: () => retry } };
    },
    now: () => time,
    schedule: (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; },
    cancel: (id) => timers.delete(id),
    onState: (state) => states.push(structuredClone(state)),
    onAlert: (alert) => alerts.push(alert),
  });
  return {
    service, responses, requests, states, alerts, timers,
    advance: (ms) => { time += ms; },
    async tick() {
      assert.equal(timers.size, 1);
      const [id, { callback, delay }] = timers.entries().next().value;
      timers.delete(id);
      time += delay;
      await callback();
    },
    async connect(input = config) {
      responses.push({ data: device });
      await service.signIn(input);
      responses.push({ data: token }, { data: { id: 'me' } });
      if (input.email) responses.push({ data: { value: [] } });
      if (input.teams) responses.push({ data: { value: [] } });
      await this.tick();
    },
  };
}

test('validates tenant-specific public-client configuration and requests only enabled delegated scopes', async () => {
  const app = setup();
  for (const invalid of [{}, { ...config, tenantId: 'common' }, { ...config, clientId: '--secret' },
    { ...config, email: false, teams: false }, { ...config, email: 'yes' }]) {
    assert.throws(() => validateConfig(invalid));
  }
  assert.equal(app.requests.length, 0);
  app.responses.push({ data: device });
  await app.service.signIn({ ...config, teams: false });
  const params = new URLSearchParams(app.requests[0].options.body);
  assert.match(params.get('scope'), /Mail.ReadBasic/);
  assert.match(params.get('scope'), /User.Read/);
  assert.match(params.get('scope'), /offline_access/);
  assert.doesNotMatch(params.get('scope'), /Chat.Read|Mail.ReadWrite|client_secret/);
  assert.equal(app.service.state.code, device.user_code);
  assert.doesNotMatch(JSON.stringify(app.states), /private-device-code/);
  app.service.disconnect();
});

test('device sign-in ignores response URLs and defaults an omitted polling interval to five seconds', async () => {
  for (const verificationUri of ['https://microsoft.com/devicelogin/',
    'https://login.microsoftonline.com/common/oauth2/deviceauth',
    'https://untrusted.invalid/private-value', undefined]) {
    const app = setup();
    const response = { ...device, verification_uri: verificationUri };
    delete response.interval;
    app.responses.push({ data: response });
    await app.service.signIn(config);
    assert.equal(app.service.state.verificationUrl, 'https://microsoft.com/devicelogin');
    assert.equal(app.service.state.code, device.user_code);
    assert.equal([...app.timers.values()][0].delay, 5000);
    assert.doesNotMatch(JSON.stringify(app.states), /untrusted|private-value|private-device-code/);
    app.responses.push({ data: token }, { data: { id: 'me' } },
      { data: { value: [] } }, { data: { value: [] } });
    await app.tick();
    assert.equal(app.service.state.status, 'connected');
    app.service.disconnect();
  }
});

test('malformed device sign-in responses identify invalid fields without exposing their values', async () => {
  for (const [field, value] of [
    ['device_code', ''], ['user_code', ' '], ['expires_in', 0],
    ['expires_in', 'private-value'], ['interval', null], ['interval', -1],
    ['interval', 'private-value'],
  ]) {
    const app = setup();
    app.responses.push({ data: { ...device, [field]: value } });
    await assert.rejects(app.service.signIn(config), new RegExp(`invalid or missing: ${field}`));
    assert.equal(app.service.state.status, 'error');
    assert.equal(app.service.device, null);
    assert.equal(app.timers.size, 0);
    assert.doesNotMatch(JSON.stringify(app.states), /private-value|private-device-code|USERCODE/);
  }
  const app = setup();
  app.responses.push({ data: null });
  await assert.rejects(app.service.signIn(config), /expected an object/);
  assert.equal(app.service.state.status, 'error');
});

test('device flow handles pending, slow down, approval, expiry, and denied consent without exposing secrets', async () => {
  const app = setup();
  app.responses.push({ data: device });
  await app.service.signIn(config);
  app.responses.push({ status: 400, data: { error: 'authorization_pending' } });
  await app.tick();
  assert.equal([...app.timers.values()][0].delay, 5000);
  app.responses.push({ status: 400, data: { error: 'slow_down' } });
  await app.tick();
  assert.equal([...app.timers.values()][0].delay, 10000);
  app.responses.push({ status: 400, data: { error: 'access_denied', error_description: 'PRIVATE DETAIL' } });
  await app.tick();
  assert.equal(app.service.state.status, 'error');
  assert.match(app.service.state.message, /access_denied/);
  assert.doesNotMatch(JSON.stringify(app.states), /PRIVATE DETAIL|private-device-code/);
  assert.equal(app.service.device, null);
  assert.equal(app.timers.size, 0);

  app.responses.push({ data: device });
  await app.service.signIn(config);
  app.advance(901000);
  await app.tick();
  assert.match(app.service.state.message, /expired/);
  assert.equal(app.timers.size, 0);
});

test('polls paged Inbox metadata and Teams previews, deduplicates, excludes old/self/system messages and emits generic alerts', async () => {
  const app = setup();
  await app.connect();
  assert.equal(app.service.state.status, 'connected');
  assert.equal(app.service.state.code, null);
  app.responses.push({
    data: { value: [mail('new-mail', 30000)], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skip=1' },
  }, {
    data: { value: [mail('new-mail', 30000), mail('other-mail', 31000), mail('old', -1000)] },
  }, {
    data: { value: [chat('incoming', 30000), chat('own', 30000, 'me'),
      chat('old', -1000), chat('system', 30000, 'other', { messageType: 'systemEventMessage' }),
      chat('deleted', 30000, 'other', { isDeleted: true })] },
  });
  await app.tick();
  assert.deepEqual(app.alerts, [{ source: 'email', count: 2 }, { source: 'teams', count: 1 }]);
  const mailRequest = app.requests.find(({ url }) => url.includes('/inbox/messages?'));
  const query = new URL(mailRequest.url).searchParams;
  assert.equal(query.get('$select'), 'id,receivedDateTime');
  assert.match(query.get('$filter'), /receivedDateTime ge/);
  app.responses.push({ data: { value: [mail('new-mail', 30000), mail('other-mail', 31000)] } },
    { data: { value: [chat('incoming', 30000)] } });
  await app.tick();
  assert.equal(app.alerts.length, 2);
  assert.doesNotMatch(JSON.stringify({ states: app.states, alerts: app.alerts, ids: [...app.service.seenChats] }),
    /PRIVATE MESSAGE CONTENT|private-access-token|private-refresh-token/);
  app.service.disconnect();
  assert.equal(app.service.token, null);
  assert.equal(app.service.refreshToken, null);
  assert.equal(app.service.seenMail.size, 0);
  assert.equal(app.service.seenChats.size, 0);
  assert.equal(app.timers.size, 0);
});

test('refreshes credentials in memory and stops with a visible error if consent is revoked', async () => {
  const app = setup();
  await app.connect({ ...config, teams: false });
  app.advance(3600000);
  app.responses.push({ data: { ...token, access_token: 'renewed-token' } }, { data: { value: [] } });
  await app.tick();
  assert.equal(app.service.token, 'renewed-token');
  assert.equal(new URLSearchParams(app.requests.at(-2).options.body).get('grant_type'), 'refresh_token');
  app.responses.push({ status: 401, data: { error: { code: 'InvalidAuthenticationToken' } } });
  await app.tick();
  assert.equal(app.service.state.status, 'error');
  assert.match(app.service.state.message, /revoked/);
  assert.equal(app.service.token, null);
  assert.equal(app.timers.size, 0);
});

test('honors throttling, reports per-source failures, and prevents off-host paging from leaking bearer tokens', async () => {
  const app = setup();
  await app.connect();
  app.responses.push({ status: 429, retry: '120', data: { error: { code: 'TooManyRequests' } } });
  await app.tick();
  assert.match(app.service.state.sources.email, /HTTP 429/);
  assert.equal([...app.timers.values()][0].delay, 120000);
  app.responses.push({ data: { value: [], '@odata.nextLink': 'https://untrusted.invalid/steal' } },
    { status: 403, data: { error: { code: 'Forbidden' } } });
  await app.tick();
  assert.match(app.service.state.sources.email, /unexpected paging URL/);
  assert.match(app.service.state.sources.teams, /HTTP 403/);
  assert.ok(app.requests.every(({ url }) => !url.includes('untrusted.invalid')));
  assert.throws(() => graphUrl('https://graph.microsoft.com@untrusted.invalid/v1.0/me'));
  assert.throws(() => graphUrl('https://graph.microsoft.com/beta/me'));
  app.service.disconnect();
});

test('disconnect cancels in-flight sign-in and polling without late credentials or alerts', async () => {
  const app = setup();
  app.responses.push({ data: device });
  await app.service.signIn(config);
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  app.responses.push({ pending });
  const checking = app.tick();
  const signal = app.requests.at(-1).options.signal;
  app.service.disconnect();
  assert.equal(signal.aborted, true);
  finish({ ok: true, json: async () => token });
  await checking;
  assert.equal(app.service.token, null);
  assert.equal(app.service.state.status, 'disconnected');
  assert.equal(app.timers.size, 0);
  await app.connect();
  app.responses.push({ pending: new Promise((resolve) => { finish = resolve; }) });
  const polling = app.tick();
  app.service.disconnect();
  finish({ ok: true, json: async () => ({ value: [mail('late', 90000)] }) });
  await polling;
  assert.deepEqual(app.alerts, []);
  assert.equal(app.timers.size, 0);
});

test('connection IPC is restricted to its own main frame and sign-in URL is fixed', async () => {
  const handlers = new Map();
  const opened = [];
  const windows = [];
  const notifications = [];
  class Notification extends EventEmitter {
    static isSupported() { return true; }
    constructor(options) { super(); this.options = options; notifications.push(this); }
    show() { this.shown = true; }
    close() { this.closed = true; this.emit('close'); }
  }
  class BrowserWindow extends EventEmitter {
    constructor() {
      super();
      this.webContents = { mainFrame: {}, send() {} };
      windows.push(this);
    }
    isDestroyed() { return false; }
    setMenuBarVisibility() {}
    loadFile() {}
  }
  const context = vm.createContext({
    require: (name) => {
      if (name === 'electron') return {
        app: { setName() {}, whenReady: () => ({ then() {} }), on() {}, getPath: () => __dirname },
        BrowserWindow,
        Notification,
        ipcMain: { handle: (name, handler) => handlers.set(name, handler), on() {} },
        shell: { openExternal: async (url) => opened.push(url) },
      };
      if (name === 'fs') return {
        readFileSync: () => { const error = new Error('Missing'); error.code = 'ENOENT'; throw error; },
      };
      return require(name);
    },
    __dirname: path.join(__dirname, '..', 'src'),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8') +
    '\nglobalThis.api = { showMicrosoft365, service: () => microsoft365 };', context);
  context.api.showMicrosoft365();
  const sender = windows[0].webContents;
  const event = { sender, senderFrame: sender.mainFrame };
  assert.throws(() => handlers.get('microsoft365:snapshot')({ sender: {} }), /only available/);
  assert.throws(() => handlers.get('microsoft365:snapshot')({ sender, senderFrame: {} }), /only available/);
  assert.equal(handlers.get('microsoft365:snapshot')(event).state.status, 'disconnected');
  context.api.service().onAlert({ source: 'email', count: 2, body: 'PRIVATE MESSAGE CONTENT' });
  assert.equal(notifications[0].shown, true);
  assert.equal(notifications[0].options.body, '2 new emails in your Outlook Inbox.');
  assert.doesNotMatch(JSON.stringify(notifications[0].options), /PRIVATE/);
  handlers.get('microsoft365:disconnect')(event);
  assert.equal(notifications[0].closed, true);
  await assert.rejects(handlers.get('microsoft365:open-sign-in')(event), /Start a Microsoft/);
  context.api.service().state = { status: 'signing-in', code: 'CODE' };
  await handlers.get('microsoft365:open-sign-in')(event, 'https://untrusted.invalid');
  assert.deepEqual(opened, ['https://microsoft.com/devicelogin']);
});

test('connection form shows sign-in codes and source errors safely and invokes only scoped actions', async () => {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, {
      value: '', checked: true, events: {},
      addEventListener(name, callback) { this.events[name] = callback; },
    });
    return elements.get(id);
  };
  let state = { status: 'disconnected', message: 'Not connected.', sources: {} };
  let onChange;
  let signedIn;
  let disconnected = false;
  let opened = false;
  const context = vm.createContext({
    document: { getElementById: element },
    window: {
      addEventListener() {},
      mapleMicrosoft365: {
        onChange: (callback) => { onChange = callback; return () => {}; },
        snapshot: async () => ({ config, state }),
        signIn: async (input) => {
          signedIn = input;
          state = { status: 'signing-in', message: 'Enter the code.', code: '<PLAIN CODE>', sources: {} };
          onChange(state);
        },
        openSignIn: async () => { opened = true; },
        disconnect: async () => {
          disconnected = true;
          state = { status: 'disconnected', message: 'Disconnected.', sources: {} };
          onChange(state);
        },
      },
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'microsoft365.js'), 'utf8'), context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(element('client-id').value, config.clientId);
  await element('connection-form').events.submit({ preventDefault() {} });
  assert.deepEqual(JSON.parse(JSON.stringify(signedIn)), config);
  assert.equal(element('device').hidden, false);
  assert.equal(element('code').textContent, '<PLAIN CODE>');
  assert.equal(element('connect').disabled, true);
  await element('open-sign-in').events.click();
  assert.equal(opened, true);
  onChange({ status: 'connected', message: 'Connected.', sources: { email: 'HTTP 403. Will retry.' } });
  assert.match(element('email-status').textContent, /HTTP 403/);
  assert.equal(element('device').hidden, true);
  await element('disconnect').events.click();
  assert.equal(disconnected, true);
  assert.equal(element('connect').disabled, false);
});

test('notification bridge strips IPC events, and alerts never overwrite chat or interrupt working animations', () => {
  const ipc = new EventEmitter();
  let bridge;
  const preloadContext = vm.createContext({ require: () => ({
    contextBridge: { exposeInMainWorld: (_name, api) => { bridge = api; } }, ipcRenderer: ipc,
  }) });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8'), preloadContext);
  const updates = [];
  const unsubscribe = bridge.onNotification((...args) => updates.push(args));
  ipc.emit('mascot:notification', { sender: 'private' }, { source: 'teams', text: 'New Teams message.' });
  assert.equal(updates[0].length, 1);
  unsubscribe();
  assert.equal(ipc.listenerCount('mascot:notification'), 0);

  let onNotification;
  const states = [];
  const elements = Object.fromEntries(['notification', 'notification-text', 'notification-dismiss'].map((id) => [
    id, { textContent: '', classes: new Set(['hidden']),
      classList: { add() {}, remove() {} }, addEventListener() {} },
  ]));
  const rendererContext = vm.createContext({
    busy: false,
    document: { getElementById: (id) => { assert.ok(elements[id], 'Must not touch chat'); return elements[id]; } },
    window: { addEventListener() {}, mascot: { onNotification: (callback) => { onNotification = callback; return () => {}; } } },
    Sprite: { setState: (state) => states.push(state) },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'notifications.js'), 'utf8'), rendererContext);
  onNotification({ source: 'email', text: '<plain text>' });
  assert.equal(elements['notification-text'].textContent, '<plain text>');
  assert.deepEqual(states, ['email_alert']);
  rendererContext.busy = true;
  onNotification({ source: 'teams', text: 'New message' });
  assert.deepEqual(states, ['email_alert']);
  rendererContext.busy = false;
  onNotification({ source: 'teams', text: 'New message' });
  assert.deepEqual(states, ['email_alert', 'teams_alert']);
  onNotification(null);
});
