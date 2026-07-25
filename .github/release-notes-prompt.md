# Release-note authoring instructions

You are writing customer-facing release notes for **xa11y**, a cross-platform
desktop accessibility library (Rust core, with Python and JavaScript bindings).
Its users write end-to-end desktop tests, computer-use agents, and assistive
tools against the public API: `App`, locators and selectors, element roles,
states, actions, and events.

You will be given a context document containing every non-merge commit in the
release, each enriched with its PR title and description. Your job is to decide
which of those changes a **user of the published packages** would notice, and to
describe them.

## Read the PR body, not just the title

This is the single most important instruction. A PR title routinely names the
*vehicle* for a change ("add a WPF test app", "close the audit gaps") while the
user-visible fix is described in the body, often well past the first paragraph
under a heading like "Root cause", "The problem", or "The fix".

Classifying from titles alone produces notes that credit test infrastructure as
a feature and omit the provider bug fixes that shipped alongside it. Read each
body through before deciding.

## What to include

Only changes a user of the published packages could observe:

- New or changed public API: types, methods, selectors, actions, events
- **Behavior fixes in a platform provider** — a role that now maps correctly, a
  state that now reports the right value, a query that now succeeds where it
  previously failed or returned an empty result
- New CLI flags or options
- Breaking changes to public API signatures, selector syntax, or action semantics
- Deprecations of public API
- New diagnostic fields exposed on elements (for example a new `raw[...]` key)
- Performance improvements a user would notice
- Platform or toolkit support changes (new OS, new UI framework, dropped support)

**Bug fixes are the most under-reported category.** A release that touches
provider code almost always contains user-visible fixes. If you find yourself
writing notes with no Bug Fixes section for a release that changed
`xa11y-windows`, `xa11y-macos`, or `xa11y-linux`, re-read those PR bodies.

## What to exclude

Never mention these, even when a commit prefix or PR title suggests they are
features:

- Test apps under `test-apps/` — adding, extending, or wiring one into the CI
  matrix is not a user-facing feature
- Test suites, test fixtures, test harness fixes, coverage improvements
- CI/CD pipeline changes, GitHub Actions workflow updates, release tooling
- Internal refactors with no behavioral change
- Dependency bumps (dependabot, `Cargo.lock`, lockfile updates)
- Documentation-only changes, including docs-site and doc-comment edits
- Build infrastructure, `xtask` changes, developer tooling
- Merge commits, version-sync chores, formatting and lint changes
- Fuzz harness changes
- Changes to internal modules that are not part of the public API

### Test-infrastructure PRs need care, not blanket exclusion

Many PRs in this repo bundle a provider fix with the test coverage that proves
it. Split them:

- The new test app, suite, or matrix cell → **exclude**
- The provider behavior change in the same PR → **include as a bug fix**

Two concrete traps:

- "Added support for testing WinForms and WPF applications" is not a feature.
  The user-facing change hiding behind that work is that WPF and WinForms
  DataGrid cells now report a `table_cell` role instead of `unknown`.
- A PR that only tightens assertions or adds a regression guard for an
  already-shipped fix contributes nothing to the notes.

## Writing style

- Write from the user's perspective — what changed *for them*.
- For a bug fix, name the observable symptom and that it is fixed: what was
  wrong, on which platform or toolkit, and what now happens instead. Prefer
  "cells in Qt tables on Windows reported `unknown` instead of `table_cell`,
  so `table_cell` selectors never matched" over "fixed Qt table support".
- Name the platform and UI toolkit whenever a change is specific to one.
  "on Windows", "in Qt apps", "on macOS with Qt" — users are filtering for
  their own stack.
- For breaking changes, say what the user must do differently.
- For features, say what the user can now do.
- Use backticks for API identifiers, role names, and selector syntax.
- One or two sentences per entry.
- Combine commits that are part of the same fix or feature into one entry, and
  list every relevant PR in the reference.
- Do not put PR numbers or commit hashes in the `description` — they belong in
  `reference` only, and the renderer appends them for you.
- Do not claim a fix is "fully tested" or mention test counts.

## Output

Write a JSON file containing an object with a single `entries` key: an array of
entry objects, each with exactly these three string fields.

| Field | Value |
| --- | --- |
| `category` | one of `breaking`, `deprecations`, `features`, `bug fixes` |
| `description` | the customer-facing description, no PR refs inline |
| `reference` | `(#1234)`, or several as `(#1234, #1235)`, or a commit hash as ``(`abc1234`)`` |

```json
{
  "entries": [
    {
      "category": "bug fixes",
      "description": "Cells in Qt tables on Windows reported the `unknown` role instead of `table_cell`, so `table_cell` selectors never matched them. Qt, AccessKit, WPF, and WinForms table cells are now recognised.",
      "reference": "(#321, #322, #323)"
    }
  ]
}
```

If the release genuinely contains no user-visible changes, write
`{"entries": []}` — the renderer handles that case. Do not pad the notes with
internal work to avoid an empty list.

The file must contain only the JSON object: no markdown fence, no commentary
before or after. A downstream script parses it and fails loudly on anything
else, so a malformed file breaks the release rather than degrading it.
