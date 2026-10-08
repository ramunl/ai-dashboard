"""The last results of the Ops checks, kept in one file across restarts.

Disk report and cleanup, package check and upgrade, AI tool check and update:
without this, every restart or deploy of the dashboard showed "Not checked"
until the owner ran the check again. Only finished results are kept, never
"running", so a restart cannot leave a button stuck.
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
import tempfile
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


class SavedChecks:
    """Named sections of results, read once and rewritten on every change."""

    def __init__(self, path: Path | None) -> None:
        """Load earlier results; None keeps everything in memory (tests)."""
        self.path = path
        self.sections: dict[str, dict] = self._load()

    def _load(self) -> dict[str, dict]:
        if self.path is None:
            return {}
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {}
        except (OSError, ValueError) as error:
            logger.warning(
                "Saved checks %s unreadable, starting fresh: %s", self.path, error
            )
            return {}
        if not isinstance(raw, dict):
            return {}
        return {name: value for name, value in raw.items() if isinstance(value, dict)}

    def get(self, name: str, key: str, kind: type | tuple = dict) -> Any:
        """One saved value of the expected kind, or None (missing or malformed)."""
        value = self.sections.get(name, {}).get(key)
        return (
            value if isinstance(value, kind) and not isinstance(value, bool) else None
        )

    def put(self, name: str, values: dict) -> None:
        """Replace one section and save the file atomically; errors are logged."""
        self.sections[name] = values
        if self.path is None:
            return
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            fd, tmp = tempfile.mkstemp(
                dir=self.path.parent, prefix=".checks-", suffix=".tmp"
            )
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as handle:
                    json.dump(self.sections, handle)
                os.replace(tmp, self.path)
            except BaseException:
                with contextlib.suppress(OSError):
                    os.unlink(tmp)
                raise
        except (OSError, TypeError, ValueError) as error:
            logger.error("Could not save checks to %s: %s", self.path, error)
