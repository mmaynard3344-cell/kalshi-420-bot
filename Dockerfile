FROM node:24-alpine
WORKDIR /app
COPY artifacts/btc-shadow/*.mjs ./artifacts/btc-shadow/
COPY artifacts/btc-shadow/btcSharedLadder.sql ./artifacts/btc-shadow/
RUN npm install --prefix ./artifacts/btc-shadow --no-save --omit=dev pg@8
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
USER node
CMD ["node", "artifacts/btc-shadow/index.mjs"]
