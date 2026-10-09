"""The agent's tools: search_web(query), fetch_article(url) and finish(report).

Each one also runs on its own, without the model:

    python -m tracker.tools search_web "oat milk cold brew launch"
    python -m tracker.tools fetch_article https://example.com/some-article
    python -m tracker.tools finish my-report.json

finish from the command line checks a report file: it fetches every cited source through
fetch_article's guardrail and says whether each quoted sentence really appears there.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit

import requests

from .config import ConfigError, load_config
from .extract import decode, extract, looks_like_instructions
from .failures import TerminalError, TransientError, classify_http_error, with_retries
from .guard import FetchFailed, Rejected, RobotsCache, check_url, fetch_page
from .trace import Trace
from .verify import quote_problem

TRACKING_PARAMS = {"fbclid", "gclid", "dclid", "msclkid", "mc_cid", "mc_eid", "ref", "ref_src", "cmpid", "ocid",
                   "smid", "sr_share", "igshid", "mkt_tok", "guccounter", "guce_referrer", "guce_referrer_sig"}


def url_key(url: str) -> str:
    """The same article under small URL differences (www., http/https, tracking tags) gets one key."""
    try:
        parts = urlsplit(url.strip())
    except ValueError:
        return url.strip()
    host = (parts.hostname or "").lower().removeprefix("www.")
    path = parts.path.rstrip("/") or "/"
    query = urlencode(sorted((k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True)
                             if not k.lower().startswith("utm_") and k.lower() not in TRACKING_PARAMS))
    return f"{host}{path}" + (f"?{query}" if query else "")


# ------------------------------------------------------------------ search_web

def search_web(query: str, *, config, trace: Trace, session=None) -> dict:
    """Search recent news with Tavily. Returns {'query', 'results': [...], 'credits'}."""
    import os

    query = (query or "").strip()
    if not 2 <= len(query) <= 400:
        raise ValueError("the search query must be 2 to 400 characters")
    key = os.environ.get("TAVILY_API_KEY", "").strip()
    if not key:
        raise TerminalError("search", "TAVILY_API_KEY is not set. Add it to tracker/.env (free key at https://app.tavily.com).")
    s = config.search
    body = {
        "query": query,
        "topic": s.topic,
        "time_range": s.time_range,
        "max_results": s.max_results,
        "search_depth": s.search_depth,
        "include_answer": False,
        "include_raw_content": False,
        "include_published_date": True,
        "include_usage": True,
        "exclude_domains": list(config.fetch.blocked_hosts)[:150],
    }
    url = f"{s.base_url}/search"
    host = urlsplit(url).hostname
    http = session or requests

    def attempt(number: int) -> dict:
        started = time.monotonic()
        status = None
        try:
            response = http.post(url, json=body, headers={"Authorization": f"Bearer {key}"}, timeout=(10, 30))
            status = response.status_code
        except requests.Timeout:
            raise TransientError("search", "the search request timed out") from None
        except requests.ConnectionError:
            raise TransientError("search", f"can't reach {host} (is the internet connection up?)") from None
        finally:
            trace.event("http", service="search", host=host, attempt=number, status=status,
                        latency_ms=int((time.monotonic() - started) * 1000))
        if status >= 400:
            raise classify_http_error("search", status, response.headers, response.text)
        try:
            return response.json()
        except ValueError:
            raise TransientError("search", "the search reply was not JSON") from None

    started = time.monotonic()
    data = with_retries(attempt, service="search", policy=config.retries, trace=trace)
    results = []
    for item in data.get("results") or []:
        link = str(item.get("url") or "").strip()
        if not link.startswith(("http://", "https://")):
            continue
        results.append({
            "title": str(item.get("title") or "")[:200],
            "url": link,
            "published": str(item.get("published_date") or "")[:40],
            "snippet": " ".join(str(item.get("content") or "").split())[:280],
        })
    credits = (data.get("usage") or {}).get("credits")
    if credits is None:
        credits = 2 if s.search_depth == "advanced" else 1
    trace.event("tool", tool="search_web", args={"query": query}, status="ok", results=len(results),
                credits=int(credits), latency_ms=int((time.monotonic() - started) * 1000))
    return {"query": query, "results": results, "credits": int(credits)}


# ------------------------------------------------------------------ fetch_article

def fetch_article(url: str, *, config, trace: Trace, robots: RobotsCache | None = None) -> dict:
    """Download one article through the guardrail and return its text.

    Never raises for a bad URL: the result's status is "fetched", "rejected" (the
    guardrail refused it before any request) or "failed" (the download didn't work).
    """
    started = time.monotonic()
    result = {"url": url}
    try:
        check_url(url, config.fetch)  # refuse bad URLs before anything else, robots.txt included
        if robots is not None:
            reason = robots.check(url)
            if reason:
                raise Rejected(reason)
        page = fetch_page(url, config.fetch, trace=trace)
        html = decode(page.body, page.charset)
        content = extract(html, page.content_type)
        text = content["text"]
        flagged = looks_like_instructions(content["title"] + "\n" + text)
        result.update(
            final_url=page.final_url,
            title=content["title"] or url,
            published=content["published"],
            http_status=page.http_status,
            bytes=len(page.body),
            truncated=page.truncated,
            flagged=flagged,
            words=len(text.split()),
            text=text,
        )
        if len(text) < 200:
            result.update(status="failed", reason="the page has almost no readable text (it may need JavaScript or a login)")
        else:
            result["status"] = "fetched"
    except Rejected as err:
        result.update(status="rejected", reason=err.reason)
    except FetchFailed as err:
        result.update(status="failed", reason=err.reason, http_status=err.http_status)
    trace.event(
        "tool",
        tool="fetch_article",
        args={"url": url},
        status=result["status"],
        reason=result.get("reason"),
        http_status=result.get("http_status"),
        bytes=result.get("bytes"),
        flagged=result.get("flagged"),
        truncated=result.get("truncated"),
        latency_ms=int((time.monotonic() - started) * 1000),
    )
    return result


# ------------------------------------------------------------------ finish (stand-alone check)

def finish(report: dict, *, config, trace: Trace) -> dict:
    """Check a finished report: every source must be fetchable and contain its quote.

    Inside a run the agent's finish step works on ids of notes it has already verified
    (see agent.py). This stand-alone form takes full items so a report can be checked by hand.
    """
    items = report.get("items") if isinstance(report, dict) else None
    if not isinstance(items, list) or not items:
        raise ValueError('the report must look like {"items": [{"title", "summary", "sources": [{"url", "quote"}]}]}')
    if len(items) > config.k:
        raise ValueError(f"the report has {len(items)} items; k in config.yaml is {config.k}")
    robots = RobotsCache(config.fetch, trace)
    checked = []
    lines = [f"# {report.get('title') or 'Report check'}", ""]
    all_ok = True
    for rank, item in enumerate(items, start=1):
        title = str(item.get("title") or "").strip()
        summary = str(item.get("summary") or "").strip()
        sources = item.get("sources") or []
        if not title or not summary or not sources:
            raise ValueError(f"item {rank} needs a title, a summary and at least one source")
        lines += [f"{rank}. **{title}**  ", f"   {summary}"]
        results = []
        for source in sources:
            fetched = fetch_article(str(source.get("url") or ""), config=config, trace=trace, robots=robots)
            if fetched["status"] != "fetched":
                verdict = f"could not check: {fetched['status']} ({fetched.get('reason')})"
            else:
                problem = quote_problem(str(source.get("quote") or ""), fetched["title"] + "\n" + fetched["text"])
                verdict = "verified: the quote is in the source" if not problem else f"NOT verified: {problem}"
            all_ok = all_ok and verdict.startswith("verified")
            results.append({"url": source.get("url"), "verdict": verdict})
            lines.append(f"   - {source.get('url')}: \"{source.get('quote')}\" ({verdict})")
        checked.append({"rank": rank, "title": title, "sources": results})
        lines.append("")
    trace.event("tool", tool="finish", args={"items": len(items)}, status="verified" if all_ok else "unverified")
    return {"ok": all_ok, "items": checked, "markdown": "\n".join(lines)}


# ------------------------------------------------------------------ command line

def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="python -m tracker.tools", description="Run one tracker tool without the model.")
    parser.add_argument("--config", help="path to config.yaml (default: the one in the project folder)")
    sub = parser.add_subparsers(dest="tool", required=True)
    p = sub.add_parser("search_web", help="search recent news")
    p.add_argument("query")
    p = sub.add_parser("fetch_article", help="fetch one URL through the guardrail")
    p.add_argument("url")
    p.add_argument("--full", action="store_true", help="print the whole text, not just the start")
    p = sub.add_parser("finish", help="check a report file's sources and quotes")
    p.add_argument("report", help="a JSON file, or - to read from standard input")
    args = parser.parse_args(argv)

    try:
        config = load_config(args.config)
    except ConfigError as err:
        print(f"Config problem: {err}", file=sys.stderr)
        return 2
    trace = Trace()
    try:
        if args.tool == "search_web":
            out = search_web(args.query, config=config, trace=trace)
            print(json.dumps(out, indent=2, ensure_ascii=False))
            return 0
        if args.tool == "fetch_article":
            out = fetch_article(args.url, config=config, trace=trace, robots=RobotsCache(config.fetch, trace))
            if "text" in out and not args.full:
                out["text_preview"] = out.pop("text")[:1500]
            print(json.dumps(out, indent=2, ensure_ascii=False))
            return {"fetched": 0, "rejected": 3, "failed": 4}[out["status"]]
        raw = sys.stdin.read() if args.report == "-" else Path(args.report).read_text(encoding="utf-8")
        out = finish(json.loads(raw), config=config, trace=trace)
        print(out["markdown"])
        print("\nAll quotes verified." if out["ok"] else "\nSome quotes could not be verified.")
        return 0 if out["ok"] else 1
    except (TerminalError, TransientError) as err:
        print(f"Stopped: {err}", file=sys.stderr)
        return 2
    except (ValueError, json.JSONDecodeError, OSError) as err:
        print(f"Problem: {err}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
