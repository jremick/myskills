#!/usr/bin/env python3
"""Run selected research provider calls with safe auth and artifact capture."""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4


EXA_URL = "https://api.exa.ai/search"
KEENABLE_SEARCH_URL = "https://api.keenable.ai/v1/search"
KEENABLE_FETCH_URL = "https://api.keenable.ai/v1/fetch"
TAVILY_RESEARCH_URL = "https://api.tavily.com/research"
RETRY_STATUS = {429, 500, 502, 503, 504}
TAVILY_RECORD_NAMES = {"attempt.json", "submitted.json", "latest.json", "run.json", "request.json", "poll-request.json"}


class ProviderError(RuntimeError):
    pass


def now_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def slugify(value: str, limit: int = 60) -> str:
    slug = re.sub(r"[^A-Za-z0-9]+", "-", value.strip().lower()).strip("-")
    return (slug[:limit].strip("-") or "research")


def write_json(path: str | Path, data: Any) -> Path:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=target.parent, delete=False) as handle:
            temp_path = Path(handle.name)
            handle.write(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, target)
    finally:
        if temp_path and temp_path.exists():
            temp_path.unlink()
    return target


def write_text(path: str | Path, data: str) -> Path:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(data, encoding="utf-8")
    return target


def load_json(path: str | None) -> Any:
    if not path:
        return None
    return json.loads(Path(path).read_text(encoding="utf-8"))


def default_raw_path(provider: str, prompt: str) -> Path:
    return Path("work") / "research-router" / provider / f"{now_stamp()}-{slugify(prompt)}" / "raw.json"


def keychain_service(cache_name: str) -> str:
    prefix = os.environ.get("OP_KEYCHAIN_CACHE_PREFIX", "codex-op-cache")
    return f"{prefix}:{cache_name}"


def read_keychain_cache(cache_name: str) -> str | None:
    account = os.environ.get("USER") or "codex"
    try:
        result = subprocess.run(
            [
                "security",
                "find-generic-password",
                "-a",
                account,
                "-s",
                keychain_service(cache_name),
                "-w",
            ],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
        )
    except FileNotFoundError:
        return None
    if result.returncode != 0:
        return None
    secret = result.stdout.strip()
    return secret or None


def resolve_api_key(env_var: str, cache_name: str) -> str:
    value = os.environ.get(env_var)
    if value:
        return value
    value = read_keychain_cache(cache_name)
    if value:
        return value
    raise ProviderError(
        f"Missing {env_var}; no Keychain cache '{cache_name}' was available. "
        "Use auth-handling to import or refresh the cache without printing the key."
    )


def retry_delay(error: urllib.error.HTTPError, attempt: int) -> float:
    retry_after = error.headers.get("Retry-After") if error.headers else None
    if retry_after:
        try:
            return min(float(retry_after), 60.0)
        except ValueError:
            pass
    return min(2.0**attempt, 30.0)


