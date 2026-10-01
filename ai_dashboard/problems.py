"""Evaluate service, resource, and agent readings for the overview window."""

SEVERITY_ORDER = {"error": 0, "warning": 1, "info": 2}


def _problem(severity: str, text: str) -> dict:
    return {"severity": severity, "text": text}


def _service_problems(services: list[dict]) -> list[dict]:
    problems = []
    for service in services:
        unit = service["unit"]
        if service["load_state"] == "not-found":
            problems.append(_problem("warning", f"{unit} is not installed"))
            continue
        if service["state"] != "active":
            problems.append(_problem("error", f"{unit} is {service['state']}"))
        if service["restarts"] >= 3:
            problems.append(
                _problem(
                    "warning",
                    f"{unit} restarted automatically {service['restarts']} times",
                )
            )
        errors = service.get("errors_last_hour")
        if errors:
            label = "500+" if errors >= 500 else str(errors)
            problems.append(
                _problem("warning", f"{unit}: {label} errors in the last hour")
            )

    return problems


def _resource_problems(resources: dict | None) -> list[dict]:
    if not resources:
        return []
    problems = []
    disk = resources["disk"]
    used = disk["used"] / disk["total"] if disk["total"] else 0
    if used >= 0.9:
        problems.append(_problem("error", f"Disk {used:.0%} full"))
    elif used >= 0.8:
        problems.append(_problem("warning", f"Disk {used:.0%} full"))
    problems.extend(_disk_trend_problems(disk.get("trend")))
    memory = resources["memory"]
    free = memory["available"] / memory["total"] if memory["total"] else 1
    if free < 0.10:
        problems.append(
            _problem("error", f"Memory almost exhausted ({free:.0%} available)")
        )
    elif free < 0.15:
        problems.append(_problem("warning", f"Memory low ({free:.0%} available)"))
    if resources["load"][1] > 2 * resources["cpus"]:
        problems.append(
            _problem(
                "warning",
                f"High load: {resources['load'][1]:.2f} on {resources['cpus']} CPU",
            )
        )

    return problems


def _disk_trend_problems(trend: dict | None) -> list[dict]:
    """Warn while there is still time to act, not when the disk is already full."""
    days = trend.get("days_until_full") if trend else None
    if days is None:
        return []
    growth = trend["bytes_per_day"] / 1024**3
    text = f"Disk grows {growth:.1f} GB/day: full in ~{days:.0f} days"
    if days <= 7:
        return [_problem("error", text)]
    if days <= 30:
        return [_problem("warning", text)]
    return []


def _agent_problems(agents: list[dict], active_units: set[str]) -> list[dict]:
    problems = []
    for agent in agents:
        # A stopped service is already reported above; only add snapshot trouble
        # when the agent claims to be running.
        if agent.get("problem") and agent.get("unit") in active_units:
            problems.append(
                _problem(
                    "warning", f"{agent.get('agent', 'an')} agent {agent['problem']}"
                )
            )

    coding = next((agent for agent in agents if agent.get("agent") == "coding"), None)
    if coding:
        snapshot = coding.get("snapshot") or {}
        if "(updatable)" in (snapshot.get("core") or ""):
            problems.append(
                _problem(
                    "info", "Coding agent core update available: /core update coding"
                )
            )
        queued = len(snapshot.get("queue") or [])
        if queued and not snapshot.get("running"):
            problems.append(
                _problem(
                    "info",
                    f"{queued} task(s) queued, nothing running: /confirm to resume",
                )
            )

    return problems


def compute_problems(
    resources: dict | None, services: list[dict], agents: list[dict]
) -> list[dict]:
    """Evaluate readings and return problems with the most severe first."""
    active_units = {
        service["unit"]
        for service in services
        if service["state"] == "active" and service["load_state"] != "not-found"
    }
    problems = [
        *_service_problems(services),
        *_resource_problems(resources),
        *_agent_problems(agents, active_units),
    ]
    return sorted(problems, key=lambda problem: SEVERITY_ORDER[problem["severity"]])
