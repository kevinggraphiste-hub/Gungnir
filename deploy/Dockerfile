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

# System deps + Node.js (needed for MCP servers via npx) + Playwright/Chromium deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    # Chromium dependencies for Playwright
    libnss3 libnspr4 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libxkbcommon0 libatspi2.0-0 libxcomposite1 \
    libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 \
    libcairo2 libasound2 libwayland-client0 \
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

# Install Chromium for Playwright (browser automation)
# Set PLAYWRIGHT_BROWSERS_PATH so all users can access it
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
RUN python -m playwright install chromium \
    && chmod -R 755 /opt/pw-browsers

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

# Install gosu for dropping privileges in entrypoint
RUN apt-get update && apt-get install -y --no-install-recommends gosu && rm -rf /var/lib/apt/lists/*

# Copy entrypoint script
COPY deploy/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Expose backend port
EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD curl -f http://localhost:8000/api/health || exit 1

# Run as root initially — entrypoint fixes permissions then drops to gungnir
ENTRYPOINT ["/entrypoint.sh"]
