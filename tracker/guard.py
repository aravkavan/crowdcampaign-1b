"""fetch_article's guardrail. Every check here runs before any request is made.

1. Only http and https. file:, ftp:, javascript:, data: and the rest are refused.
2. No usernames or passwords inside URLs, only allowed ports (80 and 443 by default),
   no local names like localhost, and the blocked/allowed host lists from config.yaml.
3. The host name is resolved, and if ANY address it resolves to is loopback, private,
   link-local, multicast or otherwise not public, the URL is refused. This also catches
   tricks like http://2130706433/ or http://127.1/ (both mean 127.0.0.1) and public-looking
   names that point at a private address.
4. The connection goes to the address that was just checked (it is never looked up a
   second time, so a DNS answer can't change in between), and the address actually
   connected to is checked again.
5. Redirects are not followed automatically: each new location goes through all of the
   checks above, and at most max_redirects are followed.
6. One deadline covers the whole download, redirects included, and reading stops at
   max_bytes. Only HTML and plain-text pages are accepted.
"""
from __future__ import annotations

import http.client
import ipaddress
import socket
import ssl
import time
import zlib
from dataclasses import dataclass, field
from urllib import robotparser
from urllib.parse import urljoin, urlsplit

from .config import SAFE_SCHEMES

try:  # requests installs certifi; using its CA bundle avoids macOS certificate problems
    import certifi

    _CAFILE = certifi.where()
except ImportError:  # pragma: no cover
    _CAFILE = None

ALLOWED_TYPES = {"text/html", "application/xhtml+xml", "text/plain"}
LOCAL_NAMES = {"localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback", "broadcasthost"}
LOCAL_SUFFIXES = (".localhost", ".local", ".internal", ".lan", ".home.arpa", ".intranet", ".corp", ".localdomain")
NAT64 = ipaddress.ip_network("64:ff9b::/96")
ROBOTS_AGENT = "CrowdCampaignTracker"


class Rejected(Exception):
    """The guardrail refused this URL. Nothing was sent to it."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


class FetchFailed(Exception):
    """The URL passed the guardrail, but downloading it didn't work."""

    def __init__(self, reason: str, http_status: int | None = None):
        super().__init__(reason)
        self.reason = reason
        self.http_status = http_status


@dataclass
class Target:
    url: str
    scheme: str
    host: str
    port: int
    path: str
    addresses: list


@dataclass
class Page:
    url: str
    final_url: str
    http_status: int
    content_type: str
    charset: str | None
    body: bytes
    truncated: bool
    redirects: list = field(default_factory=list)


def is_public_ip(value: str) -> bool:
    """True only for globally routable unicast addresses."""
    try:
        ip = ipaddress.ip_address(value.split("%", 1)[0])
    except ValueError:
        return False
    if ip.version == 6:
        if ip.ipv4_mapped:  # ::ffff:127.0.0.1
            return is_public_ip(str(ip.ipv4_mapped))
        if ip.sixtofour:  # 2002:7f00:1::/48 embeds 127.0.0.1
            return is_public_ip(str(ip.sixtofour))
        if ip.teredo or ip in NAT64:  # tunnels that can reach IPv4 addresses
            if ip in NAT64:
                return is_public_ip(str(ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF)))
            return False
    if (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
        or getattr(ip, "is_site_local", False)
    ):
        return False
    return ip.is_global


def resolve_host(host: str, port: int) -> list:
    """Every address the host name resolves to."""
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except UnicodeError:
        raise Rejected("the host name is not valid") from None
    except socket.gaierror:
        raise FetchFailed(f"could not resolve {host}") from None
    addresses = []
    for info in infos:
        address = info[4][0]
        if address not in addresses:
            addresses.append(address)
    return addresses


def _matches(host: str, domains) -> bool:
    return any(host == d or host.endswith("." + d) for d in domains)


def _is_ip_literal(host: str) -> bool:
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        return False


