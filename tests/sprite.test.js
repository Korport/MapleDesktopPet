const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'sprite.js'), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));

function animation(durations) {
  const padding = Buffer.alloc(10);
  padding.write('JUNK');
  padding.writeUInt32LE(1, 4);
  const chunks = durations.map(duration => {
    const chunk = Buffer.alloc(24);
    chunk.write('ANMF');
    chunk.writeUInt32LE(16, 4);
    chunk.writeUIntLE(duration, 20, 3);
    return chunk;
  });
  const header = Buffer.alloc(12);
  header.write('RIFF');
  header.writeUInt32LE(4 + padding.length + chunks.length * 24, 4);
  header.write('WEBP', 8);
  return Buffer.concat([header, padding, ...chunks]);
}

function setup(fetchData = async () => animation([150])) {
  const blobs = [];
  const errors = [];
  const assignments = [];
  const image = { style: {}, set src(value) { assignments.push(value); } };
  let fetches = 0;
  const context = vm.createContext({
    document: { getElementById: id => id === 'sprite' ? image : {} },
    fetch: async source => {
      fetches++;
      const data = await fetchData(source);
      return { ok: true, arrayBuffer: async () => Uint8Array.from(data).buffer };
    },
    Blob,
    URL: { createObjectURL: blob => {
      blobs.push(blob);
      return `blob:maple-${blobs.length}`;
    } },
    console: { error: (...args) => errors.push(args) },
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: () => 1,
    clearInterval() {},
  });
  vm.runInContext(`${script}\nglobalThis.sprite = Sprite;`, context);
  return { sprite: context.sprite, blobs, errors, assignments, get fetches() { return fetches; } };
}

test('speeds up every frame, preserves other bytes and avoids Chromium short-delay clamping', async () => {
  const original = animation([150, 450, 15, 100000]);
  const app = setup(async () => original);
  app.sprite.setState('thinking');
  await settle();
  const actual = Buffer.from(await app.blobs[0].arrayBuffer());
  const expected = Buffer.from(original);
  [100, 300, 20, 66667].forEach((duration, index) => {
    expected.writeUIntLE(duration, 22 + index * 24 + 20, 3);
  });
  assert.deepEqual(actual, expected);
  assert.equal(app.blobs[0].type, 'image/webp');
});

test('caches retimed animations and does not restart an unchanged loop', async () => {
  const app = setup();
  app.sprite.setState('thinking');
  await settle();
  app.sprite.setState('thinking');
  await settle();
  assert.equal(app.assignments.length, 1);
  app.sprite.setState('talking');
  await settle();
  app.sprite.setState('thinking');
  await settle();
  assert.equal(app.fetches, 2);
  assert.equal(app.blobs.length, 2);
  assert.equal(app.assignments.at(-1), 'blob:maple-1');
});

test('a late animation load cannot overwrite a newer extra-pack animation', async () => {
  let resolve;
  const app = setup(source => source.endsWith('maple-thinking.webp')
    ? new Promise(done => { resolve = done; })
    : animation([150]));
  app.sprite.setState('thinking');
  app.sprite.setState('talking');
  await settle();
  assert.deepEqual(app.assignments, ['blob:maple-1']);
  resolve(animation([150]));
  await settle();
  assert.deepEqual(app.assignments, ['blob:maple-1']);
});

test('invalid animation data logs an error and retains original playback', async () => {
  const app = setup(async () => Buffer.from('not a WebP'));
  app.sprite.setState('thinking');
  await settle();
  assert.equal(app.errors.length, 1);
  assert.match(app.assignments[0], /maple-thinking\.webp$/);
  assert.equal(app.blobs.length, 0);
});

test('plays the supplied animation pack for matching states', async () => {
  const states = {
    idle: 'maple-idle.webp',
    greeting: 'maple-wave.webp',
    thinking: 'maple-thinking.webp',
    listening: 'maple-ear-perk.webp',
    happy: 'maple-happy.webp',
    celebrating: 'maple-happy.webp',
    confused: 'maple-head-tilt.webp',
    ack: 'maple-ear-perk.webp',
    email_alert: 'maple-email-alert.webp',
    teams_alert: 'maple-teams-alert.webp',
  };
  for (const [state, filename] of Object.entries(states)) {
    const app = setup(async source => {
      assert.equal(source, `../assets/Maple-Animation-Pack/Maple-Animations/${filename}`);
      return fs.readFileSync(path.resolve(__dirname, '..', 'src', 'renderer', source));
    });

    app.sprite.setState(state);
    await settle();
    assert.deepEqual(app.errors, [], state);
    assert.equal(app.blobs.length, 1, state);
    assert.deepEqual(app.assignments, ['blob:maple-1'], state);
  }
});

test('replaces all remaining static poses with the supplied extra animations', async () => {
  const states = {
    idle_yawn: 'maple-yawning.webp',
    idle_sleep: 'maple-sleeping.webp',
    idle_stretch: 'maple-stretching.webp',
    talking: 'maple-talking.webp',
    concerned: 'maple-concerned.webp',
    surprised: 'maple-surprised.webp',
    loving: 'maple-loving.webp',
    laughing: 'maple-laughing.webp',
    embarrassed: 'maple-shy.webp',
    proud: 'maple-proud.webp',
    sad: 'maple-sad.webp',
    goodbye: 'maple-goodbye.webp',
    startled: 'maple-startled-dragged.webp',
  };
  for (const [state, filename] of Object.entries(states)) {
    const app = setup(async source => {
      assert.equal(source, `../assets/Maple-Extra-Animations/${filename}`);
      return fs.readFileSync(path.resolve(__dirname, '..', 'src', 'renderer', source));
    });
    app.sprite.setState(state);
    await settle();
    assert.deepEqual(app.errors, [], state);
    assert.equal(app.blobs.length, 1, state);
    assert.deepEqual(app.assignments, ['blob:maple-1'], state);
    const bytes = Buffer.from(await app.blobs[0].arrayBuffer());
    let frames = 0;
    for (let offset = 12; offset < bytes.length;) {
      const size = bytes.readUInt32LE(offset + 4);
      if (bytes.toString('ascii', offset, offset + 4) === 'ANMF') frames++;
      offset += 8 + size + size % 2;
    }
    assert.ok(frames > 1, `${state} must be animated`);
  }
});
