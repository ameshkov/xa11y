//! In-memory mock Provider and test tree for binding tests.
//!
//! Gated behind the `test-support` feature so it only ships when a downstream
//! crate explicitly opts in (bindings' test builds, examples). The tree and
//! Provider impl are shared between `xa11y-python` and `xa11y-js` — neither
//! binding needed a bespoke mock; only their wrapper shapes differ.
//!
//! # Topology
//!
//! ```text
//! application "TestApp" (stable_id="app-root", desc="Test application")
//! └── window "Main Window" (focused, active)
//!     ├── toolbar "Navigation"
//!     │   ├── button "Back" (stable_id="btn-back", desc="Go back")
//!     │   └── button "Forward" (disabled)
//!     └── group "Content"
//!         ├── text_field "Search" (value="hello", editable, desc="Search field")
//!         ├── check_box "Agree" (checked=on)
//!         ├── slider "Volume" (numeric=75, min=0, max=100)
//!         ├── static_text "Status" (value="Loading...", visible=false)
//!         └── list "Items" (expanded=true)
//!             ├── list_item "Item 1" (selected)
//!             └── list_item "Item 2"
//! ```
//!
//! Call [`build_provider`] to get an `Arc<dyn Provider>`. The provider records
//! actions into an internal log; use [`MockProviderHandle::actions`] to inspect
//! them from tests.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::element::{ElementData, Rect, StateSet, Toggled};
use crate::error::{Error, Result};
use crate::event_provider::Subscription;
use crate::provider::Provider;
use crate::role::Role;

/// Tuple describing one row in the mock element table.
///
/// Kept as a type alias so clippy's `type_complexity` lint stays happy.
type MockElementSpec<'a> = (
    Role,
    Option<&'a str>, // name
    Option<&'a str>, // value
    Option<&'a str>, // description
    Option<Rect>,
    Vec<&'a str>, // actions
    StateSet,
    Option<f64>,                                // numeric_value
    Option<f64>,                                // min_value
    Option<f64>,                                // max_value
    Option<&'a str>,                            // stable_id
    Option<HashMap<String, serde_json::Value>>, // raw
);

/// One entry in the mock's action log. `(handle, action_name, optional_argument)`.
pub type ActionLogEntry = (u64, String, Option<String>);

/// Mock provider backing the test tree.
pub struct MockProvider {
    /// Interior-mutable so window verbs can mutate state/bounds in place.
    nodes: Mutex<Vec<MockNode>>,
    actions: Mutex<Vec<ActionLogEntry>>,
}

impl MockProvider {
    /// Return a clone of the action log recorded so far.
    pub fn actions(&self) -> Vec<ActionLogEntry> {
        self.actions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// Clear the action log.
    pub fn clear_actions(&self) {
        self.actions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
    }

    fn record(&self, el: &ElementData, action: &str, data: Option<String>) -> Result<()> {
        self.actions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push((el.handle, action.to_string(), data));
        Ok(())
    }
}

#[derive(Clone)]
struct MockNode {
    data: ElementData,
    children: Vec<usize>,
    parent: Option<usize>,
    /// A closed window is gone: unlike `minimized` (visible=false but still
    /// listed), a closed window must not be enumerated by `get_children` or
    /// `list_windows` — real providers drop it from the tree.
    closed: bool,
}

impl Provider for MockProvider {
    fn get_children(&self, element: Option<&ElementData>) -> Result<Vec<ElementData>> {
        let nodes = self.nodes.lock().unwrap_or_else(|e| e.into_inner());
        match element {
            None => {
                if nodes.is_empty() {
                    return Ok(vec![]);
                }
                Ok(vec![nodes[0].data.clone()])
            }
            Some(el) => {
                let idx = el.handle as usize;
                // A closed element is gone (see `closed`): resolving its subtree
                // through a stale handle would fake a live window that real
                // providers have dropped.
                if idx >= nodes.len() || nodes[idx].closed {
                    return Ok(vec![]);
                }
                Ok(nodes[idx]
                    .children
                    .iter()
                    .filter(|&&i| !nodes[i].closed)
                    .map(|&i| nodes[i].data.clone())
                    .collect())
            }
        }
    }

    fn get_parent(&self, element: &ElementData) -> Result<Option<ElementData>> {
        let nodes = self.nodes.lock().unwrap_or_else(|e| e.into_inner());
        let idx = element.handle as usize;
        // A closed element is gone: no parent either (see `closed`).
        if idx >= nodes.len() || nodes[idx].closed {
            return Ok(None);
        }
        Ok(nodes[idx].parent.map(|i| nodes[i].data.clone()))
    }

