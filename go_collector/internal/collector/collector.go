package collector

type SNMPTarget struct {
	ServiceID string
	Host      string
	Port      int
	Community string
}

type Collector interface {
	Collect(target SNMPTarget) (Metrics, error)
}

type Metrics struct {
	CPUUsagePercent  float64
	RAMUsageMB       int
	RAMTotalMB       int
	DiskUsagePercent float64
	BandwidthInMB    float64
	BandwidthOutMB   float64
	UptimeSeconds    int64
	ServiceUp        bool
	SNMPLatencyMs    int
}
