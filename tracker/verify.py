"""Provenance checks: is this quote really in the article, and are the numbers in a claim?

The model must back every development with a sentence copied word for word from an
article it fetched. These checks run in code, so a made-up or paraphrased quote is
caught before it can reach a report.
"""
from __future__ import annotations

import re
import unicodedata

_SAME = str.maketrans({
    "‘": "'", "’": "'", "‚": "'", "‛": "'", "′": "'",
    "“": '"', "”": '"', "„": '"', "″": '"',
    "–": "-", "—": "-", "−": "-", "‐": "-", "‑": "-",
    " ": " ", " ": " ", " ": " ", "​": "",
    "‹": "<", "›": ">",  # the model sees < and > as ‹ and › (see prompts.web_text)
    "…": "...",
})
_NUMBER = re.compile(r"\d[\d,]*(?:\.\d+)?")


def normalize(text: str) -> str:
    """Lowercase, one space between words, and curly quotes/dashes made plain."""
    text = unicodedata.normalize("NFKC", text or "").translate(_SAME)
    return re.sub(r"\s+", " ", text).strip().lower()


def quote_problem(quote: str, source_text: str) -> str | None:
    """None if the quote appears in the source; otherwise what is wrong with it."""
    q = normalize(quote).strip(" \"'")
    if len(q) < 25 or len(q.split()) < 5:
        return "the quote is too short; copy one full sentence"
    if len(q) > 400:
        return "the quote is too long; copy a single sentence"
    if "..." in q or "[" in q:
        return "copy the sentence exactly, without '...' or [brackets]"
    if q.rstrip(".!?;:,") not in normalize(source_text):
        return "the quote is not in the article; copy a sentence exactly as written"
    return None


def unsupported_numbers(claim: str, source_text: str) -> list:
    """Numbers in a title or summary that never appear in the source (likely invented)."""
    source = normalize(source_text).replace(",", "")
    missing = []
    for raw in _NUMBER.findall(claim or ""):
        number = raw.replace(",", "").rstrip(".")
        if not re.search(r"(?<![\d.])" + re.escape(number) + r"(?![\d])", source):
            missing.append(raw)
    return missing
