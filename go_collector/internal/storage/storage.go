package storage

import "time"

type MetricRecord struct {
	ServiceID        string
	CPUUsagePercent  float64
	RAMUsageMB       int
	RAMTotalMB       int
	DiskUsagePercent float64
	BandwidthInMB    float64
	BandwidthOutMB   float64
	UptimeSeconds    int64
	ServiceStatus    string // 'online' | 'offline' | 'degraded'
	SNMPLatencyMs    int
	CollectedAt      time.Time
}

type Storage interface {
	SaveMetric(record MetricRecord) error
	GetServices() ([]MonitoredService, error)
	// RecordDown opens a service_events row (event_type='down') if none is open.
	// Returns the ID of the open event (new or existing).
	RecordDown(serviceID string, cause string) (string, error)
	// RecordRecovered closes the open event and inserts a 'recovered' event.
	RecordRecovered(serviceID string, openEventID string) error
	// ActiveEvent returns the ID of the open 'down' event for the service,
	// or "" if none exists.
	ActiveEvent(serviceID string) (string, error)
	Close() error
}

type MonitoredService struct {
	ID        string
	Name      string
	Host      string
	SNMPPort  int
	Community string
	Enabled   bool
}
