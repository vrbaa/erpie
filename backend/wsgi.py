"""WSGI entry point (PythonAnywhere): `from wsgi import application`."""
from a2wsgi import ASGIMiddleware

from app.main import app, init_app

init_app()  # a2wsgi sends no lifespan events, so run startup once here
application = ASGIMiddleware(app)
