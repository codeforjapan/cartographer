# =============================================================================
# Stage 1: Build the Haskell backend using Nix
# =============================================================================
FROM nixos/nix:latest AS builder

RUN mkdir -p /etc/nix && \
    echo "experimental-features = nix-command flakes" >> /etc/nix/nix.conf && \
    echo "extra-substituters = https://kotto5.cachix.org" >> /etc/nix/nix.conf && \
    echo "extra-trusted-public-keys = kotto5.cachix.org-1:kIqTVHIxWyPkkiJ24ceZpS6JVvs2BE8GTIA48virk/s=" >> /etc/nix/nix.conf

WORKDIR /src

# Copy flake inputs first for better caching
COPY flake.nix flake.lock ./
RUN nix flake metadata . 2>/dev/null || true

# Copy the rest of the source
COPY . .

# Build the backend binary
RUN nix build .#cartographer-backend

# Export the Nix closure (binary + all runtime dependencies)
RUN mkdir -p /export/nix/store && \
    cp -a $(nix-store -qR result) /export/nix/store/ && \
    readlink -f result/bin/cartographer-backend > /export/binary-path

# =============================================================================
# Stage 2: Minimal runtime image
# =============================================================================
FROM debian:bookworm-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends curl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Copy the Nix store closure (includes all shared libraries the binary needs)
COPY --from=builder /export/nix/store /nix/store
COPY --from=builder /export/binary-path /tmp/binary-path

RUN ln -s "$(cat /tmp/binary-path)" /usr/local/bin/cartographer-backend && \
    rm /tmp/binary-path

# Create app user matching EFS access point UID/GID
RUN groupadd -g 1000 app && \
    useradd -u 1000 -g app -m -d /app app

WORKDIR /app
RUN chown -R app:app /app

EXPOSE 8080

ENV M36_DATA_PATH=/app/.m36-data

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

# Docker ボリュームが root で作成される場合があるため、
# entrypoint で権限を修正してから app ユーザーで起動する
COPY --chmod=755 <<'EOF' /entrypoint.sh
#!/bin/sh
set -e
# Docker ボリュームのマウントポイントが root:root で作成されるため、
# app ユーザーが書き込めるように権限を修正する
m36_parent=$(dirname "${M36_DATA_PATH}")
chown -R app:app "$m36_parent"
exec su -s /bin/sh app -c 'exec cartographer-backend'
EOF

ENTRYPOINT ["/entrypoint.sh"]
