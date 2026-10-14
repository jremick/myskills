#!/usr/bin/env python3
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path


SELF_DIR = Path(__file__).resolve().parent
AUTH_HELPER = SELF_DIR / "pushover-auth.sh"
API_HELPER = SELF_DIR / "pushover_api.py"
LOG_PATH = Path.home() / ".codex" / "log" / "pushover-notify.log"
OPT_IN_ENV = "CODEX_PUSHOVER_NOTIFY"
OPT_IN_FILES = (".codex-pushover-notify", ".codex-pushover-notifications")
COMPUTER_USE_NOTIFY = (
    Path.home()
    / ".codex"
    / "computer-use"
    / "Codex Computer Use.app"
    / "Contents"
    / "SharedSupport"
    / "SkyComputerUseClient.app"
    / "Contents"
    / "MacOS"
    / "SkyComputerUseClient"
)


def log(message: str) -> None:
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).isoformat()
    with LOG_PATH.open("a", encoding="utf-8") as handle:
        handle.write(f"{timestamp} {message}\n")


def load_payload() -> tuple[dict, str, bool]:
    if len(sys.argv) > 1:
        raw = sys.argv[-1]
        try:
            return json.loads(raw), raw, True
        except json.JSONDecodeError:
            return {}, raw, True

    if not sys.stdin.isatty():
        raw = sys.stdin.read()
        if raw.strip():
            try:
                return json.loads(raw), raw, False
            except json.JSONDecodeError:
                return {}, raw, False

    return {}, "", False


def status_ready() -> bool:
    try:
        result = subprocess.run(
            [str(AUTH_HELPER), "status", "--json"],
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        )
        return bool(json.loads(result.stdout).get("readyToSend"))
    except Exception as exc:
        log(f"pushover_status_error={type(exc).__name__}")
        return False


def env_opt_in() -> bool | None:
    raw_value = os.environ.get(OPT_IN_ENV)
    if raw_value is None:
        return None

    value = raw_value.strip().lower()
    if value in {"1", "true", "yes", "on"}:
        return True
    if value in {"0", "false", "no", "off"}:
        return False

    log(f"pushover_opt_in_invalid_env={OPT_IN_ENV}")
    return False


def project_opt_in(payload: dict) -> bool:
    cwd = Path(str(payload.get("cwd") or os.getcwd())).expanduser()
    try:
        cwd = cwd.resolve()
    except OSError:
        pass

    home = Path.home().resolve()
    search_paths = [cwd, *cwd.parents]
    for path in search_paths:
        if path == home:
            break
        for filename in OPT_IN_FILES:
            marker = path / filename
            if marker.is_file():
                log(f"pushover_opt_in_marker={marker}")
                return True

    return False


def notification_allowed(payload: dict) -> bool:
    env_value = env_opt_in()
    if env_value is not None:
        return env_value

    return project_opt_in(payload)


def message_from_payload(payload: dict) -> tuple[str, str]:
    event = str(
        payload.get("type")
        or payload.get("event")
        or payload.get("event_name")
        or "turn-complete"
    )
    cwd = payload.get("cwd") or os.getcwd()
    project = Path(str(cwd)).name or str(cwd)

    lowered = event.lower()
    if "approval" in lowered or "permission" in lowered:
        return "Codex needs input", f"Approval requested in {project}"
    if "fail" in lowered or "error" in lowered:
        return "Codex request failed", f"Check the Codex turn in {project}"
    return "Codex turn complete", f"Finished in {project}"


def send_pushover(payload: dict) -> None:
    if not notification_allowed(payload):
        log("pushover_skipped=not_explicitly_enabled")
        return

    if not status_ready():
        log("pushover_skipped=credentials_missing")
        return

    title, message = message_from_payload(payload)
    try:
        result = subprocess.run(
            [
                str(API_HELPER),
                "send",
                "--title",
                title,
                "--message",
                message,
                "--priority",
                "0",
                "--ttl",
                "3600",
                "--json",
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=20,
        )
        try:
            response = json.loads(result.stdout)
            request_id = response.get("response", {}).get("request", "unknown")
            remaining = response.get("limits", {}).get("remaining", "unknown")
            log(f"pushover_sent request={request_id} remaining={remaining}")
        except json.JSONDecodeError:
            log("pushover_sent")
    except subprocess.CalledProcessError as exc:
        log(f"pushover_send_failed returncode={exc.returncode}")
    except Exception as exc:
        log(f"pushover_send_error={type(exc).__name__}")


def forward_to_computer_use(raw_payload: str, payload_was_arg: bool) -> None:
    if not COMPUTER_USE_NOTIFY.exists():
        return

    command = [str(COMPUTER_USE_NOTIFY), "turn-ended"]
    input_text = None
    if raw_payload:
        if payload_was_arg:
            command.append(raw_payload)
        else:
            input_text = raw_payload

    try:
        subprocess.run(
            command,
            input=input_text,
            text=True,
            capture_output=True,
            timeout=15,
            check=False,
        )
    except Exception as exc:
        log(f"computer_use_forward_error={type(exc).__name__}")


def main() -> None:
    payload, raw_payload, payload_was_arg = load_payload()
    send_pushover(payload)
    forward_to_computer_use(raw_payload, payload_was_arg)


if __name__ == "__main__":
    main()
