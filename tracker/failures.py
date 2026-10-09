"""Failure handling for every call to an outside service (model, search, the app's API).

Two kinds of failure, handled differently:

  Transient  might succeed if we wait: timeouts, dropped connections, per-minute rate
             limits, 5xx server errors. Retried with exponential backoff, a few times.
  Terminal   waiting can't fix it: a bad API key, a used-up daily quota, payment
             required, a wrong model name. Never retried; the run stops with a message
             that says what to do. Retrying a daily quota would only burn more requests.
"""
from __future__ import annotations

import random
import re
import time
from email.utils import parsedate_to_datetime


class TrackerError(Exception):
    def __init__(self, service: str, message: str):
        super().__init__(f"{service}: {message}")
        self.service = service
        self.message = message


class TransientError(TrackerError):
    """Worth retrying after a pause. `wait` is the delay the service asked for, if any."""

    def __init__(self, service: str, message: str, wait: float | None = None):
        super().__init__(service, message)
        self.wait = wait


class TerminalError(TrackerError):
    """Retrying cannot help. The run stops and reports what happened."""


class RetriesExhausted(TerminalError):
    """A transient failure kept happening on every retry (for example, the network is down)."""


# Gemini answers a wrong key with HTTP 400 ("API key not valid", reason API_KEY_INVALID), not 401.
BAD_KEY = re.compile(r"api[\s_-]?key[\s_-]?(?:not[\s_-]?valid|invalid|expired)|invalid[\s_-]?api[\s_-]?key", re.IGNORECASE)

# Words providers use in 429 bodies. Gemini: "GenerateRequestsPerDayPerProjectPerModel" or
# "...PerMinute...". Groq: "on requests per day (RPD)" or "tokens per minute (TPM)".
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
    if status in (401, 403) or (status == 400 and BAD_KEY.search(body or "")):
        return TerminalError(service, f"the API key was rejected (HTTP {status}). Check the key in tracker/.env. {detail}")
    if status == 402:
        return TerminalError(service, f"payment required (HTTP 402): the account is out of credit. {detail}")
    if status in (432, 433):
        return TerminalError(service, f"the plan's credit limit is used up (HTTP {status}). {detail}")
    if status in (408, 425, 500, 502, 503, 504, 529) or status >= 500:
        return TransientError(service, f"server error (HTTP {status})", wait=retry_after(headers, body))
    if status == 404:
        return TerminalError(service, f"not found (HTTP 404). Check the model name in config.yaml. {detail}")
    if status == 413:
        return TerminalError(service, "one request was larger than the provider allows (HTTP 413). Lower "
                                      f"fetch.max_chars_to_model or the model's max_output_tokens in config.yaml. {detail}")
    return TerminalError(service, f"request refused (HTTP {status}). {detail}")


def with_retries(attempt_fn, *, service: str, policy, trace=None, sleep=time.sleep):
    """Call attempt_fn(attempt_number); retry TransientError with exponential backoff.

    Waits base_delay, 2x, 4x ... (plus up to 25% random jitter so many clients don't retry
    in lockstep), or exactly what the service asked for in Retry-After. Gives up after
    policy.max_retries retries, or at once if the service asks for a longer wait than
    policy.max_wait. TerminalError passes straight through: it is never retried.
    """
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


def retry_after(headers, body: str = "") -> float | None:
    """Seconds the service asked us to wait: the Retry-After header, or a hint in the body."""
    value = (headers or {}).get("retry-after") or (headers or {}).get("Retry-After")
    if value:
        try:
            return max(0.0, float(value))
        except ValueError:
            try:
                return max(0.0, parsedate_to_datetime(value).timestamp() - time.time())
            except (TypeError, ValueError):
                pass
    # Gemini: "Please retry in 39.5s." / "retryDelay": "39s"; Groq: "Please try again in 1m2.5s."
    m = re.search(r"(?:retry|try again) in ([\d.]+ms|(?:\d+h)?(?:\d+m(?!s))?[\d.]+s|\d+m(?!s))", body, re.IGNORECASE) or re.search(
        r'"retryDelay"\s*:\s*"([\d.]+s)"', body
    )
    return _duration(m.group(1)) if m else None


def _duration(text: str) -> float | None:
    if text.endswith("ms") and text[:-2].replace(".", "", 1).isdigit():
        return float(text[:-2]) / 1000
    total = 0.0
    found = False
    for amount, unit in re.findall(r"([\d.]+)([hms])", text):
        found = True
        total += float(amount) * {"h": 3600, "m": 60, "s": 1}[unit]
    return total if found else None


def _short(body: str, limit: int = 220) -> str:
    """The useful part of an error body, without secrets or page-long HTML."""
    text = body or ""
    m = re.search(r'"message"\s*:\s*"((?:[^"\\]|\\.)*)"', text)
    if m:
        text = m.group(1).encode("utf-8").decode("unicode_escape", errors="ignore")
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    text = re.sub(r"(api[_-]?key=|key=|Bearer\s+)[A-Za-z0-9._\-]+", r"\1[hidden]", text, flags=re.IGNORECASE)
    return text[:limit] + ("…" if len(text) > limit else "")
