# Tracker trace logs

`python -m tracker run` writes one trace per run: `run1.jsonl`, `run2.jsonl`, and so on.
Each line is one JSON record: a model call, a tool call (`search_web`, `fetch_article`, `finish`),
an HTTP round trip, a retry, a note, or a budget stop, with the time, campaign, step, arguments,
status, latency, and tokens or search credits. API keys and login tokens are never written.

Summarize a run: `python -m tracker stats traces/run1.jsonl`
