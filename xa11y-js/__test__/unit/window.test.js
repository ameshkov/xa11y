// Window-management surface against the shared mock provider: Element /
// Locator window verbs, window state getters, and App.windows().
//
// The mock models window state mutations in place (minimize marks the window
// minimized and off-screen; restore reverses both).

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { _makeTestActionProbe, _makeTestApp, InvalidActionDataError } = require('../../index.js');

async function findDescendant(root, predicate) {
  const queue = [root];
  while (queue.length > 0) {
    const el = queue.shift();
    if (predicate(el)) return el;
    queue.push(...(await el.children()));
  }
  return null;
}

async function probeWindow(predicate, probe = _makeTestActionProbe()) {
  const app = await probe.locator().element();
  const el = await findDescendant(app, predicate);
  assert.ok(el, 'fixture element not found in mock tree');
  return { probe, el };
}

function lastAction(probe) {
  const log = probe.actions();
  assert.ok(log.length > 0, 'expected at least one recorded action');
  return log[log.length - 1];
}

// ── Element window verbs ────────────────────────────────────────────────

test('window verbs record their action names', async () => {
  const { probe, el } = await probeWindow((e) => e.role === 'window');
  for (const verb of ['raise', 'minimize', 'maximize', 'restore', 'close']) {
    probe.clear();
    await el[verb]();
    assert.equal(lastAction(probe)[1], verb);
  }
});

test('moveTo() records the coordinate payload', async () => {
  const { probe, el } = await probeWindow((e) => e.role === 'window');
  await el.moveTo(10, 20);
  const [, name, data] = lastAction(probe);
  assert.equal(name, 'move_to');
  assert.equal(data, '10,20');
});

test('resizeTo() records the dimension payload', async () => {
  const { probe, el } = await probeWindow((e) => e.role === 'window');
  await el.resizeTo(640, 480);
  const [, name, data] = lastAction(probe);
  assert.equal(name, 'resize_to');
  assert.equal(data, '640x480');
});

test('resizeTo() rejects zero dimensions before reaching the provider', async () => {
  const { probe, el } = await probeWindow((e) => e.role === 'window');
  await assert.rejects(el.resizeTo(0, 100), InvalidActionDataError);
  assert.deepEqual(probe.actions(), []);
});

test('window state getters default to null and round-trip minimize/restore', async () => {
  const { probe, el } = await probeWindow((e) => e.role === 'window');
  assert.equal(el.minimized, null);
  assert.equal(el.maximized, null);
  assert.equal(el.fullscreen, null);

  await el.minimize();
  const minimized = await probeWindow((e) => e.role === 'window', probe);
  assert.equal(minimized.el.minimized, true);
  assert.equal(minimized.el.maximized, null);
  assert.equal(minimized.el.visible, false);

  await minimized.el.restore();
  const restored = await probeWindow((e) => e.role === 'window', probe);
  assert.equal(restored.el.minimized, false);
  assert.equal(restored.el.visible, true);
});

// ── Locator window verbs (enabled-only auto-wait gate) ──────────────────

test('locator window verbs act on a minimized (invisible) window', async () => {
  const probe = _makeTestActionProbe();
  await probe.locator().descendant('window').minimize();
  // The window is now visible=false; the enabled-only gate must let restore
  // through — a visible-gated wait would time out after the default 5s.
  await probe.locator().descendant('window').restore();
  const log = probe.actions();
  assert.ok(log.some(([, action]) => action === 'restore'));
});

test('locator resizeTo() rejects zero before auto-wait', async () => {
  const probe = _makeTestActionProbe();
  const loc = probe.locator().descendant('window[name="never-matches"]');
  await assert.rejects(loc.resizeTo(0, 100), InvalidActionDataError);
});

// ── App.windows() ───────────────────────────────────────────────────────

test('App.windows() lists the app\'s window children', async () => {
  const app = _makeTestApp();
  const windows = await app.windows();
  assert.equal(windows.length, 1);
  assert.equal(windows[0].role, 'window');
  assert.equal(windows[0].name, 'Main Window');
  assert.equal(windows[0].minimized, null);
});
