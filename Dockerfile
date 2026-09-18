# Dockerfile for pr-shadow
# Multi-stage build: installs dependencies, builds TypeScript, then
# runs the daemon with claude CLI and git available.
# Uses GitHub App discovery plus a user PAT for mirror PR authorship.

# ============================================================
# Stage 1: Build
# ============================================================
FROM node:22-bookworm-slim AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ============================================================
# Stage 2: Runtime
# ============================================================
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist/ ./dist/

RUN git config --global user.email "pr-shadow@users.noreply.github.com" \
  && git config --global user.name "pr-shadow"

RUN mkdir -p /data/repos /data/db

ENV SHADOW_WORK_DIR=/data/repos
ENV SHADOW_DB_PATH=/data/db/state.db

COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

ENTRYPOINT ["/app/entrypoint.sh"]
