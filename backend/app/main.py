from contextlib import asynccontextmanager
from datetime import date

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Query, Response
from sqlalchemy import delete, select, update
from sqlalchemy.orm import Session

from . import auth, config, hours, models, scheduling, schemas
from .database import Base, SessionLocal, engine, get_db
from .export import build_month_workbook
from .workdays import ensure_defaults, resolve_days


def init_app() -> None:
    """Idempotent startup work. Called by lifespan (uvicorn) and by wsgi.py (no lifespan there)."""
    Base.metadata.create_all(engine)
    scheduling.migrate(engine)
    with SessionLocal() as db:
        auth.bootstrap_admin(db)
        ensure_defaults(db)
        scheduling.ensure_default_rules(db)


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_app()
    yield


app = FastAPI(title="Erpie - caffe bar staff & hours", lifespan=lifespan)
api = APIRouter(dependencies=[Depends(auth.current_user)])


# ---------------------------------------------------------------- employees
@api.get("/api/employees", response_model=list[schemas.EmployeeOut])
def list_employees(active_only: bool = False, db: Session = Depends(get_db)):
    q = select(models.Employee).order_by(models.Employee.last_name, models.Employee.first_name)
    if active_only:
        q = q.where(models.Employee.active.is_(True))
    return list(db.scalars(q))


@api.post("/api/employees", response_model=schemas.EmployeeOut, status_code=201)
def create_employee(data: schemas.EmployeeIn, db: Session = Depends(get_db)):
    emp = models.Employee(**data.model_dump())
    db.add(emp)
    db.commit()
    return emp


def _get_employee(db: Session, employee_id: int) -> models.Employee:
    emp = db.get(models.Employee, employee_id)
    if not emp:
        raise HTTPException(404, "Employee not found")
    return emp


@api.get("/api/employees/{employee_id}", response_model=schemas.EmployeeOut)
def get_employee(employee_id: int, db: Session = Depends(get_db)):
    return _get_employee(db, employee_id)


@api.put("/api/employees/{employee_id}", response_model=schemas.EmployeeOut)
def update_employee(employee_id: int, data: schemas.EmployeeIn, db: Session = Depends(get_db)):
    emp = _get_employee(db, employee_id)
    for k, v in data.model_dump().items():
        setattr(emp, k, v)
    db.commit()
    return emp


@api.delete("/api/employees/{employee_id}", status_code=204)
def delete_employee(employee_id: int, db: Session = Depends(get_db)):
    db.delete(_get_employee(db, employee_id))
    db.commit()


# ---------------------------------------------------------------- workdays
@api.get("/api/workdays/weekly", response_model=list[schemas.WeekdayHoursIO])
def get_weekly(db: Session = Depends(get_db)):
    return list(db.scalars(select(models.WeekdayHours).order_by(models.WeekdayHours.weekday)))


@api.put("/api/workdays/weekly", response_model=list[schemas.WeekdayHoursIO])
def set_weekly(data: list[schemas.WeekdayHoursIO], db: Session = Depends(get_db)):
    for item in data:
        row = db.get(models.WeekdayHours, item.weekday) or models.WeekdayHours(weekday=item.weekday)
        row.open_time, row.close_time, row.closed = item.open_time, item.close_time, item.closed
        db.add(row)
    db.commit()
    return get_weekly(db)


@api.get("/api/workdays/special", response_model=list[schemas.SpecialDayOut])
def list_special(start: date | None = None, end: date | None = None, db: Session = Depends(get_db)):
    q = select(models.SpecialDay).order_by(models.SpecialDay.date)
    if start:
        q = q.where(models.SpecialDay.date >= start)
    if end:
        q = q.where(models.SpecialDay.date <= end)
    return list(db.scalars(q))


@api.post("/api/workdays/special", response_model=schemas.SpecialDayOut, status_code=201)
def create_special(data: schemas.SpecialDayIn, db: Session = Depends(get_db)):
    if db.scalar(select(models.SpecialDay).where(models.SpecialDay.date == data.date)):
        raise HTTPException(409, "A special day already exists for this date")
    sp = models.SpecialDay(**data.model_dump())
    db.add(sp)
    db.commit()
    return sp


@api.put("/api/workdays/special/{special_id}", response_model=schemas.SpecialDayOut)
def update_special(special_id: int, data: schemas.SpecialDayIn, db: Session = Depends(get_db)):
    sp = db.get(models.SpecialDay, special_id)
    if not sp:
        raise HTTPException(404, "Special day not found")
    clash = db.scalar(select(models.SpecialDay).where(models.SpecialDay.date == data.date,
                                                      models.SpecialDay.id != special_id))
    if clash:
        raise HTTPException(409, "A special day already exists for this date")
    for k, v in data.model_dump().items():
        setattr(sp, k, v)
    db.commit()
    return sp


@api.delete("/api/workdays/special/{special_id}", status_code=204)
def delete_special(special_id: int, db: Session = Depends(get_db)):
    sp = db.get(models.SpecialDay, special_id)
    if not sp:
        raise HTTPException(404, "Special day not found")
    db.delete(sp)
    db.commit()


