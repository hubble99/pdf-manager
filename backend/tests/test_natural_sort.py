"""Natural ordering rule for the sources tree and the initial queue order."""
from utils.natural_sort import natural_key, natural_sorted


def test_digit_runs_compare_as_numbers():
    assert natural_sorted(["report10.pdf", "report2.pdf"]) == ["report2.pdf", "report10.pdf"]
    assert natural_sorted(["page100.pdf", "page20.pdf", "page3.pdf"]) == [
        "page3.pdf", "page20.pdf", "page100.pdf",
    ]


def test_case_does_not_decide_the_order():
    # Under a plain sort the upper-case name would come first because of its code
    # point; the rule ignores case for ordering.
    assert natural_sorted(["banana.pdf", "Apple.pdf"]) == ["Apple.pdf", "banana.pdf"]
    assert natural_sorted(["REPORT10.pdf", "report2.pdf"]) == ["report2.pdf", "REPORT10.pdf"]
    assert natural_sorted(["APPLE.pdf", "apple2.pdf"]) == ["APPLE.pdf", "apple2.pdf"]


def test_names_equal_apart_from_case_still_order_deterministically():
    once = natural_sorted(["a.pdf", "A.pdf"])
    again = natural_sorted(["A.pdf", "a.pdf"])
    assert once == again
    assert len(once) == 2


def test_leading_zeros_do_not_change_the_numeric_order():
    assert natural_sorted(["file010.pdf", "file9.pdf"]) == ["file9.pdf", "file010.pdf"]
    # Equal values fall back to the shorter run, then to the name, so the result
    # is reproducible rather than dependent on input order.
    assert natural_sorted(["file02.pdf", "file2.pdf"]) == natural_sorted(["file2.pdf", "file02.pdf"])


def test_names_without_digits_order_case_insensitively():
    assert natural_sorted(["zebra.pdf", "Alpha.pdf", "beta.pdf"]) == [
        "Alpha.pdf", "beta.pdf", "zebra.pdf",
    ]


def test_a_shared_prefix_is_settled_by_the_next_character():
    # "-" sorts before "." by code point, and both sort before a digit would.
    assert natural_sorted(["report.pdf", "report-extra.pdf"]) == ["report-extra.pdf", "report.pdf"]
    assert natural_sorted(["apple2.pdf", "apple.pdf"]) == ["apple.pdf", "apple2.pdf"]


def test_key_is_total_and_handles_the_empty_string():
    assert natural_key("") < natural_key("a.pdf")
    assert natural_sorted([]) == []


def test_digits_and_letters_at_the_same_position_order_deterministically():
    assert natural_sorted(["2notes.pdf", "notes2.pdf"]) == natural_sorted(["notes2.pdf", "2notes.pdf"])
