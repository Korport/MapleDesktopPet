const output = document.getElementById('output');
const follow = document.getElementById('follow');
const status = document.getElementById('status');
const download = document.getElementById('download');
const downloadStatus = document.getElementById('download-status');
let receivedLiveUpdate = false;
let hasOutput = false;
let downloading = false;

function render(text) {
  hasOutput = Boolean(text);
  download.disabled = downloading || !hasOutput;
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

download.addEventListener('click', async () => {
  if (downloading || !hasOutput) return;
  downloading = true;
  download.disabled = true;
  downloadStatus.textContent = 'Choose where to save the activity log...';
  try {
    const result = await window.mapleActivity.download();
    downloadStatus.textContent = result.canceled
      ? 'Download canceled.'
      : `Activity log saved to ${result.filePath}`;
  } catch (error) {
    downloadStatus.textContent = `Unable to save activity log: ${error.message}`;
  } finally {
    downloading = false;
    download.disabled = !hasOutput;
  }
});
window.addEventListener('beforeunload', unsubscribe, { once: true });
