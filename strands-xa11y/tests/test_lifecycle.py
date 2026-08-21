"""open_app and close_app: the two actions that reach outside the accessibility layer.

Neither goes through xa11y — one spawns a process, the other signals them — so both are
driven here against a stub subprocess and a stub psutil rather than the fake tree.
"""

from __future__ import annotations

import os
import subprocess
import sys

import fake_xa11y
import pytest

from strands_xa11y import _actions
from strands_xa11y._actions import run
from strands_xa11y.models import CloseAppAction, OpenAppAction


def text_of(result) -> str:
    return result["content"][0]["text"]


class FakePopen:
    """Records the command it was handed instead of running it."""

    def __init__(self, command, **kwargs):
        self.command = command
        self.kwargs = kwargs
        self.pid = 7777


@pytest.fixture
def spawned(monkeypatch):
    launches = []

    def popen(command, **kwargs):
        process = FakePopen(command, **kwargs)
        launches.append(process)
        return process

    monkeypatch.setattr(subprocess, "Popen", popen)
    return launches


# ── open_app ─────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("system", "expected"),
    [
        ("Darwin", ["open", "-a", "TextEdit"]),
        ("Windows", ["cmd", "/c", "start", "", "TextEdit"]),
        ("Linux", ["TextEdit"]),
    ],
)
def test_open_app_uses_each_platforms_launcher(editor, spawned, monkeypatch, system, expected):
    monkeypatch.setattr(_actions.platform, "system", lambda: system)
    result = run(OpenAppAction(type="open_app", name="TextEdit"))
    assert result["status"] == "success"
    assert spawned[0].command == expected


def test_open_app_never_leaves_an_unread_pipe_behind(editor, spawned, monkeypatch):
    """An unread PIPE deadlocks the child as soon as it fills its buffer."""
    monkeypatch.setattr(_actions.platform, "system", lambda: "Linux")
    run(OpenAppAction(type="open_app", name="TextEdit"))
    assert spawned[0].kwargs["stdout"] is subprocess.DEVNULL
    assert spawned[0].kwargs["stderr"] is subprocess.DEVNULL


def test_open_app_waits_for_the_bridge_rather_than_reporting_the_spawn(editor, spawned, monkeypatch):
    monkeypatch.setattr(_actions.platform, "system", lambda: "Darwin")
    result = text_of(run(OpenAppAction(type="open_app", name="TextEdit")))
    assert "reachable" in result
    assert "pid 4242" in result  # the app xa11y found, not the launcher's pid


def test_open_app_falls_back_to_the_spawned_pid_on_linux(spawned, monkeypatch):
    """'open' and 'start' exit immediately, so their pid is useless; a direct exec's is not."""
    monkeypatch.setattr(_actions.platform, "system", lambda: "Linux")
    fake_xa11y.APPS.append(fake_xa11y.App("renamed-by-the-desktop", pid=7777))

    result = run(OpenAppAction(type="open_app", name="TextEdit"))
    assert result["status"] == "success"
    assert "renamed-by-the-desktop" in text_of(result)


def test_open_app_on_macos_does_not_guess_at_the_launcher_pid(spawned, monkeypatch):
    monkeypatch.setattr(_actions.platform, "system", lambda: "Darwin")
    fake_xa11y.APPS.append(fake_xa11y.App("something-else", pid=7777))

    result = run(OpenAppAction(type="open_app", name="TextEdit"))
    assert result["status"] == "error"
    # The unrelated app holding the launcher's pid may appear as a near miss; what must not
    # happen is reporting it as the app that was launched.
    assert "reachable" not in text_of(result)


def test_open_app_reports_a_launch_that_never_started(monkeypatch):
    monkeypatch.setattr(_actions.platform, "system", lambda: "Linux")
    monkeypatch.setattr(subprocess, "Popen", lambda *a, **k: (_ for _ in ()).throw(OSError("no such file")))

    result = run(OpenAppAction(type="open_app", name="NoSuchApp"))
    assert result["status"] == "error"
    assert "Could not launch 'NoSuchApp'" in text_of(result)


def test_open_app_needs_a_name_to_launch():
    with pytest.raises(Exception, match="at least 1 character"):
        OpenAppAction(type="open_app", name="")


# ── close_app ────────────────────────────────────────────────────────────────


class FakeProcess:
    def __init__(self, pid, name, fails=False):
        self.info = {"pid": pid, "name": name}
        self.fails = fails
        self.terminated = False

    def terminate(self):
        if self.fails:
            raise FakePsutil.Error("access denied")
        self.terminated = True


class FakePsutil:
    class Error(Exception):
        pass

    def __init__(self, processes):
        self.processes = processes

    def process_iter(self, _fields):
        return list(self.processes)


@pytest.fixture
def processes(monkeypatch):
    """Install a stub psutil, and return the process list the sweep will see."""
    running = []
    monkeypatch.setitem(sys.modules, "psutil", FakePsutil(running))
    return running


def test_close_app_terminates_every_matching_process(processes):
    processes += [FakeProcess(1, "TextEdit"), FakeProcess(2, "textedit helper"), FakeProcess(3, "Safari")]

    result = run(CloseAppAction(type="close_app", name="TextEdit"))
    assert result["status"] == "success"
    assert "2 process(es)" in text_of(result)
    assert [process.terminated for process in processes] == [True, True, False]


def test_close_app_never_terminates_the_process_hosting_the_agent(processes):
    """'python' matches this very interpreter; killing it would take the agent with it."""
    own = FakeProcess(os.getpid(), "python")
    other = FakeProcess(os.getpid() + 1, "python")
    processes += [own, other]

    result = run(CloseAppAction(type="close_app", name="python"))
    assert own.terminated is False
    assert other.terminated is True
    assert "1 process(es)" in text_of(result)


def test_close_app_reports_a_process_it_could_not_signal(processes):
    processes.append(FakeProcess(9, "Locked", fails=True))
    result = run(CloseAppAction(type="close_app", name="Locked"))
    assert "failed to terminate" in text_of(result)


def test_close_app_on_no_match_says_so_instead_of_claiming_success(processes):
    processes.append(FakeProcess(1, "Safari"))
    result = run(CloseAppAction(type="close_app", name="TextEdit"))
    assert "No running process matches" in text_of(result)
    assert processes[0].terminated is False


def test_close_app_refuses_a_name_short_enough_to_match_everything():
    """Matching is a case-insensitive substring, so '' would sweep the whole process table."""
    for name in ("", "x"):
        with pytest.raises(Exception, match="at least 2 characters"):
            CloseAppAction(type="close_app", name=name)


def test_close_app_without_psutil_says_how_to_get_it(monkeypatch):
    monkeypatch.setitem(sys.modules, "psutil", None)  # a None entry makes `import psutil` raise
    result = run(CloseAppAction(type="close_app", name="TextEdit"))
    assert result["status"] == "error"
    assert "strands-xa11y[process]" in text_of(result)