def check_url(url, policy) -> Target:
    """Run every check that doesn't need a connection. Raises Rejected or FetchFailed."""
    if not isinstance(url, str) or not url.strip():
        raise Rejected("empty URL")
    url = url.strip()
    if len(url) > 2048:
        raise Rejected("URL is longer than 2048 characters")
    if any(ord(ch) < 33 or ord(ch) == 127 for ch in url):
        raise Rejected("URL contains spaces or control characters")
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError as err:
        raise Rejected(f"not a valid URL ({err})") from None

    scheme = parts.scheme.lower()
    if not scheme:
        raise Rejected("the URL has no scheme; it must start with http:// or https://")
    if scheme not in SAFE_SCHEMES or scheme not in policy.allowed_schemes:
        raise Rejected(f"scheme not allowed: {scheme}: (only http and https)")
    if parts.username is not None or parts.password is not None:
        raise Rejected("URLs with a username or password are not allowed")
    host = (parts.hostname or "").rstrip(".")
    if not host:
        raise Rejected("URL has no host")
    port = port or (443 if scheme == "https" else 80)
    if port not in policy.allowed_ports:
        raise Rejected(f"port {port} is not allowed (allowed: {', '.join(map(str, policy.allowed_ports))})")
    if not _is_ip_literal(host):
        try:
            host = host.encode("idna").decode("ascii").lower()
        except UnicodeError:
            raise Rejected("the host name is not valid") from None
    if host in LOCAL_NAMES or host.endswith(LOCAL_SUFFIXES):
        raise Rejected(f"local network names are not allowed ({host})")
    if _matches(host, policy.blocked_hosts):
        raise Rejected(f"{host} is on the blocked list in config.yaml")
    if "*" not in policy.allowed_hosts and not _matches(host, policy.allowed_hosts):
        raise Rejected(f"{host} is not on the allowed list in config.yaml")

    addresses = resolve_host(host, port)
    if not addresses:
        raise FetchFailed(f"could not resolve {host}")
    for address in addresses:
        if not is_public_ip(address):
            if _is_ip_literal(host):
                raise Rejected(f"{host} is not a public address (loopback, private, link-local or reserved)")
            raise Rejected(f"{host} resolves to a non-public address ({address})")

    path = parts.path or "/"
    if parts.query:
        path += "?" + parts.query
    return Target(url=url, scheme=scheme, host=host, port=port, path=path, addresses=addresses)


def _open_socket(address: str, port: int, timeout: float) -> socket.socket:
    """Connect to an address that already passed the checks, then check the peer again."""
    sock = socket.create_connection((address, port), timeout=timeout)
    peer = sock.getpeername()[0]
    if not is_public_ip(peer):
        sock.close()
        raise Rejected(f"the connection reached a non-public address ({peer})")
    return sock


class _PinnedHTTP(http.client.HTTPConnection):
    def __init__(self, target: Target, timeout: float):
        super().__init__(target.host, target.port, timeout=timeout)
        self._address = target.addresses[0]

    def connect(self):
        self.sock = _open_socket(self._address, self.port, self.timeout)


class _PinnedHTTPS(http.client.HTTPSConnection):
    def __init__(self, target: Target, timeout: float):
        context = ssl.create_default_context(cafile=_CAFILE)
        super().__init__(target.host, target.port, timeout=timeout, context=context)
        self._address = target.addresses[0]

    def connect(self):
        sock = _open_socket(self._address, self.port, self.timeout)
        # Encryption and certificate checks still use the real host name.
        self.sock = self._context.wrap_socket(sock, server_hostname=self.host)


def _read_limited(response, connection, max_bytes: int, deadline: float):
    chunks, total, truncated = [], 0, False
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise FetchFailed("timed out while downloading")
        if connection.sock is not None:
            connection.sock.settimeout(remaining)
        # read1 returns after a single socket read, so the deadline is checked between every
        # piece: a server that sends one byte at a time can't stretch the download.
        chunk = response.read1(min(65536, max_bytes - total + 1))
        if not chunk:
            break
        chunks.append(chunk)
        total += len(chunk)
        if total > max_bytes:
            truncated = True
            break
    return b"".join(chunks)[:max_bytes], truncated


def _decompress(body: bytes, encoding: str, max_bytes: int):
    if encoding in ("", "identity"):
        return body, False
    if encoding in ("gzip", "x-gzip", "deflate"):
        wbits = 16 + zlib.MAX_WBITS if "gzip" in encoding else zlib.MAX_WBITS
        try:
            d = zlib.decompressobj(wbits)
            out = d.decompress(body, max_bytes)  # never expands past max_bytes (no zip bombs)
        except zlib.error:
            try:
                d = zlib.decompressobj(-zlib.MAX_WBITS)
                out = d.decompress(body, max_bytes)
            except zlib.error:
                raise FetchFailed("could not decompress the page") from None
        return out, bool(d.unconsumed_tail)
    raise Rejected(f"unsupported compression ({encoding})")


