"""The schema has to reject ambiguous instructions before anything touches the screen."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from strands_xa11y.models import (
    MUTATING_ACTIONS,
    ActAction,
    AnyAction,
    ClickAction,
    CloseAppAction,
    DesktopInput,
    ElementTarget,
    InspectInput,
    MouseAction,
    OpenAppAction,
    PointerTarget,
    ScreenshotAction,
    ScrollAction,
    SnapshotAction,
    TypeAction,
)


def test_element_target_requires_exactly_one_locator():
    ElementTarget(ref="e1")
    ElementTarget(selector="button")
    with pytest.raises(ValidationError, match="exactly one"):
        ElementTarget(app="TextEdit")
    with pytest.raises(ValidationError, match="exactly one"):
        ElementTarget(selector="button", ref="e1")


def test_pointer_target_admits_a_point_but_still_only_one():
    assert PointerTarget(point=(10, 20)).point == (10, 20)
    with pytest.raises(ValidationError, match="exactly one"):
        PointerTarget(point=(1, 2), selector="button")


@pytest.mark.parametrize(
    ("verb", "missing"),
    [("set_number", "number"), ("select_text", "start"), ("raw", "action_name")],
)
def test_act_verbs_declare_their_own_required_fields(verb, missing):
    with pytest.raises(ValidationError, match=missing):
        ActAction(type="act", target=ElementTarget(ref="e1"), verb=verb)


def test_act_verb_with_its_field_supplied_is_accepted():
    action = ActAction(type="act", target=ElementTarget(ref="e1"), verb="set_number", number=0.5)
    assert action.number == 0.5


def test_scroll_needs_a_direction():
    with pytest.raises(ValidationError, match="non-zero"):
        ScrollAction(type="scroll", target=PointerTarget(ref="e1"))


def test_screenshot_takes_a_target_or_a_region_not_both():
    with pytest.raises(ValidationError, match="not both"):
        ScreenshotAction(type="screenshot", target=ElementTarget(ref="e1"), region=(0, 0, 10, 10))


def test_mouse_move_needs_somewhere_to_move_to():
    with pytest.raises(ValidationError, match="requires a target"):
        MouseAction(type="mouse", op="move")
    MouseAction(type="mouse", op="down", button="left")


def test_discriminator_picks_the_right_action_model():
    parsed = DesktopInput.model_validate({"action": {"type": "click", "target": {"ref": "e7"}}})
    assert parsed.action.type == "click"
    assert parsed.action.target.ref == "e7"


def test_inspect_input_rejects_mutating_actions():
    """The read-only tool's schema is the enforcement point, not a runtime check."""
    with pytest.raises(ValidationError):
        InspectInput.model_validate({"action": {"type": "click", "target": {"ref": "e7"}}})
    assert InspectInput.model_validate({"action": {"type": "list_apps"}}).action.type == "list_apps"


def test_snapshot_scope_is_selector_or_ref_not_both():
    with pytest.raises(ValidationError, match="not both"):
        SnapshotAction(type="snapshot", selector="toolbar", ref="e1")
    assert SnapshotAction(type="snapshot").selector is None


@pytest.mark.parametrize(
    ("fields", "expected"),
    [
        ({"max_nodes": 0}, "greater than or equal to 1"),
        ({"max_depth": -1}, "greater than or equal to 0"),
        ({"detail": "verbose"}, "'basic' or 'rich'"),
    ],
)
def test_snapshot_bounds_are_enforced_by_the_schema(fields, expected):
    with pytest.raises(ValidationError, match=expected):
        SnapshotAction(type="snapshot", **fields)


def test_click_count_is_capped_at_a_triple_click():
    assert ClickAction(type="click", target=PointerTarget(ref="e1"), count=3).count == 3
    with pytest.raises(ValidationError, match="less than or equal to 3"):
        ClickAction(type="click", target=PointerTarget(ref="e1"), count=4)


def test_close_app_will_not_take_a_name_broad_enough_to_match_everything():
    """The sweep is a case-insensitive substring match, so short names are dangerous."""
    with pytest.raises(ValidationError, match="at least 2 characters"):
        CloseAppAction(type="close_app", name="")
    assert CloseAppAction(type="close_app", name="TextEdit").name == "TextEdit"


def test_open_app_needs_something_to_launch():
    with pytest.raises(ValidationError, match="at least 1 character"):
        OpenAppAction(type="open_app", name="")


def test_typing_needs_no_target_but_pointing_does():
    """Typing into the focused element is a legitimate request; clicking nothing is not."""
    assert TypeAction(type="type", text="hello").target is None
    with pytest.raises(ValidationError):
        ClickAction(type="click")


def test_the_schema_names_every_action_the_docs_promise():
    offered = {model.model_fields["type"].annotation.__args__[0] for model in AnyAction.__args__}
    assert offered == set(MUTATING_ACTIONS) | {"list_apps", "snapshot", "find", "read", "wait", "screenshot"}