def request_json(
    method: str,
    url: str,
    headers: dict[str, str],
    payload: dict[str, Any] | None = None,
    *,
    retries: int = 2,
    timeout: float = 60.0,
) -> dict[str, Any]:
    # A missing response does not prove a paid POST was rejected. Only reads
    # have automatic retries; callers must recover submitted jobs by identity.
    retries = max(0, retries) if method.upper() in {"GET", "HEAD"} else 0
    data = None
    request_headers = dict(headers)
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        request_headers.setdefault("Content-Type", "application/json")

    for attempt in range(retries + 1):
        req = urllib.request.Request(url, data=data, headers=request_headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as response:
                body = response.read().decode("utf-8")
                return json.loads(body) if body else {}
        except urllib.error.HTTPError as error:
            body = error.read().decode("utf-8", errors="replace")
            if error.code in RETRY_STATUS and attempt < retries:
                time.sleep(retry_delay(error, attempt))
                continue
            detail = body[:500].replace("\n", " ")
            raise ProviderError(f"HTTP {error.code} from {url}: {detail}") from error
        except urllib.error.URLError as error:
            if attempt < retries:
                time.sleep(min(2.0**attempt, 30.0))
                continue
            raise ProviderError(f"Request failed for {url}: {error.reason}") from error
    raise ProviderError(f"Request failed for {url}")


def exa_payload(args: argparse.Namespace) -> dict[str, Any]:
    if not 1 <= args.num_results <= 100:
        raise ProviderError("--num-results must be between 1 and 100.")
    if args.additional_query and args.type not in {"deep", "deep-reasoning", "deep-lite"}:
        raise ProviderError("--additional-query is only valid with Exa deep-search types.")

    contents: dict[str, Any] = {}
    if args.content in {"highlights", "both"}:
        contents["highlights"] = True
    if args.content in {"text", "both"}:
        if args.text_max_characters <= 0:
            raise ProviderError("--text-max-characters must be positive.")
        contents["text"] = {"maxCharacters": args.text_max_characters}

    payload: dict[str, Any] = {
        "query": args.query,
        "type": args.type,
        "numResults": args.num_results,
        "contents": contents,
        "stream": False,
    }
    if args.additional_query:
        payload["additionalQueries"] = args.additional_query
    if args.include_domain:
        payload["includeDomains"] = args.include_domain
    if args.exclude_domain:
        payload["excludeDomains"] = args.exclude_domain
    if args.category:
        payload["category"] = args.category
    if args.system_prompt:
        payload["systemPrompt"] = args.system_prompt
    output_schema = load_json(args.output_schema_file)
    if output_schema is not None:
        payload["outputSchema"] = output_schema
    return payload


def keenable_search_payload(args: argparse.Namespace) -> dict[str, Any]:
    if not 1 <= args.max_results <= 50:
        raise ProviderError("--max-results must be between 1 and 50.")
    if not 180 <= args.snippet_max_length <= 10000:
        raise ProviderError("--snippet-max-length must be between 180 and 10000.")

    payload: dict[str, Any] = {
        "query": args.query,
        "max_results": args.max_results,
        "snippet_max_length": args.snippet_max_length,
    }
    optional_fields = (
        "site",
        "acquired_after",
        "acquired_before",
        "published_after",
        "published_before",
        "query_time",
    )
    for field in optional_fields:
        value = getattr(args, field)
        if value:
            payload[field] = value
    return payload


def keenable_fetch_params(args: argparse.Namespace) -> dict[str, Any]:
    if not 1 <= args.max_chars <= 100000:
        raise ProviderError("--max-chars must be between 1 and 100000.")
    if args.prompt and len(args.prompt) > 2000:
        raise ProviderError("--prompt must not exceed 2000 characters.")

    params: dict[str, Any] = {
        "url": args.url,
        "max_chars": args.max_chars,
        "live": str(bool(args.live)).lower(),
    }
    if args.prompt:
        params["prompt"] = args.prompt
    return params


def tavily_payload(args: argparse.Namespace) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "input": args.input,
        "model": args.model,
        "stream": False,
        "citation_format": args.citation_format,
        "output_length": args.output_length,
    }
    if args.include_domain:
        payload["include_domains"] = args.include_domain
    if args.exclude_domain:
        payload["exclude_domains"] = args.exclude_domain
    output_schema = load_json(args.output_schema_file)
    if output_schema is not None:
        payload["output_schema"] = output_schema
    return payload


def redact_request(provider: str, payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "provider": provider,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "payload": payload,
        "auth": "env-or-keychain",
    }


def exa_summary(data: dict[str, Any], payload: dict[str, Any]) -> str:
    lines = [
        "# Exa Search Summary",
        "",
        f"- Query: {payload.get('query')}",
        f"- Type: {payload.get('type')}",
        f"- Request id: {data.get('requestId', 'n/a')}",
        f"- Search type: {data.get('searchType') or data.get('resolvedSearchType') or 'n/a'}",
        f"- Cost: {data.get('costDollars', {}).get('total', 'n/a')}",
        "",
        "## Results",
        "",
    ]
    for index, item in enumerate(data.get("results", []), 1):
        title = item.get("title") or "Untitled"
        url = item.get("url") or item.get("id") or ""
        date = item.get("publishedDate") or "n/a"
        lines.append(f"{index}. [{title}]({url}) - {date}")
        highlights = item.get("highlights") or []
        if highlights:
            first = str(highlights[0]).replace("\n", " ")
            lines.append(f"   - Highlight: {first[:500]}")
    if data.get("output"):
        lines.extend(["", "## Provider Output", "", str(data["output"].get("content", ""))])
    return "\n".join(lines).rstrip() + "\n"


