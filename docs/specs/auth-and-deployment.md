# Spec: Login (password + Google) and free production deployment

Status: approved for implementation - 2026-11-19

## Goals

1. Nobody can see or change data without logging in.
2. Users log in with email + password, or with "Sign in with Google".
3. Invite-only: only users that exist in the `users` table (created by an admin) can log in. Google login works only for an email that already has a user row.
4. Production deploy at zero cost: **Angular on Cloudflare Pages**, **FastAPI on Render** (free web service, native Python runtime) with **Neon Postgres**, deployed separately.

Non-goals: self-registration, password reset by email, multi-tenancy, 2FA.

## Architecture

```
Browser ──HTTPS──> https://<project>.pages.dev   (Cloudflare Pages)
                     /*      -> static Angular build (SPA fallback to index.html)
                     /api/*  -> Pages Function frontend/functions/api/[[path]].ts
                                  └─ fetch() ──HTTPS──> https://erpie-api.onrender.com/api/*
                                                          uvicorn app.main:app (FastAPI, render.yaml)
                                                          Neon Postgres (pooled connection, psycopg 3)
```

- The Pages Function proxy keeps the API **same-origin** for the browser (as does the Angular dev proxy locally). So auth uses a first-party **httpOnly session cookie** set on the pages.dev host; no CORS, no third-party cookies, no tokens in JS.
- Remove `CORSMiddleware` from `backend/app/main.py` (nothing calls the API cross-origin).
- Render free web services sleep after 15 minutes idle (wake ~30-60 s), so the proxy sets no timeout. It forwards the client IP as `X-Forwarded-For` (from `CF-Connecting-IP`); uvicorn runs with `--proxy-headers --forwarded-allow-ips='*'`.

## Configuration (env vars, all read in one place: `backend/app/config.py`)

| Var | Default (dev) | Prod |
|---|---|---|
| `DATABASE_URL` | Neon pooled URL from `neon env pull` (repo-root `.env.local`); unset -> SQLite `backend/erpie.db` | Neon pooled URL (`...-pooler...`, `sslmode=require`) as a Render env var |
| `GOOGLE_CLIENT_ID` | unset -> Google login disabled, button hidden | OAuth Web client id |
| `ADMIN_EMAIL` | unset | bootstrap admin email |
| `ADMIN_PASSWORD` | unset | optional bootstrap password (if unset the admin must use Google) |
| `COOKIE_SECURE` | `false` | `true` |
| `SESSION_DAYS` | `30` | `30` |

`config.py` loads `backend/.env`, then the repo-root `.env.local` (written by `neon env pull`, dev only), with `python-dotenv` (existing env vars win). `postgres://` and `postgresql://` URLs are normalized to `postgresql+psycopg://`. In prod the vars are set in Render (see `render.yaml`). `backend/.env` is git-ignored; commit `backend/.env.example`.

## Backend (FastAPI, `backend/`)

### Dependencies (`requirements.txt`)
`argon2-cffi`, `google-auth`, `requests` (transport used by google-auth), `python-dotenv`, `psycopg[binary]` (Postgres driver, psycopg 3).

### Database
- `database.py`: engine from `config.DATABASE_URL`. SQLite keeps `check_same_thread=False`. Postgres (Neon pooled/PgBouncer endpoint, as the Neon guidance recommends for web apps): `pool_pre_ping=True`, `pool_recycle=300` (computes suspend when idle), small pool, `prepare_threshold=None` (no server-side prepared statements behind PgBouncer).
- Schema is created by `Base.metadata.create_all` at startup; `scheduling.migrate()` uses `sqlalchemy.inspect` and works on both dialects. Session rows are removed by `ON DELETE CASCADE` on Postgres.
- Existing data: one-off `backend/scripts/copy_sqlite_to_db.py` copies `backend/erpie.db` into an empty target (FK-safe order, resets sequences, refuses if employees exist). Run it once, ideally with the direct URL (`DATABASE_URL_UNPOOLED`).
- Tests use in-memory SQLite; `tests/conftest.py` neutralizes `DATABASE_URL` and `COOKIE_SECURE`.

### Startup
- The body of `lifespan` lives in `def init_app() -> None` (create_all, migrate, defaults, rules, bootstrap admin), idempotent, called from `lifespan`.

### Models (`models.py`)
```
User:    id, email (unique, stored lowercase), name, password_hash (nullable),
         google_sub (nullable, unique), role ('admin'|'user'), active (bool, default true),
         created_at, last_login_at (nullable)
Session: id, token_hash (sha256 hex of the cookie token, unique, indexed), user_id (FK users, ON DELETE CASCADE),
         created_at, expires_at
```
Tables are created by the existing `Base.metadata.create_all` at startup.

