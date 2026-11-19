"""Fill the 'Evidencija radnog vremena' template: one sheet per employee for one month."""
import calendar
import re
from datetime import date, timedelta
from io import BytesIO
from pathlib import Path

from openpyxl import load_workbook
from sqlalchemy import select
from sqlalchemy.orm import Session

from . import hours, models
from .scheduling import absence_on, absences_by_employee
from .workdays import resolve_days

TEMPLATE = Path(__file__).resolve().parent / "templates" / "sihterica_template.xlsx"

MONTHS_HR = ["siječanj", "veljača", "ožujak", "travanj", "svibanj", "lipanj",
             "srpanj", "kolovoz", "rujan", "listopad", "studeni", "prosinac"]

FIRST_DAY_ROW = 9  # template row of day 1 (day 31 is row 39)
TOTAL_ROW = 40
# template columns
COL_DAY, COL_TOTAL, COL_START, COL_END, COL_NIGHT = "A", "B", "C", "D", "E"
COL_SUNDAY, COL_HOLIDAY_WORK, COL_NOTE = "I", "K", "AD"
COL_VACATION, COL_SICK, COL_SICK_LONG, COL_PAID_LEAVE, COL_UNPAID_LEAVE = "P", "Q", "R", "S", "U"
SICK_SHORT_DAYS = 42  # "Bolovanje do 42 dana" / "od 42 dana"

ABSENCE_COLUMN = {"vacation": COL_VACATION, "sick": COL_SICK, "paid_leave": COL_PAID_LEAVE,
                  "unpaid_leave": COL_UNPAID_LEAVE}
ABSENCE_NOTE = {"vacation": "Godišnji odmor", "sick": "Bolovanje", "paid_leave": "Plaćeni dopust",
                "unpaid_leave": "Neplaćeni dopust", "other": "Odsutan"}


def _sheet_title(name: str, used: set[str]) -> str:
    base = re.sub(r"[\[\]*?/\\:]", "", name).strip()[:31] or "Radnik"
    title, i = base, 2
    while title.lower() in used:
        suffix = f" ({i})"
        title = base[: 31 - len(suffix)] + suffix
        i += 1
    used.add(title.lower())
    return title


def _num(v: float):
    if not v:
        return None
    return int(v) if float(v).is_integer() else round(v, 2)


