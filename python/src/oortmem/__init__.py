"""Oort: open-source memory for AI agents.

``from oortmem import Oort`` (Python 3.10 or newer) gives the native client; the ``oort``
console script (any Python 3.9+) launches the Node CLI. The client loads lazily, so the launcher
never imports it.

>>> from oortmem import Oort, format_for_prompt
>>> with Oort() as oort:
...     r = oort.recall("how do we deploy?")
...     prompt = format_for_prompt(r)
...     oort.observe(user="We deploy on Fridays now.", assistant="Noted.")
"""

__version__ = "0.7.0"

import sys as _sys

_CLIENT = {
    "Oort": "_client",
    "AsyncOort": "_client",
    "OortJudge": "_client",
    "AsyncOortJudge": "_client",
    "OortEndUsers": "_client",
    "AsyncOortEndUsers": "_client",
    "format_for_prompt": "_format",
}
_ERRORS = (
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
)

__all__ = ["__version__", *_CLIENT, *_ERRORS, "types", "errors"]


def __getattr__(name):
    if name in _CLIENT or name == "types":
        if _sys.version_info < (3, 10):
            raise ImportError(f"oortmem.{name} needs Python 3.10 or newer (this is {_sys.version.split()[0]})")
        import importlib

        if name == "types":
            return importlib.import_module(".types", __name__)
        return getattr(importlib.import_module(f".{_CLIENT[name]}", __name__), name)
    if name in _ERRORS or name == "errors":
        import importlib

        mod = importlib.import_module(".errors", __name__)
        return mod if name == "errors" else getattr(mod, name)
    raise AttributeError(f"module 'oortmem' has no attribute {name!r}")


def __dir__():
    return sorted(set(globals()) | set(__all__))
