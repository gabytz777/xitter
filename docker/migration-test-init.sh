#!/bin/sh
# the second instance's database (docker/migration-test.yaml)
set -e
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "create database xit_b"
