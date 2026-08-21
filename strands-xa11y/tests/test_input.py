"""Tier three: the synthesised-input actions, and where the tier boundary sits.

The point of the layering is that these are reached deliberately, not by accident, so
these tests care as much about which calls are *not* made as about which are.
"""

from __future__ import annotations

import pytest

from strands_xa11y._actions import run
from strands_xa11y.models import (
    DragAction,
    ElementTarget,
    FocusAction,
    KeyAction,
    MouseAction,
    PointerTarget,
    ScrollAction,
)


def text_of(result) -> str:
    return result["content"][0]["text"]


def called(calls, name: str) -> list:
    return [entry for entry in calls if entry[0] == name]


# ── focus ────────────────────────────────────────────────────────────────────


def test_focus_goes_through_the_accessibility_layer(editor, calls):
    result = run(FocusAction(type="focus", target=ElementTarget(app="TextEdit", selector="text_field")))
    assert result["status"] == "success"
    assert called(calls, "focus")
    assert not called(calls, "input.click")


# ── mouse ────────────────────────────────────────────────────────────────────


def test_mouse_move_to_an_element_aims_at_the_element_not_a_guess(editor, calls):
    result = run(MouseAction(type="mouse", op="move", target=PointerTarget(app="TextEdit", selector="text_area")))
    assert result["status"] == "success"
    _, args, _ = called(calls, "input.move_to")[0]
    assert args[0] is editor.as_element().children()[0]._children[2]


def test_mouse_move_to_a_point_passes_the_tuple_through(editor, calls):
    run(MouseAction(type="mouse", op="move", target=PointerTarget(point=(12, 34))))
    _, args, _ = called(calls, "input.move_to")[0]
    assert args[0] == (12, 34)


@pytest.mark.parametrize("op", ["down", "up"])
def test_mouse_press_and_release_act_at_the_current_position(editor, calls, op):
    """down/up take no target — they apply wherever the pointer already is."""
    result = run(MouseAction(type="mouse", op=op, button="right"))
    assert result["status"] == "success"
    _, args, _ = called(calls, f"input.mouse_{op}")[0]
    assert args[0] == "right"
    assert not called(calls, "input.move_to")


# ── drag ─────────────────────────────────────────────────────────────────────


def test_drag_resolves_both_ends_and_forwards_its_options(editor, calls):
    result = run(
        DragAction(
            type="drag",
            start=PointerTarget(app="TextEdit", selector="text_area"),
            end=PointerTarget(point=(200, 300)),
            button="middle",
            modifiers=["shift"],
            duration=0.5,
        )
    )
    assert result["status"] == "success"
    _, args, kwargs = called(calls, "input.drag")[0]
    assert args[0] is editor.as_element().children()[0]._children[2]
    assert args[1] == (200, 300)
    assert kwargs == {"button": "middle", "held": ["Shift"], "duration": 0.5}


def test_drag_without_modifiers_passes_none_rather_than_an_empty_list(editor, calls):
    run(DragAction(type="drag", start=PointerTarget(point=(1, 2)), end=PointerTarget(point=(3, 4))))
    _, _, kwargs = called(calls, "input.drag")[0]
    assert kwargs["held"] is None


# ── scroll ───────────────────────────────────────────────────────────────────


def test_scroll_over_an_element_targets_that_element(editor, calls):
    run(ScrollAction(type="scroll", target=PointerTarget(app="TextEdit", selector="text_area"), dx=2, dy=0))
    _, args, _ = called(calls, "input.scroll")[0]
    assert args[0] is editor.as_element().children()[0]._children[2]
    assert args[1:] == (2, 0)


# ── keys ─────────────────────────────────────────────────────────────────────


def test_key_reports_the_combination_it_sent(editor):
    result = run(KeyAction(type="key", keys=["s"], hold=["ctrl"], repeat=2))
    assert "Ctrl+s" in text_of(result)
    assert "x2" in text_of(result)


def test_key_can_raise_an_application_first(editor, calls):
    editor.is_foreground = False
    result = run(KeyAction(type="key", keys=["a"], app="TextEdit"))
    assert result["status"] == "success"
    assert called(calls, "focus")
    assert "WARNING" not in text_of(result)


def test_key_warns_loudly_when_it_could_not_raise_the_application(editor, calls):
    """Keystrokes land wherever focus is, so a failed raise means they went somewhere else."""
    editor.is_foreground = False
    editor.as_element()._children = []  # nothing to focus

    result = run(KeyAction(type="key", keys=["a"], app="TextEdit"))
    assert result["status"] == "success"
    assert "WARNING" in text_of(result)
    assert "may" in text_of(result)
    assert called(calls, "input.press")


def test_key_does_not_try_to_raise_anything_when_no_app_is_named(editor, calls):
    run(KeyAction(type="key", keys=["a"]))
    assert not called(calls, "focus")
