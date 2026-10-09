"""Command line for the market-intel tracker.

    python -m tracker run                 research every campaign in config.yaml (one run)
    python -m tracker status              what the tracker remembers
    python -m tracker reset               forget every saved run (asks first)
    python -m tracker stats traces/run1.jsonl   round trips, time, tokens and credits of a run
"""
from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime
from pathlib import Path

from .agent import CampaignAgent
from .config import REPO_ROOT, ConfigError, load_config
from .failures import TerminalError
from .guard import RobotsCache
from .llm import ChatModel
from .memory import AppClient
from .report import payload, render
from .tools import url_key
from .trace import Trace, format_summary, summarize

REPORTS = REPO_ROOT / "reports"
TRACES = REPO_ROOT / "traces"


def say(text: str = "") -> None:
    print(text, flush=True)


def cmd_run(args) -> int:
    try:
        config = load_config(args.config)
        model_settings = config.model()
    except ConfigError as err:
        say(f"Can't start: {err}")
        return 2
    if "search_web" in config.tools and not os.environ.get("TAVILY_API_KEY", "").strip():
        say("Can't start: TAVILY_API_KEY is not set. Add it to tracker/.env (free key at https://app.tavily.com).")
        return 2

    trace = Trace()
    app = AppClient(trace)
    say("CrowdCampaign market-intel tracker")
    say(f"  Model:  {model_settings.label} ({model_settings.name})")
    say(f"  Search: Tavily ({config.search.topic}, past {config.search.time_range}), K = {config.k}")
    say(f"  App:    {app.base_url} as {app.username or '(TRACKER_USERNAME not set)'}")

    try:
        app.login()
        campaigns = app.campaigns()
        state = app.load_state()
    except TerminalError as err:
        say(f"\nStopped before starting: {err.message}")
        return 2

    run_number = state["next_run_number"]
    trace.open(TRACES / f"run{run_number}.jsonl", run_number)
    last = state.get("last_run")
    say(f"  Run:    #{run_number}" + (f" (last run: #{last['number']} on {_local(last['started_at'])})" if last else " (first run)"))

    by_title = {c["title"].strip().lower(): c for c in campaigns}
    memory = {c["campaign_id"]: c for c in state.get("campaigns", [])}
    seen = {url_key(s["url"]): s for s in state.get("seen_urls", [])}
    run_cache: dict = {}
    model = ChatModel(model_settings, config.retries, trace)
    robots = RobotsCache(config.fetch, trace)
    today = datetime.now().astimezone().strftime("%A, %B %d, %Y").replace(" 0", " ")

    started = datetime.now().astimezone()
    results, missing, fatal = [], [], None
    for index, target in enumerate(config.targets, start=1):
        campaign = by_title.get(target.title.lower())
        if campaign is None:
            missing.append(target.title)
            say(f"\n[{index}/{len(config.targets)}] {target.title}\n  Not found in the app: check the title in config.yaml "
                "(or run npm run seed in backend to add the demo campaigns).")
            continue
        info = {"id": campaign["id"], "title": campaign["title"], "brand": campaign["brand"]}
        say(f"\n[{index}/{len(config.targets)}] {campaign['title']} ({campaign['brand']})")
        if fatal is not None:
            from .agent import CampaignResult

            results.append(CampaignResult(campaign=info, topic=target.topic, status="failed",
                                          stop_reason=f"not started: {fatal.message}"))
            say(f"  Skipped: {fatal.message}")
            continue
        agent = CampaignAgent(config=config, model=model, trace=trace, campaign=info, target=target,
                              memory=memory.get(campaign["id"], {}), seen=seen, run_cache=run_cache,
                              robots=robots, today=today)
        result = agent.run()
        results.append(result)
        _print_campaign(result, config.k)
        if agent.fatal is not None:
            fatal = agent.fatal
            say(f"  Stopping the run: {fatal}")

    finished = datetime.now().astimezone()
    if not results:
        say("\nNone of the campaigns in config.yaml exist in the app, so nothing was researched.")
        trace.close()
        return 2

    statuses = {r.status for r in results}
    status = "complete" if statuses == {"complete"} and not missing else "failed" if statuses == {"failed"} else "partial"
    reasons = [f"{r.campaign['title']}: {r.stop_reason}" for r in results if r.status != "complete" and r.stop_reason]
    stats = {
        "model_calls": sum(r.steps for r in results),
        "tokens": sum(r.tokens for r in results),
        "searches": sum(r.searches for r in results),
        "credits": sum(r.credits for r in results),
        "fetches": sum(r.fetches for r in results),
        "seconds": int((finished - started).total_seconds()),
        "campaigns": len(results),
        "k": config.k,
    }
    notes = []
    if fatal is not None:
        notes.append(f"The run stopped early: {fatal}")
    markdown = render(run_number=run_number, started=started, finished=finished, status=status,
                      model_label=model.label, config=config, results=results, missing=missing, stats=stats, notes=notes)
    trace.event("run_end", status=status, **stats)

    if status == "failed":
        # Nothing was learned, so the run is not saved and doesn't use up a run number.
        stamp = started.strftime("%Y%m%d-%H%M%S")
        report_path = REPORTS / f"failed-{stamp}.md"
        _write(report_path, markdown)
        trace.rename(TRACES / f"failed-{stamp}.jsonl")
        trace.close()
        say(f"\nThe run failed: {fatal or 'no campaign could be researched'}")
        say(f"Report: {_rel(report_path)}   Trace: {_rel(trace.path)}")
        say("Nothing was saved to the app. Fix the problem above and run the tracker again.")
        return 2

    report_path = REPORTS / f"run{run_number}.md"
    _write(report_path, markdown)
    trace.event("save", status="saving")
    try:
        saved = app.save_run(payload(started=started, finished=finished, status=status,
                                     stop_reason="; ".join(reasons)[:500] or None, model_label=model.label,
                                     stats=stats, markdown=markdown, results=results))
    except TerminalError as err:
        trace.close()
        say(f"\nReport written to {_rel(report_path)}, but the run could not be saved to the app: {err.message}")
        say("The next run will not know about this one. Fix the problem and run the tracker again.")
        return 1
    trace.close()
    if saved.get("number") != run_number:  # another run was saved in between: keep the names in step
        new_number = saved["number"]
        report_path = report_path.replace(REPORTS / f"run{new_number}.md")
        trace.rename(TRACES / f"run{new_number}.jsonl")
        run_number = new_number

    counts = saved.get("counts", {})
    say("")
    say(f"Run {run_number}: {status}. {counts.get('new', 0)} new, {counts.get('still', 0)} still in the top list, "
        f"{counts.get('dropped', 0)} dropped.")
    say(f"Usage: {_n(stats['model_calls'], 'model call')}, {stats['tokens']:,} tokens, {_n(stats['searches'], 'search', 'searches')} "
        f"({_n(stats['credits'], 'credit')}), {_n(stats['fetches'], 'download')}, {stats['seconds'] // 60} min {stats['seconds'] % 60} s.")
    say(f"Report: {_rel(report_path)}")
    say(f"Trace:  {_rel(trace.path)}")
    say("See it in the app: open the frontend and choose Market intel.")
    return 0


