"""Two ways to use the tools: hand-driven, and through an agent.

Run the hand-driven half without an LLM to check permissions and see what the agent
will see:

    BYPASS_TOOL_CONSENT=true python examples/quickstart.py
"""

import os

from strands_xa11y import use_desktop


def hand_driven() -> None:
    """Drive the tool directly — the fastest way to check a permission grant works."""
    print(use_desktop({"action": {"type": "list_apps"}})["content"][0]["text"])

    snapshot = use_desktop({"action": {"type": "snapshot", "max_nodes": 60}})
    print(snapshot["content"][0]["text"])

    # Refs come from the snapshot above; act on one with e.g.
    # use_desktop({"action": {"type": "click", "target": {"ref": "e4"}}})


def with_an_agent() -> None:
    """The intended shape: hand the tool to an agent and describe the goal."""
    from strands import Agent

    agent = Agent(tools=[use_desktop])
    agent("Open the Calculator, add 7 and 8, and tell me what the display shows.")


if __name__ == "__main__":
    hand_driven()
    if os.environ.get("RUN_AGENT"):
        with_an_agent()
