"""The agent loop for one campaign: search -> fetch -> observe -> decide -> synthesize.

Who decides what:
  The model decides  which searches to run, which results to read, what each article
                     says (notes), whether two notes are the same event, and the ranking.
  The code decides   everything that must not be left to a model: the budgets and when to
                     stop, which URLs may be fetched (only ones from search results, through
                     the guardrail), skipping articles already read in earlier runs, whether
                     each quote is really in its article, the New / Still / Dropped sections,
                     and the partial report when a budget runs out.
"""
from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass, field

from . import prompts
from .failures import TerminalError
from .tools import fetch_article, search_web, url_key
from .verify import quote_problem, unsupported_numbers

STOPWORDS = set("""a an and are as at be by for from has have in into is it its new of on or the to with will
was were this that than their they our your after over more most first launches launch launched""".split())


class ActionError(ValueError):
    """The model's reply wasn't a usable action."""


@dataclass
class Action:
    tool: str
    args: dict
    notes: list


@dataclass
class Note:
    id: str
    url: str
    key: str
    article_title: str
    title: str
    summary: str
    quote: str
    same_as: str | None = None


@dataclass
class Item:
    """One development in this run's top list."""

    ref: str  # an existing development id, or "new:<n>"
    title: str
    summary: str
    sources: list  # sources to save with this run (new ones only)
    all_sources: list  # every source, for the report
    change: str  # "new", "still" (in the last top list) or "back" (known, but not in the last top list)
    previous_rank: int | None = None
    first_run: int | None = None


@dataclass
class CampaignResult:
    campaign: dict
    topic: str
    status: str  # complete | partial | failed
    stop_reason: str | None
    top: list = field(default_factory=list)
    dropped: list = field(default_factory=list)
    articles: list = field(default_factory=list)
    steps: int = 0
    tokens: int = 0
    searches: int = 0
    fetches: int = 0
    credits: int = 0


class Budget:
    """Counts what the agent has used. The loop checks it before every model call."""

    def __init__(self, limits, clock=time.monotonic):
        self.limits = limits
        self.clock = clock
        self.started = clock()
        self.steps = self.searches = self.fetches = self.tokens = 0

    def elapsed(self) -> float:
        return self.clock() - self.started

    def stop_reason(self) -> str | None:
        """Why no more model calls are allowed, or None while budget remains."""
        lim = self.limits
        if self.steps >= lim.max_steps:
            return f"step budget used up ({lim.max_steps} model calls)"
        if self.tokens >= lim.max_tokens:
            return f"token budget used up ({self.tokens:,} of {lim.max_tokens:,} tokens)"
        if self.elapsed() >= lim.max_seconds:
            return f"time budget used up ({lim.max_seconds} s)"
        return None

    def last_call_reason(self) -> str | None:
        """Why the next model call must be the last one (so the model should finish), or None."""
        lim = self.limits
        if self.steps + 1 >= lim.max_steps:
            return f"step budget reached ({lim.max_steps} model calls)"
        if self.tokens >= 0.85 * lim.max_tokens:
            return f"token budget nearly used up ({self.tokens:,} of {lim.max_tokens:,} tokens)"
        if self.elapsed() >= 0.85 * lim.max_seconds:
            return f"time budget nearly used up ({lim.max_seconds} s)"
        return None

    def left(self) -> dict:
        lim = self.limits
        return {
            "steps": max(0, lim.max_steps - self.steps),
            "searches": max(0, lim.max_searches - self.searches),
            "fetches": max(0, lim.max_fetches - self.fetches),
        }


