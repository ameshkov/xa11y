// Mutating window-management coverage for the JS binding, against a real app.
//
// Runs in the `js-window` suite, which the harness orders after every other
// suite (see tests/harness/launch.py): the harness runs python → js → cli
// against one shared app instance, and the window-state verbs (minimize /
// restore / resize) churn the UIA/AX cache in a way that made a following
// suite's action tests flaky. This file owns the last slot, so its mutations
// disturb nothing that follows, and the real napi wiring of the mutating
// verb methods (plus the Locator's async dispatch) is exercised against an
// actual provider instead of only against the mock.
//
// Every test restores the window it mutated: a failed `restore` ends the
// test (it is a real provider failure, not cleanup noise), but a best-effort
// restore is attempted first so the shared app is never left mutated for the
// next test — same failure-preserving pattern as the Locator test. A verb
// advertised in `actions` must dispatch to the real platform action
// (tenet 3): `ActionNotSupportedError` from an advertised verb is a fidelity
// regression and fails the test. The only legitimate early return is "no
// window advertises the verb" — never "advertised but the platform cannot
// perform it".
//
// `close` is only exercised against a *secondary* dialog window (opened via
// the app's "Open Dialog" button): closing the shared app's main window would
// kill the app the harness still needs. A dialog left open would also change
// the enumeration the next suites rely on, so every close test ends with a
// best-effort close of the dialog — through the platform close action when it
// exists, else through the dialog's own "Close Dialog" button.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { getApp, appConfig, ActionNotSupportedError, TimeoutError, sleep } = require('./helpers.js');

async function windowAdvertising(app, verb) {
  const windows = await app.windows();
  return windows.find((w) => w.actions.includes(verb)) || null;
}

