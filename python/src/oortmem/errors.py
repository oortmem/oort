"""Typed errors: the ten ``oort.v1`` codes, as the TypeScript SDK's ``OortError`` classes.

Branch on ``code`` (or the class), and on ``reason`` for the finer, stable cases
(``principal-required``, ``daily-limit``, ``rate-limit``). ``fix`` is a runnable ``oort ...``
command where one fixes it, else ``None``. ``retryable`` says whether the same call may succeed
later, and ``retry_after`` is the wait in seconds the service asked for, when it said.

Messages name fields, never their values, and never carry a key.
"""

from __future__ import annotations

import re
from typing import Any, Dict, Literal, Mapping, Optional

__all__ = [
    "OortErrorCode",
    "OortError",
    "OortUsageError",
    "OortNotFoundError",
    "OortAmbiguousIdError",
    "OortNeedsKeyError",
    "OortNeedsLoginError",
    "OortNeedsConfirmationError",
    "OortCloudOnlyError",
    "OortNetworkError",
    "OortRefusedError",
    "OortInternalError",
]

OortErrorCode = Literal[
    "usage",
    "not-found",
    "ambiguous-id",
    "needs-key",
    "needs-login",
    "needs-confirmation",
    "cloud-only",
    "network",
    "refused",
    "internal",
]


