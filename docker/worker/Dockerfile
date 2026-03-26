FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV PATH="/root/.local/bin:/root/.cursor/bin:${PATH}"

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl git tini \
  && rm -rf /var/lib/apt/lists/*

RUN curl https://cursor.com/install -fsS | bash && agent --version

WORKDIR /app

COPY docker/worker/entrypoint.sh /usr/local/bin/entrypoint.sh

RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
