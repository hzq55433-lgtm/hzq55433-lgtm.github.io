FROM node:24-alpine
WORKDIR /app
COPY package.json server.mjs local-library.mjs server-validation.cjs game2048-core.js ./
COPY index.html styles.css journal.css games.css account.css library.css app.js journal.js games.js account.js library.js ./
COPY vendor ./vendor
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4317 DATA_FILE=/app/data/site.sqlite
EXPOSE 4317
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:4317/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
