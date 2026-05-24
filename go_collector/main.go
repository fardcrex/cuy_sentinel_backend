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

func main() {
	dsn := os.Getenv("PG_DSN")
	if dsn == "" {
		dsn = "postgres://app:app_secret_2025@localhost:5432/postgres?sslmode=disable"
	}
	intervalStr := os.Getenv("SNMP_INTERVAL")
	interval, _ := strconv.Atoi(intervalStr)
	if interval <= 0 {
		interval = 300
	}

	store, err := storage.NewPostgresStorage(dsn)
	if err != nil {
		log.Fatalf("storage: %v", err)
	}
	defer store.Close()

	col := collector.NewSNMPCollector()
	activeEvents := map[string]string{}

	log.Printf("collector started — polling every %ds", interval)

	for {
		services, err := store.GetServices()
		if err != nil {
			log.Printf("get services: %v", err)
			time.Sleep(time.Duration(interval) * time.Second)
			continue
		}

		for _, svc := range services {
			if _, seen := activeEvents[svc.ID]; !seen {
				openID, err := store.ActiveEvent(svc.ID)
				if err != nil {
					log.Printf("active event %s: %v", svc.Name, err)
				}
				activeEvents[svc.ID] = openID
			}

			target := collector.SNMPTarget{
				ServiceID: svc.ID,
				Host:      svc.Host,
				Port:      svc.SNMPPort,
				Community: svc.Community,
			}
			m, collectErr := col.Collect(target)
			isDown := collectErr != nil || !m.ServiceUp
			status := "online"
			if isDown {
				status = "offline"
			}

			if isDown && activeEvents[svc.ID] == "" {
				cause := "SNMP unreachable"
				if collectErr != nil {
					cause = collectErr.Error()
				}
				eventID, err := store.RecordDown(svc.ID, cause)
				if err != nil {
					log.Printf("record down %s: %v", svc.Name, err)
				} else {
					activeEvents[svc.ID] = eventID
					log.Printf("⚠ %s DOWN — event %s opened", svc.Name, eventID)
				}
			}

			if !isDown && activeEvents[svc.ID] != "" {
				if err := store.RecordRecovered(svc.ID, activeEvents[svc.ID]); err != nil {
					log.Printf("record recovered %s: %v", svc.Name, err)
				} else {
					log.Printf("✓ %s RECOVERED — event %s closed", svc.Name, activeEvents[svc.ID])
					activeEvents[svc.ID] = ""
				}
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
			if saveErr := store.SaveMetric(rec); saveErr != nil {
				log.Printf("save metric %s: %v", svc.Name, saveErr)
			} else {
				fmt.Printf("✓ %s — %s\n", svc.Name, status)
			}
		}
		time.Sleep(time.Duration(interval) * time.Second)
	}
}