### Auth module (`backend/app/auth.py`, APIRouter)
- Passwords: `argon2.PasswordHasher`. Min length 8.
- Session token: `secrets.token_urlsafe(32)`; store only its sha256. Cookie `erpie_session`: `HttpOnly`, `SameSite=Lax`, `Secure=COOKIE_SECURE`, `Path=/`, `Max-Age=SESSION_DAYS*86400`.
- Dependency `current_user` (reads cookie, looks up unexpired session, user must be active; else 401 `{"detail": "Not authenticated"}`). Dependency `require_admin` (403 otherwise).
- Expired sessions are deleted lazily (on login).
- Brute force: in-process limiter, max 100 failed logins per email per 15 minutes -> 429. (Single instance on Render, so in-memory is enough.)
- Bootstrap (called from `lifespan`): if `ADMIN_EMAIL` is set and no user with that email exists, create it as `admin` (hash `ADMIN_PASSWORD` if set). Never overwrite an existing user.
- Google: `google.oauth2.id_token.verify_oauth2_token(credential, google.auth.transport.requests.Request(), GOOGLE_CLIENT_ID)`. Require `email_verified`. Find user by `google_sub`, else by lowercase email (then store `google_sub`). Unknown/inactive -> 403 `"No access for this Google account. Ask an admin to add you."`.
- Login error messages never reveal whether the email exists (`"Invalid email or password"`).

### API contract (both agents build against this)

Public:
| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/health` | - | `{"status":"ok"}` |
| GET | `/api/auth/config` | - | `{"google_client_id": string \| null}` |
| POST | `/api/auth/login` | `{"email","password"}` | `200 UserOut` + sets cookie; 401 / 429 |
| POST | `/api/auth/google` | `{"credential"}` (GIS ID token) | `200 UserOut` + sets cookie; 401 / 403 |
| POST | `/api/auth/logout` | - | `204`, deletes session + clears cookie (works even if not logged in) |

Logged in:
| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/auth/me` | - | `UserOut` or 401 |
| PUT | `/api/auth/password` | `{"current_password": string\|null, "new_password"}` | `204`. `current_password` required if the user already has a password. Other sessions of the user are deleted. |

