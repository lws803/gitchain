FROM node:20-alpine

# git is needed by git-server (git daemon) and by the post-receive hook
RUN apk add --no-cache curl git

WORKDIR /app

# Install dependencies first for better layer caching
COPY package*.json ./
RUN npm ci

# Copy source
COPY . .

# Compile TypeScript → dist/
RUN npm run build

# Compile Solidity contracts → artifacts/
RUN npx hardhat compile

# Shared and repos directories will be provided by Docker volumes at runtime
RUN mkdir -p /app/shared /app/repos
