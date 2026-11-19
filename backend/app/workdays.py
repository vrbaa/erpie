from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import models, schemas

DEFAULT_OPEN, DEFAULT_CLOSE = "13:00", "23:00"


def ensure_defaults(db: Session) -> None:
    existing = {w.weekday for w in db.scalars(select(models.WeekdayHours))}
    for wd in range(7):
        if wd not in existing:
            db.add(models.WeekdayHours(weekday=wd, open_time=DEFAULT_OPEN, close_time=DEFAULT_CLOSE, closed=False))
    if db.get(models.Setting, "company_name") is None:
        db.add(models.Setting(key="company_name", value=""))
    db.commit()


def resolve_days(db: Session, start: date, end: date) -> list[schemas.DayInfo]:
    """Working hours for every date in [start, end]: special day override, else the weekday default."""
    weekly = {w.weekday: w for w in db.scalars(select(models.WeekdayHours))}
    specials = {
        s.date: s
        for s in db.scalars(
            select(models.SpecialDay).where(models.SpecialDay.date >= start, models.SpecialDay.date <= end)
        )
    }
    out = []
    d = start
    while d <= end:
        sp = specials.get(d)
        if sp:
            out.append(schemas.DayInfo(date=d, open_time=sp.open_time, close_time=sp.close_time, closed=sp.closed,
                                       is_holiday=sp.is_holiday, special=True, note=sp.note))
        else:
            w = weekly.get(d.weekday())
            out.append(schemas.DayInfo(date=d, open_time=w.open_time if w else DEFAULT_OPEN,
                                       close_time=w.close_time if w else DEFAULT_CLOSE,
                                       closed=w.closed if w else False, is_holiday=False, special=False))
        d += timedelta(days=1)
    return out
