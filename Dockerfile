FROM node:22-bookworm-slim AS web-builder

WORKDIR /build/web

COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY web/ ./
RUN npm run build


FROM python:3.12-slim-bookworm AS app

# Local-mode deployments analyze on the server and need native Stockfish. Hosted
# deployments (CHESS_COACH_PERSISTENCE_MODE=hosted) compute in the browser and must
# be built with INSTALL_NATIVE_STOCKFISH=false so no engine binary ships at all.
ARG INSTALL_NATIVE_STOCKFISH=true

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    CHESS_COACH_DATA_DIR=/app/runtime/data \
    CHESS_COACH_MODEL_DIR=/app/runtime/models \
    CHESS_COACH_FRONTEND_DIST=/app/web/dist \
    STOCKFISH_PATH=/usr/games/stockfish

RUN apt-get update \
    && apt-get install --no-install-recommends -y libgomp1 \
    && if [ "$INSTALL_NATIVE_STOCKFISH" = "true" ]; then \
        apt-get install --no-install-recommends -y stockfish; \
    fi \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY pyproject.toml README.md ./
COPY src/ ./src/
RUN pip install --no-cache-dir .

COPY --from=web-builder /build/web/dist ./web/dist

RUN mkdir -p /app/runtime/data /app/runtime/models \
    && addgroup --system chess-coach \
    && adduser --system --ingroup chess-coach chess-coach \
    && chown -R chess-coach:chess-coach /app

USER chess-coach

EXPOSE 10000

CMD ["sh", "-c", "exec chess-coach ui --host 0.0.0.0 --port \"${PORT:-10000}\" --no-open"]
