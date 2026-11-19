from io import BytesIO

import pytest
from fastapi.testclient import TestClient
from openpyxl import load_workbook
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import config, database, hours
from app.main import app


@pytest.fixture()
def client(monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    TestSession = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    monkeypatch.setattr("app.main.engine", engine)
    monkeypatch.setattr("app.main.SessionLocal", TestSession)

    def override():
        db = TestSession()
        try:
            yield db
        finally:
            db.close()

    monkeypatch.setattr(config, "ADMIN_EMAIL", "admin@example.com")
    monkeypatch.setattr(config, "ADMIN_PASSWORD", "test-password")
    app.dependency_overrides[database.get_db] = override
    with TestClient(app) as c:
        r = c.post("/api/auth/login", json={"email": "admin@example.com", "password": "test-password"})
        assert r.status_code == 200
        yield c
    app.dependency_overrides.clear()


def test_hours():
    assert hours.shift_hours("13:00", "23:00") == 10
    assert hours.shift_hours("10:00", "00:00") == 14
    assert hours.night_hours("13:00", "23:00") == 1
    assert hours.night_hours("18:00", "02:00") == 4
    assert hours.night_hours("05:00", "07:00") == 1


def test_flow_and_export(client):
    emp = client.post("/api/employees", json={"first_name": "Ana", "last_name": "Horvat"}).json()
    weekly = client.get("/api/workdays/weekly").json()
    assert len(weekly) == 7 and weekly[0]["open_time"] == "13:00"

    sp = client.post("/api/workdays/special", json={
        "date": "2026-11-01", "open_time": "10:00", "close_time": "00:00", "is_holiday": True, "note": "Svi sveti"})
    assert sp.status_code == 201
    days = client.get("/api/workdays/days", params={"start": "2026-11-01", "end": "2026-11-02"}).json()
    assert days[0]["open_time"] == "10:00" and days[0]["special"]
    assert days[1]["open_time"] == "13:00" and not days[1]["special"]

    # Sunday + holiday, past midnight
    s = client.post("/api/shifts", json={"employee_id": emp["id"], "date": "2026-11-01",
                                         "start_time": "10:00", "end_time": "00:00"}).json()
    assert s["hours"] == 14
    client.post("/api/shifts", json={"employee_id": emp["id"], "date": "2026-11-03",
                                     "start_time": "13:00", "end_time": "23:00", "note": "test"})

    r = client.get("/api/export/month", params={"year": 2026, "month": 11})
    assert r.status_code == 200
    wb = load_workbook(BytesIO(r.content))
    ws = wb.worksheets[0]
    assert ws.title == "Ana Horvat"
    assert ws["F3"].value == "Ana Horvat"
    assert ws["B9"].value == 14 and ws["C9"].value == "10:00" and ws["D9"].value == "00:00"
    assert ws["E9"].value == 2  # 22-24
    assert ws["I9"].value == 14 and ws["K9"].value == 14
    assert ws["B11"].value == 10 and ws["AD11"].value == "test"
    assert ws["A39"].value is None  # November has 30 days
    assert "Evidencija radnog vremena" not in wb.sheetnames


def _emp(client, first, last="Test"):
    return client.post("/api/employees", json={"first_name": first, "last_name": last}).json()


def test_default_rule_and_rotation_pattern(client):
    rules = client.get("/api/rules").json()
    assert len(rules) == 2 and rules[0]["is_default"] and rules[0]["kind"] == "pattern"
    rot = next(r for r in rules if r["kind"] == "rotation")
    assert rot["off_days"] == 2 and rot["shift_days"] == 2 and not rot["is_default"]

    ana = _emp(client, "Ana")
    # 2026-06-01 is a Monday: free Mon+Tue in week 1
    r = client.post("/api/schedule/generate", json={
        "year": 2026, "month": 6, "rule_id": rot["id"],
        "assignments": [{"employee_id": ana["id"], "first_off_date": "2026-06-01"}]})
    assert r.status_code == 200, r.text
    shifts = client.get("/api/shifts", params={"start": "2026-06-01", "end": "2026-06-30"}).json()
    worked = {s["date"] for s in shifts}
    off = sorted(f"2026-06-{d:02d}" for d in range(1, 31) if f"2026-06-{d:02d}" not in worked)
    # week1 Mon+Tue, week2 Wed+Thu, week3 Fri+Sat, week4 Sun+Mon (into week 5), week 6 Tue+Wed
    assert off == ["2026-06-01", "2026-06-02", "2026-06-10", "2026-06-11", "2026-06-19", "2026-06-20",
                   "2026-06-28", "2026-06-29"]
    assert all(s["start_time"] == "13:00" and s["end_time"] == "23:00" for s in shifts)

    # next month continues the stored rotation: Jul 7 (Tue) + Jul 8 (Wed)
    nxt = client.get("/api/schedule/rotations", params={"year": 2026, "month": 7, "rule_id": rot["id"]}).json()
    assert nxt == [{"employee_id": ana["id"], "first_off_date": "2026-07-07", "stored": True}]


def test_rules_crud_and_single_default(client):
    first = client.get("/api/rules").json()[0]
    assert first["is_default"]
    fixed = client.post("/api/rules", json={"name": "Fixed Mon+Tue", "off_days": 2, "shift_days": 0,
                                            "is_default": True}).json()
    rules = {r["id"]: r for r in client.get("/api/rules").json()}
    assert rules[fixed["id"]]["is_default"] and not rules[first["id"]]["is_default"]
    bad = client.post("/api/rules", json={"name": "x", "start_time": "10:00"})
    assert bad.status_code == 422
    assert client.post("/api/rules", json={"name": "p", "kind": "pattern", "pattern": "0000000"}).status_code == 422
    assert client.post("/api/rules", json={"name": "p", "kind": "pattern", "pattern": "101"}).status_code == 422
    client.delete(f"/api/rules/{fixed['id']}")
    assert client.get("/api/rules").json()[0]["is_default"]


def test_staggered_suggestions(client):
    ids = [_emp(client, n)["id"] for n in ("A", "B", "C")]
    rule = next(r for r in client.get("/api/rules").json() if r["kind"] == "rotation")
    rot = client.get("/api/schedule/rotations", params={"year": 2026, "month": 6, "rule_id": rule["id"]}).json()
    starts = sorted(r["first_off_date"] for r in rot)
    assert len(set(starts)) == 3 and not any(r["stored"] for r in rot)
    assert {r["employee_id"] for r in rot} == set(ids)


def test_absences_block_shifts_and_export(client):
    ana = _emp(client, "Ana", "Horvat")
    client.post("/api/shifts", json={"employee_id": ana["id"], "date": "2026-11-03",
                                     "start_time": "13:00", "end_time": "23:00"})
    r = client.post("/api/absences", json={"employee_id": ana["id"], "kind": "sick",
                                           "start_date": "2026-11-02", "end_date": "2026-11-04"})
    assert r.status_code == 201 and r.json()["removed_shifts"] == 1
    clash = client.post("/api/absences", json={"employee_id": ana["id"], "kind": "vacation",
                                               "start_date": "2026-11-04", "end_date": "2026-11-06"})
    assert clash.status_code == 409
    client.post("/api/absences", json={"employee_id": ana["id"], "kind": "vacation",
                                       "start_date": "2026-11-10", "end_date": "2026-11-10"})
    blocked = client.post("/api/shifts", json={"employee_id": ana["id"], "date": "2026-11-03",
                                               "start_time": "13:00", "end_time": "23:00"})
    assert blocked.status_code == 409 and "sick" in blocked.json()["detail"]

    rule = next(r for r in client.get("/api/rules").json() if r["kind"] == "rotation")
    gen = client.post("/api/schedule/generate", json={
        "year": 2026, "month": 11, "rule_id": rule["id"], "assignments": [{"employee_id": ana["id"], "first_off_date": "2026-11-23"}]}).json()
    assert gen["skipped_absent"] == 4
    days = {s["date"] for s in client.get("/api/shifts", params={"start": "2026-11-01", "end": "2026-11-30"}).json()}
    assert "2026-11-03" not in days and "2026-11-10" not in days and "2026-11-07" in days

    client.put("/api/settings", json={"company_name": "Bar", "absence_hours": 7.5})
    assert client.get("/api/settings").json()["absence_hours"] == 7.5
    ws = load_workbook(BytesIO(client.get("/api/export/month", params={"year": 2026, "month": 11}).content)).worksheets[0]
    assert ws["Q10"].value == 7.5 and ws["AD10"].value == "Bolovanje"  # Nov 2 sick
    assert ws["P18"].value == 7.5 and ws["AD18"].value == "Godišnji odmor"  # Nov 10 vacation
    assert ws["P40"].value == "=SUM(P9:P39)"


def test_alternating_two_workers(client):
    a, b = _emp(client, "Ana")["id"], _emp(client, "Bruno")["id"]
    # default rule = 2-week pattern; suggestions put the two workers in opposite weeks
    rot = client.get("/api/schedule/rotations", params={"year": 2026, "month": 6}).json()
    starts = {r["employee_id"]: r["first_off_date"] for r in rot}
    assert sorted(starts.values()) == ["2026-06-01", "2026-06-08"]  # Mondays, one week apart
    r = client.post("/api/schedule/generate", json={
        "year": 2026, "month": 6, "assignments": [{"employee_id": e, "first_off_date": d} for e, d in starts.items()]})
    assert r.status_code == 200, r.text
    shifts = client.get("/api/shifts", params={"start": "2026-06-01", "end": "2026-06-30"}).json()
    by_day = {}
    for s in shifts:
        by_day.setdefault(s["date"], []).append(s["employee_id"])
    assert len(by_day) == 30 and all(len(v) == 1 for v in by_day.values())  # exactly one worker every day
    week1_first = [e for e, d in starts.items() if d == "2026-06-01"][0]
    worked = sorted(int(s["date"][-2:]) for s in shifts if s["employee_id"] == week1_first)
    # week 1 Mon 1, Thu 4, Sat 6; week 2 Tue 9, Wed 10, Fri 12, Sun 14; week 3 = week 1 again ...
    assert worked[:7] == [1, 4, 6, 9, 10, 12, 14] and worked[7:10] == [15, 18, 20]
    # July continues: Jul 1 is in the week of Mon Jun 29 = week 1 again for that worker (Jun 1 + 4 weeks)
    nxt = {r["employee_id"]: r for r in client.get("/api/schedule/rotations", params={"year": 2026, "month": 7}).json()}
    assert nxt[week1_first]["first_off_date"] == "2026-06-29" and nxt[week1_first]["stored"]
