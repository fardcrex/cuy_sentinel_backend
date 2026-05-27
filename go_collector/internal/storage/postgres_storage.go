package storage

import (
	"database/sql"
	"fmt"
	"log"
	"time"

	_ "github.com/lib/pq"
)

// retryDelays mirrors the Node collector backoff: 2s→4s→8s→16s→30s×3 (~2 min total).
var retryDelays = []time.Duration{
	2 * time.Second,
	4 * time.Second,
	8 * time.Second,
	16 * time.Second,
	30 * time.Second,
	30 * time.Second,
	30 * time.Second,
}

type PostgresStorage struct {
	db *sql.DB
}

func NewPostgresStorage(dsn string) (*PostgresStorage, error) {
	db, err := sql.Open("postgres", dsn)
	if err != nil {
		return nil, fmt.Errorf("open db: %w", err)
	}

	db.SetMaxOpenConns(5)
	db.SetConnMaxIdleTime(30 * time.Second)

	var lastErr error
	for attempt := 0; attempt <= len(retryDelays); attempt++ {
		if lastErr = db.Ping(); lastErr == nil {
			log.Println("db connected")
			return &PostgresStorage{db: db}, nil
		}
		if attempt == len(retryDelays) {
			break
		}
		delay := retryDelays[attempt]
		log.Printf("db connect attempt %d failed (%v), retrying in %v…", attempt+1, lastErr, delay)
		time.Sleep(delay)
	}
	db.Close()
	return nil, fmt.Errorf("ping db: %w", lastErr)
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

func (s *PostgresStorage) SaveCollectorRun(r CollectorRunRecord) error {
	errMsg := sql.NullString{String: r.ErrorMessage, Valid: r.ErrorMessage != ""}
	_, err := s.db.Exec(`
		INSERT INTO collector_runs
			(started_at, finished_at, services_polled, success, error_message)
		VALUES ($1, $2, $3, $4, $5)`,
		r.StartedAt, r.FinishedAt, r.ServicesPolled, r.Success, errMsg,
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