class OortError(Exception):
    """An Oort call failed. Every error the client raises is one of its subclasses."""

    code: OortErrorCode = "internal"

    def __init__(
        self,
        message: str,
        *,
        fix: Optional[str] = None,
        reason: Optional[str] = None,
        status: Optional[int] = None,
        retryable: bool = False,
        retry_after: Optional[int] = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.fix = fix
        self.reason = reason
        self.status = status if status is not None and status > 0 else None
        self.retryable = retryable
        self.retry_after = retry_after

    def __repr__(self) -> str:
        return f"{type(self).__name__}(code={self.code!r}, reason={self.reason!r}, message={self.message!r})"


class OortUsageError(OortError):
    code = "usage"


class OortNotFoundError(OortError):
    code = "not-found"


class OortAmbiguousIdError(OortError):
    code = "ambiguous-id"


class OortNeedsKeyError(OortError):
    """A model role has no key and no local model. ``role`` and ``env_var`` say which."""

    code = "needs-key"

    def __init__(
        self, message: str, *, role: str = "write", env_var: str = "ANTHROPIC_API_KEY", **kw: Any
    ) -> None:
        kw.setdefault("reason", "missing-key")
        super().__init__(message, **kw)
        self.role = role
        self.env_var = env_var


class OortNeedsLoginError(OortError):
    code = "needs-login"


class OortNeedsConfirmationError(OortError):
    code = "needs-confirmation"


class OortCloudOnlyError(OortError):
    code = "cloud-only"


class OortNetworkError(OortError):
    code = "network"

    def __init__(self, message: str, **kw: Any) -> None:
        kw.setdefault("retryable", True)
        super().__init__(message, **kw)


class OortRefusedError(OortError):
    code = "refused"


class OortInternalError(OortError):
    code = "internal"


_BY_CODE: Dict[str, type] = {
    cls.code: cls
    for cls in (
        OortUsageError,
        OortNotFoundError,
        OortAmbiguousIdError,
        OortNeedsKeyError,
        OortNeedsLoginError,
        OortNeedsConfirmationError,
        OortCloudOnlyError,
        OortNetworkError,
        OortRefusedError,
        OortInternalError,
    )
}


def _str(v: Any) -> Optional[str]:
    return v if isinstance(v, str) else None


def _int(v: Any) -> Optional[int]:
    return v if isinstance(v, int) and not isinstance(v, bool) else None


def error_from_envelope(error: Any) -> OortError:
    """An ``oort.v1`` envelope's ``error`` (from ``oort serve``) as its class. Unknown codes are
    ``internal``; only the documented fields are read."""
    e: Mapping[str, Any] = error if isinstance(error, Mapping) else {}
    code = _str(e.get("code")) or "internal"
    cls = _BY_CODE.get(code, OortInternalError)
    message = _str(e.get("message")) or "The call failed."
    kw: Dict[str, Any] = {
        "fix": _str(e.get("fix")),
        "reason": _str(e.get("reason")),
        "status": _int(e.get("status")),
        "retryable": e.get("retryable") is True,
        "retry_after": _int(e.get("retryAfter")),
    }
    if cls is OortNeedsKeyError:
        return OortNeedsKeyError(
            message,
            role=_str(e.get("role")) or "write",
            env_var=_str(e.get("envVar")) or "ANTHROPIC_API_KEY",
            **kw,
        )
    return cls(message, **kw)


# --------------------------------------------------------------------------------------------
# Oort Cloud's refusals: the TypeScript SDK's mapping, line for line (cloud.ts `cloudErrorKind`
# and `messageFor`, describe-error.ts `fixInMessage`, sdk/errors.ts `fromCloud`). The shared
# vectors in contract/sdk/vectors/cloud-errors.json pin both.

ACCOUNT_URL = "https://oortcloud.dev/account"

# core/src/display.ts DISPLAY_UNSAFE_SOURCE: control, bidi and invisible characters.
_DISPLAY_UNSAFE = re.compile(
    r"[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]"
)


def shown(s: str) -> str:
    """Text safe to show: each unsafe character as ``\\u{hex}``, as the CLI's ``shown``."""
    return _DISPLAY_UNSAFE.sub(lambda m: "\\u{%x}" % ord(m.group(0)), s)


#: Refused before any request names an end user (CON-132): whoami does not list the key's
#: ``end-users`` capability. An Oort Cloud from before it ignores ``Oort-User`` and would write the
#: end user's memories into the account's own Planet, so the header is never sent to one.
END_USERS_UNSUPPORTED = (
    "Per-user memory needs Oort Cloud with server keys: whoami does not list the end-users "
    'capability for this Oort key (an Oort Cloud without per-user memory, or a key made without "Acts '
    'for end users"), so nothing was sent for this end user. Make a server key on '
    "https://oortcloud.dev/account."
)


def end_users_unsupported() -> OortError:
    return OortRefusedError(END_USERS_UNSUPPORTED, reason="end-users-unsupported")


def _cloud_kind(status: int, code: Optional[str]) -> str:
    if status == 401:
        return "unauthorized"
    if status == 402 and code == "end_user_limit":
        # A plan's end-user limit (CON-132), not a lapsed plan.
        return "end-user-limit"
    if status == 402:
        return "payment-required"
    if status == 403:
        if code == "cloud_not_enabled":
            return "not-enabled"
        if code == "hive_not_enabled":
            return "hive-not-enabled"
        return "refused"
    if status == 404:
        return "not-found"
    if status == 409 and code == "ambiguous":
        return "ambiguous-prefix"
    if status == 413:
        return "too-large"
    if status == 429:
        return "rate-limit"
    if status >= 500:
        return "busy"
    return "bad-request"


def _cloud_message(kind: str, status: int, api_raw: Optional[str]) -> str:
    api = None if api_raw is None else shown(api_raw)
    tail = f": {api}" if api is not None else "."
    if kind == "unauthorized":
        return f"Oort Cloud rejected the Oort key (HTTP {status}): it is unknown or revoked. Run `oort login` again."
    if kind == "payment-required":
        return (
            f"Oort Pro is not active on this account (HTTP 402). Subscribe or update billing at {ACCOUNT_URL}, "
            "or run `oort cloud use --local`. `oort cloud export` still works."
        )
    if kind == "not-enabled":
        return (
            "Oort Cloud is not enabled for this account yet (HTTP 403). Your memories stay on this "
            "machine; run `oort cloud use --local`."
        )
    if kind == "rate-limit":
        return f"Oort Cloud limit reached (HTTP 429){tail} Usage is at {ACCOUNT_URL}."
    if kind == "too-large":
        return f"Oort Cloud refused a request that is too large (HTTP 413){tail}"
    if kind == "not-found":
        return "No such memory in Oort Cloud."
    if kind == "ambiguous-prefix":
        return "That id prefix matches more than one memory in Oort Cloud; give more of the id."
    if kind == "bad-request":
        return f"Oort Cloud refused the request (HTTP {status}){tail}"
    if kind == "busy":
        return f"Oort Cloud is busy or down, try again shortly (HTTP {status})."
    if kind == "hive-not-enabled":
        return (
            "Constellations are not enabled for this account yet (an invite-only beta). Your "
            "memories stay in your Planet."
        )
    if kind == "refused":
        return f"Oort Cloud refused this (HTTP {status}){tail}"
    if kind == "end-user-limit":
        return f"Oort Cloud refused a new end user (HTTP 402){tail}"
    return "Oort Cloud is unreachable: check your network, then try again."


def fix_in_message(message: str) -> Optional[str]:
    """The first runnable ```oort ...``` command quoted in a message, skipping placeholders."""
    for m in re.finditer(r"`(oort [^`]+)`", message):
        c = m.group(1)
        if not re.search("[<>\\u2026]|\\.\\.\\.", c):
            return c
    return None


def _sdk_fix(fix: Optional[str]) -> Optional[str]:
    if fix is None or fix == "" or "--yes" in fix or fix.startswith("oort --help"):
        return None
    return fix


_RETRY_AFTER_MAX_S = 3600
_IMF = re.compile(r"^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$")


def parse_retry_after(value: Optional[str], now_ms: Optional[float] = None) -> Optional[int]:
    """``Retry-After`` in whole seconds (a delay or an HTTP date), clamped to 1 s .. 1 h."""
    if value is None or value.strip() == "":
        return None
    v = value.strip()
    seconds: Optional[float] = None
    if re.fullmatch(r"\d{1,10}", v):
        seconds = float(v)
    elif _IMF.match(v):
        from email.utils import parsedate_to_datetime
        import math
        import time

        try:
            at = parsedate_to_datetime(v).timestamp() * 1000
        except (TypeError, ValueError):
            return None
        now = time.time() * 1000 if now_ms is None else now_ms
        seconds = math.ceil((at - now) / 1000)
    if seconds is None:
        return None
    return int(min(_RETRY_AFTER_MAX_S, max(1, seconds)))


def cloud_error(
    status: int,
    api_code: Optional[str] = None,
    api_message: Optional[str] = None,
    retry_after: Optional[int] = None,
) -> OortError:
    """An Oort Cloud refusal (HTTP status and its ``{ error: { code, message } }``) as its class.
    ``status`` 0 is a request that never got an answer (``api_code`` ``timeout`` when it timed
    out)."""
    kind = "network" if status == 0 else _cloud_kind(status, api_code)
    message = _cloud_message(kind, status, api_message)
    opts: Dict[str, Any] = {
        "fix": _sdk_fix(fix_in_message(message)),
        "status": status,
        "retry_after": retry_after,
    }
    if kind == "unauthorized":
        return OortNeedsLoginError(message, **{**opts, "fix": "oort login", "reason": "key-rejected"})
    if kind == "rate-limit":
        return OortRefusedError(message, **opts, reason=kind, retryable=True)
    if kind in ("payment-required", "not-enabled", "hive-not-enabled"):
        return OortRefusedError(message, **opts, reason=kind)
    if kind == "refused":
        # CON-132: only a server key acts for end users.
        if api_code == "end_users_not_allowed":
            return OortRefusedError(message, **opts, reason="end-users-not-allowed")
        return OortRefusedError(message, **opts, reason="forbidden")
    if kind == "end-user-limit":
        return OortRefusedError(message, **opts, reason="end-user-limit")
    if kind == "too-large":
        return OortUsageError(message, **opts, reason="too-large")
    if kind == "not-found":
        return OortNotFoundError(message, **opts)
    if kind == "ambiguous-prefix":
        return OortAmbiguousIdError(message, **opts)
    if kind == "busy":
        return OortNetworkError(message, **opts, reason="busy")
    if kind == "network":
        return OortNetworkError(
            message, **opts, reason="timeout" if api_code == "timeout" else "unreachable"
        )
    # bad-request; 409s the facade defines (the CLI reads them as bad requests).
    if status == 409 and api_code == "preview_required":
        return OortNeedsConfirmationError(message, **opts, reason="preview-required")
    if status == 409 and api_code == "findings_unacknowledged":
        return OortNeedsConfirmationError(message, **opts, reason="findings-unacknowledged")
    if api_code == "scope_denied":
        return OortRefusedError(message, **opts, reason="scope-denied")
    # CON-132's end-user refusals, with the reasons the client's own checks use.
    usage = _END_USER_USAGE.get(api_code or "")
    if usage is not None:
        return OortUsageError(message, **opts, reason=usage)
    if api_code == "star_with_user":
        return OortRefusedError(message, **opts, reason="star-with-user")
    if status == 409 and api_code == "end_user_erased":
        # Erased while the write ran: nothing was stored, and a retry would make a new end user.
        return OortRefusedError(message, **opts, reason="end-user-erased")
    return OortUsageError(message, **opts, reason="bad-request")


_END_USER_USAGE = {
    "user_missing": "user-missing",
    "self_not_derivable": "self-not-derivable",
    "bad_user": "invalid-argument",
    "user_not_supported": "user-not-supported",
}


def error_shape(e: BaseException) -> Dict[str, Any]:
    """The documented fields of an error, in the shared vectors' camelCase names."""
    out: Dict[str, Any] = {
        "name": type(e).__name__,
        "code": getattr(e, "code", None),
        "reason": getattr(e, "reason", None),
        "fix": getattr(e, "fix", None),
        "status": getattr(e, "status", None),
        "retryable": getattr(e, "retryable", None),
        "retryAfter": getattr(e, "retry_after", None),
        "message": getattr(e, "message", str(e)),
    }
    if isinstance(e, OortNeedsKeyError):
        out["role"] = e.role
        out["envVar"] = e.env_var
    return out
