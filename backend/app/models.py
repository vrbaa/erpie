from datetime import date, datetime

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


class Employee(Base):
    __tablename__ = "employees"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    first_name: Mapped[str] = mapped_column(String(100))
    last_name: Mapped[str] = mapped_column(String(100))
    oib: Mapped[str | None] = mapped_column(String(11), nullable=True)
    position: Mapped[str | None] = mapped_column(String(100), nullable=True)
    phone: Mapped[str | None] = mapped_column(String(50), nullable=True)
    email: Mapped[str | None] = mapped_column(String(200), nullable=True)
    employment_start: Mapped[date | None] = mapped_column(Date, nullable=True)
    color: Mapped[str] = mapped_column(String(7), default="#4f7cac")
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    shifts: Mapped[list["Shift"]] = relationship(back_populates="employee", cascade="all, delete-orphan")
    absences: Mapped[list["Absence"]] = relationship(cascade="all, delete-orphan")
    rotations: Mapped[list["EmployeeRotation"]] = relationship(cascade="all, delete-orphan")


class WeekdayHours(Base):
    """Default opening hours per weekday (0 = Monday ... 6 = Sunday)."""

    __tablename__ = "weekday_hours"

    weekday: Mapped[int] = mapped_column(Integer, primary_key=True)
    open_time: Mapped[str] = mapped_column(String(5), default="13:00")
    close_time: Mapped[str] = mapped_column(String(5), default="23:00")
    closed: Mapped[bool] = mapped_column(Boolean, default=False)


class SpecialDay(Base):
    """Override of the default hours for one date (special occasion, holiday, closed day)."""

    __tablename__ = "special_days"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    date: Mapped[date] = mapped_column(Date, unique=True, index=True)
    open_time: Mapped[str] = mapped_column(String(5), default="13:00")
    close_time: Mapped[str] = mapped_column(String(5), default="23:00")
    closed: Mapped[bool] = mapped_column(Boolean, default=False)
    is_holiday: Mapped[bool] = mapped_column(Boolean, default=False)
    note: Mapped[str | None] = mapped_column(String(200), nullable=True)


class Shift(Base):
    __tablename__ = "shifts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id", ondelete="CASCADE"), index=True)
    date: Mapped[date] = mapped_column(Date, index=True)
    start_time: Mapped[str] = mapped_column(String(5))
    end_time: Mapped[str] = mapped_column(String(5))  # end <= start means it ends after midnight
    note: Mapped[str | None] = mapped_column(String(200), nullable=True)

    employee: Mapped[Employee] = relationship(back_populates="shifts")


class Setting(Base):
    __tablename__ = "settings"

    key: Mapped[str] = mapped_column(String(50), primary_key=True)
    value: Mapped[str] = mapped_column(String(500), default="")


class ScheduleRule(Base):
    """Rule for generating a month schedule. Two kinds:

    ``rotation``: ``off_days`` free days in a row; each week the free block moves ``shift_days`` days later.
    A repeating cycle of ``7 + shift_days`` days: work ``7 + shift_days - off_days``, then ``off_days`` free.
    Example off_days=2, shift_days=2: week 1 Mon+Tue, week 2 Wed+Thu, week 3 Fri+Sat, week 4 Sun+Mon, ...

    ``pattern``: fixed work days per week over a cycle of 1-4 weeks, e.g. "1001010,0110101" =
    week 1 Mon/Thu/Sat, week 2 Tue/Wed/Fri/Sun. Employees start in different weeks of the cycle, so with
    two employees one works week 1 while the other works week 2 (the opposite days).

    Either way the rule is a list of work/free flags (one per day of the cycle) and each employee has an
    anchor date where their cycle starts (any day for rotations, a Monday for patterns).
    """

    __tablename__ = "schedule_rules"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    kind: Mapped[str] = mapped_column(String(20), default="rotation")
    pattern: Mapped[str | None] = mapped_column(String(40), nullable=True)  # weeks of 7 x "0"/"1", Mon first
    off_days: Mapped[int] = mapped_column(Integer, default=2)
    shift_days: Mapped[int] = mapped_column(Integer, default=2)
    stagger: Mapped[bool] = mapped_column(Boolean, default=True)  # spread employees' free days apart
    start_time: Mapped[str | None] = mapped_column(String(5), nullable=True)  # None = use the day's hours
    end_time: Mapped[str | None] = mapped_column(String(5), nullable=True)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
    note: Mapped[str | None] = mapped_column(String(300), nullable=True)

    rotations: Mapped[list["EmployeeRotation"]] = relationship(cascade="all, delete-orphan")

    def work_flags(self) -> list[bool]:
        """One flag per day of the cycle, starting at the anchor: True = works."""
        if self.kind == "pattern" and self.pattern:
            return [c == "1" for c in self.pattern.replace(",", "")]
        cycle = 7 + self.shift_days
        return [i >= self.off_days for i in range(cycle)]

    @property
    def cycle(self) -> int:
        return len(self.work_flags())

    @property
    def step(self) -> int:
        """Anchors of a weekly pattern must be Mondays; rotations can start on any day."""
        return 7 if self.kind == "pattern" else 1


class EmployeeRotation(Base):
    """Where an employee is in a rule's cycle: any date on which one of their free blocks starts."""

    __tablename__ = "employee_rotations"
    __table_args__ = (UniqueConstraint("employee_id", "rule_id"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id", ondelete="CASCADE"), index=True)
    rule_id: Mapped[int] = mapped_column(ForeignKey("schedule_rules.id", ondelete="CASCADE"), index=True)
    first_off_date: Mapped[date] = mapped_column(Date)


ABSENCE_KINDS = ("vacation", "sick", "paid_leave", "unpaid_leave", "other")


class Absence(Base):
    """Employee absence over a date range (inclusive): sick leave, vacation (godišnji odmor), ..."""

    __tablename__ = "absences"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(20))
    start_date: Mapped[date] = mapped_column(Date, index=True)
    end_date: Mapped[date] = mapped_column(Date, index=True)
    note: Mapped[str | None] = mapped_column(String(200), nullable=True)


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    email: Mapped[str] = mapped_column(String(200), unique=True)  # stored lowercase
    name: Mapped[str] = mapped_column(String(100))
    password_hash: Mapped[str | None] = mapped_column(String(255), nullable=True)
    google_sub: Mapped[str | None] = mapped_column(String(100), unique=True, nullable=True)
    role: Mapped[str] = mapped_column(String(10), default="user")  # admin | user
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class Session(Base):
    __tablename__ = "sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)  # sha256 hex of the cookie token
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime)
