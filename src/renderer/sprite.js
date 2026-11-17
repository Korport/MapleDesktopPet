/**
 * Sprite-based mascot ("Maple"). Swaps a single <img> between
 * pre-rendered PNGs instead of drawing on canvas. Mirrors the old Orb API
 * (start/setState/setAmplitude) so renderer.js barely had to change.
 *
 * States fall into three buckets:
 *  - 'idle'       : a loop that auto-cycles through idle sub-poses and naps
 *                   after a while with no interaction.
 *  - persistent   : thinking / talking / listening — stay until the caller
 *                   changes state (driven by the Copilot request lifecycle).
 *  - reactions    : everything else — shown briefly, then auto-revert to idle.
 */
const Sprite = (() => {
  const img = document.getElementById('sprite');
  const stateLabel = document.getElementById('state-label');
  const BASE = '../assets/sprites/';

  const FILES = {
    idle_neutral: '01-neutral.png',
    idle_blink: '02-blink.png',
    idle_tail_swish: '03-tail-swish.png',
    idle_yawn: '04-yawn.png',
    idle_sleep: '05-sleep.png',
    idle_stretch: '06-stretch.png',
    thinking: '07-thinking.png',
    talking: '08-talking.png',
    listening: '09-listening.png',
    happy: '10-happy-successful.png',
    confused: '11-confused-error.png',
    celebrating: '12-celebrating.png',
    concerned: '13-concerned-worried.png',
    surprised: '14-surprised.png',
    loving: '15-loving-touched.png',
    laughing: '16-laughing.png',
    embarrassed: '17-embarrassed-shy.png',
    proud: '18-proud-confident.png',
    sad: '19-sad-apologetic.png',
    greeting: '20-greeting-wave.png',
    goodbye: '21-goodbye.png',
    startled: '22-startled-dragged.png',
    ack: '23-quick-acknowledgement.png',
  };

  // Idle sub-poses cycle automatically while resting. Weighted so the plain
  // neutral pose dominates and the rarer ones (yawn/stretch) feel special.
  const IDLE_CYCLE = [
    { key: 'idle_neutral', weight: 6 },
    { key: 'idle_blink', weight: 3 },
    { key: 'idle_tail_swish', weight: 2 },
    { key: 'idle_yawn', weight: 1 },
    { key: 'idle_stretch', weight: 1 },
  ];
  const IDLE_TICK_MS = 5000;
  const SLEEP_AFTER_MS = 90000; // uninterrupted idling this long -> nap

  // Ongoing activity states: stay on screen until explicitly changed.
  const PERSISTENT = new Set(['thinking', 'talking', 'listening']);

  // How long a reaction stays up before auto-returning to idle (ms).
  const REACTION_DURATION = {
    happy: 2600,
    confused: 2600,
    celebrating: 3200,
    concerned: 2400,
    surprised: 2000,
    loving: 2600,
    laughing: 2800,
    embarrassed: 2400,
    proud: 2600,
    sad: 2600,
    greeting: 2000,
    goodbye: 2000,
    startled: 1200,
    ack: 900,
  };

  let state = 'idle';
  let amplitude = 0;
  let idleLoopTimer = null;
  let revertTimer = null;
  let idleSince = 0;

  function pickWeighted(list) {
    const total = list.reduce((sum, item) => sum + item.weight, 0);
    let r = Math.random() * total;
    for (const item of list) {
      if (r < item.weight) return item.key;
      r -= item.weight;
    }
    return list[0].key;
  }

  function show(key) {
    img.src = BASE + FILES[key];
    if (stateLabel) stateLabel.textContent = key.replace(/_/g, ' ');
  }

  function stopIdleLoop() {
    if (idleLoopTimer) {
      clearInterval(idleLoopTimer);
      idleLoopTimer = null;
    }
  }

  function startIdleLoop() {
    stopIdleLoop();
    idleSince = Date.now();
    show('idle_neutral');
    idleLoopTimer = setInterval(() => {
      const napping = Date.now() - idleSince > SLEEP_AFTER_MS;
      show(napping ? 'idle_sleep' : pickWeighted(IDLE_CYCLE));
    }, IDLE_TICK_MS);
  }

  function clearRevert() {
    if (revertTimer) {
      clearTimeout(revertTimer);
      revertTimer = null;
    }
  }

  function setState(next) {
    if (next !== 'idle' && !FILES[next]) return;
    clearRevert();

    if (next === 'idle') {
      state = 'idle';
      startIdleLoop();
      return;
    }

    stopIdleLoop();
    state = next;
    show(next);

    if (PERSISTENT.has(next)) return; // stays until caller changes it

    const duration = REACTION_DURATION[next] ?? 2200;
    revertTimer = setTimeout(() => setState('idle'), duration);
  }

  function setAmplitude(v) {
    // No per-frame talk/listen animation frames (yet) — use amplitude to add
    // a tiny lively bounce via CSS instead of swapping images.
    amplitude = Math.max(0, Math.min(1, v));
    const scale = 1 + amplitude * 0.04;
    img.style.transform = `scale(${scale})`;
  }

  function start() {
    setState('greeting'); // waves hello on launch, then settles into idle
  }

  return { start, setState, setAmplitude, get state() { return state; } };
})();
