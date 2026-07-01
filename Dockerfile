# syntax=docker/dockerfile:1

# ---- deps: install node_modules once, with a warm npm cache ----
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

# ---- runner: the image that actually ships ----
# The app runs TypeScript directly via tsx (no compile step), so we carry
# node_modules + src and start it the same way `npm start` does locally.
FROM node:22-alpine AS runner
ENV NODE_ENV=production \
    PORT=8787 \
    LMSTUDIO_BASE_URL=http://host.docker.internal:1234/v1 \
    MCP_URL=http://host.docker.internal:8000/mcp
WORKDIR /app

COPY --chown=node:node --from=deps /app/node_modules ./node_modules
COPY --chown=node:node package.json tsconfig.json ./
COPY --chown=node:node src ./src

USER node
EXPOSE 8787

# Uses the app's own /health route (returns {status:"ok"}).
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]