@api.get("/api/workdays/days", response_model=list[schemas.DayInfo])
def days(start: date, end: date, db: Session = Depends(get_db)):
    if end < start or (end - start).days > 400:
        raise HTTPException(400, "Invalid date range")
    return resolve_days(db, start, end)


# ---------------------------------------------------------------- shifts
def _shift_out(s: models.Shift) -> schemas.ShiftOut:
    out = schemas.ShiftOut.model_validate(s)
    out.hours = hours.shift_hours(s.start_time, s.end_time)
    return out


@api.get("/api/shifts", response_model=list[schemas.ShiftOut])
def list_shifts(start: date, end: date, db: Session = Depends(get_db)):
    q = (select(models.Shift).where(models.Shift.date >= start, models.Shift.date <= end)
         .order_by(models.Shift.date, models.Shift.start_time))
    return [_shift_out(s) for s in db.scalars(q)]


ABSENCE_LABELS = {"vacation": "on vacation (godišnji odmor)", "sick": "on sick leave (bolovanje)",
                  "paid_leave": "on paid leave (plaćeni dopust)", "unpaid_leave": "on unpaid leave (neplaćeni dopust)",
                  "other": "absent"}


def _check_not_absent(db: Session, emp: models.Employee, day: date) -> None:
    absent = scheduling.absence_on(scheduling.absences_by_employee(db, [emp.id], day, day).get(emp.id, []), day)
    if absent:
        raise HTTPException(409, f"{emp.first_name} {emp.last_name} is {ABSENCE_LABELS[absent.kind]} on {day:%d.%m.%Y}.")


@api.post("/api/shifts", response_model=schemas.ShiftOut, status_code=201)
def create_shift(data: schemas.ShiftIn, db: Session = Depends(get_db)):
    _check_not_absent(db, _get_employee(db, data.employee_id), data.date)
    s = models.Shift(**data.model_dump())
    db.add(s)
    db.commit()
    return _shift_out(s)


@api.put("/api/shifts/{shift_id}", response_model=schemas.ShiftOut)
def update_shift(shift_id: int, data: schemas.ShiftIn, db: Session = Depends(get_db)):
    s = db.get(models.Shift, shift_id)
    if not s:
        raise HTTPException(404, "Shift not found")
    _check_not_absent(db, _get_employee(db, data.employee_id), data.date)
    for k, v in data.model_dump().items():
        setattr(s, k, v)
    db.commit()
    return _shift_out(s)


@api.delete("/api/shifts/{shift_id}", status_code=204)
def delete_shift(shift_id: int, db: Session = Depends(get_db)):
    s = db.get(models.Shift, shift_id)
    if not s:
        raise HTTPException(404, "Shift not found")
    db.delete(s)
    db.commit()


# ---------------------------------------------------------------- settings
def read_settings(db: Session) -> schemas.SettingsIO:
    company = db.get(models.Setting, "company_name")
    absence = db.get(models.Setting, "absence_hours")
    try:
        absence_hours = float(absence.value) if absence else 8.0
    except ValueError:
        absence_hours = 8.0
    return schemas.SettingsIO(company_name=company.value if company else "", absence_hours=absence_hours)


@api.get("/api/settings", response_model=schemas.SettingsIO)
def get_settings(db: Session = Depends(get_db)):
    return read_settings(db)


@api.put("/api/settings", response_model=schemas.SettingsIO)
def put_settings(data: schemas.SettingsIO, db: Session = Depends(get_db)):
    for key, value in (("company_name", data.company_name), ("absence_hours", f"{data.absence_hours:g}")):
        row = db.get(models.Setting, key) or models.Setting(key=key)
        row.value = value
        db.add(row)
    db.commit()
    return data


# ---------------------------------------------------------------- schedule rules
def _get_rule(db: Session, rule_id: int | None) -> models.ScheduleRule:
    rule = db.get(models.ScheduleRule, rule_id) if rule_id else scheduling.default_rule(db)
    if not rule:
        raise HTTPException(404, "Schedule rule not found" if rule_id else "No schedule rules defined")
    return rule


def _save_rule(db: Session, rule: models.ScheduleRule, data: schemas.ScheduleRuleIn) -> models.ScheduleRule:
    for k, v in data.model_dump().items():
        setattr(rule, k, v)
    db.add(rule)
    db.flush()
    if data.is_default:
        db.execute(update(models.ScheduleRule).where(models.ScheduleRule.id != rule.id).values(is_default=False))
    elif not db.scalar(select(models.ScheduleRule.id).where(models.ScheduleRule.is_default.is_(True))):
        rule.is_default = True  # there is always exactly one default rule
    db.commit()
    db.refresh(rule)
    return rule


@api.get("/api/rules", response_model=list[schemas.ScheduleRuleOut])
def list_rules(db: Session = Depends(get_db)):
    return list(db.scalars(select(models.ScheduleRule).order_by(models.ScheduleRule.is_default.desc(),
                                                                models.ScheduleRule.name)))


