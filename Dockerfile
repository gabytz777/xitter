FROM oven/bun:1.4.4
# ffmpeg converts uploaded video; pg_dump (from PGDG, matching the server's
# Postgres 18) makes the scheduled backups
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates ffmpeg postgresql-common \
	&& /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y \
	&& apt-get install -y --no-install-recommends postgresql-client-18 \
	&& rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src src
COPY public public
COPY scripts scripts
COPY instances.json instances.json
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/entrypoint
# volumes mount here; created now so they belong to the bun user
RUN mkdir -p client media data && chown bun:bun client media data
USER bun
ENV PORT=3000
EXPOSE 3000
# unhealthy when the server stops answering or can't reach its database; the
# long start allows for the client download on a first start
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
	CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/usr/local/bin/entrypoint"]
CMD ["bun", "src/server.ts"]
