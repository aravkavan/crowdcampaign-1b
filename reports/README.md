# Tracker reports

`python -m tracker run` writes one report here per run: `run1.md`, `run2.md`, and so on.
Each campaign's section lists **New since last run**, then **Still in top 5**, then **Dropped**,
and every development cites its sources with a sentence quoted from each.

For Assignment 1B, `run1.md` and `run2.md` come from two runs at least a day apart.
A run that researched nothing (for example, a bad API key) is written as `failed-<date>-<time>.md`
and doesn't use up a run number.
