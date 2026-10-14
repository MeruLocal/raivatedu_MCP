# ---------------------------------------------------------------------------
# raivat-education-mcp-server — read-only MCP server for raivatedu.com.
#
# Multi-stage. Final image runs the server over the Streamable HTTP transport
# as a non-root user, binds 0.0.0.0:3000, and contains only production
# dependencies — no dev toolchain and no TypeScript sources.
#
# The server fetches public pages from raivatedu.com at runtime, so the only
# network the BUILD needs is the npm registry in stage 1. (stdio mode is also
# available via `--`-less CMD override, but a container is meant to be reached
# on a port, so HTTP is the default.)
# ---------------------------------------------------------------------------

# ---- Stage 1: install all dependencies (incl. dev, for the build) ----------
FROM node:22-alpine AS deps
WORKDIR /app

# libc6-compat: some npm postinstall binaries expect glibc symbols on musl.
RUN apk add --no-cache libc6-compat

COPY package.json package-lock.json* ./
RUN npm ci

# ---- Stage 2: build TypeScript -> dist/ ------------------------------------
FROM node:22-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NODE_ENV=production
RUN npm run build

# ---- Stage 3: production dependencies only ---------------------------------
# A clean install with no dev dependencies, for a small runtime image.
FROM node:22-alpine AS prod-deps
WORKDIR /app

RUN apk add --no-cache libc6-compat
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts

# ---- Stage 4: runtime ------------------------------------------------------
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
# Express binds every interface by default; PORT is read by dist/index.js.
# Optional runtime overrides (all have safe defaults — see .env.example):
#   RAIVATEDU_DEFAULT_MARKET  — market used when a tool omits one (default in)
#   RAIVATEDU_TIMEOUT_MS      — per-request timeout (default 15000)
#   RAIVATEDU_LOG_LEVEL       — debug|info|warn|error|silent (default info)
# Pass them with `docker run -e RAIVATEDU_DEFAULT_MARKET=us ...`.
# ENV RAIVATEDU_DEFAULT_MARKET=in

RUN addgroup -g 1001 -S nodejs \
 && adduser -S mcp -u 1001

# Production node_modules, the built server, and the manifest.
COPY --from=prod-deps --chown=mcp:nodejs /app/node_modules ./node_modules
COPY --from=builder   --chown=mcp:nodejs /app/dist ./dist
COPY --from=builder   --chown=mcp:nodejs /app/package.json ./package.json

USER mcp

EXPOSE 3000

# Container-level health signal; hits the server's own /health endpoint.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Run over Streamable HTTP so the server is reachable on the port.
# For stdio instead, override: `docker run ... node dist/index.js`.
CMD ["node", "dist/index.js", "--http"]
