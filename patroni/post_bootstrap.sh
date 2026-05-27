#!/bin/bash
set -e

export PGPASSWORD=postgres_pass_2025
PSQL="psql -U postgres -h 127.0.0.1 -p 5432"

$PSQL -c "CREATE USER admin WITH PASSWORD 'admin_pass_2025' CREATEROLE CREATEDB;"
$PSQL -c "CREATE USER app   WITH PASSWORD 'app_secret_2025' LOGIN;"
$PSQL -f /etc/patroni/init.sql
echo "post_bootstrap: users and schema created"
