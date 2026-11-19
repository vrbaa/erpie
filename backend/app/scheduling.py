"""Schedule rules: rotating free days and month schedule generation."""
import calendar
from datetime import date, timedelta

from sqlalchemy import Engine, delete, inspect, select
from sqlalchemy.orm import Session

from . import models, schemas
from .workdays import resolve_days


def migrate(engine: Engine) -> None:
    """Add columns introduced after the first release (create_all does not alter existing tables)."""
    with engine.begin() as conn:
        insp = inspect(conn)
        cols = {c["name"] for c in insp.get_columns("schedule_rules")} if insp.has_table("schedule_rules") else set()
        if cols and "kind" not in cols:
            conn.exec_driver_sql("ALTER TABLE schedule_rules ADD COLUMN kind VARCHAR(20) NOT NULL DEFAULT 'rotation'")
        if cols and "pattern" not in cols:
            conn.exec_driver_sql("ALTER TABLE schedule_rules ADD COLUMN pattern VARCHAR(40)")


ALTERNATING_PATTERN = "1001010,0110101"  # week 1 Mon/Thu/Sat, week 2 Tue/Wed/Fri/Sun


def ensure_default_rules(db: Session) -> None:
    if db.scalar(select(models.ScheduleRule.id).limit(1)) is None:
        db.add(models.ScheduleRule(
            name="2 free days in a row, moving 2 days each week", off_days=2, shift_days=2, stagger=True,
            is_default=False, note="Week 1 Mon+Tue, week 2 Wed+Thu, week 3 Fri+Sat, week 4 Sun+Mon, ..."))
    # added once (also to existing databases) and made the default
    if db.get(models.Setting, "seeded_alternating_rule") is None:
        for r in db.scalars(select(models.ScheduleRule)):
            r.is_default = False
        db.add(models.ScheduleRule(
            name="2 workers alternating, one per day", kind="pattern", pattern=ALTERNATING_PATTERN, stagger=True,
            is_default=True,
            note="Week 1: Mon, Thu, Sat · week 2: Tue, Wed, Fri, Sun. The second worker has the opposite days."))
        db.add(models.Setting(key="seeded_alternating_rule", value="1"))
    db.commit()


def default_rule(db: Session) -> models.ScheduleRule | None:
    rule = db.scalar(select(models.ScheduleRule).where(models.ScheduleRule.is_default.is_(True)))
    return rule or db.scalar(select(models.ScheduleRule).order_by(models.ScheduleRule.id))


def is_off(day: date, anchor: date, rule: models.ScheduleRule, flags: list[bool] | None = None) -> bool:
    flags = flags or rule.work_flags()
    return not flags[(day - anchor).days % len(flags)]


def base_day(month_start: date, rule: models.ScheduleRule) -> date:
    """Rotations are anchored from the 1st; weekly patterns from the Monday of the week containing the 1st."""
    return month_start - timedelta(days=month_start.weekday()) if rule.step == 7 else month_start


def normalize(anchor: date, month_start: date, rule: models.ScheduleRule) -> date:
    """The first cycle start on or after the month's base day that belongs to the same rotation."""
    base = base_day(month_start, rule)
    return base + timedelta(days=(anchor - base).days % rule.cycle)


def month_bounds(year: int, month: int) -> tuple[date, date]:
    return date(year, month, 1), date(year, month, calendar.monthrange(year, month)[1])


