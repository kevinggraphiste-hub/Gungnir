# ============================================================================
# Gungnir — Multi-stage Docker build
# Stage 1: Build frontend (Node)
# Stage 2: Production runtime (Python + static frontend)
# ============================================================================

# ── Stage 1: Frontend build ─────────────────────────────────────────────────
FROM node:20-alpine AS frontend-build

WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci --no-audit --no-fund 2>/dev/null || npm install --no-audit --no-fund

COPY frontend/ ./
RUN npm run build


# ── Stage 2: Python backend + static frontend ──────────────────────────────
FROM python:3.12-slim AS production

# System deps + Node.js (needed for MCP servers via npx)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js for MCP (npx) support
COPY --from=frontend-build /usr/local/bin/node /usr/local/bin/node
COPY --from=frontend-build /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -sf /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

# Create non-root user
RUN useradd -m -s /bin/bash gungnir

WORKDIR /app

# Python dependencies
COPY deploy/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Copy backend
COPY backend/ ./backend/

# Copy frontend build from stage 1
COPY --from=frontend-build /build/frontend/dist ./frontend/dist/

# Copy data defaults (will be overridden by volume mount)
COPY data/ ./data/

# Copy project-level files
COPY CLAUDE.md ./CLAUDE.md

# Create data directory structure
RUN mkdir -p data/backups data/workspace data/consciousness \
    && chown -R gungnir:gungnir /app

# Switch to non-root user
USER gungnir

# Expose backend port
EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD curl -f http://localhost:8000/api/health || exit 1

# Start uvicorn
CMD ["python", "-m", "uvicorn", "backend.core.main:app", \
     "--host", "0.0.0.0", "--port", "8000", \
     "--workers", "1", "--loop", "uvloop", \
     "--limit-concurrency", "50"]
