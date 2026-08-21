"""Test fixtures: the fake accessibility backend, and a sample application tree."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

import fake_xa11y  # noqa: E402

# The package imports xa11y lazily by name, so seeding sys.modules is enough to swap in
# the fake — no patching of import sites required.
sys.modules["xa11y"] = fake_xa11y

from strands_xa11y import _refs  # noqa: E402


@pytest.fixture(autouse=True)
def clean_state(monkeypatch):
    """Fresh refs, an empty call log, and consent granted, for every test."""
    fake_xa11y.reset()
    _refs.REFS.__init__()
    monkeypatch.setenv("BYPASS_TOOL_CONSENT", "true")
    yield


@pytest.fixture
def calls():
    return fake_xa11y.CALLS


@pytest.fixture
def editor():
    """A small but realistic app: duplicate names, a disabled control, decoration to filter."""
    element = fake_xa11y.Element
    tree = element(
        "application",
        "TextEdit",
        children=[
            element(
                "window",
                "Untitled",
                active=True,
                children=[
                    element(
                        "toolbar",
                        children=[
                            element("button", "Bold", stable_id="btn-bold"),
                            element("button", "Italic", enabled=False),
                            element("button", "Bold"),
                            element("separator"),
                        ],
                    ),
                    element(
                        "group",
                        children=[
                            element("text_field", "File name", value="untitled", stable_id="tf-1", editable=True),
                            element("check_box", "Wrap lines", checked="off"),
                            element("image"),
                        ],
                    ),
                    element("text_area", "document", value="Dear Alice,", bounds=fake_xa11y.Rect(10, 20, 300, 400)),
                ],
            )
        ],
    )
    app = fake_xa11y.App("TextEdit", pid=4242, root=tree, foreground=True)
    fake_xa11y.APPS.append(app)
    return app
