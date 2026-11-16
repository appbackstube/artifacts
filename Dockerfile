FROM node:22-alpine
ENV NODE_ENV=production HOST=0.0.0.0 PORT=47381 DATA_DIR=/data
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && mkdir /data && chown node:node /data
COPY --chown=node:node server.mjs ./
COPY --chown=node:node lib ./lib
USER node
EXPOSE 47381
VOLUME /data
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD node -e "fetch('http://127.0.0.1:47381/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
