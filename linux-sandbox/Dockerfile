FROM node:24.20.0-alpine3.24@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf

WORKDIR /app

COPY --chown=node:node agent.ts ./agent.ts
COPY --chown=node:node workload.mjs ./workload.mjs

USER node

EXPOSE 3000

CMD ["node", "agent.ts"]
