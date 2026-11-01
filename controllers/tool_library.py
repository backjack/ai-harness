"""Tool source, catalog, and playground APIs."""

from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import AnyHttpUrl, BaseModel, Field

from services.tool_library import create_custom_tool, create_source, deactivate_source, deactivate_tool, discover_source, get_tool, list_executions, list_sources, list_tools, test_tool, update_source
from services.tool_runtime import ToolFunctionValidationError
from utils.database import DatabaseUnavailableError


router = APIRouter(tags=["tool-library"])


class McpSourceCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    description: str | None = None
    endpoint: AnyHttpUrl
    owner_email: str = Field(min_length=3, max_length=320)


class McpSourceUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    description: str | None = None
    endpoint: AnyHttpUrl


class CustomToolCreate(BaseModel):
    name: str = Field(pattern=r"^[A-Za-z_][A-Za-z0-9_]*$", max_length=255)
    display_name: str | None = Field(default=None, max_length=255)
    description: str = Field(min_length=1, max_length=2000)
    source_code: str = Field(min_length=1)
    owner_email: str = Field(min_length=3, max_length=320)
    category: str = Field(default="Other", max_length=100)
    effect: Literal["read", "calculate", "write", "delete", "unknown"] = "unknown"
    examples: list[str] = Field(default_factory=list)
    output_preview: Any | None = None


class ToolTestRequest(BaseModel):
    arguments: dict[str, Any] = Field(default_factory=dict)
    invoked_by: str = Field(min_length=3, max_length=320)


def _db_error(exc: DatabaseUnavailableError) -> HTTPException:
    return HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Database service is unavailable")


@router.get("/tool-sources")
async def sources_endpoint() -> list[dict[str, Any]]:
    try: return list_sources()
    except DatabaseUnavailableError as exc: raise _db_error(exc) from exc


@router.post("/tool-sources/mcp", status_code=status.HTTP_201_CREATED)
async def create_source_endpoint(request: McpSourceCreate) -> dict[str, Any]:
    try:
        source = create_source({**request.model_dump(mode="json"), "endpoint": str(request.endpoint)})
        source["test"] = await discover_source(source["source_id"])
        return source
    except DatabaseUnavailableError as exc: raise _db_error(exc) from exc


@router.post("/tool-sources/{source_id}/test")
async def test_source_endpoint(source_id: str) -> dict[str, Any]:
    try: return await discover_source(source_id)
    except KeyError as exc: raise HTTPException(status_code=404, detail="Tool source not found") from exc
    except DatabaseUnavailableError as exc: raise _db_error(exc) from exc


@router.patch("/tool-sources/{source_id}")
async def update_source_endpoint(source_id: str, request: McpSourceUpdate) -> dict[str, Any]:
    try:
        source = update_source(source_id, {**request.model_dump(mode="json"), "endpoint": str(request.endpoint)})
        if source is None:
            raise HTTPException(status_code=404, detail="Tool source not found")
        test = await discover_source(source_id)
        source.update({"status": test["status"], "tool_count": test["tool_count"], "last_error": test["error"], "test": test})
        return source
    except DatabaseUnavailableError as exc: raise _db_error(exc) from exc


@router.delete("/tool-sources/{source_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_source_endpoint(source_id: str) -> None:
    try: deleted = deactivate_source(source_id)
    except DatabaseUnavailableError as exc: raise _db_error(exc) from exc
    if not deleted: raise HTTPException(status_code=404, detail="Tool source not found")


@router.get("/tools")
async def tools_endpoint(search: str = "", connection: str | None = None, category: str | None = None,
                         effect: str | None = None, tool_status: str | None = Query(default=None, alias="status"),
                         source_id: str | None = None) -> list[dict[str, Any]]:
    try: return list_tools(search=search, connection=connection, category=category, effect=effect, status=tool_status, source_id=source_id)
    except DatabaseUnavailableError as exc: raise _db_error(exc) from exc


@router.get("/tools/{tool_definition_id}")
async def tool_endpoint(tool_definition_id: str) -> dict[str, Any]:
    try: tool = get_tool(tool_definition_id)
    except DatabaseUnavailableError as exc: raise _db_error(exc) from exc
    if tool is None: raise HTTPException(status_code=404, detail="Tool not found")
    return tool


@router.post("/tools/custom", status_code=status.HTTP_201_CREATED)
async def create_custom_endpoint(request: CustomToolCreate) -> dict[str, Any]:
    try: return create_custom_tool(request.model_dump())
    except ToolFunctionValidationError as exc: raise HTTPException(status_code=422, detail=str(exc)) from exc
    except DatabaseUnavailableError as exc: raise _db_error(exc) from exc


@router.post("/tools/{tool_definition_id}/test")
async def test_tool_endpoint(tool_definition_id: str, request: ToolTestRequest) -> dict[str, Any]:
    try: return await test_tool(tool_definition_id, request.arguments, request.invoked_by)
    except KeyError as exc: raise HTTPException(status_code=404, detail="Tool not found") from exc
    except DatabaseUnavailableError as exc: raise _db_error(exc) from exc


@router.delete("/tools/{tool_definition_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_tool_endpoint(tool_definition_id: str) -> None:
    try: deleted = deactivate_tool(tool_definition_id)
    except DatabaseUnavailableError as exc: raise _db_error(exc) from exc
    if not deleted: raise HTTPException(status_code=404, detail="Tool not found")


@router.get("/tool-executions")
async def executions_endpoint(tool_definition_id: str | None = None,
                              limit: int = Query(default=100, ge=1, le=500)) -> list[dict[str, Any]]:
    try: return list_executions(tool_definition_id=tool_definition_id, limit=limit)
    except DatabaseUnavailableError as exc: raise _db_error(exc) from exc
