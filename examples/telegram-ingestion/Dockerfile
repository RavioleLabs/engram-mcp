# Build from the repository root, not the example directory.
FROM node:24-alpine
WORKDIR /app
COPY packages/cloud-sdk/src/ ./packages/cloud-sdk/src/
COPY examples/telegram-ingestion/src/ ./examples/telegram-ingestion/src/
RUN mkdir /data && chown node:node /data
USER node
ENV ENGRAM_TELEGRAM_CONFIG=/config/config.json
ENV TELEGRAM_BOT_TOKEN_FILE=/run/secrets/telegram_bot_token
CMD ["node", "examples/telegram-ingestion/src/run.mjs"]
