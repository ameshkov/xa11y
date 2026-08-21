#!/usr/bin/env python3
"""Bump the version in a pure-Python sibling package's pyproject.toml.

`pytest-xa11y` and `strands-xa11y` each version independently of xa11y, so
they are deliberately outside cargo-release's shared-version scheme. This
script is the whole mechanism: read the current version, apply the requested
level, write it back, print the new version.

Usage:
    python .github/scripts/bump_python_package.py --package strands-xa11y --level patch
    python .github/scripts/bump_python_package.py --package pytest-xa11y --show
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

# Only the packages that carry their own version line. Naming them explicitly,
# rather than accepting any path, means a typo fails here instead of writing a
# version into some unrelated pyproject.toml.
PACKAGES = ("pytest-xa11y", "strands-xa11y")

# Matches the version line inside [project]. Deliberately anchored to the
# line start so a version string elsewhere in the file cannot be picked up.
VERSION_RE = re.compile(r'^version = "(\d+)\.(\d+)\.(\d+)"$', re.MULTILINE)


def pyproject_for(package: str) -> Path:
    return REPO_ROOT / package / "pyproject.toml"


def read_version(text: str, path: Path) -> tuple[int, int, int]:
    matches = VERSION_RE.findall(text)
    if len(matches) != 1:
        raise SystemExit(
            f"Expected exactly one `version = \"X.Y.Z\"` line in {path}, "
            f"found {len(matches)}."
        )
    major, minor, patch = matches[0]
    return int(major), int(minor), int(patch)


def bump(version: tuple[int, int, int], level: str) -> tuple[int, int, int]:
    major, minor, patch = version
    if level == "major":
        return major + 1, 0, 0
    if level == "minor":
        return major, minor + 1, 0
    if level == "patch":
        return major, minor, patch + 1
    raise SystemExit(f"Unknown level {level!r}; expected major, minor or patch.")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package", choices=PACKAGES, required=True)
    parser.add_argument("--level", choices=["major", "minor", "patch"])
    parser.add_argument(
        "--show",
        action="store_true",
        help="Print the current version without changing it.",
    )
    args = parser.parse_args(argv)

    pyproject = pyproject_for(args.package)
    text = pyproject.read_text(encoding="utf-8")
    current = read_version(text, pyproject)

    if args.show or args.level is None:
        print(".".join(str(part) for part in current))
        return 0

    new = bump(current, args.level)
    new_str = ".".join(str(part) for part in new)
    pyproject.write_text(
        VERSION_RE.sub(f'version = "{new_str}"', text, count=1), encoding="utf-8"
    )
    print(new_str)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
