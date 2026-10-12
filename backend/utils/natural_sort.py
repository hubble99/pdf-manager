"""Natural ordering for file and folder names.

One rule, used for both the sources tree and the initial merge-queue order:

* comparison is case-insensitive, so letter case never decides the order;
* runs of digits compare as numbers, so ``report2.pdf`` precedes
  ``report10.pdf``;
* everything else compares by code point, which is why ``apple.pdf`` precedes
  ``apple2.pdf`` (``.`` sorts before ``2``) and why names that differ only by
  punctuation follow that same ordering.

The comparison walks the names character by character rather than comparing
chunks, so a digit that follows a shared prefix is still considered. Comparing
whole chunks would let ``apple2.pdf`` sort before ``APPLE.pdf``, because the
chunk ``apple`` is a prefix of ``apple.pdf``.
"""
from __future__ import annotations

from functools import cmp_to_key
from typing import Iterable


def _read_digit_run(value: str, start: int) -> tuple[int, int]:
    """Return the numeric value of the digit run at ``start`` and its end index."""
    end = start
    while end < len(value) and value[end].isdigit():
        end += 1
    # Leading zeros do not change the value.
    return int(value[start:end]), end


def compare_names(left: str, right: str) -> int:
    """Compare two names under the natural-order rule."""
    left_position = right_position = 0

    while left_position < len(left) and right_position < len(right):
        left_char = left[left_position]
        right_char = right[right_position]

        if left_char.isdigit() and right_char.isdigit():
            left_value, left_position = _read_digit_run(left, left_position)
            right_value, right_position = _read_digit_run(right, right_position)
            if left_value != right_value:
                return -1 if left_value < right_value else 1
            continue

        left_folded, right_folded = left_char.casefold(), right_char.casefold()
        if left_folded != right_folded:
            return -1 if left_folded < right_folded else 1
        left_position += 1
        right_position += 1

    if left_position == len(left) and right_position == len(right):
        # Same under the rule (for example only leading zeros or letter case
        # differ), so order on the raw text to stay reproducible.
        if left == right:
            return 0
        return -1 if left < right else 1
    return -1 if left_position == len(left) else 1


natural_key = cmp_to_key(compare_names)


def natural_sorted(names: Iterable[str]) -> list[str]:
    """Return the names in natural order."""
    return sorted(names, key=natural_key)
