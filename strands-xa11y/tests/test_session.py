"""Resolving apps, targets, and keys — the layer everything else is built on."""

from __future__ import annotations

import fake_xa11y
import pytest

from strands_xa11y._errors import ToolError
from strands_xa11y._refs import REFS
from strands_xa11y._session import (
    Resolved,
    app_key,
    focus_app,
    normalize_key,
    normalize_keys,
    pointer_argument,
    resolve_app,
    resolve_element,
    resolve_pointer,
    resolve_ref,
)
from strands_xa11y.models import ElementTarget, PointerTarget

# ── Keys ─────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("given", "expected"),
    [
        ("cmd", "Meta"),
        ("COMMAND", "Meta"),
        ("ctrl", "Ctrl"),
        ("control", "Ctrl"),
        ("esc", "Escape"),
        ("page_up", "PageUp"),
        ("page-down", "PageDown"),
        ("up", "ArrowUp"),
        ("arrowleft", "ArrowLeft"),
        ("return", "Enter"),
    ],
)
def test_aliases_map_onto_the_spelling_xa11y_expects(given, expected):
    assert normalize_key(given) == expected


@pytest.mark.parametrize("key", ["a", "7", ";", "F5", "Enter", "SomethingUnknown"])
def test_single_characters_and_unrecognised_names_pass_through_untouched(key):
    assert normalize_key(key) == key


def test_normalize_keys_maps_a_whole_sequence():
    assert normalize_keys(["cmd", "shift", "s"]) == ["Meta", "Shift", "s"]


# ── Applications ─────────────────────────────────────────────────────────────


def test_app_key_prefers_pid_because_names_are_not_unique(editor):
    assert app_key(editor) == "pid:4242"
    assert app_key(fake_xa11y.App("Nameless")) == "name:Nameless"


def test_an_app_key_round_trips_back_to_its_app(editor):
    assert resolve_app(app_key(editor)) is editor
    assert resolve_app("name:TextEdit") is editor


@pytest.mark.parametrize("spec", ["foreground", "front", "frontmost", "active", "current", "  Foreground  ", None])
def test_every_foreground_alias_resolves_to_the_foreground_app(editor, spec):
    assert resolve_app(spec) is editor


def test_a_malformed_pid_selector_says_what_the_shape_should_be(editor):
    with pytest.raises(ToolError, match="expected 'pid:1234'"):
        resolve_app("pid:not-a-number")


def test_exact_names_win_over_a_fuzzy_match(editor):
    fake_xa11y.APPS.append(fake_xa11y.App("TextEdit Helper", pid=99))
    assert resolve_app("TextEdit") is editor


def test_a_prefix_beats_a_mid_string_match(editor):
    """'Text' prefixes TextEdit and only appears mid-string in the other, so it is unambiguous."""
    fake_xa11y.APPS.append(fake_xa11y.App("Rich Text Composer", pid=99))
    assert resolve_app("Text") is editor


# ── Focus ────────────────────────────────────────────────────────────────────


def test_focus_app_short_circuits_when_the_app_is_already_in_front(editor, calls):
    assert focus_app(editor) is True
    assert calls == []


def test_focus_app_raises_the_first_window(editor, calls):
    editor.is_foreground = False
    assert focus_app(editor) is True
    assert calls[0][0] == "focus"


def test_focus_app_reports_failure_rather_than_pretending(editor):
    editor.is_foreground = False
    editor.as_element()._children = []
    assert focus_app(editor) is False


def test_focus_app_treats_a_backend_error_as_a_failure_not_a_crash(editor):
    editor.is_foreground = False
    editor.children = lambda: (_ for _ in ()).throw(fake_xa11y.PlatformError("app is busy"))
    assert focus_app(editor) is False


# ── Targets ──────────────────────────────────────────────────────────────────


def test_a_selector_target_resolves_to_a_locator_that_re_queries(editor):
    resolved = resolve_element(ElementTarget(app="TextEdit", selector="button"))
    assert resolved.locator is not None
    assert resolved.actor is resolved.locator


def test_a_point_target_resolves_to_no_element_at_all(editor):
    resolved = resolve_pointer(PointerTarget(point=(3, 4)))
    assert resolved.app is None
    assert resolved.actor is None
    with pytest.raises(ToolError, match="a point has no accessibility node"):
        resolved.as_element()


def test_pointer_argument_hands_back_a_tuple_for_points_and_an_element_otherwise(editor):
    point = PointerTarget(point=(3, 4))
    assert pointer_argument(resolve_pointer(point), point) == (3, 4)

    element_target = PointerTarget(app="TextEdit", selector="text_area")
    resolved = resolve_pointer(element_target)
    assert pointer_argument(resolved, element_target) is editor.as_element().children()[0]._children[2]


def test_a_ref_falls_back_to_its_captured_handle_when_no_selector_resolves(editor):
    """The last resort: no stable_id, no path, just the element seen at snapshot time."""
    element = editor.as_element().children()[0]._children[2]
    entry = REFS.issue(app_key(editor), "text_area", element=element)

    resolved = resolve_ref(entry)
    assert resolved.locator is None
    assert resolved.as_element() is element


def test_a_ref_whose_path_now_matches_several_elements_is_not_used(editor):
    """Resolving through an ambiguous path would act on whichever element happened to be first."""
    entry = REFS.issue(app_key(editor), "button", path="button")
    with pytest.raises(ToolError, match="no longer resolves to exactly one element"):
        resolve_ref(entry)


def test_a_ref_with_an_unparseable_path_falls_through_instead_of_raising(editor):
    element = editor.as_element().children()[0]._children[2]
    entry = REFS.issue(app_key(editor), "text_area", path="!!not a selector!!", element=element)
    assert resolve_ref(entry).as_element() is element


def test_resolved_prefers_the_locator_but_can_still_produce_an_element(editor):
    resolved = Resolved(app=editor, label="x", locator=editor.locator("text_area"))
    assert resolved.as_element() is editor.as_element().children()[0]._children[2]