def rotations(db: Session, rule: models.ScheduleRule, employee_ids: list[int], year: int, month: int
              ) -> list[schemas.RotationOut]:
    """Stored rotation per employee, or a suggestion that spreads free days apart (when rule.stagger)."""
    first, _ = month_bounds(year, month)
    base = base_day(first, rule)
    flags = rule.work_flags()
    cycle = len(flags)
    stored = {r.employee_id: r.first_off_date for r in db.scalars(select(models.EmployeeRotation).where(
        models.EmployeeRotation.rule_id == rule.id, models.EmployeeRotation.employee_id.in_(employee_ids)))}

    # how many employees are free on each day of the cycle (position 0 = base day)
    load = [0] * cycle

    def free_positions(offset: int):
        return [p for p in range(cycle) if not flags[(p - offset) % cycle]]

    def occupy(offset: int):
        for p in free_positions(offset):
            load[p] += 1

    out: dict[int, schemas.RotationOut] = {}
    for emp_id in employee_ids:
        if emp_id in stored:
            d = normalize(stored[emp_id], first, rule)
            occupy((d - base).days)
            out[emp_id] = schemas.RotationOut(employee_id=emp_id, first_off_date=d, stored=True)
    for emp_id in employee_ids:
        if emp_id in out:
            continue
        k = 0
        if rule.stagger:
            k = min(range(0, cycle, rule.step), key=lambda o: (sum(load[p] for p in free_positions(o)), o))
        occupy(k)
        out[emp_id] = schemas.RotationOut(employee_id=emp_id, first_off_date=base + timedelta(days=k), stored=False)
    return [out[e] for e in employee_ids]


def absences_by_employee(db: Session, employee_ids, start: date, end: date) -> dict[int, list[models.Absence]]:
    q = select(models.Absence).where(models.Absence.start_date <= end, models.Absence.end_date >= start)
    if employee_ids is not None:
        q = q.where(models.Absence.employee_id.in_(employee_ids))
    out: dict[int, list[models.Absence]] = {}
    for a in db.scalars(q):
        out.setdefault(a.employee_id, []).append(a)
    return out


def absence_on(absences: list[models.Absence], day: date) -> models.Absence | None:
    return next((a for a in absences if a.start_date <= day <= a.end_date), None)


def generate(db: Session, rule: models.ScheduleRule, data: schemas.GenerateIn) -> schemas.GenerateOut:
    first, last = month_bounds(data.year, data.month)
    emp_ids = [a.employee_id for a in data.assignments]
    employees = {e.id: e for e in db.scalars(select(models.Employee).where(models.Employee.id.in_(emp_ids)))}

    # remember each employee's rotation so next month continues the same pattern
    existing = {r.employee_id: r for r in db.scalars(select(models.EmployeeRotation).where(
        models.EmployeeRotation.rule_id == rule.id, models.EmployeeRotation.employee_id.in_(emp_ids)))}
    for a in data.assignments:
        if rule.step == 7 and a.first_off_date.weekday() != 0:
            a.first_off_date -= timedelta(days=a.first_off_date.weekday())  # weekly patterns start on Monday
        row = existing.get(a.employee_id) or models.EmployeeRotation(employee_id=a.employee_id, rule_id=rule.id)
        row.first_off_date = a.first_off_date
        db.add(row)

    deleted = 0
    month_shifts = models.Shift.date.between(first, last)
    if data.replace:
        deleted = db.execute(delete(models.Shift).where(
            models.Shift.employee_id.in_(emp_ids), month_shifts)).rowcount or 0
        already: set[tuple[int, date]] = set()
    else:
        already = {(s.employee_id, s.date) for s in db.scalars(select(models.Shift).where(
            models.Shift.employee_id.in_(emp_ids), month_shifts))}

    days = resolve_days(db, first, last)
    absences = absences_by_employee(db, emp_ids, first, last)
    created = skipped_absent = 0
    flags = rule.work_flags()
    for a in data.assignments:
        emp = employees.get(a.employee_id)
        if not emp:
            continue
        for day in days:
            if day.closed or is_off(day.date, a.first_off_date, rule, flags) or (emp.id, day.date) in already:
                continue
            if emp.employment_start and day.date < emp.employment_start:
                continue
            if absence_on(absences.get(emp.id, []), day.date):
                skipped_absent += 1
                continue
            db.add(models.Shift(employee_id=emp.id, date=day.date,
                                start_time=rule.start_time or day.open_time, end_time=rule.end_time or day.close_time))
            created += 1
    db.commit()
    return schemas.GenerateOut(created=created, deleted=deleted, skipped_absent=skipped_absent)