Admin only:
| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/users` | - | `UserOut[]` sorted by name |
| POST | `/api/users` | `UserCreate` | `201 UserOut`; 409 if email exists |
| PUT | `/api/users/{id}` | `UserUpdate` | `UserOut` |
| DELETE | `/api/users/{id}` | - | `204` |

```
UserOut    = {id, email, name, role, active, has_password: bool, has_google: bool, last_login_at: string|null}
UserCreate = {email, name, role, password: string|null}
UserUpdate = {name, role, active, password: string|null}   // password non-null = admin sets a new one
```
Rules: an admin cannot delete, deactivate or demote themselves; the last active admin cannot be removed/demoted/deactivated (400 with a clear message). Deactivating a user or setting their password deletes their sessions.

### Protecting the existing API
In `main.py` replace `@app.<method>` route decorators with `@api.<method>` where `api = APIRouter(dependencies=[Depends(current_user)])`, then `app.include_router(auth.router)` and `app.include_router(api)`. Paths stay exactly the same. Every existing `/api/*` route must return 401 without a valid cookie.

### Not serving the SPA
The backend serves only `/api/*` (Cloudflare Pages serves the frontend). Remove the SPA/static catch-all and `STATIC_DIR`. Unknown `/api/*` paths return 404 JSON.

### Tests
User instruction: do not write new unit tests. Only update `backend/tests/test_api.py` so the existing tests still pass: the `client` fixture creates a user and logs in (cookie kept by TestClient). `python -m pytest` must be green.

## Frontend (Angular 22, `frontend/`)

Follow existing patterns: standalone components, signals, `core/api.service.ts` style, styles from `src/styles.css`. Reuse existing button/form/card classes; do not add a UI library.

- `core/auth.service.ts`: `user = signal<User|null>`, `isAdmin = computed(...)`, `loadMe()`, `login(email,pw)`, `loginWithGoogle(credential)`, `logout()`, `changePassword(...)`, `config()`. Users CRUD methods go in `api.service.ts` (same style as the others).
- `provideAppInitializer` calls `loadMe()` (a 401 just means logged out) so guards know the state before the first navigation.
- `core/auth.guard.ts`: `authGuard` (else redirect to `/login?returnUrl=...`), `adminGuard` (else redirect `/calendar`), `guestGuard` on `/login` (logged in -> `/calendar`).
- `core/auth.interceptor.ts` (functional, registered with `withInterceptors`): on any 401 from `/api/*` other than `/api/auth/me` and `/api/auth/login`, clear the user and navigate to `/login?returnUrl=<current>`.
- `app.ts`: render the sidebar shell only when logged in; on `/login` render a centered card without the sidebar. Sidebar: add "👤 Users" link (admin only); footer shows the user's name, a "Change password" link (`/account`) and a "Log out" button.
- `pages/login/login.page.ts`: product brand ("E Erpie"), email + password form, inline error text (401 -> "Invalid email or password", 429 -> "Too many attempts, try again later", 403 from Google -> backend message), loading state on the submit button, Enter submits. If `google_client_id` is set: a divider "or" and the official Google button.
  - Load `https://accounts.google.com/gsi/client` once (dynamic `<script>` tag, promise-wrapped), then `google.accounts.id.initialize({ client_id, callback, ux_mode: 'popup' })` and `google.accounts.id.renderButton(el, { theme: 'outline', size: 'large', text: 'signin_with', width: <form width> })`. Callback -> `loginWithGoogle(resp.credential)` -> navigate to `returnUrl` or `/calendar`. Declare a minimal `google` type locally (no extra npm package).
  - On logout call `google.accounts.id.disableAutoSelect()` if loaded.
- `pages/users/users.page.ts` (admin): table (name, email, role, active, sign-in methods: "Password" / "Google", last login), add/edit dialog following the existing dialog components in `shared/`, delete with confirm. Show the backend 400/409 message on error.
- `pages/account/account.page.ts`: change password form (current password field only if `has_password`).
- `angular.json` production build must work with `npm run build` (output `dist/frontend/browser`).

## Deployment

No Docker. The database is Neon Postgres (project branch `production`); use throwaway branches (`neon checkout <name> --create`) for testing.

### Cloudflare Pages (frontend)
- `frontend/functions/api/[[path]].ts`: Pages Function proxy. `onRequest` builds `env.BACKEND_ORIGIN + url.pathname + url.search`, forwards method, body and headers (drop `host`; set `X-Forwarded-Host`/`X-Forwarded-Proto`), `redirect: 'manual'`, and returns the upstream response unchanged (status, body, all headers incl. `Set-Cookie`, `Content-Disposition`). If `BACKEND_ORIGIN` is unset return 500 JSON with a clear message. Minimal local types; no new npm dependencies except `wrangler` as a devDependency for local testing (pin an exact version).
- SPA deep links: Pages serves `index.html` for unknown paths when the build has no `404.html` (confirm the Angular build output has none). Add `frontend/public/_headers`: `/index.html` -> `Cache-Control: no-cache`; hashed `/*.js` and `/*.css` -> long immutable cache.
- Pages project settings (documented in README): Git integration, root directory `frontend`, build command `npm run build`, output directory `dist/frontend/browser`, env vars `BACKEND_ORIGIN=https://erpie-api.onrender.com` (the Render URL) and `NODE_VERSION=22`.

### Render (backend)
- `render.yaml` (repo root): one web service `erpie-api`, `runtime: python`, `plan: free`, `rootDir: backend`, build `pip install -r requirements.txt`, start `uvicorn app.main:app --host 0.0.0.0 --port $PORT --proxy-headers --forwarded-allow-ips='*'`, health check `/api/health`. Env: `PYTHON_VERSION` (pinned), `COOKIE_SECURE=true`, and `DATABASE_URL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `GOOGLE_CLIENT_ID` as `sync: false` (asked for at Blueprint creation).
- README steps: push to GitHub, Render -> New -> Blueprint, fill env vars, check `/api/health`. Updates deploy on git push.
- Free tier: sleeps after 15 min idle (first request ~30-60 s); Neon free scales to zero.
- Google Cloud Console: OAuth client (Web application), Authorized JavaScript origins `http://localhost:4200` and `https://<project>.pages.dev`. No redirect URI.
- Local dev: document `set ADMIN_EMAIL=...` / `backend/.env` before starting.

## Acceptance (verified end to end)
1. Fresh DB + `ADMIN_EMAIL/ADMIN_PASSWORD` -> open app -> redirected to `/login` -> log in -> calendar loads; reload keeps the session.
2. `curl /api/employees` without cookie -> 401. `/api/health`, `/api/auth/config` -> 200.
3. Wrong password -> error text; 101st failed try -> "Too many attempts".
4. Admin creates a user, logs out, logs in as that user: no "Users" link, `/users` redirects, `GET /api/users` -> 403.
5. Admin cannot demote/delete themselves (message shown).
6. With `GOOGLE_CLIENT_ID` set, the Google button renders on `/login`; without it, no button and no divider.
7. **Prod-like local run**: backend started with the Render start command (uvicorn), frontend via `npx wrangler pages dev dist/frontend/browser --binding BACKEND_ORIGIN=http://localhost:<port>`. In the browser at the wrangler URL: login, cookie set on the wrangler host, reload keeps session, CRUD works, Excel export downloads with the right filename, deep link `/employees` reload works, logout works.
8. `python -m pytest` green; `npm run build` green with no new warnings.
