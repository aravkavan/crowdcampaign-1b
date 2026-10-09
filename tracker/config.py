"""Loads the tracker's policy (config.yaml) and its secrets (tracker/.env).

config.yaml says what the agent may do; this module checks every value, fills in
defaults, and refuses anything unsafe (for example, a scheme other than http(s)).
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

import yaml

PACKAGE_DIR = Path(__file__).resolve().parent
REPO_ROOT = PACKAGE_DIR.parent
DEFAULT_CONFIG_PATH = REPO_ROOT / "config.yaml"
ENV_PATH = PACKAGE_DIR / ".env"

# Known model providers. All of them speak the OpenAI chat-completions format.
PROVIDERS = {
    "gemini": {
        "label": "Gemini",
        "base_url": "https://generativelanguage.googleapis.com/v1beta/openai/",
        "key_env": "GEMINI_API_KEY",
    },
    "groq": {"label": "Groq", "base_url": "https://api.groq.com/openai/v1/", "key_env": "GROQ_API_KEY"},
    "openrouter": {"label": "OpenRouter", "base_url": "https://openrouter.ai/api/v1/", "key_env": "OPENROUTER_API_KEY"},
    "ollama": {"label": "Ollama (local)", "base_url": "http://localhost:11434/v1/", "key_env": None},
}
ALL_TOOLS = ("search_web", "fetch_article", "finish")
# The hard ceiling for fetch_article: config.yaml can narrow this list, never widen it.
SAFE_SCHEMES = ("http", "https")


class ConfigError(Exception):
    """config.yaml or tracker/.env has a problem the user needs to fix."""


@dataclass
class Target:
    """One campaign to research."""

    title: str
    topic: str


@dataclass
class ModelSettings:
    provider: str
    label: str
    name: str
    base_url: str
    api_key: str | None
    key_env: str | None
    extra: dict = field(default_factory=dict)  # e.g. reasoning_effort, temperature
    max_output_tokens: int = 2048
    timeout: float = 60.0


@dataclass
class SearchSettings:
    provider: str = "tavily"
    base_url: str = "https://api.tavily.com"
    topic: str = "news"
    time_range: str = "month"
    max_results: int = 6
    search_depth: str = "basic"


@dataclass
class Limits:
    max_steps: int = 10
    max_searches: int = 3
    max_fetches: int = 5
    max_tokens: int = 60000
    max_seconds: int = 420


@dataclass
class RetryPolicy:
    max_retries: int = 3
    base_delay: float = 2.0
    max_wait: float = 65.0


@dataclass
class FetchPolicy:
    allowed_schemes: tuple = ("http", "https")
    allowed_ports: tuple = (80, 443)
    allowed_hosts: tuple = ("*",)
    blocked_hosts: tuple = ()
    respect_robots_txt: bool = True
    timeout_seconds: float = 15.0
    max_bytes: int = 2_000_000
    max_redirects: int = 4
    max_chars_to_model: int = 3500
    user_agent: str = "Mozilla/5.0 (compatible; CrowdCampaignTracker/1.0)"


@dataclass
class Config:
    path: Path
    topic: str
    k: int
    targets: list
    instructions: str
    tools: tuple
    model_section: dict
    search: SearchSettings
    limits: Limits
    retries: RetryPolicy
    fetch: FetchPolicy

    def model(self) -> ModelSettings:
        """Pick the model provider. Done on demand so `tools` commands don't need a model key."""
        return resolve_model(self.model_section)


def load_env(path: Path = ENV_PATH) -> None:
    """Read KEY=VALUE lines from tracker/.env into the environment.

    Variables that are already set win, so a key exported in the terminal overrides the file.
    """
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if key.startswith("export "):
            key = key[len("export "):].strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if key and key not in os.environ:
            os.environ[key] = value


def _section(raw: dict, name: str) -> dict:
    value = raw.get(name) or {}
    if not isinstance(value, dict):
        raise ConfigError(f"'{name}' in config.yaml must be a section of settings.")
    return value


def _int(section: dict, key: str, default: int, low: int, high: int, where: str) -> int:
    value = section.get(key, default)
    if not isinstance(value, int) or isinstance(value, bool) or not low <= value <= high:
        raise ConfigError(f"{where}.{key} must be a whole number from {low} to {high} (got {value!r}).")
    return value