async function waitForWindow(app, verb, what) {
  // A fullscreen transition transiently removes the real window from
  // app.windows() (a shell window appears in its place), and the provider's
  // settle loop promises the *state*, not that the window is enumerable the
  // instant the verb returns. A one-shot lookup right after a verb reads that
  // absence as "the window is gone", so every repeated call waits for it.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const win = await windowAdvertising(app, verb);
    if (win) return win;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

async function waitUntil(predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

async function dialogWindow(app) {
  // Prefer the top-level window shape (what `close` acts on); fall back to
  // the in-tree dialog node — the GTK app's AT-SPI tree has no top-level
  // window node, but its dialog is a Role::Dialog child (the same shape the
  // shared Python dialog test relies on).
  const dialogName = appConfig.dialogName;
  if (!dialogName) return null;
  const windows = await app.windows();
  const top = windows.find((w) => w.name && w.name.includes(dialogName));
  if (top) return top;
  const results = await app
    .locator(`window[name*="${dialogName}"], dialog[name*="${dialogName}"]`)
    .elements();
  return results[0] || null;
}

async function closeDialogBestEffort(app) {
  // Best-effort close of a still-open dialog, for cleanup rails. Prefers the
  // platform close action; falls back to the dialog's own Close Dialog
  // button. Never throws: cleanup must not replace the original failure.
  try {
    const dlg = await dialogWindow(app);
    if (!dlg) return;
    if (dlg.actions.includes('close')) {
      await dlg.close();
    } else {
      await app.locator('button[name="Close Dialog"]').press();
    }
  } catch (_e) {
    // best-effort cleanup; the original error wins
  }
}

async function openDialog(app) {
  // Press the app's "Open Dialog" button and wait for the dialog window.
  // Returns the dialog element; returns null when the app has no dialog
  // button config. "Pressed but the dialog never appeared" is a fixture
  // regression and throws (the dialog name comes from the same config the
  // CLI suite's close test relies on).
  const btnName = appConfig.dialogButtonName;
  const dialogName = appConfig.dialogName;
  if (!btnName || !dialogName) return null;
  try {
    await app.locator(`button[name="${btnName}"]`).press();
  } catch (err) {
    // Only a never-matched selector means "this app has no dialog button".
    // Any other failure (the button exists but the dispatch broke) is a
    // regression and must surface.
    if (err instanceof TimeoutError) return null;
    throw err;
  }
  try {
    await waitUntil(async () => (await dialogWindow(app)) !== null, 5000, `dialog ${dialogName} to appear`);
    return await dialogWindow(app);
  } catch (err) {
    // Clean up the press side effect before declaring the fixture regression.
    await closeDialogBestEffort(app);
    throw err;
  }
}

function locatorForWindow(app, win) {
  // A single-match Locator for a window-like element. The top-level may be a
  // Role::Window *or* a Role::Dialog (the Qt and Cocoa apps' top level is a
  // dialog), while App.windows() lists both, so the selector must accept both.
  if (!win.name) return null;
  return app.locator(`window[name="${win.name}"], dialog[name="${win.name}"]`);
}

test('js-window suite resolves the shared app', async () => {
  const app = await getApp();
  const windows = await app.windows();
  assert.ok(Array.isArray(windows), 'windows() returns an array');
});

test('a window that advertises minimize is minimized and restored', async () => {
  const app = await getApp();
  const win = await windowAdvertising(app, 'minimize');
  if (!win || !win.actions.includes('restore')) {
    return; // no window advertises the verb on this app/platform
  }
  try {
    await win.minimize();
    // Advertised restore must succeed; a failure leaves the app minimized and
    // is a real provider failure, never swallowed.
    await win.restore();
  } catch (err) {
    // Never leave the shared app minimized for the suite after this one:
    // restore from the element path, then re-throw the original failure.
    // Same best-effort pattern as the Locator test below.
    try {
      const current = await windowAdvertising(app, 'minimize');
      if (current && current.actions.includes('restore')) {
        await current.restore();
      }
    } catch (_cleanup) {
      // best-effort cleanup; the original error wins
    }
    throw err;
  }
});

async function windowReadsMaximized(app) {
  // The state is platform-specific: Windows reports `maximized`, macOS
  // reports the native fullscreen state as `fullscreen` (its `maximized`
  // stays null). Both are checked so the assertion is portable.
  //
  // null while the state is unknown: no window advertising `maximize` is
  // enumerable (the transition transiently removes the real window), or
  // neither getter answered. Boolean(null) would read that as "restored" and
  // let the state waits below pass without observing anything.
  const win = await windowAdvertising(app, 'maximize');
  if (!win) return null;
  if (win.maximized === true || win.fullscreen === true) return true;
  if (win.maximized === false || win.fullscreen === false) return false;
  return null;
}

test('a window that advertises maximize is maximized and restored', async () => {
  const app = await getApp();
  const win = await windowAdvertising(app, 'maximize');
  if (!win || !win.actions.includes('restore')) {
    return;
  }
  try {
    await win.maximize();
    await waitUntil(
      async () => (await windowReadsMaximized(app)) === true,
      5000,
      'window to report maximized'
    );
    // Repeated calls must be idempotent, not toggles: the old macOS provider
    // pressed the window's zoom button, so a second maximize exited
    // fullscreen (issue #399). Re-read the window first: the platform can
    // recreate the window object during the transition.
    let current = await waitForWindow(app, 'maximize', 'a maximizable window');
    await current.maximize();
    await sleep(2000);
    await waitUntil(
      async () => (await windowReadsMaximized(app)) === true,
      5000,
      'the window to remain maximized after a second maximize'
    );
    current = await waitForWindow(app, 'maximize', 'a maximizable window');
    await current.restore();
    await waitUntil(
      async () => (await windowReadsMaximized(app)) === false,
      5000,
      'window to report restored'
    );
    current = await waitForWindow(app, 'maximize', 'a maximizable window');
    await current.restore();
    await sleep(2000);
    await waitUntil(
      async () => (await windowReadsMaximized(app)) === false,
      5000,
      'the window to remain restored after a second restore'
    );
  } catch (err) {
    try {
      // waitForWindow, not a one-shot lookup: the transition can have the
      // real window out of app.windows(), and a null here would leave the
      // shared app fullscreen for the suites after this one.
      const current = await waitForWindow(app, 'maximize', 'a maximizable window');
      await current.restore();
    } catch (_cleanup) {
      // best-effort cleanup; the original error wins
    }
    throw err;
  }
});

test('moveTo() dispatches and puts the window back where it was', async () => {
  const app = await getApp();
  const win = await windowAdvertising(app, 'move_to');
  if (!win || !win.bounds) {
    return; // no window (or no bounds to restore from)
  }
  const { x, y, width, height } = win.bounds;
  try {
    await win.moveTo(x + 10, y + 10);
    // Restoring keeps the shared app usable for what follows.
    await win.moveTo(x, y);
  } catch (err) {
    // Never leave the shared app moved: best-effort move back, then the
    // original failure surfaces.
    try {
      const current = await windowAdvertising(app, 'move_to');
      if (current) {
        await current.moveTo(x, y);
      }
    } catch (_cleanup) {
      // best-effort cleanup; the original error wins
    }
    throw err;
  }
});

test('resizeTo() dispatches and restores the original size', async () => {
  const app = await getApp();
  const win = await windowAdvertising(app, 'resize_to');
  if (!win || !win.bounds) {
    return;
  }
  const { width, height } = win.bounds;
  try {
    await win.resizeTo(width + 50, height + 50);
    await win.resizeTo(width, height);
  } catch (err) {
    // Same failure-preserving cleanup as moveTo: the shared app must not be
    // left resized for the suites after this one.
    try {
      const current = await windowAdvertising(app, 'resize_to');
      if (current) {
        await current.resizeTo(width, height);
      }
    } catch (_cleanup) {
      // best-effort cleanup; the original error wins
    }
    throw err;
  }
});

test('Locator window verbs dispatch through the async binding', async () => {
  const app = await getApp();
  const win = await windowAdvertising(app, 'minimize');
  if (!win || !win.actions.includes('restore')) {
    return;
  }
  // The Locator carries the selector + auto-wait machinery, so its dispatch
  // is a separate code path worth exercising end to end. The selector must
  // match exactly one window — and the top-level may be a Role::Window *or*
  // a Role::Dialog (the Qt and Cocoa apps' top level is a dialog), while
  // App.windows() lists both, so the selector must accept both.
  const locator = locatorForWindow(app, win);
  if (!locator) return;
  try {
    await locator.minimize();
    await locator.restore();
  } catch (err) {
    // Never leave the shared app minimized: restore from the element path,
    // then re-throw the original failure. The cleanup lookup sits inside the
    // same best-effort block, so a re-enumeration rejection cannot replace
    // the original restore() error — the original failure wins, however the
    // cleanup itself goes.
    try {
      const current = await windowAdvertising(app, 'minimize');
      if (current && current.actions.includes('restore')) {
        await current.restore();
      }
    } catch (_cleanup) {
      // best-effort cleanup; the original error wins
    }
    throw err;
  }
});

test('Locator maximize()/restore() dispatch through the async binding', async () => {
  const app = await getApp();
  const win = await windowAdvertising(app, 'maximize');
  if (!win || !win.actions.includes('restore')) {
    return;
  }
  const locator = locatorForWindow(app, win);
  if (!locator) return;
  try {
    await locator.maximize();
    await locator.restore();
  } catch (err) {
    try {
      // Same failure-preserving cleanup as the element path: a one-shot
      // lookup can miss the window while the transition has it out of
      // app.windows(), leaving the shared app fullscreen.
      const current = await waitForWindow(app, 'maximize', 'a maximizable window');
      await current.restore();
    } catch (_cleanup) {
      // best-effort cleanup; the original error wins
    }
    throw err;
  }
});

test('Locator activate() dispatches through the async binding', async () => {
  const app = await getApp();
  const win = await windowAdvertising(app, 'activate');
  if (!win) {
    return; // no window advertises activate on this app/platform
  }
  const locator = locatorForWindow(app, win);
  if (!locator) return;
  // A non-minimized window has nothing to restore: activate only changes
  // focus/stacking (a minimized window is restored first).
  await locator.activate();
});

test('Locator moveTo() dispatches and puts the window back where it was', async () => {
  const app = await getApp();
  const win = await windowAdvertising(app, 'move_to');
  if (!win || !win.bounds) {
    return;
  }
  const locator = locatorForWindow(app, win);
  if (!locator) return;
  const { x, y } = win.bounds;
  try {
    await locator.moveTo(x + 10, y + 10);
    await locator.moveTo(x, y);
  } catch (err) {
    // Never leave the shared app moved: best-effort move back, then the
    // original failure surfaces.
    try {
      const current = await windowAdvertising(app, 'move_to');
      if (current) {
        await current.moveTo(x, y);
      }
    } catch (_cleanup) {
      // best-effort cleanup; the original error wins
    }
    throw err;
  }
});

test('Locator resizeTo() dispatches and restores the original size', async () => {
  const app = await getApp();
  const win = await windowAdvertising(app, 'resize_to');
  if (!win || !win.bounds) {
    return;
  }
  const locator = locatorForWindow(app, win);
  if (!locator) return;
  const { width, height } = win.bounds;
  try {
    await locator.resizeTo(width + 50, height + 50);
    await locator.resizeTo(width, height);
  } catch (err) {
    try {
      const current = await windowAdvertising(app, 'resize_to');
      if (current) {
        await current.resizeTo(width, height);
      }
    } catch (_cleanup) {
      // best-effort cleanup; the original error wins
    }
    throw err;
  }
});

test('Element.close() dispatches on a secondary dialog', async () => {
  const app = await getApp();
  const dlg = await openDialog(app);
  if (!dlg) {
    return; // this app has no dialog config
  }
  try {
    if (dlg.actions.includes('close')) {
      await dlg.close();
      await waitUntil(async () => (await dialogWindow(app)) === null, 5000,
        'the dialog to disappear after close()');
    } else {
      // The platform has no close API (AT-SPI on Linux): the dispatch must
      // fail surfaceably (tenet 2 — never input-simulate), and the error
      // must reach the binding as ActionNotSupportedError.
      await assert.rejects(dlg.close(), ActionNotSupportedError);
    }
  } finally {
    await closeDialogBestEffort(app);
  }
});

test('Locator.close() dispatches on a secondary dialog', async () => {
  const app = await getApp();
  const dlg = await openDialog(app);
  if (!dlg) {
    return;
  }
  try {
    const locator = locatorForWindow(app, dlg);
    if (!locator) return;
    if (dlg.actions.includes('close')) {
      await locator.close();
      await waitUntil(async () => (await dialogWindow(app)) === null, 5000,
        'the dialog to disappear after Locator.close()');
    } else {
      await assert.rejects(locator.close(), ActionNotSupportedError);
    }
  } finally {
    await closeDialogBestEffort(app);
  }
});
