"""FastAPI application entry point."""

import os
from pathlib import Path

from fastapi import FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.openapi.docs import get_swagger_ui_html, get_swagger_ui_oauth2_redirect_html
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from controllers.analytics import router as analytics_router
from controllers.agents import router as agents_router
from controllers.conversations import router as conversations_router
from controllers.service_status import router as service_status_router
from controllers.tool_library import router as tool_library_router
from utils.config import get_config
from utils.logging_config import configure_logging


configure_logging()
config = get_config()
frontend_dist = Path(__file__).resolve().parent / "frontend" / "dist"
swagger_ui_assets = Path(__file__).resolve().parent / "resources" / "swagger-ui"
app = FastAPI(
    title=config.title,
    version=config.version,
    description="REST API for service status checks and stateless AI chat.",
    docs_url=None,
    openapi_url="/api/openapi.json",
    swagger_ui_oauth2_redirect_url="/api/docs/oauth2-redirect",
    swagger_ui_parameters={"docExpansion": "list"},
    openapi_tags=[
        {"name": "service", "description": "Service identification endpoints."},
        {"name": "health", "description": "Service availability endpoints."},
        {"name": "chat", "description": "Stateless AI chat endpoints."},
        {"name": "analytics", "description": "Usage and token-cost reporting."},
        {"name": "conversations", "description": "Recent user conversation summaries."},
    ],
)
cors_origins = [
    origin.strip()
    for origin in os.getenv(
        "FRONTEND_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173"
    ).split(",")
    if origin.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)
app.include_router(service_status_router, prefix="/api")
app.include_router(agents_router, prefix="/api")
app.include_router(analytics_router, prefix="/api")
app.include_router(conversations_router, prefix="/api")
app.include_router(tool_library_router, prefix="/api")
app.mount(
    "/api/docs-assets",
    StaticFiles(directory=swagger_ui_assets),
    name="swagger-ui-assets",
)


@app.get("/api/docs", include_in_schema=False)
async def swagger_ui():
    """Serve Swagger UI without relying on public CDN assets."""
    return get_swagger_ui_html(
        openapi_url=app.openapi_url,
        title=f"{app.title} - Swagger UI",
        oauth2_redirect_url=app.swagger_ui_oauth2_redirect_url,
        swagger_js_url="/api/docs-assets/swagger-ui-bundle.js",
        swagger_css_url="/api/docs-assets/swagger-ui.css",
        swagger_favicon_url="/api/docs-assets/favicon-32x32.png",
        swagger_ui_parameters=app.swagger_ui_parameters,
    )


@app.get("/api/docs/oauth2-redirect", include_in_schema=False)
async def swagger_ui_oauth2_redirect():
    """Complete Swagger UI OAuth2 redirects."""
    return get_swagger_ui_oauth2_redirect_html()


@app.get("/docs", include_in_schema=False)
async def swagger_ui_shortcut() -> RedirectResponse:
    """Redirect the conventional documentation URL to the API namespace."""
    return RedirectResponse(url="/api/docs", status_code=status.HTTP_307_TEMPORARY_REDIRECT)

if (frontend_dist.is_dir()):
    app.mount("/assets", StaticFiles(directory=frontend_dist / "assets"), name="frontend-assets")


@app.get("/{full_path:path}", include_in_schema=False)
async def serve_frontend(full_path: str) -> FileResponse:
    """Serve the compiled dashboard and its browser-history routes."""
    if full_path == "api" or full_path.startswith("api/"):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not Found")

    requested_file = (frontend_dist / full_path).resolve()
    if requested_file.is_relative_to(frontend_dist.resolve()) and requested_file.is_file():
        return FileResponse(requested_file)

    index_file = frontend_dist / "index.html"
    if not index_file.is_file():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Frontend build is unavailable",
        )
    return FileResponse(index_file)
