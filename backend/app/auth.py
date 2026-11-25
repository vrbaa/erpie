import hashlib
import secrets
import time
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from fastapi import APIRouter, Cookie, Depends, HTTPException, Response
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from . import config, models, schemas
from .database import get_db

COOKIE_NAME = "erpie_session"
MAX_FAILED_LOGINS = 100
FAILED_WINDOW_SECONDS = 15 * 60

router = APIRouter()
hasher = PasswordHasher()
_failed_logins: dict[str, deque[float]] = defaultdict(deque)


def _utcnow() -> datetime:
    return datetime.utcnow()


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _user_out(user: models.User) -> schemas.UserOut:
    return schemas.UserOut(
        id=user.id, email=user.email, name=user.name, role=user.role, active=user.active,
        has_password=user.password_hash is not None, has_google=user.google_sub is not None,
        last_login_at=user.last_login_at.replace(tzinfo=timezone.utc) if user.last_login_at else None,
    )


# ---------------------------------------------------------------- sessions
def _start_session(db: Session, user: models.User, response: Response) -> None:
    now = _utcnow()
    db.execute(delete(models.Session).where(models.Session.expires_at < now))  # lazy cleanup
    token = secrets.token_urlsafe(32)
    db.add(models.Session(token_hash=_hash_token(token), user_id=user.id, created_at=now,
                          expires_at=now + timedelta(days=config.SESSION_DAYS)))
    user.last_login_at = now
    db.commit()
    response.set_cookie(COOKIE_NAME, token, max_age=config.SESSION_DAYS * 86400, httponly=True,
                        samesite="lax", secure=config.COOKIE_SECURE, path="/")


def _delete_sessions(db: Session, user_id: int, keep_token_hash: str | None = None) -> None:
    q = delete(models.Session).where(models.Session.user_id == user_id)
    if keep_token_hash:
        q = q.where(models.Session.token_hash != keep_token_hash)
    db.execute(q)


def current_user(erpie_session: str | None = Cookie(default=None), db: Session = Depends(get_db)) -> models.User:
    if erpie_session:
        row = db.execute(
            select(models.User, models.Session)
            .join(models.Session, models.Session.user_id == models.User.id)
            .where(models.Session.token_hash == _hash_token(erpie_session), models.Session.expires_at > _utcnow())
        ).first()
        if row and row.User.active:
            return row.User
    raise HTTPException(401, "Not authenticated")


def require_admin(user: models.User = Depends(current_user)) -> models.User:
    if user.role != "admin":
        raise HTTPException(403, "Admin only")
    return user


# ---------------------------------------------------------------- bootstrap
def bootstrap_admin(db: Session) -> None:
    """Create the ADMIN_EMAIL user if missing. Never overwrites an existing user."""
    email = config.ADMIN_EMAIL
    if not email or db.scalar(select(models.User.id).where(models.User.email == email)):
        return
    db.add(models.User(
        email=email, name="Admin", role="admin",
        password_hash=hasher.hash(config.ADMIN_PASSWORD) if config.ADMIN_PASSWORD else None,
    ))
    db.commit()


# ---------------------------------------------------------------- public endpoints
@router.get("/api/health")
def health():
    return {"status": "ok"}


@router.get("/api/auth/config", response_model=schemas.AuthConfigOut)
def auth_config():
    return {"google_client_id": config.GOOGLE_CLIENT_ID}


@router.post("/api/auth/login", response_model=schemas.UserOut)
def login(data: schemas.LoginIn, response: Response, db: Session = Depends(get_db)):
    email = data.email.strip().lower()
    now = time.monotonic()
    failed = _failed_logins[email]
    while failed and now - failed[0] > FAILED_WINDOW_SECONDS:
        failed.popleft()
    if len(failed) >= MAX_FAILED_LOGINS:
        raise HTTPException(429, "Too many attempts, try again later")

    user = db.scalar(select(models.User).where(models.User.email == email))
    ok = False
    if user and user.active and user.password_hash:
        try:
            ok = hasher.verify(user.password_hash, data.password)
        except VerifyMismatchError:
            ok = False
    if not ok:
        failed.append(now)
        raise HTTPException(401, "Invalid email or password")
    _failed_logins.pop(email, None)
    _start_session(db, user, response)
    return _user_out(user)


