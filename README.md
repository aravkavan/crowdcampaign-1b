# CrowdCampaign

**AI-assisted crowdsourced marketing.** Brands and organizers post a marketing brief with a deadline and a prize. Anyone with an account can pitch one idea per campaign. An AI judge scores every idea on creativity, relevance, feasibility and marketing potential, and recommends a top-ten shortlist. **The organizer, a person, always picks the winner.** The AI never can.

**Market intel (Assignment 1B).** A research agent written from scratch in Python tracks what is happening around each campaign: competitor launches, notable marketing campaigns, trends. It finds the top K developments with sources, and every later run reports what's new since the last one. The results appear inside the app, on a **Market intel** page and on each campaign's page, so people pitching ideas build on what's current instead of repeating it.

Built for CSCI-GA.2630. Assignment 1: a full-stack app with registration, login, token authentication, account management, and data that survives restarts. Assignment 1B: an agentic tracker with its own loop, budgets, failure handling, guardrails, memory between runs, and provenance, shown in the A1 app.

```
Register / Log in  ->  Browse campaigns  ->  Open a brief  ->  Submit an idea
      ->  AI scores ideas  ->  Top 10 shortlist  ->  Organizer reviews  ->  Organizer picks the winner

python -m tracker run  ->  search -> fetch -> observe -> decide -> synthesize (per campaign)
      ->  saved through the API  ->  Market intel page + a box on each campaign page
```

