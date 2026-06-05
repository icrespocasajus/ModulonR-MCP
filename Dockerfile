FROM node:18-slim

# Install Docker CLI and other dependencies
RUN apt-get update && apt-get install -y \
    docker.io \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files and install dependencies
COPY package.json package-lock.json ./
RUN npm ci --include=dev

# Copy project files
COPY . .

# Build with the project-pinned TypeScript (avoids global TS 6.x deprecation errors)
RUN npm run build

# Expose the port for Streamable HTTP transport
EXPOSE 2030

# Start the server with Streamable HTTP transport
CMD ["node", "build/index.js"]
