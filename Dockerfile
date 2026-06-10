FROM oven/bun:1.3.14

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates python3 \
  && rm -rf /var/lib/apt/lists/* \
  && curl -LsSf https://astral.sh/uv/install.sh | sh

ENV PATH="/root/.local/bin:${PATH}"
ENV VIDEO_DIGEST_OUTPUT_DIR=/data/outputs
ENV VIDEO_DIGEST_DB_PATH=/data/ingestions.sqlite
ENV PORT=3000
ENV HOST=0.0.0.0

WORKDIR /app

COPY package.json bun.lock tsconfig.json ./
COPY python ./python
COPY src ./src

RUN cd python && uv sync --frozen

EXPOSE 3000
VOLUME ["/data"]

CMD ["bun", "run", "src/web/server.ts"]
