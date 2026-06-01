package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/cuy-sentinel/collector/internal/collector"
	"github.com/cuy-sentinel/collector/internal/storage"
)

// ─── Config ──────────────────────────────────────────────────────────────────

type config struct {
	dsn        string
	interval   time.Duration
	healthPort int
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

	port, _ := strconv.Atoi(os.Getenv("HEALTH_PORT"))
	if port <= 0 {
		port = 9090
	}

	return config{
		dsn:        dsn,
		interval:   time.Duration(seconds) * time.Second,
		healthPort: port,
	}
}

// ─── Health ──────────────────────────────────────────────────────────────────

type healthState struct {
	mu            sync.RWMutex
	status        string // "starting" | "ok" | "error"
	dbConnected   bool
	lastPollAt    *time.Time
	servicesCount int
	startedAt     time.Time
}

func newHealthState() *healthState {
	return &healthState{status: "starting", startedAt: time.Now()}
}

func (h *healthState) setStatus(s string) {
	h.mu.Lock()
	h.status = s
	h.mu.Unlock()
}

func (h *healthState) setDBConnected() {
	h.mu.Lock()
	h.dbConnected = true
	h.status = "ok"
	h.mu.Unlock()
}

func (h *healthState) setPollDone(count int) {
	now := time.Now()
	h.mu.Lock()
	h.servicesCount = count
	h.lastPollAt = &now
	h.status = "ok"
	h.mu.Unlock()
}

func startHealthServer(port int, h *healthState) {
	type response struct {
		Status        string  `json:"status"`
		DBConnected   bool    `json:"dbConnected"`
		LastPollAt    *string `json:"lastPollAt"`
		ServicesCount int     `json:"servicesCount"`
		StartedAt     string  `json:"startedAt"`
		UptimeSeconds int64   `json:"uptimeSeconds"`
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		h.mu.RLock()
		defer h.mu.RUnlock()

		var lastPollAt *string
		if h.lastPollAt != nil {
			s := h.lastPollAt.UTC().Format(time.RFC3339)
			lastPollAt = &s
		}

		code := http.StatusServiceUnavailable
		if h.status == "ok" {
			code = http.StatusOK
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(code)
		json.NewEncoder(w).Encode(response{
			Status:        h.status,
			DBConnected:   h.dbConnected,
			LastPollAt:    lastPollAt,
			ServicesCount: h.servicesCount,
			StartedAt:     h.startedAt.UTC().Format(time.RFC3339),
			UptimeSeconds: int64(time.Since(h.startedAt).Seconds()),
		})
	})

	addr := fmt.Sprintf(":%d", port)
	log.Printf("health server listening on %s", addr)
	go func() {
		if err := http.ListenAndServe(addr, mux); err != nil {
			log.Fatalf("health server: %v", err)
		}
	}()
}

// ─── Main loop ───────────────────────────────────────────────────────────────

func main() {
	cfg := loadConfig()
	hs := newHealthState()

	startHealthServer(cfg.healthPort, hs)

	store, err := storage.NewPostgresStorage(cfg.dsn)
	if err != nil {
		hs.setStatus("error")
		log.Fatalf("storage: %v", err)
	}
	defer store.Close()
	hs.setDBConnected()

	col := collector.NewSNMPCollector()
	activeEvents := map[string]string{}

	log.Printf("collector started — polling every %v", cfg.interval)

	for {
		services, err := store.GetServices()
		if err != nil {
			log.Printf("get services: %v", err)
			hs.setStatus("error")
			time.Sleep(cfg.interval)
			continue
		}

		pollStart := time.Now()
		var pollErrMsg string

		for _, svc := range services {
			if err := processService(store, col, svc, activeEvents); err != nil {
				pollErrMsg = err.Error()
			}
		}

		run := storage.CollectorRunRecord{
			StartedAt:      pollStart,
			FinishedAt:     time.Now(),
			ServicesPolled: len(services),
			Success:        pollErrMsg == "",
			ErrorMessage:   pollErrMsg,
		}
		if err := store.SaveCollectorRun(run); err != nil {
			log.Printf("save collector run: %v", err)
		}

		hs.setPollDone(len(services))
		time.Sleep(cfg.interval)
	}
}

// ─── Service processing ──────────────────────────────────────────────────────

func processService(
	store *storage.PostgresStorage,
	col *collector.SNMPCollector,
	svc storage.MonitoredService,
	activeEvents map[string]string,
) error {
	syncActiveEvent(store, svc, activeEvents)

	m, collectErr := col.Collect(collector.SNMPTarget{
		ServiceID: svc.ID,
		Host:      svc.Host,
		Port:      svc.SNMPPort,
		Community: svc.Community,
	})

	isDown := collectErr != nil || !m.ServiceUp

	var eventErr error
	if isDown {
		eventErr = handleDown(store, svc, collectErr, activeEvents)
	} else {
		eventErr = handleRecovered(store, svc, activeEvents)
	}

	metricErr := saveMetric(store, svc, m, isDown)
	if eventErr != nil {
		return eventErr
	}
	return metricErr
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
		// Leave the key unset so the next poll retries the DB sync.
		return
	}
	activeEvents[svc.ID] = openID
}

func handleDown(store *storage.PostgresStorage, svc storage.MonitoredService, collectErr error, activeEvents map[string]string) error {
	if activeEvents[svc.ID] != "" {
		return nil
	}
	cause := "SNMP unreachable"
	if collectErr != nil {
		cause = collectErr.Error()
	}
	eventID, err := store.RecordDown(svc.ID, cause)
	if err != nil {
		log.Printf("record down %s: %v", svc.Name, err)
		return err
	}
	activeEvents[svc.ID] = eventID
	log.Printf("⚠ %s DOWN — event %s opened", svc.Name, eventID)
	return nil
}

func handleRecovered(store *storage.PostgresStorage, svc storage.MonitoredService, activeEvents map[string]string) error {
	eventID := activeEvents[svc.ID]
	if eventID == "" {
		return nil
	}
	if err := store.RecordRecovered(svc.ID, eventID); err != nil {
		log.Printf("record recovered %s: %v", svc.Name, err)
		return err
	}
	log.Printf("✓ %s RECOVERED — event %s closed", svc.Name, eventID)
	activeEvents[svc.ID] = ""
	return nil
}

func saveMetric(store *storage.PostgresStorage, svc storage.MonitoredService, m collector.Metrics, isDown bool) error {
	status := "online"
	if isDown {
		status = "offline"
	}

	rec := storage.MetricRecord{
		ServiceID:        svc.ID,
		CPUUsagePercent:  m.CPUUsagePercent,
		RAMUsageMB:       m.RAMUsageMB,
		RAMTotalMB:       m.RAMTotalMB,
		DiskUsagePercent: m.DiskUsagePercent,
		BandwidthInMB:    m.BandwidthInMB,
		BandwidthOutMB:   m.BandwidthOutMB,
		UptimeSeconds:    m.UptimeSeconds,
		ServiceStatus:    status,
		SNMPLatencyMs:    m.SNMPLatencyMs,
		CollectedAt:      time.Now(),
	}

	if err := store.SaveMetric(rec); err != nil {
		log.Printf("save metric %s: %v", svc.Name, err)
		return err
	}

	fmt.Printf("✓ %s — %s\n", svc.Name, status)
	return nil
}