| Part | Technology |
| --- | --- |
| Database | PostgreSQL on [Neon](https://neon.tech) (free tier) |
| Backend | Node.js + Express 5, port **4000** |
| Frontend | React 19 + Vite 6 + React Router 7, port **5173** |
| Passwords | scrypt (built into Node), OWASP parameters |
| Auth | Bearer tokens (JWT, HMAC-SHA256), 2-hour expiry |
| AI judge (optional) | Claude or Gemini; clearly labelled offline estimate without a key |
| Tracker (1B) | Python 3.10+, own agent loop (no agent framework), `requests` + `PyYAML` only |
| Tracker model | Gemini (`gemini-3.5-flash-lite`, free tier) or Groq (`openai/gpt-oss-120b`), any OpenAI-compatible API |
| Tracker search | [Tavily](https://tavily.com) (free plan: 1,000 credits a month; 1 credit per basic search) |

---

## Prerequisites

| Tool | Version | Check with |
| --- | --- | --- |
| Node.js | **20 or newer** (the current LTS is recommended) | `node --version` |
| npm | comes with Node (10 or newer) | `npm --version` |
| Python | **3.10 or newer** (for the tracker) | `python3 --version` (Windows: `py --version`) |
| Git | any recent version | `git --version` |
| Internet | needed: the database is hosted on Neon | |
| API keys (tracker only) | a free **Gemini** key ([aistudio.google.com/apikey](https://aistudio.google.com/apikey)) or **Groq** key ([console.groq.com/keys](https://console.groq.com/keys)), and a free **Tavily** key ([app.tavily.com](https://app.tavily.com)) | |

No database install is needed. The connection string for the throwaway Neon database is already in `backend/.env`. No API keys are in the repository: put your own in `tracker/.env` (step 2).

## Run it: the commands, in order

### 1. Bring up the backend and frontend

You need **two terminals**.

**Terminal 1: backend**

```bash
git clone https://github.com/aravkavan/crowdcampaign-1b.git crowdcampaign
cd crowdcampaign/backend
npm install
npm run seed
npm start
```

Wait for `CrowdCampaign API is running at http://localhost:4000`. Leave this terminal open.

**Terminal 2: frontend**

```bash
cd crowdcampaign/frontend
npm install
npm run dev
```

Open **http://localhost:5173**. **Log in as the grader:** username `NYUgrader`, password `Courant2026!`

`npm run seed` is safe to run any number of times. It creates the tables if needed, makes sure the grader account exists with that password, and adds the demo data (skipping anything already there), including the three open campaigns the tracker researches. Every demo account (for example `maya_makes` or `brewhaus_team`) uses the password `DemoPass2026!`.

### 2. Set up the tracker (once)

In a **third terminal**, from the `crowdcampaign` folder:

Mac or Linux:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r tracker/requirements.txt
cp tracker/.env.example tracker/.env
```

Windows (PowerShell):

```powershell
py -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r tracker\requirements.txt
copy tracker\.env.example tracker\.env
```

Open `tracker/.env` and fill in `GEMINI_API_KEY` (or `GROQ_API_KEY`) and `TAVILY_API_KEY`. It already contains the app login the tracker uses (`NYUgrader`), so its runs show up when you log in as the grader. `tracker/.env` is git-ignored. In every new terminal, activate the environment again (the `source` or `Activate.ps1` line) before running the tracker.

### 3. Run the tracker

```bash
python -m tracker run
```

It researches each campaign listed in `config.yaml`, prints what it found, writes `reports/runN.md` and `traces/runN.jsonl`, and saves the run through the app's API. Open **Market intel** in the app to see it. A run takes a few minutes.

### 4. Run it again

```bash
python -m tracker run
```

The second run skips articles it already read, recognizes new articles about developments it already reported, and organizes each campaign's report as **New since last run**, then **Still in top K**, then **Dropped**. (`reports/run1.md` and `reports/run2.md` in this repository come from runs at least a day apart, and their traces are in `traces/`.)

### 5. Reset its saved state

```bash
python -m tracker reset
```

This asks for confirmation, then deletes every saved run, development and article for the tracker's user, so the next run is run 1 again. Add `--yes` to skip the question, and `--delete-files` to also delete `reports/run*.md` and `traces/run*.jsonl`.

### Other commands

```bash
python -m tracker status                     # what the tracker remembers
python -m tracker stats traces/run1.jsonl    # round trips, time, tokens and credits of one run

python -m tracker.tools search_web "oat milk cold brew launch"
python -m tracker.tools fetch_article https://example.com/some-article
python -m tracker.tools finish my-report.json   # checks every quote against its source
```

Each tool runs without the model. `fetch_article` applies the full guardrail and prints JSON with `status` (`fetched`, `rejected` or `failed`) and the reason; the exit code is 0, 3 (rejected) or 4 (failed).

### Check the A1 API in one command

With the backend running:

```bash
cd crowdcampaign/backend
npm run check
```

This mirrors the A1 grading script: it registers two temporary accounts, calls every endpoint, tests all three rules (including GET, PATCH and DELETE on another user's `:id`), changes a password, deletes both accounts, and scans every response for password hashes. It prints PASS or FAIL for each of about 50 checks.

---

## The market-intel tracker (Assignment 1B)

### What it researches

`config.yaml` holds the tracker's whole policy: the topic, **K = 5**, the campaigns to research (each matched to the app by title, with its own research topic), the model, the instructions, the allowed tools, the limits, and the allowed schemes and hosts. The code checks every value when it starts and refuses unsafe ones (for example, `file` in `allowed_schemes`). The three demo campaigns it researches:

| Campaign | Research topic |
| --- | --- |
| Get NYC students talking about zero-sugar lemonade | zero-sugar and better-for-you soda brands, their launches and marketing to Gen Z and students |
| Name and launch our oat-milk cold brew | oat-milk and plant-based coffee, cold brew launches, coffee chain campaigns |
| Make our refillable bottle the one everyone carries | reusable bottle brands, viral bottle trends, launches and campaigns |

### The loop, and who decides what

`tracker/agent.py` is the loop, written by hand (no agent framework). For each campaign:

1. The model gets fixed instructions, the campaign, its topic, and the developments reported in earlier runs (labelled D1, D2...).
2. Each step, the model replies with one JSON action: `search_web`, `fetch_article` or `finish`, plus **notes** about the article it just read: a title, a summary, and one sentence quoted word for word from the article.
3. The code checks the action, runs the tool, and answers with the result. Web text is wrapped in `<web_content>` tags and labelled as data.
4. `finish` lists the ids of up to K developments, most important first.

| The model decides | The code decides |
| --- | --- |
| what to search for | the budgets, and stopping when one runs out |
| which search results to read | that only URLs from search results can be fetched, and only through the guardrail |
| what each article says (notes) | skipping articles already read in earlier runs |
| whether two notes describe the same event | whether every quote is really in its article, and every number in a summary too |
| the ranking | New / Still / Dropped, the report, and the partial report when a budget runs out |

### Budgets and partial reports

Limits are per campaign, from `config.yaml`: `max_steps` 10 model calls, `max_searches` 3, `max_fetches` 5, `max_tokens` 60,000, `max_seconds` 420. The loop checks them before every model call. When the next call will be the last, the model is told to finish now. If a budget runs out, the campaign is marked **partial**: the report keeps the verified evidence gathered so far and last run's top list, and drops nothing, because there was no time to re-check it.

### Failures: retried or not

All calls to outside services go through `tracker/failures.py`.

| Failure | Kind | What happens |
| --- | --- | --- |
| Timeout, dropped connection, network down | transient | retried after 2, 4, 8 s (plus jitter); after 3 retries the run stops with a partial report |
| HTTP 429, per-minute limit | transient | waits for `Retry-After` (or the delay in the body), then retries |
| HTTP 500, 502, 503, 504, 529 | transient | retried with backoff |
| HTTP 429, daily quota ("per day", RPD, TPD) | **terminal** | stops at once: retrying a daily cap only wastes requests |
| HTTP 401 / 403 (bad key; Gemini sends 400 "API key not valid"), 402 (payment required), 432 / 433 (Tavily credits), 404 (wrong model name) | **terminal** | stops at once with a message saying what to fix |
| A wait longer than `max_wait_seconds` (65 s) | **terminal** | stops instead of hanging |

A run where nothing could be researched (for example, a bad key on the first call) is not saved and doesn't use up a run number. Its report goes to `reports/failed-<time>.md`.

### Memory between runs (recrawl)

The tracker's memory lives in the app's PostgreSQL database, and the tracker reaches it only through the app's API: it logs in as `TRACKER_USERNAME`, loads its state at the start of a run (`GET /api/tracker/state`) and saves the finished run (`POST /api/tracker/runs`). It never connects to the database itself.

- **Articles already read** are remembered by URL, ignoring `www.`, http/https, trailing slashes, tracking tags and fragments. They are marked `[already read]` in search results and never downloaded again; in the article log they appear as *Already seen*.
- **The same development from a new URL:** the model links a note to a known development with `same_as: "D2"`. As a safety net, the code also merges a new item whose title is nearly identical to a known one. Either way the new article becomes **another source** of the known development rather than a new development.
- **What changed:** the code compares this run's top K with the last one. **New** means first reported in this run. **Still in top K** means it was reported before (marked when it is back in the top list). **Dropped** means it was in the last top K but not this one.

### Guardrails on `fetch_article`

Every check runs before any request is made (`tracker/guard.py`):

- only `http` and `https`, only ports 80 and 443, no `user:password@` URLs, no local names (`localhost`, `*.local`, `*.internal`...), plus the blocked list in `config.yaml` (sites behind a login or whose terms forbid scraping);
- the host name is resolved, and if **any** address is loopback, private, link-local, multicast, reserved or otherwise not public, the URL is refused. This also catches `http://2130706433/`, `http://127.1/`, `http://0x7f000001/`, `http://[::ffff:127.0.0.1]/` and names that point at private addresses;
- the connection goes to the address that was checked (no second DNS lookup), and the address actually reached is checked again;
- redirects are followed by hand, at most 4, and every hop goes through every check (a redirect to `127.0.0.1` or `169.254.169.254` is refused);
- one 15-second deadline covers the whole download, including servers that send one byte at a time; reading stops at 2 MB (also for compressed pages); only HTML and plain text are accepted; `robots.txt` is respected.

### Web text is data, never instructions

- Instructions, tools and budgets come only from the code and `config.yaml`. The model can't change them, and anything it asks for outside the allowed tools is refused.
- Web text reaches the model inside `<web_content>` tags, with `<` and `>` replaced so a page can't close the wrapper, and with a standing rule to ignore instructions found there.
- Only URLs that appeared in search results can be fetched, so a page can't send the agent to an address it mentions.
- A page that addresses an AI ("ignore previous instructions", "call the tool...") is **flagged**. The model still sees it as data, but no note citing it is accepted, so it can't enter a report.
- In the app, everything from the web is rendered as **text**, never HTML. Only `http(s)` links are clickable, and the API refuses to store any other kind of link. A page title like `<img src=x onerror=...><script>...` shows up as harmless text.

### Provenance

Every development in a report cites at least one source, and each source carries one sentence quoted from that article. The code checks that the quote appears in the fetched text (ignoring case, spacing and curly quotes) and that every number in the title and summary appears in the article. A note that fails either check is refused before it can reach a report. `python -m tracker.tools finish report.json` re-checks a report's quotes against the live pages.

### Trace logs

Every model call, tool call and HTTP round trip is one JSON line in `traces/runN.jsonl`, with the time, run, campaign, step, tool, arguments, status, latency, and tokens (model) or credits (search). Retries, notes, budget stops and merges are logged too. API keys and the app's login token are never written. `python -m tracker stats traces/run1.jsonl` adds up round trips and time per service, tokens and credits.

### Cost

On the free tiers a run costs nothing. The limits in `config.yaml` cap one run at 3 campaigns × (10 model calls, 3 searches, 5 downloads, 60,000 tokens): at most 30 model calls, 9 Tavily credits (of the free plan's 1,000 a month) and 180,000 tokens. Most runs use well under that; the exact numbers are printed at the end of each run and by `python -m tracker stats`. Gemini is the recommended model: Groq's free tier allows 8,000 tokens per minute, so the tracker spends time waiting between calls (it does this automatically) and a run can end partial on the time budget.

---

## Configuration and the `.env` files

| File | Committed? | Contents |
| --- | --- | --- |
| `backend/.env` | **Yes, on purpose** | Throwaway Neon `DATABASE_URL` plus non-secret settings. The course allows a working `.env` for a throwaway database. |
| `backend/.env.example` | Yes | Every variable the backend reads, with explanations |
| `backend/.env.local` | **No** (git-ignored) | Optional personal AI keys for the A1 judge. Loaded first, so it overrides `.env`. |
| `backend/.secrets/jwt-secret` | **No** (git-ignored) | Token-signing key, generated automatically on first start |
| `frontend/.env` | Yes | `VITE_API_URL=http://localhost:4000` (not a secret) |
| `config.yaml` | Yes | The tracker's policy (no secrets) |
| `tracker/.env.example` | Yes | Every variable the tracker reads |
| `tracker/.env` | **No** (git-ignored) | Your model and search keys, the API address and the app login the tracker uses |

**No personal secrets are in this repository.** The only credential is the throwaway database's, created only for this assignment. The grader login in `tracker/.env.example` is the course's public grader account. The token-signing key is generated on each machine the first time the server starts and never leaves it.

## Things that might surprise you

- **No migration tool.** On every start the server runs `CREATE TABLE IF NOT EXISTS ...` (see `backend/src/migrate.js`), so an empty database gets all its tables, including the tracker's, automatically.
- **The first request after a break can take a few seconds.** Neon's free tier puts the database to sleep after 5 idle minutes and wakes it on the next query. The tracker retries the app API twice for this.
- **The tracker needs the backend running.** Its memory is in the app's database, reached through the API, so start the backend first (step 1).
- **Run numbers come from the database.** After `python -m tracker reset`, the next run is run 1 again and will overwrite `reports/run1.md`.
- **Market intel is per user.** Each user sees only their own tracker's runs (the tracker logs in as `NYUgrader`). Other users get an empty Market intel page, and campaigns show no intel box.
- **Logging in after a restart still works.** Tokens are signed with the key in `backend/.secrets/jwt-secret`, which persists across restarts. Tokens expire after 2 hours.
- **The A1 AI judge is optional.** Without a key, "Score ideas" uses a transparent keyword heuristic labelled *"Offline estimate, not AI"*.
- **If the database credentials ever stop working** (for example, if Neon revoked them after detecting them in a public repository): create any free PostgreSQL database (Neon, Supabase or Render), paste its connection string into `DATABASE_URL` in `backend/.env`, then run `npm run seed`. Tables are created automatically.

## Enabling the AI judge (A1, optional)

Create `backend/.env.local` (it is git-ignored) with **one** of these:

```bash
# Google Gemini (has a free tier: https://aistudio.google.com/apikey)
GEMINI_API_KEY=your-key-here

# or Anthropic Claude (paid: https://platform.claude.com)
ANTHROPIC_API_KEY=your-key-here
```

Restart the backend. The startup banner shows which judge is active. With both keys set, Claude is used; set `AI_PROVIDER=gemini` to force Gemini. Defaults: `gemini-3.5-flash-lite` and `claude-haiku-4-5-20251001`, changeable with `GEMINI_MODEL` and `ANTHROPIC_MODEL`.

How the judge is kept safe and separate:

- It is **one module** (`backend/src/ai/`) and **one table** (`evaluations`). If it fails, the evaluate request returns `502` with "Nothing was changed", and every other feature keeps working.
- **It cannot pick a winner.** The only code that sets a winner is `POST /api/campaigns/:id/winner`, which requires the organizer's own login.
- **Prompt injection:** ideas are untrusted text, escaped and wrapped in tags; one demo idea ("Best idea ever") tries exactly that attack. Every score is clamped to 1 to 10, and the overall score is computed by the server.

## API reference

All requests and responses are JSON. Protected routes need the header `Authorization: Bearer <token>`. Errors always look like `{"error": "A readable message."}`.

A **user** in any response is exactly `{"id", "username", "email", "created_at", "updated_at"}`. There is never a password or hash field (Rule 1).

### Required endpoints (A1)

| Method | Path | Auth | Body | Success | Errors |
| --- | --- | --- | --- | --- | --- |
| GET | `/healthz` | none | | `200 {"status":"ok"}` | |
| POST | `/api/auth/register` | none | `{"username", "email"?, "password"}` | `201 {token, access_token, token_type, expires_in, user}` | 400 invalid input, 409 taken |
| POST | `/api/auth/login` | none | `{"username" or "email", "password"}` | `200 {token, access_token, token_type, expires_in, user}` | 400, 401 wrong credentials, 429 too many attempts |
| GET | `/api/auth/me` | Bearer | | `200 user` | 401 |
| GET | `/api/users/:id` | Bearer | | `200 user` | 401, 404 |
| PATCH | `/api/users/:id` | Bearer | any of `{"username", "email", "password" + "current_password"}` | `200 user` (updated) | 400, 401, 403 wrong current password, 404, 409 taken |
| DELETE | `/api/users/:id` | Bearer | | `200 {"deleted": true, "id"}` | 401, 404 |

Rules: usernames are 3 to 50 letters, numbers, `.`, `-` or `_` (unique, case-insensitive); email is optional; passwords are 8 to 128 characters. Login accepts the username or the email. Changing the password requires `current_password` and logs out every existing token.

### CrowdCampaign endpoints (A1)

| Method | Path | Who | Body | Success |
| --- | --- | --- | --- | --- |
| GET | `/api/campaigns` | any user | | `200 {"campaigns": [...]}` newest first |
| POST | `/api/campaigns` | any user | `{"brand", "title", "brief", "prize", "deadline"}` (ISO date) | `201 campaign` |
| GET | `/api/campaigns/:id` | any user | | `200 campaign` plus `my_submission` and `winner` |
| DELETE | `/api/campaigns/:id` | organizer | | `200 {"deleted": true, "id"}` |
| POST | `/api/campaigns/:id/submissions` | anyone but the organizer | `{"title", "content"}` | `201 idea` (one per person; 409 on a second, or once closed) |
| GET | `/api/campaigns/:id/submissions` | organizer | | `200 {"campaign_id", "submissions": [ranked ideas]}` |
| POST | `/api/campaigns/:id/evaluate` | organizer | `{"force": true}` to re-score all | `200 {"judge", "scored", "failed", "message", "submissions"}`; `502` if the AI is down |
| GET | `/api/campaigns/:id/shortlist` | organizer | | `200 {"campaign_id", "size": 10, "shortlist": [...]}` |
| POST | `/api/campaigns/:id/winner` | organizer | `{"submission_id"}` | `200 campaign` with `winner` (final; 409 if already picked) |
| GET | `/api/ai/status` | any user | | `200 {"provider", "model", "is_ai", "label"}` |

### Tracker endpoints (1B)

Every route needs a login (no token or a bad token: **401**). Every route reads or changes **only the logged-in user's** tracker data; another user's run id gets **404**, exactly like an id that doesn't exist (the same reasoning as Rule 3). The upload limit for these routes is 1 MB.

| Method | Path | Used by | Body | Success | Errors |
| --- | --- | --- | --- | --- | --- |
| GET | `/api/tracker/state` | tracker, at the start of a run | | `200 {"next_run_number", "last_run", "seen_urls": [{url, run_number, fetched_at}], "campaigns": [{campaign_id, developments: [...with sources], last_top: [{rank, development_id}]}]}` | 401 |
| POST | `/api/tracker/runs` | tracker, at the end of a run | `{"started_at", "finished_at", "status", "stop_reason", "model", "stats", "report_markdown", "campaigns": [{campaign_id, topic, status, stop_reason, top: [{ref: "<development id>" or "new:1", title, summary, sources: [{url, title, quote}]}]}], "articles": [{campaign_id, url, title, status, reason, http_status, bytes, fetched_at, flagged}]}` | `201` run summary with `number` and `counts` | 400 invalid (including non-http(s) links), 401, 404 unknown campaign or someone else's development, 409 saved twice at once, 413 too large |
| DELETE | `/api/tracker/state` | `python -m tracker reset` | | `200 {"reset": true, "deleted": {"runs", "developments"}}` | 401 |
| GET | `/api/tracker/runs` | app: run history | | `200 {"runs": [...]}` newest first, each with `counts` (new, still, dropped) and article counts | 401 |
| GET | `/api/tracker/runs/latest` | app: latest report | | `200 {"run": {...} or null}` | 401 |
| GET | `/api/tracker/runs/:id` | app: one run | | `200 {"run": {..., "campaigns": [{top, dropped, counts}], "articles": [...]}}` | 401, 404 |
| GET | `/api/tracker/campaigns/:id` | app: the box on a campaign page | | `200 {"campaign_id", "run", "topic", "top", "dropped"}` (empty `top` if never researched) | 401, 404 unknown campaign |

`status` of a run or campaign is `complete`, `partial` or `failed`. An article's `status` is `fetched`, `skipped` (already seen), `rejected` (by the guardrail) or `failed`.

## Data model

```
users ──< campaigns (organizer_id)            deleting a user removes their campaigns,
  │           │                               ideas, scores and tracker data (ON DELETE CASCADE)
  └──────< submissions (author_id, campaign_id)
                 │   one per person per campaign; at most one winner per campaign
                 └── evaluations (AI judge only)

users ──< tracker_runs (owner_id, number)                 one row per run; number is per user
              ├──< tracker_run_campaigns (campaign_id, topic, status)
              ├──< tracker_articles (url, status, reason, flagged)      every URL looked at
              └──< tracker_top (campaign_id, rank, development_id)       each run's top K
users ──< tracker_developments (campaign_id, title, summary, first_run_id)
              └──< tracker_sources (url, quote, run_id)                  the evidence for each
```

Uniqueness rules live in the database itself (case-insensitive unique indexes on username and email, one idea per person, one winner per campaign, one number per run per user, each development at most once in a run's top list), so they hold even when two requests race.

Why this schema for the tracker: it stores facts only, and works out the rest. "Already seen" is a lookup in `tracker_articles`. "What the top K was last time" is the previous run's rows in `tracker_top`. **New, Still and Dropped are computed** by comparing two runs' `tracker_top` rows (`backend/src/services/trackerHistory.js`), so the tracker and the web page can't disagree, and a failed run never erases the last good top list.

## Security decisions

### Rule 3: someone else's `:id` returns 404, always

`GET`, `PATCH` and `DELETE /api/users/:id` return **404 "User not found."** whenever `:id` isn't the logged-in user's own id, exactly as if that account didn't exist. I chose 404 over 403 because a 403 confirms the account exists: anyone with one account could probe ids and learn which are real (account enumeration). A 404 reveals nothing, which is also how GitHub answers for private repositories you can't see. The check runs first, before the request body is read and before any database lookup (`ownAccountOnly` in `backend/src/routes/users.js`), so all three methods answer identically and an id that doesn't exist gets the very same response. The tracker's run ids follow the same rule.

### Passwords (Rule 1 and hashing)

- Hashed with **scrypt**, built into Node's `crypto` module, with the OWASP-recommended cost (N = 2^17, r = 8, p = 1), a random 16-byte salt per password and a 64-byte key. Stored as `scrypt$N$r$p$salt$hash`, so the cost can be raised later; logins quietly upgrade old hashes.
- Comparison uses `crypto.timingSafeEqual`. When a username doesn't exist, the server still runs one full scrypt, so response time doesn't reveal which usernames exist, and the error message is identical.
- Hashes never leave the server: every response is built from an allow-list of five fields (`backend/src/lib/users.js`), unexpected errors return a generic message, and `npm run check` scans every response for hash-like values.
- After 10 failed logins for one username from one address, that pair is locked for 15 minutes (HTTP 429).

### Tokens (Rule 2)

- JSON Web Tokens signed with HMAC-SHA256, implemented in about 60 readable lines in `backend/src/auth/tokens.js`. The signature is checked first; only `HS256` is accepted (blocking the `"alg": "none"` trick); tokens expire after 2 hours.
- Each token carries the user's `token_version`. Changing the password increments it, so every older token stops working. Deleted accounts' tokens stop working too.
- Missing, malformed, tampered, expired or revoked token: **401** with a `WWW-Authenticate` header. This applies to the tracker endpoints too.
- Tokens are sent as `Authorization: Bearer` headers, not cookies, so cross-site request forgery doesn't apply and `SameSite` settings aren't needed. React escapes all output, which protects the stored token from injected scripts.

### CORS

The frontend (`localhost:5173`) and backend (`localhost:4000`) are different origins, so the browser sends a preflight `OPTIONS` request before each API call. The backend answers only for origins listed in `CORS_ORIGINS`, allows only the methods and headers the app uses, and lets browsers cache the answer for 10 minutes. The frontend dev server uses a fixed port (`strictPort`), so it never silently moves to a port the backend doesn't allow. The tracker is not a browser, so CORS doesn't apply to it; it uses the same Bearer tokens.

## Project structure

```
config.yaml              the tracker's policy (topic, K, campaigns, model, tools, limits, hosts)
AGENT.md                 how the agent works (answers to the 1B questions)
reports/                 run1.md, run2.md ... one report per tracker run
traces/                  run1.jsonl, run2.jsonl ... one trace log per tracker run
tracker/
  __main__.py            python -m tracker run | status | reset | stats
  agent.py               the agent loop, budgets, notes, finish, partial reports
  tools.py               search_web, fetch_article, finish (also runnable on their own)
  guard.py               fetch_article's guardrail
  failures.py            transient vs terminal failures, retries with backoff
  verify.py              quote and number checks (provenance)
  llm.py                 the model client (OpenAI-compatible chat API)
  memory.py              the app API client (the tracker's memory)
  prompts.py             what the model is told
  extract.py             HTML to text, and spotting pages that address an AI
  report.py              reports/runN.md (New / Still in top K / Dropped)
  trace.py               the JSONL trace and its summary
  config.py              loads and checks config.yaml and tracker/.env
backend/
  src/
    server.js            start-up: check settings, create tables, listen
    app.js               Express app: security headers, CORS, routes, error handling
    config.js            reads .env.local and .env
    db.js, migrate.js    connection pool and schema (A1 and tracker tables)
    auth/                passwords.js, tokens.js, requireAuth.js, loginThrottle.js
    routes/              auth.js, users.js, campaigns.js, ai.js, tracker.js
    services/            submissions.js (ranking), trackerHistory.js (New/Still/Dropped)
    ai/                  the A1 judge: evaluator.js, prompt.js, offline.js, providers/
    lib/                 validation, user serialization, errors
  scripts/               seed.js, demo-data.js, check.js
frontend/
  src/
    main.jsx, App.jsx    entry point and routes
    api.js, auth.jsx     API client and login state
    pages/               Login, Register, Home, Campaigns, NewCampaign, CampaignDetail, Intel, Account
    components/          layout, shared UI, MarketIntelBox
    styles.css           all styles (no CSS framework)
```

Development mode with auto-restart: `npm run dev` in `backend/` restarts the API whenever a file changes.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `DATABASE_URL is not set` | Paste the Neon connection string into `backend/.env`. |
| `Port 4000 is already in use` | Another backend is running. Close that terminal (Ctrl+C), or set `PORT=4001` in `backend/.env`, `VITE_API_URL=http://localhost:4001` in `frontend/.env` and `CROWDCAMPAIGN_API_URL=http://localhost:4001` in `tracker/.env`. |
| `Port 5173 is already in use` | Another frontend is running; close it. The port is fixed on purpose (see CORS). |
| The app says it "can't reach the backend" | Start the backend (`npm start` in `backend/`) and click Try again. |
| Timed out connecting to the database | Neon was asleep or your connection dropped. Try again after a few seconds. |
| Windows PowerShell: "running scripts is disabled" | Run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once (this also lets `Activate.ps1` run), or use Command Prompt (`.venv\Scripts\activate.bat`). |
| `Cannot find module @rollup/rollup-...` | A known npm bug with optional packages. In `frontend/`, delete `node_modules` and `package-lock.json`, then run `npm install` again. |
| `No module named tracker` | Run the command from the `crowdcampaign` folder (the one that contains `config.yaml`). |
| `No module named yaml` or `requests` | Activate the virtual environment, then `pip install -r tracker/requirements.txt`. |
| `Can't start: No model API key found` or `Can't start: ... is not set` | Fill in that key in `tracker/.env` (copied from `tracker/.env.example`). |
| `can't reach the CrowdCampaign API` | Start the backend first (step 1), then run the tracker. |
| `Campaign ... Not found in the app` | Run `npm run seed` in `backend/` (it adds the demo campaigns), or fix the title in `config.yaml`. |
| `the API key was rejected` | The model or search key in `tracker/.env` is wrong; copy it again. |
| `daily quota used up` | The free tier's daily limit is reached; run again tomorrow, or switch provider in `config.yaml`. |
| A run ends `partial` | A budget ran out or a service failed; the report says which. Raise the limit in `config.yaml` if needed. |
| Mac: `CERTIFICATE_VERIFY_FAILED` | Run "Install Certificates.command" from your Python folder in Applications, or reinstall `requests`. |
| Login worked, then everything says "log in again" | Tokens last 2 hours. Log in again. |
| Scores say "Offline estimate, not AI" | No A1 judge key is set. That's fine; see "Enabling the AI judge". |
