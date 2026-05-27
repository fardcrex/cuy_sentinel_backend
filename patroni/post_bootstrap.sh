#!/bin/bash
set -e

export PGPASSWORD=postgres_pass_2025
PSQL="psql -U postgres -h 127.0.0.1 -p 5432"

$PSQL -c "CREATE USER admin WITH PASSWORD 'admin_pass_2025' CREATEROLE CREATEDB;"
$PSQL -c "CREATE USER app   WITH PASSWORD 'app_secret_2025' LOGIN;"

# rewind_user: Patroni 4.x creates it AFTER post_bootstrap, so we create it here
# to be able to grant pg_monitor immediately. The later Patroni create is a no-op
# because it uses ALTER USER on an existing role.
$PSQL -c "DO \$\$BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'rewind_user') THEN
    CREATE USER rewind_user WITH PASSWORD 'rewind_pass_2025' LOGIN;
  END IF;
END\$\$;"
$PSQL -c "GRANT pg_monitor TO rewind_user;"

$PSQL -f /etc/patroni/init.sql
echo "post_bootstrap: users and schema created"
