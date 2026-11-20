# ---- build stage -----------------------------------------------------------
FROM node:22-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# Build-time env only needs to satisfy validation; real values are injected at runtime.
ENV SESSION_SECRET=build-time-placeholder-secret-value-0000000000 \
    ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 \
    MEDIAMTX_API_PASS=build-placeholder \
    DATABASE_URL=postgres://build:build@localhost:5432/build
RUN npm run build

# ---- runtime stage ---------------------------------------------------------
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
RUN addgroup -S vms && adduser -S vms -G vms
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/drizzle ./drizzle
RUN mkdir -p /app/recordings && chown -R vms:vms /app
USER vms
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:3000/api/health/live || exit 1
CMD ["node", "server.js"]