def _print_campaign(result, k: int) -> None:
    new = sum(1 for i in result.top if i.change == "new")
    still = len(result.top) - new
    if result.status == "failed":
        say(f"  Failed: {result.stop_reason}")
        return
    line = f"  {result.status.capitalize()}: top {len(result.top)} ({new} new, {still} still"
    line += f", {len(result.dropped)} dropped)" if result.status == "complete" else ")"
    if result.stop_reason:
        line += f". {result.stop_reason}"
    say(line)
    for rank, item in enumerate(result.top, start=1):
        tag = "NEW " if item.change == "new" else "    "
        say(f"   {tag}#{rank} {item.title[:90]}")
    fetched = sum(1 for a in result.articles if a["status"] == "fetched")
    skipped = sum(1 for a in result.articles if a["status"] == "skipped")
    rejected = sum(1 for a in result.articles if a["status"] == "rejected")
    say(f"  {result.steps} model calls, {result.searches} searches, {fetched} fetched, {skipped} skipped (already seen), "
        f"{rejected} rejected")


def cmd_status(args) -> int:
    try:
        load_config(args.config)
    except ConfigError as err:
        say(f"Config problem: {err}")
        return 2
    trace = Trace()
    app = AppClient(trace)
    try:
        app.login()
        state = app.load_state()
        campaigns = {c["id"]: c["title"] for c in app.campaigns()}
    except TerminalError as err:
        say(f"Stopped: {err.message}")
        return 2
    last = state.get("last_run")
    if not last:
        say(f"No saved runs for {app.username}. Run: python -m tracker run")
        return 0
    say(f"Last run: #{last['number']} on {_local(last['started_at'])} ({last['status']}). Next run: #{state['next_run_number']}.")
    say(f"Articles remembered (skipped next time): {len(state['seen_urls'])}")
    for c in state["campaigns"]:
        devs = {d["id"]: d for d in c["developments"]}
        say(f"\n{campaigns.get(c['campaign_id'], c['campaign_id'])}: {len(devs)} developments known")
        for t in c["last_top"]:
            say(f"  #{t['rank']} {devs.get(t['development_id'], {}).get('title', '?')}")
    return 0


