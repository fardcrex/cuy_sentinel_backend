package storage

import (
	"database/sql"
	"fmt"

	_ "github.com/lib/pq"
)

type PostgresStorage struct {
	db *sql.DB
}

func NewPostgresStorage(dsn string) (*PostgresStorage, error) {
	db, err := sql.Open("postgres", dsn)
	if err != nil {
		return nil, fmt.Errorf("open db: %w", err)
	}
	if err := db.Ping(); err != nil {
		return nil, fmt.Errorf("ping db: %w", err)
	}
	return &PostgresStorage{db: db}, nil
}

func (s *PostgresStorage) GetServices() ([]MonitoredService, error) {
	rows, err := s.db.Query(
		`SELECT id, service_name, host_ip, snmp_port, 'public' AS community
		 FROM monitored_services WHERE enabled = true`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var services []MonitoredService
	for rows.Next() {
		var svc MonitoredService
		if err := rows.Scan(&svc.ID, &svc.Name, &svc.Host, &svc.SNMPPort, &svc.Community); err != nil {
			return nil, err
		}
		services = append(services, svc)
	}
	return services, rows.Err()
}

func (s *PostgresStorage) SaveMetric(r MetricRecord) error {
	_, err := s.db.Exec(`
		INSERT INTO metrics
			(service_id, cpu_usage_percent, ram_usage_mb, ram_total_mb,
			 disk_usage_percent, bandwidth_in_mb, bandwidth_out_mb,
			 uptime_seconds, service_status, snmp_latency_ms, collected_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
		r.ServiceID, r.CPUUsagePercent, r.RAMUsageMB, r.RAMTotalMB,
		r.DiskUsagePercent, r.BandwidthInMB, r.BandwidthOutMB,
		r.UptimeSeconds, r.ServiceStatus, r.SNMPLatencyMs, r.CollectedAt,
	)
	return err
}

func (s *PostgresStorage) ActiveEvent(serviceID string) (string, error) {
	var id string
	err := s.db.QueryRow(
		`SELECT id FROM service_events
		 WHERE service_id = $1 AND event_type = 'down' AND ended_at IS NULL
		 ORDER BY started_at DESC LIMIT 1`,
		serviceID,
	).Scan(&id)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return id, err
}

func (s *PostgresStorage) RecordDown(serviceID string, cause string) (string, error) {
	existing, err := s.ActiveEvent(serviceID)
	if err != nil {
		return "", err
	}
	if existing != "" {
		return existing, nil
	}
	var id string
	err = s.db.QueryRow(
		`INSERT INTO service_events (service_id, event_type, started_at, cause)
		 VALUES ($1, 'down', now(), $2) RETURNING id`,
		serviceID, cause,
	).Scan(&id)
	return id, err
}

func (s *PostgresStorage) RecordRecovered(serviceID string, openEventID string) error {
	if openEventID != "" {
		_, err := s.db.Exec(
			`UPDATE service_events SET ended_at = now(), resolved = true
			 WHERE id = $1`,
			openEventID,
		)
		if err != nil {
			return err
		}
	}
	_, err := s.db.Exec(
		`INSERT INTO service_events (service_id, event_type, started_at, resolved)
		 VALUES ($1, 'recovered', now(), true)`,
		serviceID,
	)
	return err
}

func (s *PostgresStorage) Close() error { return s.db.Close() }
