"""Calls the language model through the OpenAI-compatible chat API (Gemini, Groq, ...).

One request = one model decision. Transient failures are retried by failures.with_retries;
terminal ones (bad key, daily quota) stop the run.
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from urllib.parse import urlsplit

import requests

from .failures import TransientError, classify_http_error, with_retries


@dataclass
class Reply:
    text: str
    tokens_in: int
    tokens_out: int
    estimated: bool  # True when the provider didn't report usage and we estimated it
    finish_reason: str | None


class ChatModel:
    def __init__(self, settings, retry_policy, trace, session=None):
        self.settings = settings
        self.retry_policy = retry_policy
        self.trace = trace
        self.session = session or requests.Session()
        self.url = settings.base_url + "chat/completions"
        self.host = urlsplit(self.url).hostname

    @property
    def label(self) -> str:
        return f"{self.settings.label} ({self.settings.name})"

    def complete(self, messages: list) -> Reply:
        body = {"model": self.settings.name, "messages": messages, "max_tokens": self.settings.max_output_tokens}
        body.update(self.settings.extra)
        headers = {"Content-Type": "application/json"}
        if self.settings.api_key:
            headers["Authorization"] = f"Bearer {self.settings.api_key}"

        def attempt(number: int) -> Reply:
            started = time.monotonic()
            status = None
            try:
                response = self.session.post(self.url, json=body, headers=headers, timeout=(10, self.settings.timeout))
                status = response.status_code
            except requests.Timeout:
                raise TransientError("model", "the request timed out") from None
            except requests.ConnectionError:
                raise TransientError("model", f"can't reach {self.host} (is the internet connection up?)") from None
            finally:
                self.trace.event("http", service="model", host=self.host, attempt=number, status=status,
                                 latency_ms=int((time.monotonic() - started) * 1000))
            if status >= 400:
                raise classify_http_error("model", status, response.headers, response.text)
            try:
                data = response.json()
                choice = data["choices"][0]
            except (ValueError, KeyError, IndexError, TypeError):
                raise TransientError("model", "the reply was not in the expected format") from None
            content = (choice.get("message") or {}).get("content")
            if isinstance(content, list):  # some providers return content parts
                content = "".join(part.get("text", "") for part in content if isinstance(part, dict))
            text = content or ""
            usage = data.get("usage") or {}
            tokens_in = usage.get("prompt_tokens")
            total = usage.get("total_tokens")
            tokens_out = (total - tokens_in) if (total is not None and tokens_in is not None) else usage.get("completion_tokens")
            estimated = tokens_in is None or tokens_out is None
            if tokens_in is None:
                tokens_in = sum(len(str(m.get("content", ""))) for m in messages) // 4
            if tokens_out is None:
                tokens_out = len(text) // 4
            return Reply(text=text, tokens_in=int(tokens_in), tokens_out=int(tokens_out), estimated=estimated,
                         finish_reason=choice.get("finish_reason"))

        return with_retries(attempt, service="model", policy=self.retry_policy, trace=self.trace)
