FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

CMD ["npx", "tsx", "examples/complete-workflow.ts"]