def _number(section: dict, key: str, default: float, low: float, high: float, where: str) -> float:
    value = section.get(key, default)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not low <= value <= high:
        raise ConfigError(f"{where}.{key} must be a number from {low} to {high} (got {value!r}).")
    return float(value)


def _host_list(values, where: str) -> tuple:
    if not isinstance(values, list) or not all(isinstance(v, str) and v.strip() for v in values):
        raise ConfigError(f"{where} must be a list of host names.")
    return tuple(v.strip().lower().lstrip(".") for v in values)


def load_config(path: Path | str | None = None) -> Config:
    """Read and check config.yaml. Raises ConfigError with a plain-language message."""
    path = Path(path) if path else DEFAULT_CONFIG_PATH
    load_env()
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except FileNotFoundError:
        raise ConfigError(f"Can't find {path}. Run the tracker from the project folder.") from None
    except yaml.YAMLError as err:
        raise ConfigError(f"config.yaml is not valid YAML: {err}") from None
    if not isinstance(raw, dict):
        raise ConfigError("config.yaml must contain settings (key: value lines).")

    topic = str(raw.get("topic") or "").strip()
    if not topic:
        raise ConfigError("config.yaml needs a topic.")
    k = raw.get("k")
    if not isinstance(k, int) or isinstance(k, bool) or not 3 <= k <= 10:
        raise ConfigError(f"k must be a whole number from 3 to 10 (got {k!r}).")

    campaigns = raw.get("campaigns")
    if not isinstance(campaigns, list) or not 1 <= len(campaigns) <= 5:
        raise ConfigError("config.yaml must list 1 to 5 campaigns to research.")
    targets = []
    for i, item in enumerate(campaigns, start=1):
        if not isinstance(item, dict) or not str(item.get("title") or "").strip() or not str(item.get("topic") or "").strip():
            raise ConfigError(f"Campaign {i} in config.yaml needs a title and a topic.")
        targets.append(Target(title=str(item["title"]).strip(), topic=str(item["topic"]).strip()[:300]))
    titles = [t.title.lower() for t in targets]
    if len(set(titles)) != len(titles):
        raise ConfigError("config.yaml lists the same campaign twice.")

    tools = raw.get("tools") or list(ALL_TOOLS)
    if not isinstance(tools, list) or any(t not in ALL_TOOLS for t in tools):
        raise ConfigError(f"tools may only contain {', '.join(ALL_TOOLS)}.")
    if "finish" not in tools:
        raise ConfigError("tools must include finish, or the agent could never end a run.")

    lim = _section(raw, "limits")
    limits = Limits(
        max_steps=_int(lim, "max_steps", 10, 2, 50, "limits"),
        max_searches=_int(lim, "max_searches", 3, 0, 20, "limits"),
        max_fetches=_int(lim, "max_fetches", 5, 0, 30, "limits"),
        max_tokens=_int(lim, "max_tokens", 60000, 2000, 2_000_000, "limits"),
        max_seconds=_int(lim, "max_seconds", 420, 30, 7200, "limits"),
    )

    ret = _section(raw, "retries")
    retries = RetryPolicy(
        max_retries=_int(ret, "max_retries", 3, 0, 10, "retries"),
        base_delay=_number(ret, "base_delay_seconds", 2, 0, 60, "retries"),
        max_wait=_number(ret, "max_wait_seconds", 65, 1, 600, "retries"),
    )

    fe = _section(raw, "fetch")
    schemes = tuple(s.lower() for s in fe.get("allowed_schemes", ["http", "https"]))
    unsafe = [s for s in schemes if s not in SAFE_SCHEMES]
    if unsafe:
        raise ConfigError(f"fetch.allowed_schemes may only contain http and https (found {', '.join(unsafe)}).")
    ports = fe.get("allowed_ports", [80, 443])
    if not isinstance(ports, list) or not all(isinstance(p, int) and 1 <= p <= 65535 for p in ports):
        raise ConfigError("fetch.allowed_ports must be a list of port numbers.")
    fetch = FetchPolicy(
        allowed_schemes=schemes,
        allowed_ports=tuple(ports),
        allowed_hosts=_host_list(fe.get("allowed_hosts", ["*"]), "fetch.allowed_hosts"),
        blocked_hosts=_host_list(fe.get("blocked_hosts", []), "fetch.blocked_hosts"),
        respect_robots_txt=bool(fe.get("respect_robots_txt", True)),
        timeout_seconds=_number(fe, "timeout_seconds", 15, 1, 120, "fetch"),
        max_bytes=_int(fe, "max_bytes", 2_000_000, 10_000, 20_000_000, "fetch"),
        max_redirects=_int(fe, "max_redirects", 4, 0, 10, "fetch"),
        max_chars_to_model=_int(fe, "max_chars_to_model", 3500, 500, 50_000, "fetch"),
        user_agent=str(fe.get("user_agent") or FetchPolicy.user_agent),
    )

    se = _section(raw, "search")
    if se.get("provider", "tavily") != "tavily":
        raise ConfigError("search.provider must be tavily (the only search service this tracker supports).")
    search = SearchSettings(
        base_url=str(se.get("base_url") or "https://api.tavily.com").rstrip("/"),
        topic=str(se.get("topic", "news")),
        time_range=str(se.get("time_range", "month")),
        max_results=_int(se, "max_results", 6, 1, 20, "search"),
        search_depth=str(se.get("search_depth", "basic")),
    )
    if search.topic not in ("general", "news", "finance"):
        raise ConfigError("search.topic must be general, news or finance.")
    if search.time_range not in ("day", "week", "month", "year"):
        raise ConfigError("search.time_range must be day, week, month or year.")
    if search.search_depth not in ("basic", "advanced", "fast", "ultra-fast"):
        raise ConfigError("search.search_depth must be basic, advanced, fast or ultra-fast.")

    model_section = _section(raw, "model")
    if not model_section.get("providers"):
        raise ConfigError("config.yaml needs model.providers with at least one provider.")

    return Config(
        path=path,
        topic=topic,
        k=k,
        targets=targets,
        instructions=str(raw.get("instructions") or "").strip(),
        tools=tuple(tools),
        model_section=model_section,
        search=search,
        limits=limits,
        retries=retries,
        fetch=fetch,
    )


