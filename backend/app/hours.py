"""Time / hour calculations shared by the API and the Excel export."""
from datetime import date, timedelta

NIGHT_START = 22 * 60  # night work in Croatia: 22:00 - 06:00
NIGHT_END = 6 * 60


def to_minutes(hhmm: str) -> int:
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def shift_interval(start: str, end: str) -> tuple[int, int]:
    """Minutes from midnight of the shift date. End <= start means the shift runs past midnight."""
    s, e = to_minutes(start), to_minutes(end)
    if e <= s:
        e += 24 * 60
    return s, e


def _overlap(a: tuple[int, int], b: tuple[int, int]) -> int:
    return max(0, min(a[1], b[1]) - max(a[0], b[0]))


def shift_hours(start: str, end: str) -> float:
    s, e = shift_interval(start, end)
    return round((e - s) / 60, 2)


def night_hours(start: str, end: str) -> float:
    iv = shift_interval(start, end)
    windows = [(0, NIGHT_END), (NIGHT_START, 24 * 60 + NIGHT_END), (24 * 60 + NIGHT_START, 48 * 60)]
    return round(sum(_overlap(iv, w) for w in windows) / 60, 2)


def hours_on_matching_days(start: str, end: str, shift_date: date, predicate) -> float:
    """Hours of the shift that fall on calendar days for which predicate(day) is True."""
    iv = shift_interval(start, end)
    total = 0
    for offset in (0, 1):
        day = shift_date + timedelta(days=offset)
        if predicate(day):
            total += _overlap(iv, (offset * 1440, (offset + 1) * 1440))
    return round(total / 60, 2)
