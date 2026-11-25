"""Printable PDF of the schedule shown on screen: one month (calendar grid) or one week (employees x days)."""
import calendar
from datetime import date, timedelta
from pathlib import Path

from fpdf import FPDF
from fpdf.fonts import FontFace
from sqlalchemy import select
from sqlalchemy.orm import Session

from . import hours, models
from .scheduling import absence_on, absences_by_employee
from .workdays import resolve_days

FONTS = Path(__file__).resolve().parent / "fonts"  # Unicode font: names contain č, ć, ž, š, đ

WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
ABSENCE_SHORT = {"vacation": "Godišnji", "sick": "Bolovanje", "paid_leave": "Plaćeni dopust",
                 "unpaid_leave": "Neplaćeni", "other": "Odsutan"}

HEAD = FontFace(emphasis="BOLD", fill_color=(241, 243, 245))
CLOSED = FontFace(fill_color=(236, 238, 241))
HOLIDAY = FontFace(fill_color=(253, 232, 232))


def _day_hours(info) -> str:
    return "Closed" if info.closed else f"{info.open_time}–{info.close_time}"


def _day_style(info):
    return HOLIDAY if info.is_holiday else CLOSED if info.closed else None


def build_schedule_pdf(db: Session, view: str, day: date) -> bytes:
    if view == "week":
        first = day - timedelta(days=day.weekday())
        last = first + timedelta(days=6)
        title = f"Schedule {first:%d.%m.} – {last:%d.%m.%Y}"
    else:
        first = day.replace(day=1)
        last = day.replace(day=calendar.monthrange(day.year, day.month)[1])
        title = f"Schedule {calendar.month_name[day.month]} {day.year}"

    info = {d.date: d for d in resolve_days(db, first, last)}
    shifts = list(db.scalars(select(models.Shift).where(
        models.Shift.date >= first, models.Shift.date <= last).order_by(models.Shift.date, models.Shift.start_time)))
    absences = absences_by_employee(db, None, first, last)
    with_shifts = {s.employee_id for s in shifts}
    employees = [e for e in db.scalars(select(models.Employee).order_by(
        models.Employee.last_name, models.Employee.first_name)) if e.active or e.id in with_shifts]
    company = db.get(models.Setting, "company_name")

    def times(emp_id: int, d: date) -> list[str]:
        return [f"{s.start_time}–{s.end_time}" for s in shifts if s.employee_id == emp_id and s.date == d]

    def absence_label(emp_id: int, d: date) -> str | None:
        a = absence_on(absences.get(emp_id, []), d)
        return ABSENCE_SHORT.get(a.kind, a.kind) if a else None

    pdf = FPDF(orientation="landscape", format="A4")
    pdf.set_margin(8)
    pdf.set_auto_page_break(True, margin=8)
    pdf.add_font("DejaVu", "", FONTS / "DejaVuSans.ttf")
    pdf.add_font("DejaVu", "B", FONTS / "DejaVuSans-Bold.ttf")
    pdf.add_page()
    pdf.set_font("DejaVu", "B", 14)
    heading = f"{company.value} · {title}" if company and company.value else title
    pdf.multi_cell(0, 8, heading, new_x="LMARGIN", new_y="NEXT")
    pdf.ln(2)
    pdf.set_font("DejaVu", "", 8 if view == "week" else 7)

    if view == "week":
        days = [first + timedelta(days=i) for i in range(7)]
        with pdf.table(col_widths=(2.2, *[1.3] * 7, 0.8), line_height=4.5, text_align="LEFT",
                       headings_style=HEAD) as table:
            head = table.row()
            head.cell("Employee")
            for d in days:
                head.cell(f"{WEEKDAYS[d.weekday()]} {d.day}.{d.month}.\n{_day_hours(info[d])}")
            head.cell("Hours")
            for e in employees:
                row = table.row()
                row.cell(f"{e.first_name} {e.last_name}")
                for d in days:
                    label = absence_label(e.id, d)
                    text = "\n".join(([label] if label else []) + times(e.id, d))
                    row.cell(text, style=_day_style(info[d]))
                total = sum(hours.shift_hours(s.start_time, s.end_time) for s in shifts if s.employee_id == e.id)
                row.cell(f"{round(total, 2):g} h")
    else:
        names = {e.id: f"{e.first_name} {e.last_name[:1]}." for e in employees}
        with pdf.table(col_widths=(1,) * 7, line_height=3.4, text_align="LEFT", v_align="TOP",
                       headings_style=HEAD) as table:
            head = table.row()
            for name in WEEKDAYS:
                head.cell(name)
            for week in calendar.Calendar().monthdatescalendar(first.year, first.month):
                row = table.row()
                for d in week:
                    if d.month != first.month:
                        row.cell("")
                        continue
                    lines = [f"{d.day}.  {_day_hours(info[d])}"]
                    if info[d].note:
                        lines.append(info[d].note)
                    for e in employees:
                        lines += [f"{names[e.id]} {t}" for t in times(e.id, d)]
                        label = absence_label(e.id, d)
                        if label:
                            lines.append(f"{names[e.id]} {label}")
                    # keep rows an even height even when a day is empty
                    lines += [""] * (4 - len(lines))
                    row.cell("\n".join(lines), style=_day_style(info[d]))

        pdf.ln(3)
        totals = []
        for e in employees:
            total = sum(hours.shift_hours(s.start_time, s.end_time) for s in shifts if s.employee_id == e.id)
            totals.append(f"{e.first_name} {e.last_name}: {round(total, 2):g} h")
        pdf.multi_cell(0, 4.5, "Hours:  " + "    ".join(totals), new_x="LMARGIN", new_y="NEXT")

    return bytes(pdf.output())