    fn list_apps(&self) -> Result<Vec<ElementData>> {
        // The mock tree's root is a single Application node; expose it as
        // the lone "app" so Locator's rootless path enumerates it.
        let nodes = self.nodes.lock().unwrap_or_else(|e| e.into_inner());
        if nodes.is_empty() {
            return Ok(vec![]);
        }
        Ok(vec![nodes[0].data.clone()])
    }

    fn focused_app(&self) -> Result<ElementData> {
        // The mock has a single application root; treat it as the foreground
        // app so `App::is_foreground` / `find(|a| a.focused())` have something
        // to resolve against in binding and core tests.
        let nodes = self.nodes.lock().unwrap_or_else(|e| e.into_inner());
        if nodes.is_empty() {
            return Err(Error::selector_not_matched("focused application"));
        }
        Ok(nodes[0].data.clone())
    }

    fn list_windows(&self, element: &ElementData) -> Result<Vec<ElementData>> {
        // Windows of the process owning `element`: the element's children
        // with `role=Window` (the macOS/Linux shape) — plus `element` itself
        // when it is a window (the Windows shape, where every app entry IS a
        // top-level window). The app root in this fixture yields exactly its
        // "Main Window" child.
        let nodes = self.nodes.lock().unwrap_or_else(|e| e.into_inner());
        let mut out: Vec<ElementData> = Vec::new();
        let mut seen: std::collections::HashSet<u64> = std::collections::HashSet::new();
        let idx = element.handle as usize;
        // Self-inclusion (the Windows shape, where an app entry IS a window)
        // must apply the same `closed` filter as the children loop below: a
        // stale handle to a closed window is not a live window.
        if element.role == Role::Window
            && idx < nodes.len()
            && !nodes[idx].closed
            && seen.insert(element.handle)
        {
            out.push(element.clone());
        }
        if idx < nodes.len() {
            for &i in &nodes[idx].children {
                if nodes[i].data.role == Role::Window
                    && !nodes[i].closed
                    && seen.insert(nodes[i].data.handle)
                {
                    out.push(nodes[i].data.clone());
                }
            }
        }
        Ok(out)
    }

    fn press(&self, el: &ElementData) -> Result<()> {
        self.record(el, "press", None)
    }
    fn focus(&self, el: &ElementData) -> Result<()> {
        self.record(el, "focus", None)
    }
    fn blur(&self, el: &ElementData) -> Result<()> {
        self.record(el, "blur", None)
    }
    fn toggle(&self, el: &ElementData) -> Result<()> {
        self.record(el, "toggle", None)
    }
    fn select(&self, el: &ElementData) -> Result<()> {
        self.record(el, "select", None)
    }
    fn expand(&self, el: &ElementData) -> Result<()> {
        self.record(el, "expand", None)
    }
    fn collapse(&self, el: &ElementData) -> Result<()> {
        self.record(el, "collapse", None)
    }
    fn show_menu(&self, el: &ElementData) -> Result<()> {
        self.record(el, "show_menu", None)
    }
    fn increment(&self, el: &ElementData) -> Result<()> {
        self.record(el, "increment", None)
    }
    fn decrement(&self, el: &ElementData) -> Result<()> {
        self.record(el, "decrement", None)
    }
    fn scroll_into_view(&self, el: &ElementData) -> Result<()> {
        self.record(el, "scroll_into_view", None)
    }
    fn set_value(&self, el: &ElementData, value: &str) -> Result<()> {
        self.record(el, "set_value", Some(value.to_string()))
    }
    fn set_numeric_value(&self, el: &ElementData, v: f64) -> Result<()> {
        self.record(el, "set_numeric_value", Some(format!("{v}")))
    }
    fn type_text(&self, el: &ElementData, text: &str) -> Result<()> {
        self.record(el, "type_text", Some(text.to_string()))
    }
    fn set_text_selection(&self, el: &ElementData, start: u32, end: u32) -> Result<()> {
        self.record(el, "set_text_selection", Some(format!("{start}..{end}")))
    }
    fn perform_action(&self, el: &ElementData, action: &str) -> Result<()> {
        self.record(el, action, None)
    }

    // ── Window management ──────────────────────────────────────────
    //
    // The mock models window state mutations in place so tests can verify
    // minimize → state → restore round-trips without a real platform.

    fn raise(&self, el: &ElementData) -> Result<()> {
        self.record(el, "raise", None)
    }

    fn minimize(&self, el: &ElementData) -> Result<()> {
        {
            let mut nodes = self.nodes.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(node) = nodes.get_mut(el.handle as usize) {
                node.data.states.minimized = Some(true);
                node.data.states.maximized = None;
                // Model an iconified window as off-screen. That is what makes
                // the Locator window verbs' enabled-only gate (no `visible`)
                // testable: a minimized window must still be actionable.
                node.data.states.visible = false;
            }
        }
        self.record(el, "minimize", None)
    }