def build_month_workbook(db: Session, year: int, month: int, employee_ids: list[int] | None) -> bytes:
    days_in_month = calendar.monthrange(year, month)[1]
    first, last = date(year, month, 1), date(year, month, days_in_month)

    # include the day after month end so holiday hours past midnight are detected
    day_info = {d.date: d for d in resolve_days(db, first, last + timedelta(days=1))}

    q = select(models.Employee).order_by(models.Employee.last_name, models.Employee.first_name)
    if employee_ids:
        q = q.where(models.Employee.id.in_(employee_ids))
    employees = list(db.scalars(q))
    if not employee_ids:
        # default: everyone active, plus inactive employees who still have shifts in that month
        with_shifts = set(db.scalars(select(models.Shift.employee_id).where(
            models.Shift.date >= first, models.Shift.date <= last)))
        employees = [e for e in employees if e.active or e.id in with_shifts]

    shifts = list(db.scalars(select(models.Shift).where(
        models.Shift.date >= first, models.Shift.date <= last).order_by(models.Shift.date, models.Shift.start_time)))
    company = db.get(models.Setting, "company_name")
    company_name = company.value if company else ""
    absence_setting = db.get(models.Setting, "absence_hours")
    try:
        absence_hours = float(absence_setting.value) if absence_setting else 8.0
    except ValueError:
        absence_hours = 8.0
    absences = absences_by_employee(db, None, first, last)

    def is_holiday(d: date) -> bool:
        return bool(day_info.get(d) and day_info[d].is_holiday)

    def is_sunday(d: date) -> bool:
        return d.weekday() == 6

    wb = load_workbook(TEMPLATE)
    tpl = wb.worksheets[0]
    used: set[str] = {ws.title.lower() for ws in wb.worksheets}

    for idx, emp in enumerate(employees or [None]):
        ws = wb.copy_worksheet(tpl)
        ws.freeze_panes = tpl.freeze_panes
        # print each timesheet on a single landscape page
        ws.page_setup.orientation = "landscape"
        ws.sheet_properties.pageSetUpPr.fitToPage = True
        ws.page_setup.fitToWidth = 1
        ws.page_setup.fitToHeight = 1
        # move the copy (appended at the end) to position idx
        wb.move_sheet(ws, offset=idx - (len(wb.worksheets) - 1))

        name = f"{emp.first_name} {emp.last_name}" if emp else ""
        ws.title = _sheet_title(name or "Prazno", used)
        ws["F3"] = name
        ws["F4"] = f"{MONTHS_HR[month - 1]} {year}."
        if company_name:
            ws["T2"] = company_name

        emp_shifts: dict[date, list[models.Shift]] = {}
        if emp:
            for s in shifts:
                if s.employee_id == emp.id:
                    emp_shifts.setdefault(s.date, []).append(s)

        for day in range(1, 32):
            row = FIRST_DAY_ROW + day - 1
            if day > days_in_month:
                ws[f"{COL_DAY}{row}"] = None
                continue
            d = date(year, month, day)
            absent = absence_on(absences.get(emp.id, []), d) if emp else None
            if absent:
                # absence hours count on days the bar is open and that are not public holidays
                info = day_info.get(d)
                col = ABSENCE_COLUMN.get(absent.kind)
                if col == COL_SICK and (d - absent.start_date).days >= SICK_SHORT_DAYS:
                    col = COL_SICK_LONG
                if col and info and not info.closed and not info.is_holiday:
                    ws[f"{col}{row}"] = _num(absence_hours)
                ws[f"{COL_NOTE}{row}"] = "; ".join(filter(None, [ABSENCE_NOTE[absent.kind], absent.note]))
            day_shifts = emp_shifts.get(d, [])
            if not day_shifts:
                continue
            intervals = [hours.shift_interval(s.start_time, s.end_time) for s in day_shifts]
            first_i = min(range(len(day_shifts)), key=lambda i: intervals[i][0])
            last_i = max(range(len(day_shifts)), key=lambda i: intervals[i][1])

            total = sum(hours.shift_hours(s.start_time, s.end_time) for s in day_shifts)
            night = sum(hours.night_hours(s.start_time, s.end_time) for s in day_shifts)
            sunday = sum(hours.hours_on_matching_days(s.start_time, s.end_time, d, is_sunday) for s in day_shifts)
            holiday = sum(hours.hours_on_matching_days(s.start_time, s.end_time, d, is_holiday) for s in day_shifts)

            ws[f"{COL_TOTAL}{row}"] = _num(total)
            ws[f"{COL_START}{row}"] = day_shifts[first_i].start_time
            ws[f"{COL_END}{row}"] = day_shifts[last_i].end_time
            ws[f"{COL_NIGHT}{row}"] = _num(night)
            ws[f"{COL_SUNDAY}{row}"] = _num(sunday)
            ws[f"{COL_HOLIDAY_WORK}{row}"] = _num(holiday)

            notes = [s.note for s in day_shifts if s.note]
            if len(day_shifts) > 1:  # split shift: list all intervals
                notes.insert(0, ", ".join(f"{s.start_time}-{s.end_time}" for s in day_shifts))
            if notes:
                ws[f"{COL_NOTE}{row}"] = "; ".join(notes)

        last_row = FIRST_DAY_ROW + 30
        for col in (COL_TOTAL, COL_SUNDAY, COL_VACATION, COL_SICK, COL_SICK_LONG, COL_PAID_LEAVE, COL_UNPAID_LEAVE):
            ws[f"{col}{TOTAL_ROW}"] = f"=SUM({col}{FIRST_DAY_ROW}:{col}{last_row})"

    wb.remove(tpl)
    wb.active = 0
    for ws in wb.worksheets:
        ws.sheet_view.tabSelected = ws is wb.worksheets[0]

    buf = BytesIO()
    wb.save(buf)
    return buf.getvalue()