def cmd_reset(args) -> int:
    try:
        load_config(args.config)
    except ConfigError as err:
        say(f"Config problem: {err}")
        return 2
    trace = Trace()
    app = AppClient(trace)
    try:
        app.login()
        state = app.load_state()
    except TerminalError as err:
        say(f"Stopped: {err.message}")
        return 2
    runs = state["next_run_number"] - 1
    if not args.yes:
        answer = input(f"This deletes all {runs} saved runs for {app.username} (reports in the app, what was seen, "
                       f"the top lists). Type reset to continue: ")
        if answer.strip().lower() != "reset":
            say("Nothing was deleted.")
            return 1
    try:
        result = app.reset()
    except TerminalError as err:
        say(f"Stopped: {err.message}")
        return 2
    deleted = result.get("deleted", {})
    say(f"Reset done: deleted {deleted.get('runs', 0)} runs and {deleted.get('developments', 0)} developments. "
        "The next run will be run 1 and will treat every article as new.")
    if args.delete_files:
        removed = 0
        for folder, pattern in ((REPORTS, "run*.md"), (REPORTS, "failed-*.md"), (TRACES, "run*.jsonl"), (TRACES, "failed-*.jsonl")):
            for path in folder.glob(pattern):
                path.unlink()
                removed += 1
        say(f"Also deleted {removed} report and trace files.")
    else:
        say("Report and trace files in reports/ and traces/ were kept (add --delete-files to remove them).")
    return 0


def cmd_stats(args) -> int:
    path = Path(args.trace)
    if not path.exists():
        say(f"No such file: {path}")
        return 2
    say(format_summary(summarize(path)))
    return 0


def _n(count: int, word: str, plural: str | None = None) -> str:
    return f"{count} {word if count == 1 else plural or word + 's'}"


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _rel(path) -> str:
    try:
        return str(Path(path).relative_to(Path.cwd()))
    except ValueError:
        return str(path)


def _local(iso: str) -> str:
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone().strftime("%a %b %d, %I:%M %p")
    except (TypeError, ValueError):
        return str(iso)


def main(argv=None) -> int:
    try:
        sys.stdout.reconfigure(errors="replace")
    except AttributeError:  # pragma: no cover
        pass
    parser = argparse.ArgumentParser(prog="python -m tracker", description="CrowdCampaign market-intel tracker")
    parser.add_argument("--config", help="path to config.yaml (default: the one in the project folder)")
    sub = parser.add_subparsers(dest="command")
    sub.add_parser("run", help="research every campaign in config.yaml")
    sub.add_parser("status", help="show what the tracker remembers")
    p = sub.add_parser("reset", help="forget every saved run")
    p.add_argument("--yes", action="store_true", help="don't ask for confirmation")
    p.add_argument("--delete-files", action="store_true", help="also delete reports/run*.md and traces/run*.jsonl")
    p = sub.add_parser("stats", help="summarize a trace file")
    p.add_argument("trace", help="for example traces/run1.jsonl")
    args = parser.parse_args(argv)
    commands = {"run": cmd_run, "status": cmd_status, "reset": cmd_reset, "stats": cmd_stats}
    if args.command not in commands:
        parser.print_help()
        return 1
    try:
        return commands[args.command](args)
    except KeyboardInterrupt:
        say("\nStopped (Ctrl+C). Nothing from this run was saved to the app.")
        return 130


if __name__ == "__main__":
    sys.exit(main())
