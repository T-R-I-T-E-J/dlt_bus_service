FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY scripts/production-preflight.mjs ./scripts/production-preflight.mjs
USER node
EXPOSE 3000
CMD ["sh", "-c", "npm run preflight:prod && exec node --experimental-strip-types src/app.ts"]

# Privileged operations are an explicit one-off service, never the API startup.
FROM runtime AS tools
COPY migrations ./migrations
COPY scripts/migrate.mjs scripts/bootstrap-admin.mjs scripts/configure-boarding-staff.mjs ./scripts/
CMD ["node", "scripts/migrate.mjs"]
