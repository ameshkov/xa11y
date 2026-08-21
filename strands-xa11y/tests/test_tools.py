"""The Strands-facing surface: names, schemas, and what an agent actually sees."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from strands_xa11y import DesktopInput, inspect_desktop, use_desktop


def test_tools_register_under_their_own_names():
    assert use_desktop.tool_name == "use_desktop"
    assert inspect_desktop.tool_name == "inspect_desktop"


def test_descriptions_teach_the_workflow():
    description = use_desktop.tool_spec["description"]
    assert "accessibility tree" in description
    assert "snapshot" in description
    assert "refs" in description.lower()


def variants(tool) -> set:
    """The action models a tool's schema offers, by name."""
    return {name for name in tool.tool_spec["inputSchema"]["json"]["$defs"] if name.endswith("Action")}


def test_input_schema_exposes_every_action_as_a_variant():
    offered = variants(use_desktop)
    assert {"SnapshotAction", "ClickAction", "TypeAction", "ActAction", "KeyAction", "DragAction"} <= offered


def test_the_read_only_tool_offers_no_way_to_act():
    offered = variants(inspect_desktop)
    assert {"SnapshotAction", "FindAction", "ReadAction", "ScreenshotAction"} <= offered
    assert offered & {"ClickAction", "TypeAction", "DragAction", "OpenAppAction", "CloseAppAction"} == set()


def test_calling_the_tool_directly_runs_the_action(editor):
    result = use_desktop({"action": {"type": "list_apps"}})
    assert result["status"] == "success"
    assert "TextEdit" in result["content"][0]["text"]


def test_a_dict_gets_the_same_validation_an_agent_would(editor):
    """These stay ordinary callables, so a script must not slip past the schema."""
    with pytest.raises(ValidationError):
        use_desktop({"action": {"type": "click", "target": {"selector": "button", "ref": "e1"}}})
    with pytest.raises(ValidationError):
        use_desktop({"action": {"type": "no_such_action"}})


def test_an_already_validated_envelope_is_not_revalidated(editor):
    result = use_desktop(DesktopInput.model_validate({"action": {"type": "list_apps"}}))
    assert result["status"] == "success"


def test_the_read_only_tool_refuses_a_mutating_action_at_the_door(editor):
    with pytest.raises(ValidationError):
        inspect_desktop({"action": {"type": "click", "target": {"selector": "button"}}})


def test_the_read_only_tool_still_reads(editor):
    result = inspect_desktop({"action": {"type": "snapshot", "app": "TextEdit"}})
    assert result["status"] == "success"
    assert 'button "Bold"' in result["content"][0]["text"]


def test_both_tools_describe_the_same_workflow():
    """One set of instructions, so an agent given either tool learns the same loop."""
    for tool in (use_desktop, inspect_desktop):
        description = tool.tool_spec["description"]
        assert "Re-snapshot after anything that changes the UI" in description


def test_the_read_only_description_says_what_it_cannot_do():
    assert "cannot" in inspect_desktop.tool_spec["description"]


def test_a_failing_action_comes_back_as_a_result_not_an_exception(editor):
    """Strands shows the model tool results; a traceback would just end the turn."""
    result = use_desktop({"action": {"type": "find", "app": "Nonexistent", "selector": "button"}})
    assert result["status"] == "error"
    assert result["content"][0]["text"]
