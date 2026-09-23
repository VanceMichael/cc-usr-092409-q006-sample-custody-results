FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY test ./test
COPY contracts ./contracts
COPY fixtures ./fixtures
RUN npm test
EXPOSE 3000
CMD ["npm", "start"]
