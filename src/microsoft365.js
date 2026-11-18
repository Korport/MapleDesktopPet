const GRAPH = 'https://graph.microsoft.com/v1.0/';
const LOGIN = 'https://login.microsoftonline.com/';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateConfig(config) {
  if (!config || !GUID.test(config.clientId) || !GUID.test(config.tenantId)) {
    throw new Error('Enter the application (client) ID and directory (tenant) ID from your approved Entra app registration.');
  }
  if (typeof config.email !== 'boolean' || typeof config.teams !== 'boolean' ||
      (!config.email && !config.teams)) {
    throw new Error('Select Outlook email, Teams chats, or both.');
  }
  return {
    clientId: config.clientId,
    tenantId: config.tenantId,
    email: config.email,
    teams: config.teams,
  };
}

function graphUrl(value) {
  const url = new URL(value, GRAPH);
  if (url.origin !== 'https://graph.microsoft.com' ||
      !url.pathname.startsWith('/v1.0/') || url.username || url.password) {
    throw new Error('Microsoft Graph returned an unexpected paging URL.');
  }
  return url.href;
}

class Microsoft365 {
  constructor({ fetch: request = globalThis.fetch, onState, onAlert,
    now = Date.now, schedule = setTimeout, cancel = clearTimeout }) {
    this.fetch = request;
    this.onState = onState;
    this.onAlert = onAlert;
    this.now = now;
    this.schedule = schedule;
    this.cancel = cancel;
    this.generation = 0;
    this.state = { status: 'disconnected', message: 'Not connected.', sources: {} };
  }

  publish(update) {
    this.state = { ...this.state, ...update };
    this.onState(this.state);
  }

  disconnect() {
    this.generation++;
    this.cancel(this.timer);
    this.controller?.abort();
    this.controller = null;
    this.token = null;
    this.refreshToken = null;
    this.device = null;
    this.userId = null;
    this.seenMail = new Set();
    this.seenChats = new Map();
    this.publish({ status: 'disconnected', message: 'Not connected. Sign in again after restarting Maple.',
      code: null, verificationUrl: null, sources: {} });
  }

