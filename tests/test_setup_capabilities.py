"""The current setup snapshot and the action validator share role options."""

from copy import deepcopy

import pytest

from ai_dashboard.agent_actions import RequestError, capabilities, check

SETUP = {
    "planner": "codex",
    "planner_options": ["codex", "claude", "deepseek"],
    "implementer": "codex",
    "implementer_options": ["codex", "claude"],
}


def test_setup_advertised_planner_is_accepted_without_widening_executor():
    caps = capabilities({"setup": SETUP})
    check({"action": "set_planner", "args": {"value": "deepseek"}}, caps)
    for action, args in (
        ("set_implementer", {"value": "deepseek"}),
        ("retry_task", {"task": "0a1b2c3d", "tool": "deepseek"}),
        ("resume_task", {"task": "0a1b2c3d", "tool": "deepseek"}),
        ("set_planner", {"value": "unadvertised"}),
    ):
        with pytest.raises(RequestError):
            check({"action": action, "args": args}, caps)
    assert caps.switch_tools == ("claude", "codex")


@pytest.mark.parametrize("options", [[], "deepseek", ["bad/name"], [1], ["x"] * 65])
def test_malformed_setup_options_do_not_expand_allowed_values(options):
    setup = deepcopy(SETUP)
    setup["planner_options"] = options
    assert capabilities({"setup": setup}) is None


def test_malformed_registry_does_not_fall_through_to_setup():
    assert capabilities({"registry": {"format": 999}, "setup": SETUP}) is None
    assert capabilities({"setup": {**SETUP, "planner": "missing"}}) is None
