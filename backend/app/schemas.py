from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

TIME_PATTERN = r"^([01]\d|2[0-3]):[0-5]\d$"


class EmployeeBase(BaseModel):
    first_name: str = Field(min_length=1, max_length=100)
    last_name: str = Field(min_length=1, max_length=100)
    oib: str | None = Field(default=None, pattern=r"^(\d{11})?$")
    position: str | None = None
    phone: str | None = None
    email: str | None = None
    employment_start: date | None = None
    color: str = Field(default="#4f7cac", pattern=r"^#[0-9a-fA-F]{6}$")
    active: bool = True
    notes: str | None = None


class EmployeeIn(EmployeeBase):
    pass


class EmployeeOut(EmployeeBase):
    model_config = ConfigDict(from_attributes=True)
    id: int


class WeekdayHoursIO(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    weekday: int = Field(ge=0, le=6)
    open_time: str = Field(pattern=TIME_PATTERN)
    close_time: str = Field(pattern=TIME_PATTERN)
    closed: bool = False


class SpecialDayIn(BaseModel):
    date: date
    open_time: str = Field(pattern=TIME_PATTERN)
    close_time: str = Field(pattern=TIME_PATTERN)
    closed: bool = False
    is_holiday: bool = False
    note: str | None = None


class SpecialDayOut(SpecialDayIn):
    model_config = ConfigDict(from_attributes=True)
    id: int


class DayInfo(BaseModel):
    """Resolved working hours for one date."""

    date: date
    open_time: str
    close_time: str
    closed: bool
    is_holiday: bool
    special: bool
    note: str | None = None


class ShiftIn(BaseModel):
    employee_id: int
    date: date
    start_time: str = Field(pattern=TIME_PATTERN)
    end_time: str = Field(pattern=TIME_PATTERN)
    note: str | None = None


class ShiftOut(ShiftIn):
    model_config = ConfigDict(from_attributes=True)
    id: int
    hours: float = 0


class SettingsIO(BaseModel):
    company_name: str = ""
    absence_hours: float = Field(default=8, ge=0, le=24)  # hours per absence day written to the timesheet


# ---------------------------------------------------------------- schedule rules
class ScheduleRuleIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    kind: Literal["rotation", "pattern"] = "rotation"
    # "pattern" kind: 1-4 weeks of 7 flags (Mon..Sun, 1 = works), separated by commas
    pattern: str | None = Field(default=None, pattern=r"^[01]{7}(,[01]{7}){0,3}$")
    off_days: int = Field(default=2, ge=1, le=6)
    shift_days: int = Field(default=2, ge=0, le=6)
    stagger: bool = True
    start_time: str | None = Field(default=None, pattern=TIME_PATTERN)
    end_time: str | None = Field(default=None, pattern=TIME_PATTERN)
    is_default: bool = False
    note: str | None = None

    @model_validator(mode="after")
    def _times_together(self):
        if (self.start_time is None) != (self.end_time is None):
            raise ValueError("Set both start and end time, or neither (to use each day's working hours)")
        if self.kind == "pattern":
            if not self.pattern or "1" not in self.pattern:
                raise ValueError("A weekly pattern needs at least one work day")
        else:
            self.pattern = None
        return self


class ScheduleRuleOut(ScheduleRuleIn):
    model_config = ConfigDict(from_attributes=True)
    id: int


class RotationOut(BaseModel):
    employee_id: int
    first_off_date: date  # where the employee's cycle starts: first cycle start on/after the month's base day
    stored: bool  # False = suggested, not saved yet


class Assignment(BaseModel):
    employee_id: int
    first_off_date: date


class GenerateIn(BaseModel):
    year: int = Field(ge=2000, le=2100)
    month: int = Field(ge=1, le=12)
    rule_id: int | None = None  # None = default rule
    assignments: list[Assignment] = Field(min_length=1)
    replace: bool = True  # delete the employees' existing shifts in that month first


class GenerateOut(BaseModel):
    created: int
    deleted: int
    skipped_absent: int


# ---------------------------------------------------------------- absences
AbsenceKind = Literal["vacation", "sick", "paid_leave", "unpaid_leave", "other"]


class AbsenceIn(BaseModel):
    employee_id: int
    kind: AbsenceKind
    start_date: date
    end_date: date
    note: str | None = None

    @model_validator(mode="after")
    def _range(self):
        if self.end_date < self.start_date:
            raise ValueError("End date is before start date")
        if (self.end_date - self.start_date).days > 366:
            raise ValueError("An absence can be at most one year long")
        return self


class AbsenceOut(AbsenceIn):
    model_config = ConfigDict(from_attributes=True)
    id: int
    removed_shifts: int = 0


# ---------------------------------------------------------------- auth / users
class LoginIn(BaseModel):
    email: str
    password: str


class GoogleLoginIn(BaseModel):
    credential: str


class PasswordChangeIn(BaseModel):
    current_password: str | None = None
    new_password: str = Field(min_length=8, max_length=200)


class AuthConfigOut(BaseModel):
    google_client_id: str | None


class UserOut(BaseModel):
    id: int
    email: str
    name: str
    role: Literal["admin", "user"]
    active: bool
    has_password: bool
    has_google: bool
    last_login_at: datetime | None


class UserCreate(BaseModel):
    email: str = Field(pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$", max_length=200)
    name: str = Field(min_length=1, max_length=100)
    role: Literal["admin", "user"] = "user"
    password: str | None = Field(default=None, min_length=8, max_length=200)


class UserUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    role: Literal["admin", "user"]
    active: bool
    password: str | None = Field(default=None, min_length=8, max_length=200)