@router.post("/api/auth/google", response_model=schemas.UserOut)
def login_google(data: schemas.GoogleLoginIn, response: Response, db: Session = Depends(get_db)):
    if not config.GOOGLE_CLIENT_ID:
        raise HTTPException(401, "Google login is not enabled")
    from google.auth.transport import requests as google_requests
    from google.oauth2 import id_token

    try:
        info = id_token.verify_oauth2_token(data.credential, google_requests.Request(), config.GOOGLE_CLIENT_ID)
    except ValueError:
        raise HTTPException(401, "Invalid Google credential")
    if not info.get("email_verified"):
        raise HTTPException(401, "Google email is not verified")

    sub, email = info["sub"], info["email"].lower()
    user = db.scalar(select(models.User).where(models.User.google_sub == sub))
    if not user:
        user = db.scalar(select(models.User).where(models.User.email == email))
        if user and user.active:
            user.google_sub = sub
    if not user or not user.active:
        raise HTTPException(403, "No access for this Google account. Ask an admin to add you.")
    _start_session(db, user, response)
    return _user_out(user)


@router.post("/api/auth/logout", status_code=204)
def logout(response: Response, erpie_session: str | None = Cookie(default=None), db: Session = Depends(get_db)):
    if erpie_session:
        db.execute(delete(models.Session).where(models.Session.token_hash == _hash_token(erpie_session)))
        db.commit()
    response.delete_cookie(COOKIE_NAME, path="/", httponly=True, samesite="lax", secure=config.COOKIE_SECURE)


# ---------------------------------------------------------------- logged in
@router.get("/api/auth/me", response_model=schemas.UserOut)
def me(user: models.User = Depends(current_user)):
    return _user_out(user)


@router.put("/api/auth/password", status_code=204)
def change_password(data: schemas.PasswordChangeIn, erpie_session: str | None = Cookie(default=None),
                    user: models.User = Depends(current_user), db: Session = Depends(get_db)):
    if user.password_hash:
        try:
            if not data.current_password:
                raise VerifyMismatchError()
            hasher.verify(user.password_hash, data.current_password)
        except VerifyMismatchError:
            raise HTTPException(400, "Current password is incorrect")
    user.password_hash = hasher.hash(data.new_password)
    _delete_sessions(db, user.id, keep_token_hash=_hash_token(erpie_session))
    db.commit()


# ---------------------------------------------------------------- admin: users
def _get_user(db: Session, user_id: int) -> models.User:
    user = db.get(models.User, user_id)
    if not user:
        raise HTTPException(404, "User not found")
    return user


def _guard_admin_loss(db: Session, target: models.User, acting: models.User) -> None:
    """Called when `target`, an active admin, would be deleted, deactivated or demoted."""
    if target.id == acting.id:
        raise HTTPException(400, "You cannot delete, deactivate or demote yourself")
    other_admins = db.scalar(select(func.count()).select_from(models.User).where(
        models.User.role == "admin", models.User.active.is_(True), models.User.id != target.id))
    if not other_admins:
        raise HTTPException(400, "The last active admin cannot be removed, deactivated or demoted")


@router.get("/api/users", response_model=list[schemas.UserOut])
def list_users(_: models.User = Depends(require_admin), db: Session = Depends(get_db)):
    return [_user_out(u) for u in db.scalars(select(models.User).order_by(func.lower(models.User.name)))]


@router.post("/api/users", response_model=schemas.UserOut, status_code=201)
def create_user(data: schemas.UserCreate, _: models.User = Depends(require_admin), db: Session = Depends(get_db)):
    email = data.email.strip().lower()
    if db.scalar(select(models.User.id).where(models.User.email == email)):
        raise HTTPException(409, "A user with this email already exists")
    user = models.User(email=email, name=data.name.strip(), role=data.role,
                       password_hash=hasher.hash(data.password) if data.password else None)
    db.add(user)
    db.commit()
    return _user_out(user)


@router.put("/api/users/{user_id}", response_model=schemas.UserOut)
def update_user(user_id: int, data: schemas.UserUpdate, acting: models.User = Depends(require_admin),
                db: Session = Depends(get_db)):
    user = _get_user(db, user_id)
    if user.role == "admin" and user.active and (data.role != "admin" or not data.active):
        _guard_admin_loss(db, user, acting)
    user.name = data.name.strip()
    user.role = data.role
    user.active = data.active
    if data.password:
        user.password_hash = hasher.hash(data.password)
    if data.password or not data.active:
        _delete_sessions(db, user.id)
    db.commit()
    return _user_out(user)


@router.delete("/api/users/{user_id}", status_code=204)
def delete_user(user_id: int, acting: models.User = Depends(require_admin), db: Session = Depends(get_db)):
    user = _get_user(db, user_id)
    if user.role == "admin" and user.active:
        _guard_admin_loss(db, user, acting)
    elif user.id == acting.id:
        raise HTTPException(400, "You cannot delete yourself")
    _delete_sessions(db, user.id)
    db.delete(user)
    db.commit()
