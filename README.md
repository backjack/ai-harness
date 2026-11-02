# AI Harness

A minimal FastAPI service managed with Poetry. REST endpoints live in
`controllers/`, their application logic lives in `services/`, and shared
application code lives in `utils`.

## Setup

```powershell
poetry install
```

## Run locally

```powershell
poetry run uvicorn main:app --reload
```

The service exposes:

- `GET /api/conversations?email_id=<email>` — five most recent saved conversation summaries

- `GET /api/` — service identifier
- `GET /api/health` — health status
- `GET /docs` or `GET /api/docs` — interactive OpenAPI documentation

## API documentation

Swagger UI is available at `http://127.0.0.1:8000/docs` and
`http://127.0.0.1:8000/api/docs`. Its browser assets are served locally, so the
documentation works without CDN access. The raw OpenAPI schema is available at
`http://127.0.0.1:8000/api/openapi.json`.

The agent model picker supports `gpt-5.4-mini` (the default) and the legacy
`gpt-4.1-mini` OpenAI model.

## Configuration

`resources/config.json` selects the active `chat_provider` and keeps separate
model names for OpenAI and Ollama. Add `OPENAI_API_KEY` to the repository-local
`.env` file only when `chat_provider` is `openai`; do not commit that file.

## MySQL setup

Copy `.env.example` values into the ignored `.env` file and set the MySQL host,
user, password, and database values. The application requires TLS and trusts
the bundled CA certificate at `resources/certs/ca.pem`; override its location
with `MYSQL_SSL_CA` only when needed. Database readiness is available at
`GET /api/health/database`.

## Ollama setup

Install Ollama from [ollama.com](https://ollama.com), then download the default
local model:

```powershell
ollama pull llama3.2:3b
```

Ensure Ollama is running locally. The service connects to
`http://127.0.0.1:11434` by default; set `OLLAMA_BASE_URL` to use another host.

## Chat

Create an agent first, then send a prompt using that agent's configured model
and ordered system prompts. Successful chats are saved in
`agent_chat_interactions`.

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8000/api/agents `
  -ContentType "application/json" -Body '{"agent_name":"Assistant","owner_email":"owner@example.com","model_id":"gpt-5.4-mini","tooling":[],"model_type":"openai","created_by":"owner@example.com"}'

Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8000/api/chat `
  -ContentType "application/json" -Body '{"agent_id":"<agent-id>","user_id":"<user-id>","user_prompt":"Hello"}'
```

`POST /api/chat` returns a rich final response containing `chat_event_id`, a typed
`response` (`text`, `json`, `html`, or `tool`), `model_response` metadata, the
session ID, and the audited chat sequence ID. The API returns HTTP 404 for an
unknown agent, HTTP 503 when audit persistence or configuration is unavailable,
and HTTP 502 when the model provider fails.

`POST /api/chat/stream` accepts the same request body and returns
`text/event-stream`. Each Server-Sent Event includes an ordered event ID and a
shared `chat_event_id`, and reports model invocations, LangChain callbacks,
tool calls/results, auditing, the final rich response, and `complete`. The
connection closes after `complete`; failures emit `error` and then close.

## Python tools

Each agent owns its Python tool definitions in the `tooling` JSON field. A tool
contains `name`, `description`, `source_code`, and `enabled`; it is validated
when the agent is created or updated. During chat, enabled tools are bound to
the configured LangChain model and model-requested calls are executed before a
final response is returned. Tool source runs inside the API process, so use it
only in trusted deployments.

`resources/scripts/seed_stock_price_agent.sql` creates a Stock Price Assistant
with an inline `getMarketPrice` tool that calls Yahoo Finance's chart REST API.
It accepts a ticker symbol such as `AAPL` and includes a
delayed-price/not-financial-advice note.

Before deploying agent initiative support against an existing database, run
`resources/scripts/migrate_agents_add_initiative_id.sql`. The migration is
idempotent and adds the nullable `initiative_id` column used by create and edit.

For an existing database, apply the agent and tool-library scripts in this
order: `migrate_agents_add_description_workflow.sql` (retained as a legacy
filename; it now adds only `description`),
`migrate_agents_add_initiative_id.sql`, `migrate_agents_add_faq.sql`, then
`create_tool_library.sql`. The description and initiative migrations
are safe to run again; the tool-library schema uses `CREATE TABLE IF NOT EXISTS`.

## Logging

Diagnostics are written to the console. Set `LOG_LEVEL` to control application
logging (defaults to `INFO`). Every LangChain model and tool invocation is
traced at `INFO` with full prompts, history, model responses, tool arguments,
tool results, callback lifecycle events, and a shared trace ID. These logs can
contain sensitive portfolio data; restrict console-log access accordingly.

## Test

```powershell
poetry run pytest
```

## React dashboard

The Vite React dashboard lives in `frontend/`. It loads agents and streams
model/tool activity from the FastAPI service.

```powershell
# Terminal 1
poetry run uvicorn main:app --reload

# Terminal 2
cd frontend
Copy-Item .env.example .env
npm.cmd install
npm.cmd run dev
```

Open `http://127.0.0.1:5173`. The supplied frontend environment example points
`VITE_API_BASE_URL` at the local FastAPI `/api` namespace; override it when FastAPI is hosted
at a different URL. For local development, FastAPI allows requests from Vite's
default `localhost:5173` and `127.0.0.1:5173` origins; set
`FRONTEND_ORIGINS` to add deployment origins.

The dashboard uses browser-history routes such as `/chat`, `/agents`,
`/marketplace`, `/analytics`, and `/conversations/:sessionId`. Production web
servers must use an SPA fallback that serves `frontend/dist/index.html` for
frontend paths that do not match a static asset.

### Google authentication

Create a Google OAuth 2.0 Web application client and add the frontend origins
(for example `http://localhost:5173` and the deployed origin) as authorized
JavaScript origins. Set its client ID as `GOOGLE_CLIENT_ID` in the backend
environment. The browser obtains a Google ID token, keeps it for the current
tab, and sends it as a bearer token to protected `/api` endpoints. Health,
Swagger/OpenAPI, and authentication bootstrap endpoints remain public.

For a trusted static-user deployment, set `AUTH_ENABLED=false` together with
`AUTH_STATIC_USER_NAME` and `AUTH_STATIC_USER_EMAIL`. This bypasses JWT
validation for every API request, so keep `AUTH_ENABLED=true` anywhere Google
authentication must be enforced.

## Render deployment

The root `Dockerfile` builds the React dashboard and Python service into one
image. FastAPI serves both the `/api` endpoints and the compiled dashboard, so
the UI and backend share one Render host and port. The container starts Uvicorn
on `0.0.0.0` using Render's `PORT` value (defaulting locally to `10000`).

Create a Render Blueprint from `render.yaml` on branch
`feature/ai-harness-20261031`, then provide the prompted OpenAI and MySQL
environment variables. Render uses `/api/health` as its health check. The same
build phases can be run in an environment with Poetry and Node installed:

```sh
sh scripts/render-build.sh all
PORT=10000 sh scripts/start-render.sh
```