    fn maximize(&self, el: &ElementData) -> Result<()> {
        {
            let mut nodes = self.nodes.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(node) = nodes.get_mut(el.handle as usize) {
                node.data.states.maximized = Some(true);
                node.data.states.minimized = None;
                // A minimized window is modeled iconified (visible=false);
                // maximizing it must bring it back on-screen, or a
                // minimize → maximize round-trip would leave the mock
                // reporting maximized AND invisible.
                node.data.states.visible = true;
            }
        }
        self.record(el, "maximize", None)
    }

    fn restore(&self, el: &ElementData) -> Result<()> {
        {
            let mut nodes = self.nodes.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(node) = nodes.get_mut(el.handle as usize) {
                node.data.states.minimized = Some(false);
                node.data.states.maximized = Some(false);
                node.data.states.visible = true;
            }
        }
        self.record(el, "restore", None)
    }

    fn close(&self, el: &ElementData) -> Result<()> {
        {
            let mut nodes = self.nodes.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(node) = nodes.get_mut(el.handle as usize) {
                // `closed` (not `visible`) is what removes it from the tree:
                // a minimized window is also visible=false but must stay
                // listed. Both flags together model the real provider result.
                node.closed = true;
                node.data.states.visible = false;
            }
        }
        self.record(el, "close", None)
    }

    fn move_to(&self, el: &ElementData, x: i32, y: i32) -> Result<()> {
        {
            let mut nodes = self.nodes.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(node) = nodes.get_mut(el.handle as usize) {
                if let Some(b) = node.data.bounds.as_mut() {
                    b.x = x;
                    b.y = y;
                }
            }
        }
        self.record(el, "move_to", Some(format!("{x},{y}")))
    }

    fn resize_to(&self, el: &ElementData, width: u32, height: u32) -> Result<()> {
        {
            let mut nodes = self.nodes.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(node) = nodes.get_mut(el.handle as usize) {
                if let Some(b) = node.data.bounds.as_mut() {
                    b.width = width;
                    b.height = height;
                }
            }
        }
        self.record(el, "resize_to", Some(format!("{width}x{height}")))
    }

