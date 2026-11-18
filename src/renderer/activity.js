const output = document.getElementById('output');
const follow = document.getElementById('follow');
const status = document.getElementById('status');
const download = document.getElementById('download');
const downloadStatus = document.getElementById('download-status');
let receivedLiveUpdate = false;
let hasOutput = false;
let downloading = false;
let receivedUsageUpdate = false;

function renderUsage(usage) {
  const totals = usage.totals;
  const format = (value, digits = 0) => value == null
    ? 'Unavailable' : value.toLocaleString(undefined, { maximumFractionDigits: digits });
  const total = totals?.inputTokens != null && totals?.outputTokens != null
    ? totals.inputTokens + totals.outputTokens : null;
  document.getElementById('usage-total').textContent = format(total);
  document.getElementById('usage-input').textContent = format(totals?.inputTokens);
  document.getElementById('usage-output').textContent = format(totals?.outputTokens);
  const credits = totals?.aiCredits;
  document.getElementById('usage-credits').textContent =
    (credits > 0 && credits < 0.000001 ? '<0.000001' : format(credits, 6)) +
    (credits != null && totals.aiCreditsStatus === 'partial' ? ' (partial)' : '');
  document.getElementById('usage-requests').textContent = format(totals?.premiumRequests, 4);
  document.getElementById('usage-details').textContent =
    `Session ${usage.sessionId} | ${usage.turns} messages | ` +
    `Cache read: ${format(totals?.cacheReadTokens)} | ` +
    `Cache written: ${format(totals?.cacheWriteTokens)} | Reasoning: ${format(totals?.reasoningTokens)}`;
  document.getElementById('usage-status').textContent = usage.error
    ? `${usage.error} Totals above are the last successful report, if any.`
    : usage.updating
      ? 'Working... totals will refresh when this reply finishes.'
      : totals ? 'Reported cumulative usage for this session.'
        : 'No usage reported yet. Send Maple a message to begin.';
}

const unsubscribeUsage = window.mapleActivity.onUsageChange((usage) => {
  receivedUsageUpdate = true;
  renderUsage(usage);
});
window.mapleActivity.usage().then((usage) => {
  if (!receivedUsageUpdate) renderUsage(usage);
}).catch((error) => {
  document.getElementById('usage-status').textContent = `Unable to load session usage: ${error.message}`;
});

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
window.addEventListener('beforeunload', () => {
  unsubscribe();
  unsubscribeUsage();
}, { once: true });
