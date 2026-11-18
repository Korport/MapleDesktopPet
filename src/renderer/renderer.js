// Renderer wiring: chat input, click-through toggle, and the Copilot CLI
// bridge. Voice/mic input is deferred — see MVP notes; revisit later.

Sprite.start();

const bubble = document.getElementById('bubble');
const bubbleText = document.getElementById('bubble-text');
const bubbleClose = document.getElementById('bubble-close');
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');
const clickThroughBtn = document.getElementById('click-through-btn');
const thinkingBubble = document.getElementById('thinking-bubble');
const thinkingLabel = document.getElementById('thinking-label');
const thinkingText = document.getElementById('thinking-text');
const submitButton = chatForm.querySelector('button[type="submit"]');

let clickThroughEnabled = false;
let busy = false;
let thinking = false;

const stopProgress = window.mascot.onProgress(({ label, text }) => {
  if (!thinking) return;
  thinkingLabel.textContent = label;
  thinkingText.textContent = text;
  thinkingText.scrollTop = thinkingText.scrollHeight;
});
window.addEventListener('beforeunload', stopProgress);

function showBubble(text) {
  bubbleText.textContent = text;
  bubble.classList.remove('hidden');
}

function hideBubble() {
  bubble.classList.add('hidden');
}

bubbleClose.addEventListener('click', () => hideBubble());

// --- Copilot bridge --------------------------------------------------------
// Talks to the GitHub Copilot CLI via the main-process bridge (src/main.js).
// Thinking -> talking while the reply streams in, then a reaction pose
// picked from the reply content before settling back to idle.
async function askBrain(message) {
  if (busy) return;
  busy = true;
  thinking = true;
  submitButton.disabled = true;
  chatForm.setAttribute('aria-busy', 'true');
  hideBubble();
  thinkingLabel.textContent = 'Thinking';
  thinkingText.textContent = 'Connecting to GitHub Copilot...';
  thinkingBubble.classList.remove('hidden');
  Sprite.setState('thinking');

  let reply;
  let failed = false;
  try {
    reply = await window.mascot.askCopilot(message);
    if (!reply) reply = '(Copilot returned an empty response.)';
  } catch (err) {
    reply = `Error talking to Copilot: ${err.message || err}`;
    failed = true;
  }

  thinking = false;
  thinkingBubble.classList.add('hidden');
  Sprite.setState('talking');
  const durationMs = Math.min(4000, 900 + reply.length * 35);
  showBubble(reply);
  await animateTalking(durationMs);

  Sprite.setState(pickReaction(reply, failed));
  busy = false;
  submitButton.disabled = false;
  chatForm.setAttribute('aria-busy', 'false');
}

// Lightweight keyword heuristic to pick a reaction pose for the reply —
// no sentiment model, just enough to feel alive without extra plumbing.
function pickReaction(reply, failed) {
  const text = reply.toLowerCase();
  if (failed || /\berror\b|\bsorry\b|\bcan't\b|\bcannot\b|\bunable\b|\bfailed\b/.test(text)) {
    return failed ? 'confused' : 'concerned';
  }
  if (/[!?]{2,}|\bawesome\b|\bgreat\b|\bcongrat/.test(text)) {
    return 'celebrating';
  }
  if (/\bthank/.test(text)) {
    return 'loving';
  }
  return 'happy';
}

function animateTalking(durationMs) {
  return new Promise((resolve) => {
    const start = performance.now();
    function tick(now) {
      const elapsed = now - start;
      // Fake syllable envelope: random-ish bursts rather than a flat hum.
      const env = Math.abs(Math.sin(elapsed / 90)) * (0.4 + Math.random() * 0.6);
      Sprite.setAmplitude(env);
      if (elapsed < durationMs) {
        requestAnimationFrame(tick);
      } else {
        Sprite.setAmplitude(0);
        resolve();
      }
    }
    requestAnimationFrame(tick);
  });
}

// --- Chat form -------------------------------------------------------------
chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text || busy) return;
  chatInput.value = '';
  askBrain(text);
});

// --- Click-through toggle ---------------------------------------------------
clickThroughBtn.addEventListener('click', () => {
  clickThroughEnabled = !clickThroughEnabled;
  window.mascot.setClickThrough(clickThroughEnabled);
  clickThroughBtn.style.opacity = clickThroughEnabled ? '0.5' : '1';
  if (Sprite.state === 'idle') Sprite.setState('ack');
});

// Alt+Shift+C is also bound globally in main.js; keep local state roughly in
// sync by re-reading on focus (good enough for MVP).

// --- Dynamic window sizing --------------------------------------------------
// The window has no native content-based auto-sizing, so we measure #app's
// actual rendered height (it grows/shrinks with the bubble) and ask main.js
// to resize the OS window to match, anchored to the same bottom-right spot.
const appEl = document.getElementById('app');
const resizeObserver = new ResizeObserver(() => {
  window.mascot.resizeContent(appEl.offsetHeight);
});
resizeObserver.observe(appEl);
