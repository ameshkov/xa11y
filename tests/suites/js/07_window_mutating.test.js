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

const {
  getApp,
  appConfig,
  appEnv,
  ActionNotSupportedError,
  TimeoutError,
  sleep,
} = require('./helpers.js');

const WINDOW_STATE_TIMEOUT_MS = appEnv === 'cocoa' ? 15_000 : 5_000;

// The platform, not the app identity: the transition drill in the maximize
// test is about the macOS fullscreen animation and runs for every macOS test
// app, not just one.
const MACOS = process.platform === 'darwin';

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
  return waitUntil(() => windowAdvertising(app, verb), 5000, what);
}

async function currentWindow(app, original, verb) {
  const windows = await app.windows();
  if (original.name) {
    const sameName = windows.find((w) => w.name === original.name);
    if (sameName) return sameName;
  }
  return windows.find((w) => w.actions.includes(verb)) || null;
}

function boundsNear(actual, expected, fields, tolerance = 2) {
  return actual != null && fields.every(
    (field) => Math.abs(actual[field] - expected[field]) <= tolerance,
  );
}

async function waitUntil(predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

async function restoreWindowBestEffort(app) {
  // waitForWindow with `restore`, not a one-shot lookup and not a `maximize`
  // lookup: the transition can have the real window out of app.windows(), and
  // a window that advertises `maximize` does not necessarily advertise the
  // `restore` this cleanup needs. Never throws: cleanup must not replace the
  // original failure.
  try {
    const current = await waitForWindow(app, 'restore', 'a restorable window');
    await current.restore();
  } catch (_cleanup) {
    // best-effort cleanup; the original error wins
  }
}

async function assertStays(app, verb, want, holdMs, what) {
  // Fail on the first sample definitely away from `want`; pass only if it
  // holds for `holdMs`. A bounded stand-in for `sleep(holdMs)` followed by an
  // assertion: the same wall clock, but a state that flips mid-window fails
  // immediately, with the message naming the condition rather than passing on
  // the final value. An unknown sample (`null` — the window is transiently
  // unenumerable, or neither state getter answered) is skipped, not read as a
  // flip: `null` is not a verdict (see windowReadsMaximized).
  const deadline = Date.now() + holdMs;
  while (Date.now() < deadline) {
    const state = await windowReadsMaximized(app, verb);
    if (state !== null && state !== want) {
      throw new Error(`${what} did not hold`);
    }
    await sleep(100);
  }
}

async function waitForShellClear(app, what) {
  // Wait until no action-less transition shell is left in app.windows().
  // Driving a new fullscreen change into an animation still in flight makes
  // the window server leave the transient shell window behind, which changes
  // the enumeration every later test reads. The shell advertises no actions,
  // which is what separates it from the real window; waiting for that to
  // clear is the condition the fixed sleep it replaces was standing in for.
  await waitUntil(
    async () => {
      const windows = await app.windows();
      return windows.length > 0 && windows.every((w) => w.actions.length > 0);
    },
    5000,
    what
  );
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

async function actionAndWait(sub, predicate, action) {
  const controller = new AbortController();
  const pending = sub.waitFor(predicate, {
    timeout: WINDOW_STATE_TIMEOUT_MS,
    signal: controller.signal,
  });
  try {
    await action();
    return await pending;
  } catch (err) {
    controller.abort();
    try {
      await pending;
    } catch (_cancelled) {
      // Consume the cancelled waiter so it cannot reject after this test ends.
    }
    throw err;
  }
}

async function closeSiblingBestEffort(app) {
  const siblingName = appConfig.siblingName;
  if (!siblingName) return;
  try {
    const sibling = (await app.windows()).find((w) => w.name === siblingName);
    if (!sibling) return;
    if (sibling.actions.includes('restore')) await sibling.restore();
    await app.locator('button[name="Close Sibling"]').press();
  } catch (_e) {
    // best-effort cleanup; the original error wins
  }
}

async function closeDuplicatesBestEffort(app) {
  if (!appConfig.duplicateWindowName) return;
  try {
    const duplicates = (await app.windows()).filter(
      (w) => w.name === appConfig.duplicateWindowName,
    );
    for (const duplicate of duplicates) {
      if (duplicate.actions.includes('close')) await duplicate.close();
    }
  } catch (_e) {
    // best-effort cleanup; the original error wins
  }
}

async function siblingWindow(app) {
  if (!appConfig.siblingName) return null;
  return (await app.windows()).find((w) => w.name === appConfig.siblingName) || null;
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

test('a window that advertises minimize is minimized and restored', async (t) => {
  const app = await getApp();
  const win = await windowAdvertising(app, 'minimize');
  if (!win || !win.actions.includes('restore')) {
    t.skip('no window advertises both minimize and restore');
    return;
  }
  try {
    await win.minimize();
    await waitUntil(async () => {
      const current = await currentWindow(app, win, 'minimize');
      return current !== null && current.minimized === true;
    }, 5000, 'the minimized state to become true');
    // Advertised restore must succeed; a failure leaves the app minimized and
    // is a real provider failure, never swallowed.
    const minimized = await currentWindow(app, win, 'minimize');
    assert.ok(minimized, 'the minimized window stays discoverable');
    await minimized.restore();
    await waitUntil(async () => {
      const current = await currentWindow(app, win, 'restore');
      return current !== null && current.minimized === false;
    }, 5000, 'the minimized state to become false after restore');
  } catch (err) {
    // Never leave the shared app minimized for the suite after this one; the
    // original failure wins over any cleanup failure.
    await restoreWindowBestEffort(app);
    throw err;
  }
});

async function windowReadsMaximized(app, verb) {
  // `verb` is the capability the caller is waiting on: on macOS a restored
  // window can advertise `restore` while `maximize` is absent (the two verbs
  // are independent — `maximize` needs AXFullScreen settable, `restore` can
  // be a minimize-only window), so the false-state waits select by `restore`
  // and the true-state waits by `maximize`.
  //
  // The state is platform-specific: Windows reports `maximized`, macOS
  // reports the native fullscreen state as `fullscreen` (its `maximized`
  // stays null). Both are checked so the assertion is portable.
  //
  // null while the state is unknown: no window advertising `verb` is
  // enumerable (the transition transiently removes the real window), or
  // neither getter answered. Boolean(null) would read that as "restored" and
  // let the state waits below pass without observing anything.
  const win = await windowAdvertising(app, verb);
  if (!win) return null;
  if (win.maximized === true || win.fullscreen === true) return true;
  if (win.maximized === false || win.fullscreen === false) return false;
  return null;
}

async function restoreAndWait(app) {
  // Restore the real window and wait for it to read back as restored. The
  // lookup selects by `restore` for the same reason restoreWindowBestEffort
  // does: a window that advertises `maximize` does not necessarily advertise
  // `restore`.
  const current = await waitForWindow(app, 'restore', 'a restorable window');
  await current.restore();
  await waitUntil(
    async () => (await windowReadsMaximized(app, 'restore')) === false,
    5000,
    'window to report restored'
  );
}

test('a window that advertises maximize is maximized and restored', async (t) => {
  const app = await getApp();
  const win = await windowAdvertising(app, 'maximize');
  if (!win || !win.actions.includes('restore')) {
    t.skip('no window advertises both maximize and restore');
    return;
  }
  try {
    await win.maximize();
    await waitUntil(
      async () => (await windowReadsMaximized(app, 'maximize')) === true,
      5000,
      'window to report maximized'
    );
    if (!MACOS) {
      // Windows and Linux set the state synchronously; the repeated-call
      // drill below is about the macOS fullscreen transition.
      await restoreAndWait(app);
      return;
    }
    // Repeated calls must be idempotent, not toggles: the old macOS provider
    // pressed the window's zoom button, so a second maximize exited
    // fullscreen (issue #399). Re-read the window first: the transition can
    // recreate the window object.
    let current = await waitForWindow(app, 'maximize', 'a maximizable window');
    await current.maximize();
    // Stay maximized for the time the old toggle's exit transition would
    // have taken to land; a flip fails the hold immediately.
    await assertStays(
      app,
      'maximize',
      true,
      2000,
      'the window to remain maximized after a second maximize'
    );
    await restoreAndWait(app);
    // A repeated restore must not re-enter the fullscreen state.
    current = await waitForWindow(app, 'restore', 'a restorable window');
    await current.restore();
    await assertStays(
      app,
      'restore',
      false,
      2000,
      'the window to remain restored after a second restore'
    );
    // maximize -> restore -> maximize -> restore ends where every call
    // promises; no call may toggle the state the next one sets. Each step
    // waits for the previous transition's shell to clear before the next
    // call: driving a new fullscreen change into an animation still in
    // flight makes the window server leave the shell behind.
    for (const expected of [true, false, true, false]) {
      // Wait for the verb about to run: `maximize` and `restore` are
      // advertised independently (a committed fullscreen window can keep
      // `maximize` while its AXFullScreen is no longer settable, and
      // `restore` is refused in exactly that state), so a lookup pinned to
      // `maximize` cannot stand in for a restore call.
      const verb = expected ? 'maximize' : 'restore';
      current = await waitForWindow(
        app,
        verb,
        expected ? 'a maximizable window' : 'a restorable window'
      );
      if (expected) {
        await current.maximize();
      } else {
        await current.restore();
      }
      await waitUntil(
        async () => (await windowReadsMaximized(app, verb)) === expected,
        5000,
        `the window to read maximized=${expected} during the alternating sequence`
      );
      await waitForShellClear(app, 'the transition shell to clear');
    }
  } catch (err) {
    await restoreWindowBestEffort(app);
    throw err;
  }
});

test('moveTo() changes the reported bounds and puts the window back', async (t) => {
  const app = await getApp();
  const win = await windowAdvertising(app, 'move_to');
  if (!win || !win.bounds) {
    t.skip('no window advertises move_to with restorable bounds');
    return;
  }
  const { x, y } = win.bounds;
  const movedBounds = { x: x + 10, y: y + 10 };
  try {
    await win.moveTo(movedBounds.x, movedBounds.y);
    if (appEnv === 'qt' && process.platform === 'win32') {
      await waitUntil(async () => {
        const current = await currentWindow(app, win, 'move_to');
        return current !== null && current.bounds !== null &&
          (!boundsNear(current.bounds, { x, y }, ['x', 'y']));
      }, 5000, 'Qt/UIA moveTo() to produce an observable bounds change');
      try {
        const current = await currentWindow(app, win, 'move_to');
        if (current) await current.moveTo(x, y);
      } catch (_cleanup) {
        // best-effort cleanup before reporting the coordinate-space gap
      }
      t.skip('Qt/UIA client coordinates differ from decorated outer bounds (qt_windows_geometry_offsets)');
      return;
    }
    await waitUntil(async () => {
      const current = await currentWindow(app, win, 'move_to');
      return current !== null && boundsNear(current.bounds, movedBounds, ['x', 'y']);
    }, 5000, 'moveTo() to change the reported position');
    // Restoring keeps the shared app usable for what follows.
    const moved = await currentWindow(app, win, 'move_to');
    assert.ok(moved, 'the moved window stays discoverable');
    await moved.moveTo(x, y);
    await waitUntil(async () => {
      const current = await currentWindow(app, win, 'move_to');
      return current !== null && boundsNear(current.bounds, { x, y }, ['x', 'y']);
    }, 5000, 'moveTo() to restore the original position');
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

test('resizeTo() changes the reported bounds and restores the original size', async (t) => {
  const app = await getApp();
  const win = await windowAdvertising(app, 'resize_to');
  if (!win || !win.bounds) {
    t.skip('no window advertises resize_to with restorable bounds');
    return;
  }
  const { width, height } = win.bounds;
  const resizedBounds = { width: width + 50, height: height + 50 };
  try {
    await win.resizeTo(resizedBounds.width, resizedBounds.height);
    if (appEnv === 'qt' && process.platform === 'win32') {
      await waitUntil(async () => {
        const current = await currentWindow(app, win, 'resize_to');
        return current !== null && current.bounds !== null &&
          (!boundsNear(current.bounds, { width, height }, ['width', 'height']));
      }, 5000, 'Qt/UIA resizeTo() to produce an observable bounds change');
      try {
        const current = await currentWindow(app, win, 'resize_to');
        if (current) await current.resizeTo(width, height);
      } catch (_cleanup) {
        // best-effort cleanup before reporting the coordinate-space gap
      }
      t.skip('Qt/UIA client size differs from decorated outer bounds (qt_windows_geometry_offsets)');
      return;
    }
    const resizeNoop = appEnv === 'cocoa' || appEnv === 'winforms' || appEnv === 'wpf' || appEnv === 'egui' ||
      (appEnv === 'tauri' && process.platform !== 'linux');
    if (resizeNoop) {
      // The provider advertises and accepts TransformPattern.Resize, but the
      // framework leaves its bounds unchanged. Keep the dispatch covered and
      // report the known gap honestly instead of passing on the no-op.
      try {
        const current = await currentWindow(app, win, 'resize_to');
        if (current) await current.resizeTo(width, height);
      } catch (_cleanup) {
        // best-effort cleanup before reporting the known platform gap
      }
      const gap = appEnv === 'cocoa'
        ? 'cocoa_resize_noop'
        : appEnv === 'egui'
          ? 'egui_transform_resize_noop'
        : appEnv === 'winforms' || appEnv === 'wpf'
          ? `${appEnv}_transform_resize_noop`
          : 'tauri_desktop_resize_noop';
      t.skip(`${appEnv} accepts Resize without changing bounds (${gap})`);
      return;
    }
    await waitUntil(async () => {
      const current = await currentWindow(app, win, 'resize_to');
      return current !== null && boundsNear(current.bounds, resizedBounds, ['width', 'height']);
    }, 5000, 'resizeTo() to change the reported size');
    const resized = await currentWindow(app, win, 'resize_to');
    assert.ok(resized, 'the resized window stays discoverable');
    await resized.resizeTo(width, height);
    await waitUntil(async () => {
      const current = await currentWindow(app, win, 'resize_to');
      return current !== null && boundsNear(current.bounds, { width, height }, ['width', 'height']);
    }, 5000, 'resizeTo() to restore the original size');
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

test('a real sibling window emits opened, minimized state, restored state, and closed events', async (t) => {
  const app = await getApp();
  if (!appConfig.siblingButtonName || !appConfig.siblingName) {
    t.skip('this app has no sibling-window event fixture');
    return;
  }

  const sub = await app.subscribe();
  try {
    const opened = await actionAndWait(
      sub,
      (event) => event.type === 'windowOpened',
      () => app.locator(`button[name="${appConfig.siblingButtonName}"]`).press(),
    );
    assert.equal(opened.type, 'windowOpened');

    await waitUntil(async () => (await siblingWindow(app)) !== null, 5000,
      `sibling ${appConfig.siblingName} to appear`);
    let sibling = await siblingWindow(app);
    assert.ok(sibling, 'the opened sibling must be discoverable');
    assert.ok(sibling.actions.includes('minimize'), 'the sibling advertises minimize');
    assert.ok(sibling.actions.includes('restore'), 'the sibling advertises restore');

    const minimized = await actionAndWait(
      sub,
      (event) => event.type === 'stateChanged' &&
        event.stateFlag === 'minimized' && event.stateValue === true,
      () => sibling.minimize(),
    );
    assert.equal(minimized.stateFlag, 'minimized');
    assert.equal(minimized.stateValue, true);
    await waitUntil(async () => (await siblingWindow(app))?.minimized === true, 5000,
      'the sibling snapshot to report minimized=true');

    sibling = await siblingWindow(app);
    assert.ok(sibling, 'a minimized sibling stays discoverable');
    const restored = await actionAndWait(
      sub,
      (event) => event.type === 'stateChanged' &&
        event.stateFlag === 'minimized' && event.stateValue === false,
      () => sibling.restore(),
    );
    assert.equal(restored.stateValue, false);
    await waitUntil(async () => (await siblingWindow(app))?.minimized === false, 5000,
      'the sibling snapshot to report minimized=false');

    const closed = await actionAndWait(
      sub,
      (event) => event.type === 'windowClosed',
      () => app.locator('button[name="Close Sibling"]').press(),
    );
    assert.equal(closed.type, 'windowClosed');
    await waitUntil(async () => (await siblingWindow(app)) === null, 5000,
      `sibling ${appConfig.siblingName} to disappear`);
  } finally {
    sub.close();
    await closeSiblingBestEffort(app);
  }
});

test('Locator window verbs dispatch through the async binding', async (t) => {
  const app = await getApp();
  const win = await windowAdvertising(app, 'minimize');
  if (!win || !win.actions.includes('restore')) {
    t.skip('no window advertises both minimize and restore');
    return;
  }
  // The Locator carries the selector + auto-wait machinery, so its dispatch
  // is a separate code path worth exercising end to end. The selector must
  // match exactly one window — and the top-level may be a Role::Window *or*
  // a Role::Dialog (the Qt and Cocoa apps' top level is a dialog), while
  // App.windows() lists both, so the selector must accept both.
  const locator = locatorForWindow(app, win);
  if (!locator) {
    t.skip('the target window has no name for a unique Locator');
    return;
  }
  if (process.platform === 'darwin') {
    t.skip('macOS drops minimized windows from app-wide Locator discovery');
    return;
  }
  try {
    await locator.minimize();
    await waitUntil(async () => {
      const current = await currentWindow(app, win, 'minimize');
      return current !== null && current.minimized === true;
    }, 5000, 'Locator.minimize() to report minimized=true');
    await locator.restore();
    await waitUntil(async () => {
      const current = await currentWindow(app, win, 'restore');
      return current !== null && current.minimized === false;
    }, 5000, 'Locator.restore() to report minimized=false');
  } catch (err) {
    // Never leave the shared app minimized; the original failure wins over
    // any cleanup failure.
    await restoreWindowBestEffort(app);
    throw err;
  }
});

test('Locator maximize()/restore() dispatch through the async binding', async (t) => {
  const app = await getApp();
  const win = await windowAdvertising(app, 'maximize');
  if (!win || !win.actions.includes('restore')) {
    t.skip('no window advertises both maximize and restore');
    return;
  }
  const locator = locatorForWindow(app, win);
  if (!locator) {
    t.skip('the target window has no name for a unique Locator');
    return;
  }
  if (appEnv === 'tauri' && process.platform === 'darwin') {
    t.skip('Tauri/macOS Locator restore cannot clear fullscreen (tauri_macos_locator_maximize_restore_failure)');
    return;
  }
  try {
    await locator.maximize();
    if (appEnv === 'cocoa') {
      await locator.restore();
      t.skip('AppKit zoom has no observable maximized/fullscreen state');
      return;
    }
    if (['egui', 'qt'].includes(appEnv) && process.platform === 'darwin') {
      await win.restore();
      t.skip(`${appEnv}/macOS Locator maximize has no observable state change ` +
        '(macos_locator_maximize_state_unobservable)');
      return;
    }
    await waitUntil(async () => {
      const current = await currentWindow(app, win, 'maximize');
      return current !== null && (current.maximized === true || current.fullscreen === true);
    }, WINDOW_STATE_TIMEOUT_MS, 'Locator.maximize() to change the reported state');
    await locator.restore();
    await waitUntil(async () => {
      const current = await currentWindow(app, win, 'restore');
      return current !== null && current.maximized !== true && current.fullscreen !== true;
    }, WINDOW_STATE_TIMEOUT_MS, 'Locator.restore() to clear the maximized/fullscreen state');
  } catch (err) {
    await restoreWindowBestEffort(app);
    throw err;
  }
});

test('Locator activate() dispatches through the async binding', async (t) => {
  const app = await getApp();
  const win = await windowAdvertising(app, 'activate');
  if (!win) {
    t.skip('no window advertises activate on this app/platform');
    return;
  }
  const locator = locatorForWindow(app, win);
  if (!locator) {
    t.skip('the target window has no name for a unique Locator');
    return;
  }
  // A non-minimized window has nothing to restore: activate only changes
  // focus/stacking (a minimized window is restored first).
  await locator.activate();
});

test('Locator moveTo() dispatches and puts the window back where it was', async (t) => {
  const app = await getApp();
  const win = await windowAdvertising(app, 'move_to');
  if (!win || !win.bounds) {
    t.skip('no window advertises move_to with restorable bounds');
    return;
  }
  const locator = locatorForWindow(app, win);
  if (!locator) {
    t.skip('the target window has no name for a unique Locator');
    return;
  }
  const { x, y } = win.bounds;
  try {
    await locator.moveTo(x + 10, y + 10);
    if (appEnv === 'qt' && process.platform === 'win32') {
      await waitUntil(async () => {
        const current = await currentWindow(app, win, 'move_to');
        return current !== null && current.bounds !== null &&
          (!boundsNear(current.bounds, { x, y }, ['x', 'y']));
      }, 5000, 'Qt/UIA Locator.moveTo() to produce an observable bounds change');
      try {
        const current = await currentWindow(app, win, 'move_to');
        if (current) await current.moveTo(x, y);
      } catch (_cleanup) {
        // best-effort cleanup before reporting the coordinate-space gap
      }
      t.skip('Qt/UIA client coordinates differ from decorated outer bounds (qt_windows_geometry_offsets)');
      return;
    }
    await waitUntil(async () => {
      const current = await currentWindow(app, win, 'move_to');
      return current !== null && boundsNear(
        current.bounds, { x: x + 10, y: y + 10 }, ['x', 'y'],
      );
    }, 5000, 'Locator.moveTo() to change the reported position');
    await locator.moveTo(x, y);
    await waitUntil(async () => {
      const current = await currentWindow(app, win, 'move_to');
      return current !== null && boundsNear(current.bounds, { x, y }, ['x', 'y']);
    }, 5000, 'Locator.moveTo() to restore the original position');
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

test('Locator resizeTo() dispatches and restores the original size', async (t) => {
  const app = await getApp();
  const win = await windowAdvertising(app, 'resize_to');
  if (!win || !win.bounds) {
    t.skip('no window advertises resize_to with restorable bounds');
    return;
  }
  const locator = locatorForWindow(app, win);
  if (!locator) {
    t.skip('the target window has no name for a unique Locator');
    return;
  }
  const { width, height } = win.bounds;
  try {
    await locator.resizeTo(width + 50, height + 50);
    if (appEnv === 'qt' && process.platform === 'win32') {
      await waitUntil(async () => {
        const current = await currentWindow(app, win, 'resize_to');
        return current !== null && current.bounds !== null &&
          (!boundsNear(current.bounds, { width, height }, ['width', 'height']));
      }, 5000, 'Qt/UIA Locator.resizeTo() to produce an observable bounds change');
      try {
        const current = await currentWindow(app, win, 'resize_to');
        if (current) await current.resizeTo(width, height);
      } catch (_cleanup) {
        // best-effort cleanup before reporting the coordinate-space gap
      }
      t.skip('Qt/UIA client size differs from decorated outer bounds (qt_windows_geometry_offsets)');
      return;
    }
    const resizeNoop = appEnv === 'cocoa' || appEnv === 'winforms' || appEnv === 'wpf' || appEnv === 'egui' ||
      (appEnv === 'tauri' && process.platform !== 'linux');
    if (resizeNoop) {
      try {
        const current = await currentWindow(app, win, 'resize_to');
        if (current) await current.resizeTo(width, height);
      } catch (_cleanup) {
        // best-effort cleanup before reporting the known platform gap
      }
      const gap = appEnv === 'cocoa'
        ? 'cocoa_resize_noop'
        : appEnv === 'egui'
          ? 'egui_transform_resize_noop'
        : appEnv === 'winforms' || appEnv === 'wpf'
          ? `${appEnv}_transform_resize_noop`
          : 'tauri_desktop_resize_noop';
      t.skip(`${appEnv} accepts Resize without changing bounds (${gap})`);
      return;
    }
    await waitUntil(async () => {
      const current = await currentWindow(app, win, 'resize_to');
      return current !== null && boundsNear(
        current.bounds,
        { width: width + 50, height: height + 50 },
        ['width', 'height'],
      );
    }, 5000, 'Locator.resizeTo() to change the reported size');
    await locator.resizeTo(width, height);
    await waitUntil(async () => {
      const current = await currentWindow(app, win, 'resize_to');
      return current !== null && boundsNear(
        current.bounds, { width, height }, ['width', 'height'],
      );
    }, 5000, 'Locator.resizeTo() to restore the original size');
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

test('duplicate titles are preserved and a Locator re-resolves after one hides', async (t) => {
  const app = await getApp();
  if (!appConfig.duplicateButtonName || !appConfig.duplicateWindowName) {
    t.skip('this app has no duplicate-window fixture');
    return;
  }
  const selector = `window[name="${appConfig.duplicateWindowName}"]`;
  try {
    await app.locator(`button[name="${appConfig.duplicateButtonName}"]`).press();
    await waitUntil(async () => (await app.locator(selector).elements()).length === 2,
      5000, 'both same-titled windows to be discoverable');

    const firstLocator = app.locator(selector).first();
    const first = await firstLocator.element();
    assert.ok(first.bounds, 'the first duplicate has comparable bounds');
    assert.ok(first.actions.includes('close'), 'the duplicate advertises close');
    const firstX = first.bounds.x;
    await first.close();

    await waitUntil(async () => (await app.locator(selector).elements()).length === 1,
      5000, 'the hidden duplicate to leave discovery');
    const replacement = await firstLocator.element();
    assert.equal(replacement.name, appConfig.duplicateWindowName);
    assert.notEqual(replacement.bounds?.x, firstX,
      'the same Locator resolves the other native window after the first hides');
  } finally {
    await closeDuplicatesBestEffort(app);
  }
});

test('Element.close() dispatches on a secondary dialog', async (t) => {
  const app = await getApp();
  const dlg = await openDialog(app);
  if (!dlg) {
    t.skip('this app has no secondary-dialog fixture');
    return;
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

test('Locator.close() dispatches on a secondary dialog', async (t) => {
  const app = await getApp();
  const dlg = await openDialog(app);
  if (!dlg) {
    t.skip('this app has no secondary-dialog fixture');
    return;
  }
  try {
    const locator = locatorForWindow(app, dlg);
    if (!locator) {
      t.skip('the dialog has no name for a unique Locator');
      return;
    }
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
