#!/usr/bin/env python3
import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


BASE_URL = os.environ.get("PUSHOVER_API_BASE_URL", "https://api.pushover.net/1")
USER_AGENT = os.environ.get("PUSHOVER_API_USER_AGENT", "codex-pushover-notifications/1.0")
SELF_DIR = Path(__file__).resolve().parent
AUTH_HELPER = SELF_DIR / "pushover-auth.sh"


def die(message: str, code: int = 1) -> None:
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(code)


def auth_status() -> dict:
    result = subprocess.run(
        [str(AUTH_HELPER), "status", "--json"],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(result.stdout)


def read_helper_value(command: str, *, required: bool = True) -> str:
    result = subprocess.run(
        [str(AUTH_HELPER), command],
        check=required,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def read_app_token() -> str:
    return read_helper_value("read-app-token")


def read_user_key() -> str:
    return read_helper_value("read-user-key")


def read_device() -> str:
    return read_helper_value("read-device", required=False)


def endpoint(path: str) -> str:
    return f"{BASE_URL.rstrip('/')}/{path.lstrip('/')}"


def request_form(method: str, path: str, *, fields=None, query=None) -> tuple[dict, dict]:
    url = endpoint(path)
    if query:
        clean_query = {key: value for key, value in query.items() if value not in (None, "")}
        encoded_query = urllib.parse.urlencode(clean_query)
        if encoded_query:
            url = f"{url}?{encoded_query}"

    headers = {
        "Accept": "application/json",
        "User-Agent": USER_AGENT,
    }

    data = None
    if fields is not None:
        clean_fields = {key: value for key, value in fields.items() if value not in (None, "")}
        data = urllib.parse.urlencode(clean_fields).encode("utf-8")
        headers["Content-Type"] = "application/x-www-form-urlencoded"

    request = urllib.request.Request(url, method=method, headers=headers, data=data)

    try:
        with urllib.request.urlopen(request) as response:
            raw = response.read().decode("utf-8")
            response_headers = dict(response.headers.items())
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            payload = {"error": raw or exc.reason}
        payload["statusCode"] = exc.code
        raise RuntimeError(json.dumps(payload))
    except urllib.error.URLError as exc:
        raise RuntimeError(str(exc)) from exc

    payload = json.loads(raw) if raw else {}
    return payload, response_headers


def limit_headers(headers: dict) -> dict:
    mapping = {
        "X-Limit-App-Limit": "limit",
        "X-Limit-App-Remaining": "remaining",
        "X-Limit-App-Reset": "reset",
    }
    return {
        target: headers[source]
        for source, target in mapping.items()
        if source in headers
    }


def print_output(payload, as_json: bool) -> None:
    if as_json:
        print(json.dumps(payload, indent=2))
        return
    print(json.dumps(payload, indent=2))


def validate_lengths(args) -> None:
    if len(args.message) > 1024:
        die("message exceeds Pushover's 1024-character limit")
    if args.title and len(args.title) > 250:
        die("title exceeds Pushover's 250-character limit")
    if args.url and len(args.url) > 512:
        die("url exceeds Pushover's 512-character limit")
    if args.url_title and len(args.url_title) > 100:
        die("url title exceeds Pushover's 100-character limit")
    if args.ttl is not None and args.ttl <= 0:
        die("ttl must be a positive number of seconds")


def common_message_fields(args) -> dict:
    fields = {
        "token": read_app_token(),
        "user": read_user_key(),
        "device": args.device if args.device is not None else read_device(),
        "title": args.title,
        "message": args.message,
        "priority": args.priority,
        "sound": args.sound,
        "url": args.url,
        "url_title": args.url_title,
        "ttl": args.ttl,
    }
    if args.html:
        fields["html"] = 1
    if args.monospace:
        fields["monospace"] = 1
    return fields


def cmd_doctor(args) -> None:
    status = auth_status()
    payload = {
        "appName": "Pushover Notifications",
        "apiBaseUrl": BASE_URL,
        "userAgent": USER_AGENT,
        "auth": status,
        "authHelper": str(AUTH_HELPER),
        "python": sys.version.split()[0],
        "networkChecksRun": False,
    }
    print_output(payload, args.json)


def cmd_limits(args) -> None:
    payload, _headers = request_form(
        "GET",
        "/apps/limits.json",
        query={"token": read_app_token()},
    )
    print_output(payload, args.json)


def cmd_validate_user(args) -> None:
    payload, _headers = request_form(
        "POST",
        "/users/validate.json",
        fields={
            "token": read_app_token(),
            "user": read_user_key(),
            "device": args.device if args.device is not None else read_device(),
        },
    )
    print_output(payload, args.json)


def cmd_sounds(args) -> None:
    payload, _headers = request_form(
        "GET",
        "/sounds.json",
        query={"token": read_app_token()},
    )
    print_output(payload, args.json)


def cmd_send(args) -> None:
    if args.html and args.monospace:
        die("--html and --monospace cannot be used together")
    validate_lengths(args)
    payload, headers = request_form("POST", "/messages.json", fields=common_message_fields(args))
    output = {
        "response": payload,
        "limits": limit_headers(headers),
    }
    print_output(output, args.json)


def add_json_flag(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--json", action="store_true", help="print JSON output")


def add_device_arg(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--device",
        help="override target device for this call; omit to use PUSHOVER_DEVICE, Keychain device, or all active devices",
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Pushover notification helper for Codex")
    subparsers = parser.add_subparsers(dest="command", required=True)

    doctor = subparsers.add_parser("doctor", help="report auth and runtime status without contacting Pushover")
    add_json_flag(doctor)
    doctor.set_defaults(func=cmd_doctor)

    limits = subparsers.add_parser("limits", help="read monthly Pushover message quota for the app token")
    add_json_flag(limits)
    limits.set_defaults(func=cmd_limits)

    validate_user = subparsers.add_parser("validate-user", help="validate the configured user key and optional device")
    add_device_arg(validate_user)
    add_json_flag(validate_user)
    validate_user.set_defaults(func=cmd_validate_user)

    sounds = subparsers.add_parser("sounds", help="list built-in and account custom notification sounds")
    add_json_flag(sounds)
    sounds.set_defaults(func=cmd_sounds)

    send = subparsers.add_parser("send", help="send a user-requested Pushover notification")
    send.add_argument("--message", required=True, help="notification body")
    send.add_argument("--title", default="Codex", help="notification title")
    add_device_arg(send)
    send.add_argument(
        "--priority",
        type=int,
        choices=[-2, -1, 0, 1],
        default=0,
        help="Pushover priority; emergency priority 2 is intentionally not exposed here",
    )
    send.add_argument("--sound", help="Pushover sound name")
    send.add_argument("--url", help="supplementary URL")
    send.add_argument("--url-title", help="supplementary URL title")
    send.add_argument("--ttl", type=int, help="seconds before Pushover deletes the message from devices")
    send.add_argument("--html", action="store_true", help="enable Pushover-supported HTML formatting")
    send.add_argument("--monospace", action="store_true", help="enable monospace message formatting")
    add_json_flag(send)
    send.set_defaults(func=cmd_send)

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    try:
        args.func(args)
    except subprocess.CalledProcessError as exc:
        stderr = exc.stderr.strip() if exc.stderr else str(exc)
        die(stderr.removeprefix("error: "))
    except RuntimeError as exc:
        message = str(exc)
        try:
            payload = json.loads(message)
        except json.JSONDecodeError:
            die(message)
        print(json.dumps(payload, indent=2), file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
