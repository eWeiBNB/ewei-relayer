# ── Build stage ──────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# ── Production stage ─────────────────────────────────
FROM node:20-alpine AS runner

RUN apk add --no-cache tini curl
RUN addgroup -g 1001 -S ewei && adduser -S ewei -u 1001 -G ewei

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY src/db/schema.sql ./dist/db/
COPY src/db/migrations/ ./dist/db/migrations/

RUN chown -R ewei:ewei /app
USER ewei

EXPOSE 3100 9090

HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD curl -f http://localhost:3100/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
