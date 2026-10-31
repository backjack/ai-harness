FROM node:24-bookworm-slim AS frontend-builder

WORKDIR /app
COPY scripts/render-build.sh scripts/render-build.sh
COPY frontend frontend
RUN sh scripts/render-build.sh frontend

FROM python:3.13-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    POETRY_VERSION=2.5.1

WORKDIR /app
RUN pip install "poetry==${POETRY_VERSION}"
COPY pyproject.toml poetry.lock poetry.toml ./
COPY scripts/render-build.sh scripts/render-build.sh
RUN sh scripts/render-build.sh backend

COPY controllers controllers
COPY resources resources
COPY services services
COPY utils utils
COPY main.py ./
COPY scripts/start-render.sh scripts/start-render.sh
COPY --from=frontend-builder /app/frontend/dist frontend/dist

EXPOSE 10000
CMD ["sh", "scripts/start-render.sh"]
