# Erpie – caffe bar staff & hours

Small ERP-style app for managing employees, opening hours and shift plans, with export to the
"Evidencija radnog vremena" (šihterica) Excel template.

- **Backend:** Python, FastAPI, SQLAlchemy, SQLite (`backend/erpie.db`, created automatically)
- **Frontend:** Angular 22 (standalone components, signals)

## Run

First time only:

```
cd backend
pip install -r requirements.txt
cd ../frontend
npm install
```

Then start both (two terminals), or double-click `start-backend.bat` and `start-frontend.bat`:

```
cd backend  && python -m uvicorn app.main:app --reload --port 8000
cd frontend && npm start
```

Open http://localhost:4200. API docs: http://localhost:8000/docs

## Features

| Page | What it does |
|------|--------------|
| **Schedule** | Month and week calendar. Month: click a day to add/edit/remove employees on it. Week: rows = employees, click an empty cell to add a shift with that day's working hours, click a shift to change it. Hour totals per employee. Export button for the shown month. |
| **Employees** | Create, edit and delete employees (name, OIB, position, contact, start date, calendar color, active flag, notes). |
| **Schedule → Generate** | Fills a month from a schedule rule (default rule preselected, single picker). Preview grid per employee with free days, absences, closed days and a "working" count per day; click a day to change someone's first free day. Each employee's place in the rotation is stored, so the next month continues it. Closed days and absences are skipped. |
| **Drag & drop** | Drag a shift to another day (month view) or another day/employee (week view) to move it; hold Ctrl to copy. Full-day shifts take the target day's working hours. |
| **Absences** | Vacation (godišnji odmor), sick leave (bolovanje), paid/unpaid leave, other — date ranges per employee. Saving one removes that employee's shifts in the range; shifts can't be added on absent days. Shown in the calendar; yearly totals per employee. |
| **Schedule rules** | Two kinds. *Fixed weekly pattern*: tick work days per week over a 1–4 week cycle; employees start in different weeks (default rule: week 1 Mon/Thu/Sat, week 2 Tue/Wed/Fri/Sun, so two workers alternate with exactly one per day). *Rotating free days*: N free days in a row, moving M days later every week (e.g. 2 & 2: week 1 Mon+Tue, week 2 Wed+Thu, week 3 Fri+Sat, week 4 Sun+Mon, …), fixed or day hours, spread free days between employees, default rule. |
| **Workdays** | Regular hours per weekday (default 13:00–23:00), special days that override them (e.g. 10:00–00:00, closed, public holiday) and the company name printed as "Poslodavac". |

A closing/end time earlier than or equal to the start (e.g. `10:00–00:00`, `18:00–02:00`) means it runs past midnight.

## Excel export

`GET /api/export/month?year=2026&month=11` fills `backend/app/templates/sihterica_template.xlsx`
(an .xlsx conversion of the original .xls template): one sheet per employee, named after them.

Filled columns per day: **1** total hours, **3/4** start/end time, **6** night hours (22:00–06:00),
**11** Sunday hours, **13** hours worked on days marked as holiday, **18** godišnji odmor, **19/20** bolovanje
(up to / from day 42), **21** plaćeni dopust, **23** neplaćeni dopust (absence hours per day are set on
Workdays; not counted on closed days and holidays), **32** note (split shifts list all
their times here). Header: employee name, month, company name. Exported by default: all active
employees, plus inactive ones that have shifts that month.

## Tests

```
cd backend && python -m pytest
```

## Login

The whole app (API and UI) requires a login. It is invite-only: only users in the `users` table can sign in, with email + password or "Sign in with Google" (Google works only for an email that already has a user). Admins manage users on the **Users** page. Sessions use an httpOnly cookie (`erpie_session`).

The first admin is created from environment variables when the backend starts (an existing user is never overwritten):

| Variable | Meaning |
|----------|---------|
| `ADMIN_EMAIL` | Email of the bootstrap admin |
| `ADMIN_PASSWORD` | Optional password for it (if unset, the admin must use Google) |
| `GOOGLE_CLIENT_ID` | Optional, enables the Google button |
| `DATABASE_URL` | Optional, defaults to local SQLite `backend/erpie.db` |
| `COOKIE_SECURE` | `true` behind HTTPS (default `false`) |
| `SESSION_DAYS` | Session length, default `30` |

Local dev, before starting the backend (or add these lines to `start-backend.bat`):

```
set ADMIN_EMAIL=you@example.com
set ADMIN_PASSWORD=choose-a-password
```

## Deploy (Cloudflare Pages + PythonAnywhere)

Free setup: Angular on Cloudflare Pages, FastAPI + SQLite on a PythonAnywhere free account. The Pages Function `frontend/functions/api/[[path]].ts` proxies `/api/*` to PythonAnywhere, so the browser only talks to the pages.dev host and the session cookie is first-party.

### Backend (PythonAnywhere)

1. Bash console: `git clone <repo> ~/Erpie`, `mkvirtualenv erpie --python=python3.13` (or the newest available), `pip install -r ~/Erpie/backend/requirements.txt`.
2. Create `~/Erpie/backend/.env` from `backend/.env.example`. Optionally upload your local `erpie.db` to `~/Erpie/backend/` (Files tab).
3. Web tab -> Add a new web app -> Manual configuration -> same Python version. Virtualenv: `/home/<user>/.virtualenvs/erpie`. Replace the contents of the WSGI file with:
   ```python
   import sys
   sys.path.insert(0, '/home/<user>/Erpie/backend')
   from wsgi import application
   ```
   Turn Force HTTPS on, then Reload.
4. Check `https://<user>.pythonanywhere.com/api/health`.
5. Update: `cd ~/Erpie && git pull && pip install -r backend/requirements.txt`, then Reload on the Web tab.

Free tier notes: renew the web app monthly ("Run until 1 month from today" on the Web tab) or it stops; 100 CPU-seconds per day; outbound HTTP only to allow-listed domains (Google sign-in needs the Google cert endpoints on `googleapis.com`).

### Frontend (Cloudflare Pages)

Create a Pages project with Git integration and these settings:

| Setting | Value |
|---------|-------|
| Root directory | `frontend` |
| Build command | `npm run build` |
| Output directory | `dist/frontend/browser` |
| Env var `BACKEND_ORIGIN` | `https://<user>.pythonanywhere.com` |
| Env var `NODE_VERSION` | `22` |

### Google sign-in (optional)

Google Cloud Console -> APIs & Services -> Credentials -> OAuth client ID -> Web application. Authorized JavaScript origins: `http://localhost:4200` and `https://<project>.pages.dev`. No redirect URI. Put the client id in `GOOGLE_CLIENT_ID` in `backend/.env`.

### Prod-like local run

```
cd backend && pip install waitress && waitress-serve --port 8010 wsgi:application
cd frontend && npm run build && npx wrangler pages dev dist/frontend/browser --binding BACKEND_ORIGIN=http://localhost:8010
```