    fn subscribe(&self, _el: &ElementData) -> Result<Subscription> {
        Err(Error::Platform {
            code: -1,
            message: "MockProvider does not support subscribe".to_string(),
        })
    }
}

/// Build the standard test tree (Python/JS bindings share this).
///
/// Returns an `Arc<MockProvider>` so callers can inspect the action log via
/// [`MockProvider::actions`] while also using it as a `Provider` (via
/// `Arc<dyn Provider>`, supported by the blanket `&T: Provider` impl and
/// `Arc`'s `Deref` coercion).
pub fn build_provider() -> Arc<MockProvider> {
    use serde_json::json;

    let elements: Vec<MockElementSpec> = vec![
        (
            Role::Application,
            Some("TestApp"),
            None,
            Some("Test application"),
            Some(Rect {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
            }),
            vec![],
            StateSet::default(),
            None,
            None,
            None,
            Some("app-root"),
            // Example raw metadata — gives the tests a concrete value to
            // assert on via Element.raw.
            Some(HashMap::from([(
                "ax_role".to_string(),
                json!("AXApplication"),
            )])),
        ),
        (
            Role::Window,
            Some("Main Window"),
            None,
            None,
            Some(Rect {
                x: 100,
                y: 50,
                width: 800,
                height: 600,
            }),
            vec![
                "raise",
                "minimize",
                "maximize",
                "restore",
                "close",
                "move_to",
                "resize_to",
            ],
            // The mock models the foreground app, so its main window is the
            // active window — mirrors `focused_app` returning the app root.
            StateSet {
                focused: true,
                active: true,
                ..StateSet::default()
            },
            None,
            None,
            None,
            None,
            None,
        ),
        (
            Role::Toolbar,
            Some("Navigation"),
            None,
            None,
            None,
            vec![],
            StateSet::default(),
            None,
            None,
            None,
            None,
            None,
        ),
        (
            Role::Button,
            Some("Back"),
            None,
            Some("Go back"),
            Some(Rect {
                x: 110,
                y: 60,
                width: 50,
                height: 30,
            }),
            vec!["press", "focus"],
            StateSet {
                focusable: true,
                ..StateSet::default()
            },
            None,
            None,
            None,
            Some("btn-back"),
            None,
        ),
        (
            Role::Button,
            Some("Forward"),
            None,
            None,
            Some(Rect {
                x: 170,
                y: 60,
                width: 50,
                height: 30,
            }),
            vec!["press", "focus"],
            StateSet {
                enabled: false,
                focusable: true,
                ..StateSet::default()
            },
            None,
            None,
            None,
            None,
            None,
        ),
        (
            Role::Group,
            Some("Content"),
            None,
            None,
            None,
            vec![],
            StateSet::default(),
            None,
            None,
            None,
            None,
            None,
        ),
        (
            Role::TextField,
            Some("Search"),
            Some("hello"),
            Some("Search field"),
            Some(Rect {
                x: 200,
                y: 120,
                width: 300,
                height: 25,
            }),
            vec!["focus", "set_value", "type_text"],
            StateSet {
                editable: true,
                focusable: true,
                ..StateSet::default()
            },
            None,
            None,
            None,
            None,
            None,
        ),
        (
            Role::CheckBox,
            Some("Agree"),
            None,
            None,
            None,
            vec!["press", "focus"],
            StateSet {
                checked: Some(Toggled::On),
                focusable: true,
                ..StateSet::default()
            },
            None,
            None,
            None,
            None,
            None,
        ),
        (
            Role::Slider,
            Some("Volume"),
            Some("75"),
            None,
            None,
            vec!["increment", "decrement", "set_value", "focus"],
            StateSet {
                focusable: true,
                ..StateSet::default()
            },
            Some(75.0),
            Some(0.0),
            Some(100.0),
            None,
            None,
        ),
        (
            Role::StaticText,
            Some("Status"),
            Some("Loading..."),
            None,
            None,
            vec![],
            StateSet {
                visible: false,
                ..StateSet::default()
            },
            None,
            None,
            None,
            None,
            None,
        ),
        (
            Role::List,
            Some("Items"),
            None,
            None,
            None,
            vec![],
            StateSet {
                expanded: Some(true),
                ..StateSet::default()
            },
            None,
            None,
            None,
            None,
            None,
        ),
        (
            Role::ListItem,
            Some("Item 1"),
            None,
            None,
            None,
            vec!["select", "focus"],
            StateSet {
                selected: true,
                focusable: true,
                ..StateSet::default()
            },
            None,
            None,
            None,
            None,
            None,
        ),
        (
            Role::ListItem,
            Some("Item 2"),
            None,
            None,
            None,
            vec!["select", "focus"],
            StateSet {
                focusable: true,
                ..StateSet::default()
            },
            None,
            None,
            None,
            None,
            None,
        ),
    ];

    // Parent/child topology indexed by position in `elements`.
    let children_map: Vec<Vec<usize>> = vec![
        vec![1],              // 0: application
        vec![2, 5],           // 1: window
        vec![3, 4],           // 2: toolbar
        vec![],               // 3: button Back
        vec![],               // 4: button Forward
        vec![6, 7, 8, 9, 10], // 5: group
        vec![],               // 6: text_field
        vec![],               // 7: check_box
        vec![],               // 8: slider
        vec![],               // 9: static_text
        vec![11, 12],         // 10: list
        vec![],               // 11: list_item 1
        vec![],               // 12: list_item 2
    ];
    let parent_map: Vec<Option<usize>> = vec![
        None,
        Some(0),
        Some(1),
        Some(2),
        Some(2),
        Some(1),
        Some(5),
        Some(5),
        Some(5),
        Some(5),
        Some(5),
        Some(10),
        Some(10),
    ];

    let mut nodes = Vec::with_capacity(elements.len());
    for (i, (role, name, value, desc, bounds, actions, states, nv, minv, maxv, sid, raw)) in
        elements.into_iter().enumerate()
    {
        let data = ElementData {
            role,
            name: name.map(String::from),
            value: value.map(String::from),
            description: desc.map(String::from),
            bounds,
            actions: actions.iter().map(|s| s.to_string()).collect(),
            states,
            numeric_value: nv,
            min_value: minv,
            max_value: maxv,
            stable_id: sid.map(String::from),
            pid: Some(1234),
            raw: raw.unwrap_or_default(),
            handle: i as u64,
        };
        nodes.push(MockNode {
            data,
            children: children_map[i].clone(),
            parent: parent_map[i],
            closed: false,
        });
    }

    Arc::new(MockProvider {
        nodes: Mutex::new(nodes),
        actions: Mutex::new(Vec::new()),
    })
}

/// Build a [`Subscription`] whose underlying sender has already been dropped.
///
/// Used by binding tests to verify that subscriber loops terminate cleanly on
/// disconnect (rather than hanging or silently swallowing the end-of-stream
/// signal).
pub fn disconnected_subscription() -> Subscription {
    use crate::event_provider::{CancelHandle, EventReceiver};

    let (tx, rx) = std::sync::mpsc::channel::<crate::event::Event>();
    drop(tx); // immediate disconnect
    Subscription::new(EventReceiver::new(rx), CancelHandle::noop())
}
