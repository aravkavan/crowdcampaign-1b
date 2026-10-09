# AGENT.md: the CrowdCampaign market-intel tracker

The tracker researches each campaign listed in `config.yaml` (three CrowdCampaign demo briefs), keeps the top K = 5 recent developments for each with sources and on every later run reports what is new since the last one. The loop is hand written in `tracker/agent.py`. Its memory lives in the app's PostgreSQL database and is reached only through the app's API (`/api/tracker/*`). Results appear on the app's Market intel page and on each campaign's page.

## 1. Workflow vs. agent

**The model decides** what to search for, which search results to read, what each article says (it writes a note: title, summary, and one quoted sentence), whether a note describes the same event as an earlier one (`same_as`), and the final ranking of up to K developments.

**The code decides** everything that must hold no matter what the model does:

- the budgets (steps, searches, fetches, tokens, seconds) and stopping when one runs out;
- which URLs can be fetched: only ones that appeared in search results, and only through the guardrail;
- skipping articles already read in earlier runs (they are never downloaded again);
- whether each note is backed by its source;
- New / Still / Dropped, the report, and the partial report when a budget runs out.

**One decision moved out of the model: checking that a claim is really in its source.** The simple version would be to tell the model "only report facts from the articles, and cite them" and trust it. But a model can paraphrase a quote, merge two articles, or fill in a number it never read, and it can't reliably check its own work. Provenance is graded by checking claims against their sources, so this check can't depend on the model behaving.

So the model's job ends at proposing a note with a quoted sentence. The code (`tracker/verify.py`, called from `_take_notes` in `agent.py`) then checks:
- the quote appears word for word in the text that was actually downloaded, ignoring only case, spacing and curly quotes;
- every number in the title and summary appears in the article.

A note that fails either check is rejected with the reason, and the model can fix it on its next step. A page that tries to give the AI instructions is flagged, and notes citing it are refused. Only accepted notes can be ranked, so nothing unverified reaches a report. The check costs no tokens and never changes its answer.

A second example: "what changed since last run" is not asked of the model. The code compares this run's top K with the previous run's stored top K. The same function (`backend/src/services/trackerHistory.js`) produces both the tracker's memory and the web page, so they can't disagree.

## 2. The network

Run 1 made **54 round trips** (from `python -m tracker stats traces/run1.jsonl`). Each HTTP request, including every retry, redirect hop and robots.txt check, is one line in `traces/run1.jsonl` with `"kind": "http"`.

| Service | Round trips | Time | What they were |
| --- | --- | --- | --- |
| Model API (generativelanguage.googleapis.com) | 24 | 46.0 s | one per agent step, plus retries |
| Search API (api.tavily.com) | 8 | 35.2 s | one per `search_web` call |
| Article sites | 10 | 13.4 s | one per download, plus one per redirect hop |
| robots.txt checks | 8 | 5.1 s | once per site, the first time it is fetched |
| CrowdCampaign API (localhost:4000) | 4 | 9.5 s | login, campaign list, load state, save run |
| Waiting before retries | 0 waits | 0 s | rate limits and timeouts |

Wall-clock time: 110.7 s. Run 2 also made 54 round trips, in 125.0 s.

**Where the time went:** the model calls took 46.0 of the 110.7 seconds (about 2 s each), because every step waits for the model's full reply. Search was the surprise: 8 Tavily searches took 35.2 s, about 4.4 s each, slower per call than the model. Articles and their robots.txt checks took 18.5 s for 18 requests. The app API took 9.5 s for only 4 calls, while the same 4 calls took 1.7 s in run 2, so most of run 1's 9.5 s was probably the Neon database waking up. In run 2 the biggest single cost was waiting: 62.8 s of the 125.0 s went to two rate-limit waits (see question 4).

The calls are sequential by design: each step's result decides the next step, so the loop can't run steps in parallel. The cost of that is latency, mostly model latency.

## 3. "New"

Three layers decide whether two articles describe the same development:

1. **Same article.** URLs are reduced to a key: host without `www.`, path without a trailing slash, query parameters sorted, tracking tags (`utm_*`, `fbclid`...) and fragments dropped. An article whose key was fetched in an earlier run is never downloaded again; it is logged as *already seen*.
2. **Same event, different article.** The model sees the developments reported in earlier runs (D1, D2...) and links a new note to one of them with `same_as`. The code checks the id exists. The new article then becomes an extra source of the known development, which stays under "Still in top K".
3. **A safety net in code.** If the model didn't link them, two titles whose meaningful words overlap by 60% or more (Jaccard similarity, common words ignored) are merged anyway (`similar_titles` in `agent.py`). This also catches the same wire story syndicated to several sites.

**A case it gets wrong:** a brand that does the same kind of thing twice. Say "Fizzwell launches zero-sugar lemonade at college campuses" in September, and a second wave in October reported as "Fizzwell launches its zero-sugar lemonade at more college campuses". These are two separate developments, but their titles share almost every meaningful word, so the code merges the October article into the September development as just another source, and the second wave never shows up as new.

The opposite mistake happens too. The same event described with completely different words (for example "Coke enters the prebiotic soda race" and "Simply Pop launches nationwide") has no title overlap, so it depends entirely on the model setting `same_as`. If the model misses it, the event is reported twice.

## 4. Failure

A 429 goes through `classify_http_error` in `tracker/failures.py`:

