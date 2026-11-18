const output = document.getElementById('output');
const follow = document.getElementById('follow');
const status = document.getElementById('status');
let receivedLiveUpdate = false;

function render(text) {
  output.textContent = text || 'No activity yet. Send Maple a message to begin.';
  status.textContent = 'Connected | Recent output is kept in memory only';
  if (follow.checked) output.scrollTop = output.scrollHeight;
}

const unsubscribe = window.mapleActivity.onChange((text) => {
  receivedLiveUpdate = true;
  render(text);
});

window.mapleActivity.snapshot().then((text) => {
  if (!receivedLiveUpdate) render(text);
}).catch((error) => {
  status.textContent = `Unable to load activity: ${error.message}`;
});

follow.addEventListener('change', () => {
  if (follow.checked) output.scrollTop = output.scrollHeight;
});
window.addEventListener('beforeunload', unsubscribe, { once: true });