def keenable_search_summary(data: dict[str, Any], payload: dict[str, Any]) -> str:
    lines = [
        "# Keenable Search Summary",
        "",
        f"- Query: {data.get('query') or payload.get('query')}",
        f"- Result count: {len(data.get('results', []))}",
        "- Credit telemetry: unavailable in REST response",
        "",
        "## Results",
        "",
    ]
    for index, item in enumerate(data.get("results", []), 1):
        title = item.get("title") or "Untitled"
        url = item.get("url") or ""
        published = item.get("published_at") or "n/a"
        lines.append(f"{index}. [{title}]({url}) - {published}")
        description = str(item.get("description") or "").replace("\n", " ")
        snippet = str(item.get("snippet") or "").replace("\n", " ")
        if description:
            lines.append(f"   - Description: {description[:500]}")
        if snippet:
            lines.append(f"   - Snippet: {snippet[:500]}")
    return "\n".join(lines).rstrip() + "\n"


def keenable_fetch_summary(data: dict[str, Any], params: dict[str, Any]) -> str:
    max_chars = int(params.get("max_chars") or 10000)
    content = str(data.get("content") or "")
    lines = [
        "# Keenable Fetch Summary",
        "",
        f"- URL: {data.get('url') or params.get('url')}",
        f"- Title: {data.get('title') or 'n/a'}",
        f"- Author: {data.get('author') or 'n/a'}",
        f"- Published: {data.get('published_at') or 'n/a'}",
        f"- Live fetch: {params.get('live')}",
        "- Credit telemetry: unavailable in REST response",
        "",
        "## Content",
        "",
        content[:max_chars],
    ]
    return "\n".join(lines).rstrip() + "\n"


def tavily_summary(data: dict[str, Any], payload: dict[str, Any] | None = None) -> str:
    lines = [
        "# Tavily Research Summary",
        "",
        f"- Request id: {data.get('request_id', 'n/a')}",
        f"- Status: {data.get('status', 'n/a')}",
        f"- Model: {data.get('model') or (payload or {}).get('model', 'n/a')}",
        f"- Response time: {data.get('response_time', 'n/a')}",
        "",
    ]
    content = data.get("content")
    if content:
        lines.extend(["## Content", "", content if isinstance(content, str) else json.dumps(content, indent=2)])
    sources = data.get("sources") or []
    if sources:
        lines.extend(["", "## Sources", ""])
        for index, item in enumerate(sources, 1):
            title = item.get("title") or "Untitled"
            url = item.get("url") or ""
            lines.append(f"{index}. [{title}]({url})")
    return "\n".join(lines).rstrip() + "\n"


def save_request_metadata(raw_output: Path, provider: str, payload: dict[str, Any]) -> None:
    write_json(raw_output.parent / "request.json", redact_request(provider, payload))


def command_exa(args: argparse.Namespace) -> int:
    payload = exa_payload(args)
    raw_output = Path(args.raw_output) if args.raw_output else default_raw_path("exa", args.query)
    save_request_metadata(raw_output, "exa", payload)
    if args.dry_run:
        print(str(raw_output.parent / "request.json"))
        return 0

    api_key = resolve_api_key("EXA_API_KEY", "exa-api-key")
    data = request_json(
        "POST",
        EXA_URL,
        {"x-api-key": api_key},
        payload,
        retries=args.retries,
        timeout=args.timeout_seconds,
    )
    write_json(raw_output, data)
    if args.summary_output:
        write_text(args.summary_output, exa_summary(data, payload))
    write_json(
        raw_output.parent / "run.json",
        {
            "provider": "exa",
            "status": "completed",
            "raw_output": str(raw_output),
            "summary_output": args.summary_output,
            "request_id": data.get("requestId"),
            "cost": data.get("costDollars"),
        },
    )
    print(str(raw_output))
    return 0


def command_keenable_search(args: argparse.Namespace) -> int:
    payload = keenable_search_payload(args)
    raw_output = Path(args.raw_output) if args.raw_output else default_raw_path("keenable", args.query)
    save_request_metadata(raw_output, "keenable-search", payload)
    if args.dry_run:
        print(str(raw_output.parent / "request.json"))
        return 0

    api_key = resolve_api_key("KEENABLE_API_KEY", "keenable-api-key")
    data = request_json(
        "POST",
        KEENABLE_SEARCH_URL,
        {"X-API-Key": api_key},
        payload,
        retries=args.retries,
        timeout=args.timeout_seconds,
    )
    write_json(raw_output, data)
    if args.summary_output:
        write_text(args.summary_output, keenable_search_summary(data, payload))
    write_json(
        raw_output.parent / "run.json",
        {
            "provider": "keenable",
            "operation": "search",
            "status": "completed",
            "raw_output": str(raw_output),
            "summary_output": args.summary_output,
            "result_count": len(data.get("results", [])),
            "credits_telemetry": "unavailable_in_rest_response",
        },
    )
    print(str(raw_output))
    return 0


