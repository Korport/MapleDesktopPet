/**
 * Sprite-based mascot ("Maple"). Swaps a single <img> between
 * animated WebPs and PNG poses instead of drawing on canvas. Mirrors the old Orb API
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
  const ANIMATION_BASE = '../assets/Maple-Animation-Pack/Maple-Animations/';
  const ANIMATIONS = {
    idle_neutral: 'maple-idle.webp',
    idle_blink: 'maple-idle.webp',
    idle_tail_swish: 'maple-idle.webp',
    thinking: 'maple-thinking.webp',
    listening: 'maple-ear-perk.webp',
    happy: 'maple-happy.webp',
    celebrating: 'maple-happy.webp',
    confused: 'maple-head-tilt.webp',
    greeting: 'maple-wave.webp',
    ack: 'maple-ear-perk.webp',
  };
  const animationCache = new Map();
  let requestedSource = null;
  let showVersion = 0;

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
    if (stateLabel) stateLabel.textContent = key.replace(/_/g, ' ');
    const source = ANIMATIONS[key] ? ANIMATION_BASE + ANIMATIONS[key] : BASE + FILES[key];
    if (source === requestedSource) return;
    requestedSource = source;
    const version = ++showVersion;
    if (!ANIMATIONS[key]) {
      img.src = source;
      return;
    }
    if (!animationCache.has(source)) {
      animationCache.set(source, loadAnimation(source));
    }
    animationCache.get(source).then(url => {
      if (version === showVersion) img.src = url;
    });
  }

  async function loadAnimation(source) {
    try {
      const response = await fetch(source);
      if (!response.ok) throw new Error(`Could not load ${source}`);
      const buffer = await response.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      const view = new DataView(buffer);
      const tag = offset => String.fromCharCode(...bytes.subarray(offset, offset + 4));
      if (bytes.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WEBP' ||
          view.getUint32(4, true) + 8 !== bytes.length) {
        throw new Error(`Invalid WebP: ${source}`);
      }
      let frames = 0;
      for (let offset = 12; offset < bytes.length;) {
        if (offset + 8 > bytes.length) throw new Error(`Truncated WebP: ${source}`);
        const size = view.getUint32(offset + 4, true);
        const end = offset + 8 + size + (size % 2);
        if (end > bytes.length) throw new Error(`Truncated WebP chunk: ${source}`);
        if (tag(offset) === 'ANMF') {
          if (size < 16) throw new Error(`Invalid WebP frame: ${source}`);
          const position = offset + 20;
          const duration = bytes[position] | bytes[position + 1] << 8 | bytes[position + 2] << 16;
          // Chromium replaces delays below 11ms with 100ms; keep fast frames above that floor.
          const faster = Math.max(20, Math.round(duration / 1.5));
          bytes[position] = faster & 255;
          bytes[position + 1] = (faster >> 8) & 255;
          bytes[position + 2] = (faster >> 16) & 255;
          frames++;
        }
        offset = end;
      }
      if (!frames) throw new Error(`No animation frames: ${source}`);
      return URL.createObjectURL(new Blob([buffer], { type: 'image/webp' }));
    } catch (error) {
      console.error('Maple animation loading failed; using original playback.', source, error);
      return source;
    }
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