@api.post("/api/rules", response_model=schemas.ScheduleRuleOut, status_code=201)
def create_rule(data: schemas.ScheduleRuleIn, db: Session = Depends(get_db)):
    return _save_rule(db, models.ScheduleRule(), data)


@api.put("/api/rules/{rule_id}", response_model=schemas.ScheduleRuleOut)
def update_rule(rule_id: int, data: schemas.ScheduleRuleIn, db: Session = Depends(get_db)):
    rule = _get_rule(db, rule_id)
    if rule.is_default:
        data.is_default = True  # make another rule the default instead of unsetting this one
    return _save_rule(db, rule, data)


@api.delete("/api/rules/{rule_id}", status_code=204)
def delete_rule(rule_id: int, db: Session = Depends(get_db)):
    rule = _get_rule(db, rule_id)
    was_default = rule.is_default
    db.delete(rule)
    db.commit()
    if was_default and (nxt := scheduling.default_rule(db)):
        nxt.is_default = True
        db.commit()


# ---------------------------------------------------------------- schedule generation
@api.get("/api/schedule/rotations", response_model=list[schemas.RotationOut])
def get_rotations(year: int = Query(ge=2000, le=2100), month: int = Query(ge=1, le=12), rule_id: int | None = None,
                  employee_ids: list[int] | None = Query(default=None), db: Session = Depends(get_db)):
    rule = _get_rule(db, rule_id)
    if not employee_ids:
        employee_ids = list(db.scalars(select(models.Employee.id).where(models.Employee.active.is_(True))
                                       .order_by(models.Employee.last_name, models.Employee.first_name)))
    return scheduling.rotations(db, rule, employee_ids, year, month)


@api.post("/api/schedule/generate", response_model=schemas.GenerateOut)
def generate_schedule(data: schemas.GenerateIn, db: Session = Depends(get_db)):
    rule = _get_rule(db, data.rule_id)
    for a in data.assignments:
        _get_employee(db, a.employee_id)
    return scheduling.generate(db, rule, data)


# ---------------------------------------------------------------- absences
@api.get("/api/absences", response_model=list[schemas.AbsenceOut])
def list_absences(start: date | None = None, end: date | None = None, employee_id: int | None = None,
                  db: Session = Depends(get_db)):
    q = select(models.Absence).order_by(models.Absence.start_date.desc())
    if start:
        q = q.where(models.Absence.end_date >= start)
    if end:
        q = q.where(models.Absence.start_date <= end)
    if employee_id:
        q = q.where(models.Absence.employee_id == employee_id)
    return list(db.scalars(q))


def _save_absence(db: Session, absence: models.Absence, data: schemas.AbsenceIn) -> schemas.AbsenceOut:
    emp = _get_employee(db, data.employee_id)
    clash = db.scalar(select(models.Absence).where(
        models.Absence.employee_id == data.employee_id, models.Absence.id != (absence.id or 0),
        models.Absence.start_date <= data.end_date, models.Absence.end_date >= data.start_date))
    if clash:
        raise HTTPException(409, f"{emp.first_name} {emp.last_name} already has an absence from "
                                 f"{clash.start_date:%d.%m.%Y} to {clash.end_date:%d.%m.%Y}.")
    for k, v in data.model_dump().items():
        setattr(absence, k, v)
    db.add(absence)
    # an absent employee does not work: drop their shifts in that range
    removed = db.execute(delete(models.Shift).where(
        models.Shift.employee_id == data.employee_id,
        models.Shift.date.between(data.start_date, data.end_date))).rowcount or 0
    db.commit()
    out = schemas.AbsenceOut.model_validate(absence)
    out.removed_shifts = removed
    return out


@api.post("/api/absences", response_model=schemas.AbsenceOut, status_code=201)
def create_absence(data: schemas.AbsenceIn, db: Session = Depends(get_db)):
    return _save_absence(db, models.Absence(), data)


@api.put("/api/absences/{absence_id}", response_model=schemas.AbsenceOut)
def update_absence(absence_id: int, data: schemas.AbsenceIn, db: Session = Depends(get_db)):
    absence = db.get(models.Absence, absence_id)
    if not absence:
        raise HTTPException(404, "Absence not found")
    return _save_absence(db, absence, data)


@api.delete("/api/absences/{absence_id}", status_code=204)
def delete_absence(absence_id: int, db: Session = Depends(get_db)):
    absence = db.get(models.Absence, absence_id)
    if not absence:
        raise HTTPException(404, "Absence not found")
    db.delete(absence)
    db.commit()


# ---------------------------------------------------------------- export
@api.get("/api/export/month")
def export_month(year: int = Query(ge=2000, le=2100), month: int = Query(ge=1, le=12),
                 employee_ids: list[int] | None = Query(default=None), db: Session = Depends(get_db)):
    content = build_month_workbook(db, year, month, employee_ids)
    filename = f"sihterica_{year}_{month:02d}.xlsx"
    return Response(
        content,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ---------------------------------------------------------------- app assembly
app.include_router(auth.router)
app.include_router(api)


@app.api_route("/api/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH"], include_in_schema=False)
def api_not_found(path: str):
    raise HTTPException(404, "Not found")
