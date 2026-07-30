FROM node:26-slim

WORKDIR /app

COPY package.json ./
RUN npm ci --production

COPY controller.mjs ./

USER 1001

CMD ["node", "controller.mjs"]