def resolve_model(section: dict) -> ModelSettings:
    """Choose the provider: the one named in config.yaml, or with "auto" the first whose key is set."""
    providers = section.get("providers") or {}
    if not isinstance(providers, dict):
        raise ConfigError("model.providers must be a section with one entry per provider.")
    wanted = str(section.get("provider") or "auto").lower()

    def settings(name: str) -> ModelSettings:
        entry = providers.get(name) or {}
        known = PROVIDERS.get(name, {})
        base_url = str(entry.get("base_url") or known.get("base_url") or "")
        if not base_url:
            raise ConfigError(f"Provider '{name}' needs a base_url in config.yaml.")
        key_env = entry.get("key_env", known.get("key_env"))
        api_key = os.environ.get(key_env, "").strip() if key_env else None
        if key_env and not api_key:
            raise ConfigError(f"{key_env} is not set. Add it to tracker/.env (see tracker/.env.example).")
        if not entry.get("name"):
            raise ConfigError(f"model.providers.{name}.name (the model to use) is missing.")
        extra = {}
        for key in ("reasoning_effort", "temperature", "top_p"):
            if entry.get(key) is not None:
                extra[key] = entry[key]
        return ModelSettings(
            provider=name,
            label=str(entry.get("label") or known.get("label") or name),
            name=str(entry["name"]),
            base_url=base_url if base_url.endswith("/") else base_url + "/",
            api_key=api_key,
            key_env=key_env,
            extra=extra,
            max_output_tokens=_int(entry, "max_output_tokens", section.get("max_output_tokens", 2048), 256, 32768,
                                   f"model.providers.{name}"),
            timeout=_number(section, "request_timeout_seconds", 60, 5, 600, "model"),
        )

    if wanted != "auto":
        if wanted not in providers:
            raise ConfigError(f"model.provider is '{wanted}', but model.providers has no '{wanted}' entry.")
        return settings(wanted)
    for name, entry in providers.items():
        key_env = (entry or {}).get("key_env", PROVIDERS.get(name, {}).get("key_env"))
        if key_env and os.environ.get(key_env, "").strip():
            return settings(name)
    needed = [((e or {}).get("key_env") or PROVIDERS.get(n, {}).get("key_env")) for n, e in providers.items()]
    needed = [n for n in needed if n]
    raise ConfigError(
        "No model API key found. Put one of these in tracker/.env: " + ", ".join(needed)
        + ". A free Gemini key comes from https://aistudio.google.com/apikey."
    )
