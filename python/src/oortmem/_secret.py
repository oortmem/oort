"""``_Secret``: a key or token held in memory only; ``repr`` and ``str`` print ``***``."""

from __future__ import annotations

__all__ = ["_Secret"]


class _Secret:
    """Holds a secret so that printing, logging or ``repr`` of a client never shows it. The value
    is read only where a request header is built (``reveal``)."""

    __slots__ = ("_value",)

    def __init__(self, value: str) -> None:
        if not isinstance(value, str) or value == "":
            raise ValueError("a secret must be a non-empty string")
        object.__setattr__(self, "_value", value)

    def reveal(self) -> str:
        return self._value

    def __setattr__(self, name: str, value: object) -> None:
        raise AttributeError("_Secret is immutable")

    def __repr__(self) -> str:
        return "'***'"

    __str__ = __repr__

    def __format__(self, spec: str) -> str:
        return "***"

    def __reduce__(self):  # never pickled, so never written anywhere by accident
        raise TypeError("_Secret cannot be pickled")

    def __eq__(self, other: object) -> bool:
        return isinstance(other, _Secret) and other._value == self._value

    def __hash__(self) -> int:
        return hash(("_Secret", len(self._value)))