def parse_action(text: str, allowed_tools) -> Action:
    """Turn the model's reply into an Action, or raise ActionError saying what's wrong."""
    cleaned = re.sub(r"```(?:json)?", "", text or "").strip()
    start, end = cleaned.find("{"), cleaned.rfind("}")
    if start == -1 or end <= start:
        raise ActionError("no JSON object found")
    try:
        data = json.loads(cleaned[start:end + 1])
    except json.JSONDecodeError as err:
        raise ActionError(f"the JSON is not valid ({err.msg})") from None
    if not isinstance(data, dict):
        raise ActionError("the reply must be one JSON object")
    tool = data.get("tool")
    if tool not in allowed_tools:
        raise ActionError(f'"tool" must be one of {", ".join(allowed_tools)} (got {json.dumps(tool)})')
    args = data.get("args")
    args = {} if args is None else args
    notes = data.get("notes")
    notes = [] if notes is None else notes
    if not isinstance(args, dict):
        raise ActionError('"args" must be a JSON object')
    if not isinstance(notes, list):
        raise ActionError('"notes" must be a list')
    if tool == "search_web":
        query = args.get("query")
        if not isinstance(query, str) or not 2 <= len(query.strip()) <= 400:
            raise ActionError('search_web needs {"query": "..."} with 2 to 400 characters')
    elif tool == "fetch_article":
        if not isinstance(args.get("url"), str) or not args["url"].strip():
            raise ActionError('fetch_article needs {"url": "..."}')
    elif tool == "finish":
        top = args.get("top")
        if not isinstance(top, list):
            raise ActionError('finish needs {"top": ["n1", "D2", ...]}')
    return Action(tool=tool, args=args, notes=notes[:8])


def _words(text: str) -> set:
    return {w for w in re.findall(r"[a-z0-9]+", text.lower()) if w not in STOPWORDS and len(w) > 1}


def similar_titles(a: str, b: str) -> float:
    """Word overlap between two titles (0 to 1), ignoring common words."""
    wa, wb = _words(a), _words(b)
    if len(wa) < 3 or len(wb) < 3:
        return 0.0
    return len(wa & wb) / len(wa | wb)