```python
DAILY_LIMIT = re.compile(r"per\s*day|perday|per_day|daily|\brpd\b|\btpd\b", re.IGNORECASE)


def classify_http_error(service: str, status: int, headers, body: str) -> TrackerError:
    """Decide whether an HTTP error from a service is transient or terminal."""
    detail = _short(body)
    if status == 429:
        if DAILY_LIMIT.search(body):
            # A daily cap won't reset for hours, so this is terminal: never retry it.
            return TerminalError(service, f"daily quota used up ({detail}). It resets tomorrow; "
                                          "retrying today would only waste requests.")
        # A per-minute limit clears soon: retry after the delay the service asks for.
        return TransientError(service, f"rate limited ({detail})", wait=retry_after(headers, body))
```

and the retry loop in `with_retries`, which every call to the model, search and app API goes through:

```python
    attempt = 0
    while True:
        attempt += 1
        try:
            return attempt_fn(attempt)
        except TransientError as err:
            if attempt > policy.max_retries:
                raise RetriesExhausted(service, f"{err.message}; still failing after {policy.max_retries} retries") from err
            wait = err.wait if err.wait is not None else policy.base_delay * 2 ** (attempt - 1)
            wait += random.uniform(0, 0.25 * wait)
            if wait > policy.max_wait:
                raise TerminalError(service, f"{err.message}; the service asks us to wait {wait:.0f} s, "
                                             f"longer than max_wait_seconds ({policy.max_wait:.0f} s). Try again later.") from err
            if trace:
                trace.event("retry", service=service, attempt=attempt, wait_s=round(wait, 1), reason=err.message)
            sleep(wait)
```

A `TerminalError` is not caught here, so it is never retried.

- **Per-minute limit** (Gemini's quota id `GenerateRequestsPerMinute...`, Groq's "tokens per minute (TPM)"): transient. The code waits for the `Retry-After` header, or the delay written in the body ("Please retry in 39.5s"). With neither, it waits 2, 4, then 8 seconds, plus up to 25% random jitter. It gives up after 3 retries. If the service asks for a wait longer than `max_wait_seconds` (65 s), the code stops instead of sleeping through it.
- **Daily cap** (Gemini's `GenerateRequestsPerDay...`, Groq's "requests per day (RPD)" or "tokens per day (TPD)"): terminal. There is no retry and no wait. The run stops at once with "daily quota used up ... It resets tomorrow". Retrying would only use up more requests and could never succeed today.

A terminal error ends the run, but it doesn't throw the work away. The campaign in progress keeps its verified notes and is marked partial. Campaigns not started yet are marked failed with the reason. The run is still saved, unless nothing at all was researched.

Tested with fake model and search servers: a per-minute 429 waited and then succeeded. A daily 429, a bad model key and a bad search key each made exactly one request. A network cut gave 3 retries, then a partial report.

It also happened in my real run 2: 2 model requests were refused with a temporary error, and the tracker waited 62.8 s in total before retrying (about 31 s each, the delay the API asked for; its own backoff would have been 2 s and 4 s). Both retries succeeded: run 2 shows 24 model round trips for 22 model calls, and the run finished.

## 5. Budget

**One run, from the usage line at the end of the run and from `python -m tracker stats`:**

- run 1 made 24 model calls using 89,500 tokens (86,817 in, 2,683 out), plus 8 searches (8 Tavily credits) and 8 article downloads (1 more failed);
- run 2 made 22 model calls using 90,093 tokens (87,644 in, 2,449 out), plus 8 searches (8 Tavily credits) and 8 article downloads.

On free tiers that costs **$0**. At paid prices (gemini-3.5-flash-lite: $0.30 per million input tokens, $2.50 per million output tokens) it would be about **$0.03 a run**: run 1 = 86,817 × $0.30/M + 2,683 × $2.50/M ≈ $0.026 + $0.007 = $0.033, and run 2 ≈ $0.032. Running daily for a month would cost about $1. Input tokens are 97% of the tokens and about 80% of the cost, because every step resends the instructions and what the agent has read so far.

The limits in `config.yaml` also cap the worst case: 3 campaigns × (10 model calls, 3 searches, 60,000 tokens) is at most **30 model calls, 9 Tavily credits and 180,000 tokens per run**.

**Running daily: which free tier runs out first?**

| Free tier | Allowance | Used per run | Lasts |
| --- | --- | --- | --- |
| Tavily search | 1,000 credits per month | 8 (at most 9) | 1,000 ÷ 8 = 125 runs, so a daily run uses 240 credits in a 30-day month |
| Gemini requests per day (gemini-3.5-flash-lite, from my AI Studio rate-limit page) | 500 per day | 24 (including retries) | resets daily at midnight Pacific; about 20 runs fit in a day |
| Gemini tokens per day | no daily token limit (only per minute) | about 90,000 | none |
| Groq instead (openai/gpt-oss-120b) | 1,000 requests and 200,000 tokens per day | about 24 requests and 90,000 tokens | resets daily |

**Conclusion:** with one run a day, nothing runs out. A run uses 24 of Gemini's 500 daily requests (about 5%), and that allowance resets every night. Tavily is the only allowance that adds up over the month, and 30 runs × 8 credits = 240 of its 1,000 credits. If I ran the tracker every hour instead, Gemini's daily limit would run out first, on day 1: 24 runs × 24 requests = 576 requests a day, more than 500, so the 21st run of the day (500 ÷ 24 ≈ 20.8) would stop with a terminal "daily quota used up" error. Gemini recovers every night at midnight Pacific, but Tavily doesn't: at about 20 runs × 8 credits = 160 credits a day, its 1,000 monthly credits would run out on day 7 (1,000 ÷ 160 ≈ 6.25), and searches would fail until the next month. With Groq instead of Gemini, the tightest limit is 200,000 tokens per day: two runs of about 90,000 tokens fit, and a third run the same day would stop with a terminal "daily quota used up" error.