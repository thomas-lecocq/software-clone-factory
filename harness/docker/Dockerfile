# Image for implementer agents (builder, breaker). The agent sees only the sandbox mounted at /work:
# no host file system, no holdout, no git history, no secrets beyond its model credential.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

RUN apt-get update && apt-get install -y --no-install-recommends jq rsync && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code@2.1.285

# Dependencies live outside /work so the mounted sandbox cannot shadow them; Node resolves
# /node_modules by walking up from /work.
COPY package.json package-lock.json /
RUN cd / && npm ci --ignore-scripts && chown -R pwuser:pwuser /node_modules
ENV PATH="/node_modules/.bin:${PATH}"

USER pwuser
WORKDIR /work