class CampaignAgent:
    SIMILAR = 0.6  # titles this similar are treated as the same development

    def __init__(self, *, config, model, trace, campaign: dict, target, memory: dict, seen: dict, run_cache: dict,
                 robots, today: str, clock=time.monotonic):
        self.config = config
        self.model = model
        self.trace = trace
        self.campaign = campaign
        self.target = target
        self.seen = seen  # url key -> {"run_number", "fetched_at"} from earlier runs
        self.run_cache = run_cache  # url key -> fetch result, shared by all campaigns in this run
        self.robots = robots
        self.today = today
        self.budget = Budget(config.limits, clock)
        self.fatal: TerminalError | None = None

        # Developments from earlier runs, labeled D1, D2... (the last top list first).
        last_top = {t["development_id"]: t["rank"] for t in memory.get("last_top", [])}
        devs = sorted(memory.get("developments", []),
                      key=lambda d: (last_top.get(d["id"], 99), -(d.get("first_run") or 0)))[:15]
        self.known = {}
        for i, d in enumerate(devs, start=1):
            label = f"D{i}"
            self.known[label] = {**d, "label": label, "last_rank": last_top.get(d["id"])}
        self.last_top = [lbl for lbl, d in sorted(self.known.items(), key=lambda kv: kv[1]["last_rank"] or 99)
                         if d["last_rank"]]

        self.notes: dict[str, Note] = {}
        self.fetched: dict[str, dict] = {}  # url key -> article fetched (or reused) in this campaign
        self.search_urls: dict[str, dict] = {}  # url key -> search result offered to the model
        self.articles: list[dict] = []  # the article log saved with the run
        self.article_messages: list[tuple[int, str]] = []
        self.compacted: set[int] = set()  # indexes of article messages already shortened
        self.skipped_logged: set[str] = set()
        self._pending_article: str | None = None
        self.credits = 0
        self.finish_attempts = 0
        self.final_keys: list = []
        self.forced_reason: str | None = None  # set once the model has been told to finish now
        self._new_refs = 0
        self.messages = [
            {"role": "system", "content": prompts.system_prompt(config)},
            {"role": "user", "content": prompts.task_prompt(campaign=campaign, target=target, k=config.k, today=today,
                                                            known=list(self.known.values()), limits=config.limits)},
        ]

    # ------------------------------------------------------------------ the loop

    def run(self) -> CampaignResult:
        self.trace.campaign = self.campaign["title"][:48]
        self.trace.step = 0
        self.trace.event("campaign_start", title=self.campaign["title"], topic=self.target.topic,
                         known_developments=len(self.known), last_top=len(self.last_top))
        while True:
            reason = self.budget.stop_reason()
            if reason:
                self.trace.event("budget", status="stop", reason=reason)
                return self._partial(reason)

            self.budget.steps += 1
            self.trace.step = self.budget.steps
            started = time.monotonic()
            try:
                reply = self.model.complete(self.messages)
            except TerminalError as err:
                self.trace.event("model", tool="model", args=self._model_args(), status="error", error=err.message,
                                 latency_ms=int((time.monotonic() - started) * 1000))
                self.fatal = err
                return self._partial(f"stopped: {err}")
            self.budget.tokens += reply.tokens_in + reply.tokens_out
            try:
                action = parse_action(reply.text, self.config.tools)
                error = None
            except ActionError as err:
                action, error = None, str(err)
            self.trace.event("model", tool="model", args=self._model_args(), status="ok" if action else "invalid",
                             latency_ms=int((time.monotonic() - started) * 1000), tokens_in=reply.tokens_in,
                             tokens_out=reply.tokens_out, estimated=reply.estimated or None,
                             decision=self._describe(action), error=error)
            self.messages.append({"role": "assistant", "content": (reply.text or "(empty reply)")[:6000]})
            self._compact_replies()

            if action is None:
                self._observe(prompts.invalid_reply(error))
                continue

            notes_before = len(self.notes)
            feedback = self._take_notes(action.notes)
            new_ids = list(self.notes)[notes_before:]
            if action.tool == "finish" and new_ids and self.budget.steps < self.config.limits.max_steps:
                # Ids are given out by the code, so notes in this same reply had none yet when
                # the model ranked. Let it rank once more with them.
                self._observe(feedback + "finish was not accepted yet: you added notes in the same reply, so they had "
                              f"no ids when you ranked. Call finish again and include any of {', '.join(new_ids)} "
                              "that belong in the top list.")
                continue
            if action.tool == "finish":
                problem = self._finish(action.args, extra=new_ids)
                if problem is None:
                    return self._complete()
                self.finish_attempts += 1
                if self.finish_attempts >= 3:
                    return self._partial("the model could not produce a valid ranking after 3 tries")
                self._observe(feedback + problem)
                continue

            if self.budget.steps >= self.config.limits.max_steps:
                # This was the last allowed reply, so running the tool would be wasted.
                continue
            try:
                if action.tool == "search_web":
                    observation = self._search(action.args["query"])
                else:
                    observation = self._fetch(action.args["url"])
            except TerminalError as err:  # e.g. the search key is bad or its credits are used up
                self.fatal = err
                return self._partial(f"stopped: {err}")
            article_key, self._pending_article = self._pending_article, None
            self._observe(feedback + observation, article_key=article_key)

    def _observe(self, text: str, *, article_key: str | None = None) -> None:
        reason = self.budget.last_call_reason()
        if reason:
            self.forced_reason = reason
            text += "\n\n" + prompts.FINISH_NOW
        else:
            text += "\n" + prompts.budget_line(self.budget)
        self.messages.append({"role": "user", "content": text})
        if article_key:
            self.article_messages.append((len(self.messages) - 1, article_key))
            # Keep only the two most recent articles in full; older ones become a one-line summary.
            for index, key in self.article_messages[:-2]:
                if index not in self.compacted:
                    ids = [n.id for n in self.notes.values() if n.key == key]
                    self.messages[index] = {"role": "user", "content": prompts.compacted_article(self.fetched[key], ids)}
                    self.compacted.add(index)

    def _compact_replies(self) -> None:
        """Keep the model's last two replies whole; older ones lose their notes, which are
        already recorded under ids (n1, n2...). This keeps every request small."""
        replies = [i for i, m in enumerate(self.messages) if m["role"] == "assistant"]
        for index in replies[:-2]:
            if index in self.compacted:
                continue
            try:
                action = json.loads(self.messages[index]["content"])
            except ValueError:
                action = None
            if isinstance(action, dict):
                short = {"tool": action.get("tool"), "args": action.get("args")}
                if action.get("notes"):
                    short["notes"] = f"({len(action['notes'])} notes, see the ids in the runtime's answer)"
                self.messages[index] = {"role": "assistant", "content": json.dumps(short)[:1500]}
            else:
                self.messages[index] = {"role": "assistant", "content": self.messages[index]["content"][:300]}
            self.compacted.add(index)

    def _model_args(self) -> dict:
        return {"model": self.model.settings.name, "messages": len(self.messages),
                "prompt_chars": sum(len(m["content"]) for m in self.messages)}

    @staticmethod
    def _describe(action):
        if action is None:
            return None
        d = {"tool": action.tool, "args": action.args}
        if action.notes:
            d["notes"] = len(action.notes)
        return d

    # ------------------------------------------------------------------ tools

    def _search(self, query: str) -> str:
        if self.budget.searches >= self.config.limits.max_searches:
            return "No searches left in the budget. Read articles from the results you have, or finish."
        self.budget.searches += 1
        data = search_web(query, config=self.config, trace=self.trace)
        self.credits += data["credits"]
        labels = {}
        for r in data["results"]:
            key = url_key(r["url"])
            self.search_urls[key] = r
            if key in self.seen:
                labels[r["url"]] = f"already read in run {self.seen[key]['run_number']}"
                self._skip_seen(r["url"], key, r["title"])
            elif key in self.fetched:
                labels[r["url"]] = "already read in this run"
            elif key in self.run_cache:
                labels[r["url"]] = "downloaded earlier in this run; fetching it reuses that copy"
        return prompts.search_observation(query, data["results"], labels)

    def _skip_seen(self, url: str, key: str, title: str) -> None:
        """Record once per campaign that an article from an earlier run was not downloaded again."""
        if key in self.skipped_logged:
            return
        self.skipped_logged.add(key)
        run = self.seen[key]["run_number"]
        self._log_article(url, "skipped", title=title, reason=f"already fetched in run {run}")
        self.trace.event("skip", url=url, reason=f"already fetched in run {run}")

    def _log_article(self, url: str, status: str, *, title: str = "", reason=None, result=None) -> None:
        result = result or {}
        why = reason or result.get("reason")
        self.articles.append({
            "campaign_id": self.campaign["id"],
            "url": url[:2048],
            "title": (result.get("title") or title or "")[:300],
            "status": status,
            "reason": str(why)[:300] if why else None,
            "http_status": result.get("http_status"),
            "bytes": result.get("bytes"),
            "fetched_at": _now_iso(),
            "flagged": bool(result.get("flagged")),
        })

    def _fetch(self, url: str) -> str:
        url = url.strip()
        key = url_key(url)
        offered = self.search_urls.get(key)
        if offered is None:
            # Only URLs from search results: a page can't make the agent visit an address it mentions.
            self._log_article(url, "rejected", reason="not one of the search results")
            self.trace.event("tool", tool="fetch_article", args={"url": url}, status="rejected",
                             reason="not one of the search results")
            return "fetch_article refused: you can only fetch URLs from your search results. Pick one of those."
        if key in self.seen:
            run = self.seen[key]["run_number"]
            supports = [lbl for lbl, d in self.known.items() if any(url_key(s["url"]) == key for s in d.get("sources", []))]
            self._skip_seen(url, key, offered["title"])
            self.trace.event("tool", tool="fetch_article", args={"url": url}, status="skipped",
                             reason=f"already fetched in run {run}")
            also = f" It supports {', '.join(supports)}." if supports else ""
            return f"fetch_article skipped: this article was already read in run {run}.{also} Pick a different result."
        if key in self.run_cache:
            # Downloaded earlier in this run (for another campaign): reuse it, no new request.
            result = self.run_cache[key]
            self.fetched[key] = result
            self._log_article(url, "skipped", reason="already fetched earlier in this run", result=result)
            self.trace.event("tool", tool="fetch_article", args={"url": url}, status="skipped",
                             reason="already fetched earlier in this run")
            observation = prompts.article_observation(result, self.config.fetch.max_chars_to_model, reused=True)
            self._pending_article = key
            return observation
        if self.budget.fetches >= self.config.limits.max_fetches:
            return "No article fetches left in the budget. Finish with what you have."
        self.budget.fetches += 1
        result = fetch_article(url, config=self.config, trace=self.trace, robots=self.robots)
        self._log_article(url, result["status"], title=offered["title"], result=result)
        if result["status"] != "fetched":
            verb = "refused" if result["status"] == "rejected" else "failed"
            return f"fetch_article {verb}: {result.get('reason')}. Pick a different result."
        self.fetched[key] = result
        self.run_cache[key] = result
        self._pending_article = key
        return prompts.article_observation(result, self.config.fetch.max_chars_to_model)

    # ------------------------------------------------------------------ notes

    def _take_notes(self, raw_notes: list) -> str:
        if not raw_notes:
            return ""
        accepted, rejected = [], []
        for raw in raw_notes:
            if not isinstance(raw, dict):
                rejected.append(("(not an object)", "each note must be a JSON object"))
                continue
            title = str(raw.get("title") or "").strip()
            summary = str(raw.get("summary") or "").strip()
            quote = str(raw.get("quote") or "").strip()
            url = str(raw.get("url") or "").strip()
            label = title[:60] or "(untitled)"
            article = self.fetched.get(url_key(url))
            if article is None:
                rejected.append((label, "its url is not an article you read in this run"))
                continue
            if article.get("flagged"):
                rejected.append((label, "that page contained instructions aimed at AI agents, so it can't be a source"))
                continue
            if not 3 <= len(title) <= 160:
                rejected.append((label, "the title must be 3 to 160 characters"))
                continue
            if not 20 <= len(summary) <= 500:
                rejected.append((label, "the summary must be 20 to 500 characters"))
                continue
            source_text = article["title"] + "\n" + article["text"]
            problem = quote_problem(quote, source_text)
            if problem:
                rejected.append((label, problem))
                continue
            invented = unsupported_numbers(title + " " + summary, source_text)
            if invented:
                rejected.append((label, f"{', '.join(invented)} does not appear in the article"))
                continue
            if any(n.key == url_key(url) and n.title.lower() == title.lower() for n in self.notes.values()):
                continue  # the same note twice
            if len(self.notes) >= 4 * self.config.k:
                rejected.append((label, "too many notes; finish with the ones you have"))
                continue
            same_as = raw.get("same_as")
            same_as = str(same_as).strip() if same_as else None
            if same_as:
                same_as = same_as.upper() if same_as[:1] in "dD" else same_as.lower()
                if same_as not in self.known and same_as not in self.notes:
                    same_as = None
            note = Note(id=f"n{len(self.notes) + 1}", url=article["url"], key=url_key(url),
                        article_title=article["title"], title=title, summary=summary, quote=quote, same_as=same_as)
            self.notes[note.id] = note
            accepted.append(note)
        for note in accepted:
            self.trace.event("note", id=note.id, status="accepted", url=note.url, same_as=note.same_as)
        for label, reason in rejected:
            self.trace.event("note", status="rejected", title=label, reason=reason)
        parts = []
        if accepted:
            parts.append("Notes accepted: " + "; ".join(f'{n.id} "{prompts.web_text(n.title)}"' for n in accepted) + ".")
        if rejected:
            parts.append("Notes rejected: " + "; ".join(f'"{prompts.web_text(lbl)}" ({why})' for lbl, why in rejected)
                         + ". Rejected notes are not saved.")
        return "\n".join(parts) + "\n\n"

    def _root(self, note_id: str, depth: int = 0) -> str:
        """Follow same_as links to the development (D...) or first note (n...) they point at."""
        note = self.notes.get(note_id)
        if note is None or not note.same_as or depth > 20:
            return note_id
        if note.same_as in self.known:
            return note.same_as
        return self._root(note.same_as, depth + 1)

    # ------------------------------------------------------------------ finish

    def _finish(self, args: dict, extra=()) -> str | None:
        """Accept the model's ranking, or say what is wrong with it.

        extra: notes added in the same reply on the very last step; they go after the ranking.
        """
        chosen, errors = [], []
        for raw in args.get("top") or []:
            ident = raw.get("id") if isinstance(raw, dict) else raw
            ident = str(ident or "").strip()
            ident = ident.upper() if ident[:1] in "dD" else ident.lower()
            if ident in self.known:
                key = ident
            elif ident in self.notes:
                key = self._root(ident)
            else:
                errors.append(f"{ident or '(blank)'} is not an accepted note or a known development")
                continue
            if key not in chosen:
                chosen.append(key)
        for note_id in extra:
            key = self._root(note_id)
            if key not in chosen:
                chosen.append(key)
        if errors and self.finish_attempts < 2 and not extra:
            valid = ", ".join(list(self.notes) + list(self.known)) or "none yet"
            return "finish was not accepted: " + "; ".join(errors) + f". Valid ids: {valid}. Call finish again."
        if not chosen and self.notes and self.finish_attempts < 1:
            return ("finish listed no developments, but you have accepted notes "
                    f"({', '.join(self.notes)}). List the ids that matter most, or call finish with [] again.")
        self.final_keys = self._merge_similar(chosen)[: self.config.k]
        self.trace.event("tool", tool="finish", args={"top": args.get("top")}, status="accepted",
                         final=self.final_keys)
        return None

    def _merge_similar(self, keys: list) -> list:
        """A safety net for duplicates the model didn't link with same_as: near-identical titles merge."""
        merged = []
        for key in keys:
            if key in self.known:
                if key not in merged:
                    merged.append(key)
                continue
            title = self.notes[key].title
            match = next((lbl for lbl, d in self.known.items() if similar_titles(title, d["title"]) >= self.SIMILAR), None)
            if match is None:
                match = next((k for k in merged if k in self.notes and similar_titles(title, self.notes[k].title) >= self.SIMILAR), None)
            if match is not None:
                self.notes[key].same_as = match
                self.trace.event("merge", note=key, into=match, reason="near-identical title")
                if match not in merged:
                    merged.append(match)
            else:
                merged.append(key)
        return merged

    # ------------------------------------------------------------------ results

    def _group_notes(self, key: str) -> list:
        return [n for n in self.notes.values() if self._root(n.id) == key or n.id == key]

    def _source(self, note: Note) -> dict:
        return {"url": note.url, "title": note.article_title[:300], "quote": note.quote}

    def _items(self, keys: list) -> list:
        items = []
        for key in keys:
            notes = self._group_notes(key)
            if key in self.known:
                dev = self.known[key]
                known_urls = {url_key(s["url"]) for s in dev.get("sources", [])}
                extra, extra_urls = [], set()
                for n in notes:
                    if n.key not in known_urls and n.key not in extra_urls:
                        extra.append(self._source(n))
                        extra_urls.add(n.key)
                items.append(Item(ref=dev["id"], title=dev["title"], summary=dev["summary"], sources=extra,
                                  all_sources=list(dev.get("sources", [])) + extra,
                                  change="still" if dev.get("last_rank") else "back",
                                  previous_rank=dev.get("last_rank"), first_run=dev.get("first_run")))
            else:
                self._new_refs += 1
                first = self.notes[key]
                sources, urls = [], set()
                for n in [first] + [n for n in notes if n.id != key]:
                    if n.key not in urls:
                        sources.append(self._source(n))
                        urls.add(n.key)
                items.append(Item(ref=f"new:{self._new_refs}", title=first.title, summary=first.summary,
                                  sources=sources, all_sources=sources, change="new"))
        return items

    def _result(self, status: str, reason: str | None, items: list, dropped: list) -> CampaignResult:
        self.trace.event("campaign_end", status=status, reason=reason, top=len(items), dropped=len(dropped),
                         steps=self.budget.steps, tokens=self.budget.tokens)
        return CampaignResult(campaign=self.campaign, topic=self.target.topic, status=status, stop_reason=reason,
                              top=items, dropped=dropped, articles=self.articles, steps=self.budget.steps,
                              tokens=self.budget.tokens, searches=self.budget.searches, fetches=self.budget.fetches,
                              credits=self.credits)

    def _complete(self) -> CampaignResult:
        items = self._items(self.final_keys)
        chosen = set(self.final_keys)
        if self.forced_reason:
            # The budget cut the research short: keep the model's ranking, but carry over last
            # run's top list instead of dropping what there was no time to check again.
            carried = [lbl for lbl in self.last_top if lbl not in chosen]
            return self._result("partial", f"{self.forced_reason}; ranked with the evidence gathered so far",
                                items + self._items(carried), [])
        dropped = [self.known[lbl] for lbl in self.last_top if lbl not in chosen]
        return self._result("complete", None, items, dropped)

    def _partial(self, reason: str) -> CampaignResult:
        """Stop early and report the evidence gathered so far, without a new ranking.

        Last run's top list is kept as it was (nothing is dropped without a ranking), and
        every verified note that isn't about one of those developments is added after it.
        """
        if self.budget.steps <= 1 and self.fatal is not None and not self.notes:
            return self._result("failed", reason, [], [])
        keys = list(self.last_top)
        for note_id in self.notes:
            root = self._root(note_id)
            if root not in keys:
                keys.append(root)
        new_keys = [k for k in keys if k not in self.known][: self.config.k]
        keys = [k for k in keys if k in self.known] + new_keys
        return self._result("partial", reason, self._items(keys), [])


def _now_iso() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat(timespec="seconds")
