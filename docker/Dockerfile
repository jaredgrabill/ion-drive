# Ion Drive — Production Dockerfile
# Multi-stage build for minimal image size

# --- Stage 1: Build ---
FROM node:22-alpine AS builder

RUN corepack enable pnpm

WORKDIR /app

# Copy dependency manifests first for better layer caching.
# Every workspace package.json must be present for --frozen-lockfile to resolve.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/core/package.json ./packages/core/
COPY packages/admin/package.json ./packages/admin/
COPY packages/cli/package.json ./packages/cli/
COPY packages/blocks/package.json ./packages/blocks/
COPY packages/client/package.json ./packages/client/

RUN pnpm install --frozen-lockfile

# Copy source
COPY . .

# Build all packages
RUN pnpm run build

# --- Stage 2: Production ---
FROM node:22-alpine AS production

RUN corepack enable pnpm

# Create non-root user
RUN addgroup -g 1001 -S iongroup && \
    adduser -S ionuser -u 1001 -G iongroup

WORKDIR /app

# Copy built artifacts. Every workspace package.json must be present for
# --frozen-lockfile to resolve (the lockfile has an importer per package).
COPY --from=builder /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=builder /app/packages/core/package.json ./packages/core/
COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/packages/admin/package.json ./packages/admin/
COPY --from=builder /app/packages/admin/dist ./packages/admin/dist
COPY --from=builder /app/packages/cli/package.json ./packages/cli/
COPY --from=builder /app/packages/blocks/package.json ./packages/blocks/
COPY --from=builder /app/packages/client/package.json ./packages/client/

# Install production dependencies only
COPY --from=builder /app/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# Switch to non-root user
USER ionuser

# Serve the admin console from the copied build (explicit path — the admin
# package is a devDependency of core, so it isn't linked by --prod installs).
ENV ION_ADMIN_DIST=/app/packages/admin/dist

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

# Start Ion Drive
CMD ["node", "packages/core/dist/server.js"]
