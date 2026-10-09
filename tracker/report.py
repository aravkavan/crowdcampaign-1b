"""Writes reports/runN.md: per campaign, New since last run, then Still in top K, then Dropped."""
from __future__ import annotations

import re
from datetime import datetime
from urllib.parse import quote, urlsplit

STATUS_TEXT = {
    "complete": "Complete",
    "partial": "Partial (a budget ran out or a service failed; built from the evidence gathered so far)",
    "failed": "Failed",
}


def md(text: str) -> str:
    """Escape web-sourced text so it can't add links, images, HTML or formatting to the report."""
    text = re.sub(r"\s+", " ", str(text or "")).strip()
    text = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return re.sub(r"([\\`*_\[\]()#|!~])", r"\\\1", text)


def link(url: str, label: str) -> str:
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https"):
        return md(url)
    safe = quote(url, safe=":/?#[]@!$&'*+,;=%~-._")
    safe = safe.replace("(", "%28").replace(")", "%29")
    return f"[{md(label or parts.hostname or url)}]({safe})"


def _sources(sources: list) -> list:
    lines = []
    for s in sources:
        host = (urlsplit(s["url"]).hostname or "").removeprefix("www.")
        lines.append(f"   - Source: {link(s['url'], s.get('title') or host)} ({md(host)}): “{md(s['quote'])}”")
    return lines


def _item(rank: int, item, k: int) -> list:
    if item.change == "new":
        note = ""
    elif item.change == "still":
        note = f" (was #{item.previous_rank})" if item.previous_rank else ""
    else:
        note = f" (back in the top {k}; first seen in run {item.first_run})"
    return [f"**#{rank} {md(item.title)}**{note}  ", f"   {md(item.summary)}"] + _sources(item.all_sources) + [""]


def render(*, run_number: int, started: datetime, finished: datetime, status: str, model_label: str, config,
           results: list, missing: list, stats: dict, notes: list) -> str:
    when = started.astimezone().strftime("%A, %B %d, %Y at %I:%M %p %Z").replace(" 0", " ")
    lines = [
        f"# Market intel: run {run_number}",
        "",
        f"{when} · {STATUS_TEXT.get(status, status)}  ",
        f"Model: {model_label} · Search: Tavily ({config.search.topic}, past {config.search.time_range}) · "
        f"K = {config.k} per campaign",
        "",
    ]
    for note in notes:
        lines += [f"> {md(note)}", ""]
    for res in results:
        c = res.campaign
        lines += [f"## {md(c['title'])}", "", f"*{md(c['brand'])}* · Research topic: {md(res.topic)}", ""]
        if res.status != "complete":
            lines += [f"**{STATUS_TEXT[res.status].split(' (')[0]}:** {md(res.stop_reason or '')}", ""]
        if res.status == "failed":
            lines += ["No results for this campaign in this run; its previous top list is unchanged.", ""]
            continue
        ranked = list(enumerate(res.top, start=1))
        new = [(r, i) for r, i in ranked if i.change == "new"]
        still = [(r, i) for r, i in ranked if i.change != "new"]
        lines += ["### New since last run", ""]
        lines += [x for r, i in new for x in _item(r, i, config.k)] or ["Nothing new this time.", ""]
        lines += [f"### Still in top {config.k}", ""]
        lines += [x for r, i in still for x in _item(r, i, config.k)] or ["None.", ""]
        lines += ["### Dropped", ""]
        if res.status == "partial":
            lines += ["Not judged: this campaign's run was partial, so nothing was re-ranked or dropped.", ""]
        elif res.dropped:
            lines += [f"- **{md(d['title'])}** (was #{d.get('last_rank')})" for d in res.dropped] + [""]
        else:
            lines += ["Nothing dropped.", ""]
    for title in missing:
        lines += [f"## {md(title)}", "", "Not researched: no campaign with this exact title exists in the app.", ""]

    articles = [a for r in results for a in r.articles]
    count = lambda s: sum(1 for a in articles if a["status"] == s)  # noqa: E731
    minutes, seconds = divmod(int((finished - started).total_seconds()), 60)
    lines += [
        "---",
        "",
        "Run stats: "
        f"{stats['model_calls']} model calls, {stats['tokens']:,} tokens, "
        f"{stats['searches']} searches ({stats['credits']} Tavily credits), "
        f"{count('fetched')} articles fetched, {count('skipped')} skipped as already seen, "
        f"{count('rejected')} rejected by the guardrail, {count('failed')} failed; "
        f"{minutes} min {seconds} s.",
        "",
    ]
    return "\n".join(lines)


def payload(*, started: datetime, finished: datetime, status: str, stop_reason, model_label: str, stats: dict,
            markdown: str, results: list) -> dict:
    """The run, in the shape POST /api/tracker/runs expects."""
    return {
        "started_at": started.isoformat(),
        "finished_at": finished.isoformat(),
        "status": status,
        "stop_reason": stop_reason,
        "model": model_label,
        "stats": stats,
        "report_markdown": markdown,
        "campaigns": [
            {
                "campaign_id": r.campaign["id"],
                "topic": r.topic,
                "status": r.status,
                "stop_reason": r.stop_reason,
                "top": [] if r.status == "failed" else [
                    {"ref": i.ref, "title": i.title, "summary": i.summary, "sources": i.sources} for i in r.top
                ],
            }
            for r in results
        ],
        "articles": [a for r in results for a in r.articles],
    }