def _get(target: Target, policy, deadline: float, trace, service: str):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise FetchFailed("timed out")
    connection = (_PinnedHTTPS if target.scheme == "https" else _PinnedHTTP)(target, timeout=remaining)
    started = time.monotonic()
    status = None
    outcome = "error"
    try:
        connection.request(
            "GET",
            target.path,
            headers={
                "User-Agent": policy.user_agent,
                "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9",
                "Accept-Encoding": "identity",
                "Accept-Language": "en-US,en;q=0.8",
                "Connection": "close",
            },
        )
        response = connection.getresponse()
        status = response.status
        if 300 <= status < 400:
            outcome = "redirect"
            return status, response.headers, b"", False
        if status >= 400:
            raise FetchFailed(f"the site answered HTTP {status}", http_status=status)
        content_type = response.headers.get_content_type()
        if content_type not in ALLOWED_TYPES:
            raise Rejected(f"not a web page ({content_type})")
        length = response.headers.get("Content-Length")
        if length and length.strip().isdigit() and int(length) > policy.max_bytes:
            raise Rejected(f"the page is {int(length):,} bytes, over the {policy.max_bytes:,}-byte limit")
        body, truncated = _read_limited(response, connection, policy.max_bytes, deadline)
        body, cut = _decompress(body, (response.headers.get("Content-Encoding") or "").strip().lower(), policy.max_bytes)
        outcome = "ok"
        return status, response.headers, body, truncated or cut
    except (Rejected, FetchFailed) as err:
        outcome = "rejected" if isinstance(err, Rejected) else "failed"
        raise
    except TimeoutError:
        outcome = "timeout"
        raise FetchFailed("timed out") from None
    except ssl.SSLCertVerificationError as err:
        raise FetchFailed(f"the site's TLS certificate is not valid ({err.verify_message})") from None
    except ssl.SSLError:
        raise FetchFailed("TLS (https) connection failed") from None
    except (OSError, http.client.HTTPException) as err:
        raise FetchFailed(f"connection failed ({err.__class__.__name__})") from None
    finally:
        connection.close()
        if trace is not None:
            trace.event(
                "http",
                service=service,
                host=target.host,
                address=target.addresses[0],
                status=status,
                outcome=outcome,
                latency_ms=int((time.monotonic() - started) * 1000),
            )


def fetch_page(url: str, policy, *, trace=None, service: str = "fetch", deadline: float | None = None) -> Page:
    """Download one page with every guardrail applied. Raises Rejected or FetchFailed."""
    deadline = deadline or time.monotonic() + policy.timeout_seconds
    current = url
    redirects = []
    for _ in range(policy.max_redirects + 1):
        try:
            target = check_url(current, policy)  # every hop goes through every check
        except Rejected as err:
            if redirects:
                raise Rejected(f"redirected to {current[:200]}, which was refused: {err.reason}") from None
            raise
        status, headers, body, truncated = _get(target, policy, deadline, trace, service)
        if 300 <= status < 400:
            location = headers.get("Location")
            if not location:
                raise FetchFailed("redirect without a destination", http_status=status)
            current = urljoin(current, location.strip())
            redirects.append(current)
            continue
        return Page(
            url=url,
            final_url=current,
            http_status=status,
            content_type=headers.get_content_type(),
            charset=headers.get_content_charset(),
            body=body,
            truncated=truncated,
            redirects=redirects,
        )
    raise Rejected(f"more than {policy.max_redirects} redirects")


class RobotsCache:
    """robots.txt rules per site, fetched once per run through the same guardrail."""

    def __init__(self, policy, trace=None):
        self.policy = policy
        self.trace = trace
        self._rules = {}

    def check(self, url: str) -> str | None:
        """None if allowed; otherwise the reason this URL is off-limits."""
        if not self.policy.respect_robots_txt:
            return None
        parts = urlsplit(url)
        key = (parts.scheme.lower(), (parts.hostname or "").lower(), parts.port)
        if key not in self._rules:
            self._rules[key] = self._load(f"{parts.scheme}://{parts.netloc}/robots.txt")
        rules = self._rules[key]
        if rules is None:
            return None
        if rules == "unreachable":
            return "robots.txt could not be loaded (server error), so the site is treated as off-limits"
        if not rules.can_fetch(ROBOTS_AGENT, url):
            return "the site's robots.txt does not allow fetching this page"
        return None

    def _load(self, robots_url: str):
        limits = _RobotsPolicy(self.policy)
        try:
            page = fetch_page(robots_url, limits, trace=self.trace, service="robots")
        except FetchFailed as err:
            # RFC 9309: a 4xx means "no rules" (allowed); a server error or no answer
            # means the crawler must assume it is not allowed.
            if err.http_status and 400 <= err.http_status < 500:
                return None
            return "unreachable"
        except Rejected:
            return None  # not a usable robots.txt (for example, an HTML error page): no rules
        parser = robotparser.RobotFileParser()
        parser.parse(page.body.decode(page.charset or "utf-8", errors="replace").splitlines())
        return parser


class _RobotsPolicy:
    """The page policy with a shorter timeout and a smaller size limit, for robots.txt."""

    def __init__(self, policy):
        self.__dict__.update(policy.__dict__)
        self.timeout_seconds = min(policy.timeout_seconds, 8)
        self.max_bytes = min(policy.max_bytes, 512_000)