  async request(url, options = {}) {
    const response = await this.fetch(url, {
      ...options,
      signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(30000)]),
    });
    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error(`Microsoft returned an unreadable response (HTTP ${response.status}).`);
    }
    if (!response.ok) {
      const code = typeof data.error === 'string' ? data.error : data.error?.code;
      const error = new Error(`Microsoft request failed (HTTP ${response.status}${/^[\w.-]+$/.test(code || '') ? `, ${code}` : ''}).`);
      error.code = code;
      error.status = response.status;
      const retry = Number(response.headers.get('retry-after'));
      error.retryMs = Number.isFinite(retry) && retry > 0 ? Math.min(retry * 1000, 3600000) : 60000;
      throw error;
    }
    return data;
  }

  oauth(endpoint, values) {
    return this.request(`${LOGIN}${this.config.tenantId}/oauth2/v2.0/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(values).toString(),
    });
  }

  async signIn(input) {
    const config = validateConfig(input);
    this.disconnect();
    this.config = config;
    this.controller = new AbortController();
    const generation = this.generation;
    this.publish({ status: 'signing-in', message: 'Requesting a Microsoft sign-in code...' });
    const scopes = ['https://graph.microsoft.com/User.Read', 'offline_access'];
    if (config.email) scopes.push('https://graph.microsoft.com/Mail.ReadBasic');
    if (config.teams) scopes.push('https://graph.microsoft.com/Chat.ReadBasic');
    try {
      const device = await this.oauth('devicecode', {
        client_id: config.clientId, scope: scopes.join(' '),
      });
      if (generation !== this.generation) return;
      if (typeof device.device_code !== 'string' || typeof device.user_code !== 'string' ||
          !Number.isFinite(device.expires_in) || device.expires_in <= 0 ||
          !Number.isFinite(device.interval) || device.interval <= 0 ||
          device.verification_uri !== 'https://microsoft.com/devicelogin') {
        throw new Error('Microsoft returned an invalid device sign-in response.');
      }
      this.device = device.device_code;
      this.deviceExpires = this.now() + device.expires_in * 1000;
      this.interval = Math.max(5000, device.interval * 1000);
      this.publish({ code: device.user_code, verificationUrl: device.verification_uri,
        message: 'Open Microsoft sign-in, enter this code, and approve only your expected organization and app.' });
      this.timer = this.schedule(() => this.checkSignIn(generation), this.interval);
    } catch (error) {
      if (generation === this.generation) this.fail(error);
      throw error;
    }
  }

  fail(error) {
    this.disconnect();
    this.publish({ status: 'error', message: `${error.message} Check the app registration, consent, and your organization's sign-in policy.` });
  }

  async checkSignIn(generation) {
    if (generation !== this.generation) return;
    try {
      if (this.now() >= this.deviceExpires) throw new Error('The Microsoft sign-in code expired.');
      const result = await this.oauth('token', {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: this.config.clientId,
        device_code: this.device,
      });
      if (generation !== this.generation) return;
      this.acceptToken(result);
      this.device = null;
      const me = await this.graph('me?$select=id');
      if (generation !== this.generation) return;
      if (typeof me.id !== 'string' || !me.id) throw new Error('Microsoft did not return a user ID.');
      this.userId = me.id;
      this.startedAt = this.now();
      this.mailSince = this.startedAt;
      this.publish({ status: 'connected', code: null, verificationUrl: null,
        message: 'Connected. Checking about once a minute while Maple is running.' });
      await this.poll(generation);
    } catch (error) {
      if (generation !== this.generation) return;
      if (error.code === 'authorization_pending' || error.code === 'slow_down') {
        if (error.code === 'slow_down') this.interval += 5000;
        this.timer = this.schedule(() => this.checkSignIn(generation), this.interval);
      } else {
        this.fail(error);
      }
    }
  }

  acceptToken(result) {
    if (typeof result.access_token !== 'string' || !result.access_token ||
        !Number.isFinite(result.expires_in) || result.expires_in <= 0) {
      throw new Error('Microsoft returned an invalid access token response.');
    }
    this.token = result.access_token;
    if (result.refresh_token) this.refreshToken = result.refresh_token;
    this.tokenExpires = this.now() + result.expires_in * 1000;
  }

  async graph(url) {
    return this.request(graphUrl(url), { headers: { Authorization: `Bearer ${this.token}` } });
  }

  async pages(url, generation) {
    const items = [];
    const visited = new Set();
    while (url) {
      if (generation !== this.generation) return [];
      url = graphUrl(url);
      if (visited.has(url) || visited.size >= 100) {
        throw new Error('Microsoft Graph paging limit reached; notifications may be delayed.');
      }
      visited.add(url);
      const page = await this.graph(url);
      if (generation !== this.generation) return [];
      if (!Array.isArray(page.value)) throw new Error('Microsoft Graph returned an invalid list.');
      items.push(...page.value);
      url = page['@odata.nextLink'];
      if (url != null && typeof url !== 'string') throw new Error('Microsoft Graph returned invalid paging data.');
    }
    return items;
  }

  async email(generation) {
    const checkedAt = this.now();
    const since = new Date(this.mailSince).toISOString();
    const query = new URLSearchParams({
      '$select': 'id,receivedDateTime', '$filter': `receivedDateTime ge ${since}`,
      '$orderby': 'receivedDateTime desc', '$top': '100',
    });
    const items = await this.pages(`me/mailFolders/inbox/messages?${query}`, generation);
    if (generation !== this.generation) return;
    let count = 0;
    for (const item of items) {
      if (typeof item.id !== 'string' || !Number.isFinite(Date.parse(item.receivedDateTime))) {
        throw new Error('Microsoft Graph returned invalid email metadata.');
      }
      if (Date.parse(item.receivedDateTime) > this.startedAt && !this.seenMail.has(item.id)) count++;
      this.seenMail.add(item.id);
    }
    // Overlap polls to tolerate eventual consistency, deduplicating by message ID.
    this.mailSince = Math.max(this.startedAt, checkedAt - 300000);
    while (this.seenMail.size > 10000) this.seenMail.delete(this.seenMail.values().next().value);
    if (count) this.onAlert({ source: 'email', count });
  }

  async teams(generation) {
    const chats = await this.pages('me/chats?$expand=lastMessagePreview&$top=50', generation);
    if (generation !== this.generation) return;
    let count = 0;
    for (const chat of chats) {
      if (typeof chat.id !== 'string') throw new Error('Microsoft Graph returned invalid chat metadata.');
      const message = chat.lastMessagePreview;
      if (!message) continue;
      if (typeof message.id !== 'string' || !Number.isFinite(Date.parse(message.createdDateTime))) {
        throw new Error('Microsoft Graph returned invalid Teams message metadata.');
      }
      if (this.seenChats.get(chat.id) !== message.id &&
          Date.parse(message.createdDateTime) > this.startedAt &&
          message.from?.user?.id && message.from.user.id !== this.userId &&
          !message.isDeleted && message.messageType === 'message') count++;
      // Discard any body/preview text returned by Graph; retain IDs only.
      this.seenChats.set(chat.id, message.id);
    }
    if (count) this.onAlert({ source: 'teams', count });
  }

  async poll(generation) {
    if (generation !== this.generation) return;
    let delay = 60000;
    try {
      if (this.now() >= this.tokenExpires - 60000) {
        if (!this.refreshToken) throw new Error('Microsoft sign-in expired. Please reconnect.');
        const result = await this.oauth('token', {
          grant_type: 'refresh_token', client_id: this.config.clientId, refresh_token: this.refreshToken,
        });
        if (generation !== this.generation) return;
        this.acceptToken(result);
      }
      for (const source of ['email', 'teams']) {
        if (!this.config[source]) continue;
        if (generation !== this.generation) return;
        try {
          await this[source](generation);
          if (generation !== this.generation) return;
          this.publish({ sources: { ...this.state.sources, [source]: 'Checking successfully.' } });
        } catch (error) {
          if (generation !== this.generation) return;
          if (error.status === 401) throw new Error('Microsoft authorization expired or was revoked. Please reconnect.');
          this.publish({ sources: { ...this.state.sources, [source]: `${error.message} Will retry.` } });
          delay = Math.max(delay, error.retryMs || 60000);
          if (error.status === 429 || error.status === 503) break;
        }
      }
    } catch (error) {
      if (generation === this.generation) this.fail(error);
      return;
    }
    if (generation === this.generation) this.timer = this.schedule(() => this.poll(generation), delay);
  }
}

module.exports = { Microsoft365, validateConfig, graphUrl };