def command_keenable_fetch(args: argparse.Namespace) -> int:
    params = keenable_fetch_params(args)
    raw_output = Path(args.raw_output) if args.raw_output else default_raw_path("keenable", args.url)
    save_request_metadata(raw_output, "keenable-fetch", params)
    if args.dry_run:
        print(str(raw_output.parent / "request.json"))
        return 0

    api_key = resolve_api_key("KEENABLE_API_KEY", "keenable-api-key")
    request_url = f"{KEENABLE_FETCH_URL}?{urllib.parse.urlencode(params)}"
    data = request_json(
        "GET",
        request_url,
        {"X-API-Key": api_key},
        retries=args.retries,
        timeout=args.timeout_seconds,
    )
    write_json(raw_output, data)
    response_content = str(data.get("content") or "")
    if args.summary_output:
        write_text(args.summary_output, keenable_fetch_summary(data, params))
    write_json(
        raw_output.parent / "run.json",
        {
            "provider": "keenable",
            "operation": "fetch",
            "status": "completed",
            "raw_output": str(raw_output),
            "summary_output": args.summary_output,
            "url": data.get("url") or args.url,
            "response_content_characters": len(response_content),
            "summary_content_characters": min(len(response_content), args.max_chars),
            "content_truncated": len(response_content) > args.max_chars,
            "credits_telemetry": "unavailable_in_rest_response",
        },
    )
    print(str(raw_output))
    return 0


def poll_tavily(
    request_id: str,
    api_key: str,
    *,
    retries: int,
    timeout_seconds: float,
    poll_interval: float,
    max_wait_seconds: float,
    latest_path: Path | None = None,
) -> dict[str, Any]:
    deadline = time.time() + max_wait_seconds
    while True:
        data = request_json(
            "GET",
            f"{TAVILY_RESEARCH_URL}/{request_id}",
            {"Authorization": f"Bearer {api_key}"},
            retries=retries,
            timeout=timeout_seconds,
        )
        if latest_path:
            write_json(latest_path, data)
        status = data.get("status")
        if status in {"completed", "failed"}:
            return data
        if time.time() >= deadline:
            raise ProviderError(f"Tavily request {request_id} did not complete before timeout.")
        time.sleep(poll_interval)


