"""Run local status commands with bounded execution and process cleanup."""

import asyncio
import contextlib
import logging

logger = logging.getLogger(__name__)


async def run_command(
    program: str,
    *args: str,
    timeout: float = 10,
    accepted_exit_codes: tuple[int, ...] = (0,),
) -> str | None:
    """Return command output, or None on failure; reap interrupted processes."""
    try:
        process = await asyncio.create_subprocess_exec(
            program,
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
    except OSError as error:
        logger.warning("Could not start %s (%s)", program, type(error).__name__)
        return None
    try:
        stdout, _ = await asyncio.wait_for(process.communicate(), timeout=timeout)
    except TimeoutError:
        logger.warning("%s timed out after %s seconds", program, timeout)
        return None
    finally:
        if process.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                process.kill()
            await process.communicate()
    if process.returncode not in accepted_exit_codes:
        logger.warning("%s failed with exit code %s", program, process.returncode)
        return None
    return stdout.decode(errors="replace")
