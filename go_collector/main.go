package main

import (
	"fmt"
	"log"
	"os"
	"strconv"
	"time"

	"github.com/cuy-sentinel/collector/internal/collector"
	"github.com/cuy-sentinel/collector/internal/storage"
)

type config struct {
	dsn      string
	interval time.Duration
}

func loadConfig() config {
	dsn := os.Getenv("PG_DSN")
	if dsn == "" {
		dsn = "postgres://app:app_secret_2025@localhost:5432/postgres?sslmode=disable"
	}

	seconds, _ := strconv.Atoi(os.Getenv("SNMP_INTERVAL"))
	if seconds <= 0 {
		seconds = 300
	}

	return config{
		dsn:      dsn,
		interval: time.Duration(seconds) * time.Second,
	}
}

func main() {
	cfg := loadConfig()

	store, err := storage.NewPostgresStorage(cfg.dsn)
	if err != nil {
		log.Fatalf("storage: %v", err)
	}
	defer store.Close()

	col := collector.NewSNMPCollector()
	activeEvents := map[string]string{}

	log.Printf("collector started — polling every %v", cfg.interval)

	for {
		services, err := store.GetServices()
		if err != nil {
			log.Printf("get services: %v", err)
			time.Sleep(cfg.interval)
			continue
		}

		for _, svc := range services {
			processService(store, col, svc, activeEvents)
		}

		time.Sleep(cfg.interval)
	}
}

func processService(
	store *storage.PostgresStorage,
	col *collector.SNMPCollector,
	svc storage.MonitoredService,
	activeEvents map[string]string,
) {
	syncActiveEvent(store, svc, activeEvents)

	m, collectErr := col.Collect(collector.SNMPTarget{
		ServiceID: svc.ID,
		Host:      svc.Host,
		Port:      svc.SNMPPort,
		Community: svc.Community,
	})

	isDown := collectErr != nil || !m.ServiceUp

	if isDown {
		handleDown(store, svc, collectErr, activeEvents)
	} else {
		handleRecovered(store, svc, activeEvents)
	}

	saveMetric(store, svc, m, isDown)
}

// syncActiveEvent loads the current open event from the DB the first time a
// service is seen, so the in-memory map survives process restarts.
func syncActiveEvent(store *storage.PostgresStorage, svc storage.MonitoredService, activeEvents map[string]string) {
	if _, seen := activeEvents[svc.ID]; seen {
		return
	}
	openID, err := store.ActiveEvent(svc.ID)
	if err != nil {
		log.Printf("active event %s: %v", svc.Name, err)
	}
	activeEvents[svc.ID] = openID
}

func handleDown(store *storage.PostgresStorage, svc storage.MonitoredService, collectErr error, activeEvents map[string]string) {
	if activeEvents[svc.ID] != "" {
		return // event already open
	}

	cause := "SNMP unreachable"
	if collectErr != nil {
		cause = collectErr.Error()
	}

	eventID, err := store.RecordDown(svc.ID, cause)
	if err != nil {
		log.Printf("record down %s: %v", svc.Name, err)
		return
	}

	activeEvents[svc.ID] = eventID
	log.Printf("⚠ %s DOWN — event %s opened", svc.Name, eventID)
}

func handleRecovered(store *storage.PostgresStorage, svc storage.MonitoredService, activeEvents map[string]string) {
	eventID := activeEvents[svc.ID]
	if eventID == "" {
		return // already recovered or never went down
	}

	if err := store.RecordRecovered(svc.ID, eventID); err != nil {
		log.Printf("record recovered %s: %v", svc.Name, err)
		return
	}

	log.Printf("✓ %s RECOVERED — event %s closed", svc.Name, eventID)
	activeEvents[svc.ID] = ""
}

func saveMetric(store *storage.PostgresStorage, svc storage.MonitoredService, m collector.Metrics, isDown bool) {
	status := "online"
	if isDown {
		status = "offline"
	}

	rec := storage.MetricRecord{
		ServiceID:        svc.ID,
		RAMUsageMB:       m.RAMUsageMB,
		RAMTotalMB:       m.RAMTotalMB,
		DiskUsagePercent: m.DiskUsagePercent,
		UptimeSeconds:    m.UptimeSeconds,
		ServiceStatus:    status,
		SNMPLatencyMs:    m.SNMPLatencyMs,
		CollectedAt:      time.Now(),
	}

	if err := store.SaveMetric(rec); err != nil {
		log.Printf("save metric %s: %v", svc.Name, err)
		return
	}

	fmt.Printf("✓ %s — %s\n", svc.Name, status)
}
