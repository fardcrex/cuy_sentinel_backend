-- ============================================================
-- Cuy Sentinel — Fase 2 schema (PostgreSQL 15 standalone)
-- ============================================================
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Usuario de aplicación (Node.js API + Go collector)
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app') THEN
    CREATE ROLE app LOGIN PASSWORD 'app_secret_2025';
  END IF;
END $$;

-- =============================================================
-- TABLAS
-- =============================================================
CREATE TABLE IF NOT EXISTS users (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email             TEXT NOT NULL UNIQUE,
    password_hash     TEXT NOT NULL,
    display_name      TEXT NOT NULL,
    role              TEXT NOT NULL DEFAULT 'viewer'
                      CHECK (role IN ('master', 'admin', 'viewer')),
    last_login        TIMESTAMPTZ,
    session_expires_at TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_access_logs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    display_name    TEXT NOT NULL,
    action          TEXT NOT NULL CHECK (action IN ('login', 'logout')),
    timestamp       TIMESTAMPTZ NOT NULL DEFAULT now(),
    ip_address      TEXT,
    device_name     TEXT,
    device_platform TEXT
);

CREATE TABLE IF NOT EXISTS monitored_services (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service_name    TEXT NOT NULL UNIQUE,
    container_name  TEXT NOT NULL,
    host_ip         TEXT NOT NULL,
    snmp_port       INTEGER NOT NULL,
    description     TEXT,
    enabled         BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS metrics (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service_id          UUID NOT NULL REFERENCES monitored_services(id) ON DELETE CASCADE,
    cpu_usage_percent   NUMERIC(5,2),
    ram_usage_mb        INTEGER,
    ram_total_mb        INTEGER,
    disk_usage_percent  NUMERIC(5,2),
    bandwidth_in_mb     NUMERIC(10,3),
    bandwidth_out_mb    NUMERIC(10,3),
    uptime_seconds      BIGINT,
    service_status      TEXT NOT NULL DEFAULT 'online'
                        CHECK (service_status IN ('online','offline','degraded','warning')),
    snmp_latency_ms     INTEGER,
    snmp_loss_percent   NUMERIC(5,2),
    collected_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS service_events (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service_id  UUID NOT NULL REFERENCES monitored_services(id) ON DELETE CASCADE,
    event_type  TEXT NOT NULL CHECK (event_type IN ('down','recovered','degraded','warning')),
    started_at  TIMESTAMPTZ NOT NULL,
    ended_at    TIMESTAMPTZ,
    cause       TEXT,
    resolved    BOOLEAN NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS alert_thresholds (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service_id      UUID REFERENCES monitored_services(id) ON DELETE CASCADE,
    metric_name     TEXT NOT NULL CHECK (metric_name IN (
                        'cpu_usage_percent','ram_usage_mb','disk_usage_percent',
                        'bandwidth_in_mb','bandwidth_out_mb','snmp_latency_ms')),
    threshold_value NUMERIC(12,3) NOT NULL,
    severity        TEXT NOT NULL CHECK (severity IN ('critical','nuclear','warning','info')),
    enabled         BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS alert_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service_id      UUID NOT NULL REFERENCES monitored_services(id) ON DELETE CASCADE,
    service_name    TEXT NOT NULL,
    metric_name     TEXT NOT NULL,
    current_value   NUMERIC(12,3) NOT NULL,
    threshold_value NUMERIC(12,3) NOT NULL,
    severity        TEXT NOT NULL CHECK (severity IN ('critical','nuclear','warning','info')),
    triggered_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved        BOOLEAN NOT NULL DEFAULT false,
    resolved_at     TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS collector_runs (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    started_at        TIMESTAMPTZ NOT NULL,
    finished_at       TIMESTAMPTZ,
    services_polled   INTEGER NOT NULL DEFAULT 0,
    success           BOOLEAN NOT NULL DEFAULT false,
    error_message     TEXT,
    collector_version TEXT
);

-- =============================================================
-- ÍNDICES
-- =============================================================
CREATE INDEX IF NOT EXISTS idx_metrics_service_collected
    ON metrics (service_id, collected_at DESC);
CREATE INDEX IF NOT EXISTS idx_metrics_collected_desc
    ON metrics (collected_at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_events_active
    ON alert_events (resolved, triggered_at DESC) WHERE resolved = false;
CREATE INDEX IF NOT EXISTS idx_access_logs_user
    ON user_access_logs (user_id, timestamp DESC);

-- =============================================================
-- PERMISOS para rol 'app'
-- =============================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app;

-- =============================================================
-- DATOS SEMILLA
-- =============================================================
INSERT INTO monitored_services (service_name, container_name, host_ip, snmp_port, description)
VALUES
    ('Passbolt',   'passbolt',   'passbolt',   1161, 'Gestor de contraseñas corporativo'),
    ('ChkMonitor', 'chkmonitor', 'chkmonitor', 2161, 'Monitor de disponibilidad web')
ON CONFLICT (service_name) DO NOTHING;

INSERT INTO alert_thresholds (metric_name, threshold_value, severity) VALUES
    ('cpu_usage_percent',  90.0,  'critical'),
    ('cpu_usage_percent',  75.0,  'warning'),
    ('disk_usage_percent', 90.0,  'critical'),
    ('snmp_latency_ms',    500.0, 'critical')
ON CONFLICT DO NOTHING;

-- Usuario master por defecto (password: sentinel2025)
-- Reemplazar el hash con: node -e "require('bcrypt').hash('sentinel2025',10).then(console.log)"
INSERT INTO users (email, password_hash, display_name, role)
VALUES ('master@cuy.local', '$2b$10$ZMlmwEVIkX5PdkAfIzO7oelCsImr.KFHdaAf3BGpgyACxMNLWAvqC', 'Master Admin', 'master')
ON CONFLICT (email) DO NOTHING;

-- =============================================================
-- NOTIFY para Socket.IO (Go collector → Node.js push)
-- =============================================================
CREATE OR REPLACE FUNCTION notify_new_metric()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('new_metric', row_to_json(NEW)::text);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER trg_metrics_notify
AFTER INSERT ON metrics
FOR EACH ROW EXECUTE FUNCTION notify_new_metric();