def command_tavily_research(args: argparse.Namespace) -> int:
    payload = tavily_payload(args)
    raw_output = Path(args.raw_output) if args.raw_output else default_raw_path("tavily", args.input)
    validate_tavily_output_paths(raw_output, args.summary_output)
    attempt_path = raw_output.parent / "attempt.json"
    if attempt_path.exists() or (raw_output.parent / "submitted.json").exists():
        raise ProviderError(
            f"Existing Tavily attempt in {raw_output.parent}; inspect its receipt and resume by request_id. "
            "Do not resubmit an uncertain attempt. Use a new output directory only for an authorized new run."
        )
    if args.dry_run:
        request_path = raw_output.parent / "request.json"
        request_path.parent.mkdir(parents=True, exist_ok=True)
        with request_path.open("x", encoding="utf-8") as handle:
            json.dump(redact_request("tavily", payload), handle, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        print(str(request_path))
        return 0

    api_key = resolve_api_key("TAVILY_API_KEY", "tavily-api-key")
    attempt = {
        "provider": "tavily",
        "attempt_id": str(uuid4()),
        "created_at": datetime.now(timezone.utc).isoformat(),
        "status": "submitting",
        "request_id": None,
        "request_metadata": str(raw_output.parent / "request.json"),
        "usage": None,
    }
    # Exclusive creation also prevents concurrent callers from sending twice.
    attempt_path.parent.mkdir(parents=True, exist_ok=True)
    with attempt_path.open("x", encoding="utf-8") as handle:
        json.dump(attempt, handle, indent=2)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    save_request_metadata(raw_output, "tavily", payload)
    try:
        submitted = request_json(
            "POST",
            TAVILY_RESEARCH_URL,
            {"Authorization": f"Bearer {api_key}"},
            payload,
            retries=0,
            timeout=args.timeout_seconds,
        )
    except (Exception, KeyboardInterrupt):
        attempt["status"] = "ambiguity_hold"
        write_json(attempt_path, attempt)
        print(
            f"Tavily submission outcome is unknown. Attempt: {attempt_path}. "
            "Do not replay; recover the exact provider request or obtain approval for a new paid run.",
            file=sys.stderr,
        )
        raise
    write_json(raw_output.parent / "submitted.json", submitted)
    request_id = submitted.get("request_id")
    attempt.update(status="submitted" if request_id else "ambiguity_hold", request_id=request_id)
    if request_id:
        attempt["resume_command"] = tavily_resume_command(args, raw_output, request_id)
    write_json(attempt_path, attempt)
    if not request_id:
        raise ProviderError(
            f"Tavily response did not include request_id; ambiguity hold saved in {attempt_path}. "
            "Do not replay merely because the ID is missing."
        )
    if args.no_wait:
        write_json(raw_output, submitted)
        print(request_id)
        return 0

    try:
        data = poll_tavily(
            request_id,
            api_key,
            retries=args.retries,
            timeout_seconds=args.timeout_seconds,
            poll_interval=args.poll_interval,
            max_wait_seconds=args.max_wait_seconds,
            latest_path=raw_output.parent / "latest.json",
        )
    except (Exception, KeyboardInterrupt):
        print(f"Resume this Tavily request: {attempt['resume_command']}", file=sys.stderr)
        raise
    write_json(raw_output, data)
    if args.summary_output:
        write_text(args.summary_output, tavily_summary(data, payload))
    write_json(
        raw_output.parent / "run.json",
        {
            "provider": "tavily",
            "status": data.get("status"),
            "raw_output": str(raw_output),
            "summary_output": args.summary_output,
            "request_id": request_id,
            "response_time": data.get("response_time"),
        },
    )
    print(str(raw_output))
    return 0


def tavily_resume_command(args: argparse.Namespace, raw_output: Path, request_id: str) -> str:
    command = [
        sys.executable, str(Path(__file__).resolve()), "tavily-poll",
        "--request-id", request_id, "--raw-output", str(raw_output.resolve()),
        "--retries", str(args.retries), "--timeout-seconds", str(args.timeout_seconds),
        "--poll-interval", str(args.poll_interval), "--max-wait-seconds", str(args.max_wait_seconds),
    ]
    if args.summary_output:
        command.extend(["--summary-output", str(Path(args.summary_output).resolve())])
    return shlex.join(command)


def validate_tavily_output_paths(raw_output: Path, summary_output: str | None) -> None:
    if raw_output.name.casefold() in TAVILY_RECORD_NAMES:
        raise ProviderError("--raw-output must not use a reserved Tavily record filename.")
    if summary_output:
        summary = Path(summary_output).resolve()
        if summary == raw_output.resolve() or (
            summary.parent == raw_output.resolve().parent and summary.name.casefold() in TAVILY_RECORD_NAMES
        ):
            raise ProviderError("--summary-output must not overwrite the raw output or a Tavily record.")


def verify_tavily_poll_identity(raw_output: Path, request_id: str) -> None:
    records = [raw_output, *(raw_output.parent / name for name in sorted(TAVILY_RECORD_NAMES))]
    for record_path in records:
        if not record_path.exists():
            continue
        try:
            record = json.loads(record_path.read_text(encoding="utf-8"))
            if not isinstance(record, dict):
                raise ValueError("Expected a request record")
        except (OSError, ValueError) as error:
            raise ProviderError(f"Cannot verify the existing Tavily record: {record_path}") from error
        recorded_id = record.get("request_id")
        if recorded_id not in (None, "") and recorded_id != request_id:
            raise ProviderError(
                f"Tavily request_id conflicts with the existing record {record_path}; "
                "poll the saved request ID or choose a separate output directory."
            )


def command_tavily_poll(args: argparse.Namespace) -> int:
    raw_output = Path(args.raw_output) if args.raw_output else default_raw_path("tavily", args.request_id)
    validate_tavily_output_paths(raw_output, args.summary_output)
    verify_tavily_poll_identity(raw_output, args.request_id)
    if args.dry_run:
        poll_metadata = raw_output.parent / "poll-request.json"
        write_json(poll_metadata, {"provider": "tavily", "request_id": args.request_id})
        print(str(poll_metadata))
        return 0

    api_key = resolve_api_key("TAVILY_API_KEY", "tavily-api-key")
    data = poll_tavily(
        args.request_id,
        api_key,
        retries=args.retries,
        timeout_seconds=args.timeout_seconds,
        poll_interval=args.poll_interval,
        max_wait_seconds=args.max_wait_seconds,
        latest_path=raw_output.parent / "latest.json",
    )
    write_json(raw_output, data)
    if args.summary_output:
        write_text(args.summary_output, tavily_summary(data))
    print(str(raw_output))
    return 0


def add_common_network_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--raw-output", help="Path for final raw JSON. Defaults under work/research-router/.")
    parser.add_argument("--summary-output", help="Optional Markdown summary path.")
    parser.add_argument("--retries", type=int, default=2, help="Retries for read-only GET/HEAD failures; POST submissions are never replayed automatically.")
    parser.add_argument("--timeout-seconds", type=float, default=60.0, help="Per-request HTTP timeout.")
    parser.add_argument("--dry-run", action="store_true", help="Write request metadata without calling the provider.")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    exa = sub.add_parser("exa-search", help="Run Exa Search API.")
    exa.add_argument("--query", required=True)
    exa.add_argument(
        "--type",
        default="auto",
        choices=["instant", "fast", "auto", "deep-lite", "deep", "deep-reasoning"],
    )
    exa.add_argument("--num-results", type=int, default=10)
    exa.add_argument("--content", choices=["highlights", "text", "both"], default="highlights")
    exa.add_argument("--text-max-characters", type=int, default=6000)
    exa.add_argument("--additional-query", action="append", default=[])
    exa.add_argument("--include-domain", action="append", default=[])
    exa.add_argument("--exclude-domain", action="append", default=[])
    exa.add_argument("--category")
    exa.add_argument("--system-prompt")
    exa.add_argument("--output-schema-file")
    add_common_network_args(exa)
    exa.set_defaults(func=command_exa)

    keenable = sub.add_parser("keenable-search", help="Run Keenable Search API.")
    keenable.add_argument("--query", required=True)
    keenable.add_argument("--site")
    keenable.add_argument("--acquired-after")
    keenable.add_argument("--acquired-before")
    keenable.add_argument("--published-after")
    keenable.add_argument("--published-before")
    keenable.add_argument("--query-time")
    keenable.add_argument("--snippet-max-length", type=int, default=1200)
    keenable.add_argument("--max-results", type=int, default=10)
    add_common_network_args(keenable)
    keenable.set_defaults(func=command_keenable_search)

    keenable_fetch = sub.add_parser("keenable-fetch", help="Run Keenable Fetch API.")
    keenable_fetch.add_argument("--url", required=True)
    keenable_fetch.add_argument("--max-chars", type=int, default=10000)
    keenable_fetch.add_argument("--live", action="store_true")
    keenable_fetch.add_argument("--prompt")
    add_common_network_args(keenable_fetch)
    keenable_fetch.set_defaults(func=command_keenable_fetch)

    tavily = sub.add_parser("tavily-research", help="Create and optionally poll a Tavily Research task.")
    tavily.add_argument("--input", required=True)
    tavily.add_argument("--model", choices=["mini", "pro", "auto"], default="auto")
    tavily.add_argument("--output-length", choices=["short", "standard", "long"], default="standard")
    tavily.add_argument("--citation-format", choices=["numbered", "mla", "apa", "chicago"], default="numbered")
    tavily.add_argument("--include-domain", action="append", default=[])
    tavily.add_argument("--exclude-domain", action="append", default=[])
    tavily.add_argument("--output-schema-file")
    tavily.add_argument("--no-wait", action="store_true", help="Submit only and print request_id.")
    tavily.add_argument("--poll-interval", type=float, default=10.0)
    tavily.add_argument("--max-wait-seconds", type=float, default=1800.0)
    add_common_network_args(tavily)
    tavily.set_defaults(func=command_tavily_research)

    poll = sub.add_parser("tavily-poll", help="Poll an existing Tavily Research task.")
    poll.add_argument("--request-id", required=True)
    poll.add_argument("--poll-interval", type=float, default=10.0)
    poll.add_argument("--max-wait-seconds", type=float, default=1800.0)
    add_common_network_args(poll)
    poll.set_defaults(func=command_tavily_poll)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except ProviderError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
