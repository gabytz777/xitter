FROM postgres:18-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends pgbouncer && rm -rf /var/lib/apt/lists/*
COPY --chmod=755 entrypoint.sh /usr/local/bin/pool-entrypoint
USER postgres
EXPOSE 6432
ENTRYPOINT ["/usr/local/bin/pool-entrypoint"]
