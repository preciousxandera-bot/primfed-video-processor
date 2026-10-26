
FROM node:20-bookworm-slim

ENV NODE_ENV=production
ENV PORT=3000

# Install FFmpeg for video processing
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Set application directory
WORKDIR /app

# Copy dependency files first
COPY package.json package-lock.json* ./

# Install production dependencies
RUN npm install --omit=dev --no-audit --no-fund

# Copy the application
COPY server.js ./server.js

# Create a temporary working directory
RUN mkdir -p /tmp/primfed-videos \
    && chown -R node:node /app /tmp/primfed-videos

USER node

EXPOSE 3000

CMD ["node", "server.js"]
