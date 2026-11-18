const bridge = window.mapleMicrosoft365;
const form = document.getElementById('connection-form');
const connect = document.getElementById('connect');
const errorText = document.getElementById('error');
let live = false;
let submitting = false;

function render(state) {
  document.getElementById('status').textContent = state.message;
  document.getElementById('device').hidden = !state.code;
  document.getElementById('code').textContent = state.code || '';
  const locked = state.status === 'signing-in' || state.status === 'connected';
  connect.disabled = locked || submitting;
  for (const id of ['client-id', 'tenant-id', 'email', 'teams']) {
    document.getElementById(id).disabled = locked || submitting;
  }
  document.getElementById('email-status').textContent = state.sources.email ? `Outlook: ${state.sources.email}` : '';
  document.getElementById('teams-status').textContent = state.sources.teams ? `Teams: ${state.sources.teams}` : '';
}

const unsubscribe = bridge.onChange((state) => {
  live = true;
  render(state);
});
bridge.snapshot().then(({ state, config }) => {
  if (config) {
    document.getElementById('client-id').value = config.clientId;
    document.getElementById('tenant-id').value = config.tenantId;
    document.getElementById('email').checked = config.email;
    document.getElementById('teams').checked = config.teams;
  }
  if (!live) render(state);
}).catch((error) => { errorText.textContent = `Unable to load connection: ${error.message}`; });

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (submitting) return;
  submitting = true;
  connect.disabled = true;
  errorText.textContent = '';
  try {
    await bridge.signIn({
      clientId: document.getElementById('client-id').value.trim(),
      tenantId: document.getElementById('tenant-id').value.trim(),
      email: document.getElementById('email').checked,
      teams: document.getElementById('teams').checked,
    });
  } catch (error) {
    errorText.textContent = `Unable to connect: ${error.message}`;
  } finally {
    submitting = false;
    try {
      render((await bridge.snapshot()).state);
    } catch (error) {
      errorText.textContent = `Unable to refresh connection: ${error.message}`;
    }
  }
});
document.getElementById('disconnect').addEventListener('click', async () => {
  try {
    errorText.textContent = '';
    await bridge.disconnect();
  } catch (error) {
    errorText.textContent = `Unable to disconnect: ${error.message}`;
  }
});
document.getElementById('open-sign-in').addEventListener('click', async () => {
  try {
    await bridge.openSignIn();
  } catch (error) {
    errorText.textContent = `Unable to open Microsoft sign-in: ${error.message}`;
  }
});
window.addEventListener('beforeunload', unsubscribe, { once: true });
