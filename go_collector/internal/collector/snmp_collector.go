package collector

import (
	"fmt"
	"time"

	"github.com/gosnmp/gosnmp"
)

const (
	oidSysUptime      = "1.3.6.1.2.1.1.3.0"
	oidIfInOctets     = "1.3.6.1.2.1.2.2.1.10.1"
	oidIfOutOctets    = "1.3.6.1.2.1.2.2.1.16.1"
	oidHrStorageUsed  = "1.3.6.1.2.1.25.2.3.1.6.1"
	oidHrStorageSize  = "1.3.6.1.2.1.25.2.3.1.5.1"
	oidHrStorageAlloc = "1.3.6.1.2.1.25.2.3.1.4.1"
	oidHrMemUsed      = "1.3.6.1.2.1.25.2.3.1.6.2"
	oidHrMemTotal     = "1.3.6.1.2.1.25.2.3.1.5.2"
	oidHrMemAllocUnit = "1.3.6.1.2.1.25.2.3.1.4.2"
	oidHrCpuLoad      = "1.3.6.1.2.1.25.3.3.1.2.1"
)

type SNMPCollector struct{}

func NewSNMPCollector() *SNMPCollector { return &SNMPCollector{} }

func (c *SNMPCollector) Collect(target SNMPTarget) (Metrics, error) {
	g := &gosnmp.GoSNMP{
		Target:    target.Host,
		Port:      uint16(target.Port),
		Community: target.Community,
		Version:   gosnmp.Version2c,
		Timeout:   5 * time.Second,
		Retries:   1,
	}
	start := time.Now()
	if err := g.Connect(); err != nil {
		return Metrics{ServiceUp: false}, fmt.Errorf("connect: %w", err)
	}
	defer g.Conn.Close()

	oids := []string{
		oidSysUptime, oidIfInOctets, oidIfOutOctets,
		oidHrStorageUsed, oidHrStorageSize, oidHrStorageAlloc,
		oidHrMemUsed, oidHrMemTotal, oidHrMemAllocUnit,
		oidHrCpuLoad,
	}
	result, err := g.Get(oids)
	latencyMs := int(time.Since(start).Milliseconds())
	if err != nil {
		return Metrics{ServiceUp: false, SNMPLatencyMs: latencyMs},
			fmt.Errorf("get: %w", err)
	}

	m := Metrics{ServiceUp: true, SNMPLatencyMs: latencyMs}
	var memUsedRaw, memTotalRaw, memAlloc int64
	for _, pdu := range result.Variables {
		val := gosnmp.ToBigInt(pdu.Value).Int64()
		switch pdu.Name {
		case "." + oidSysUptime:
			m.UptimeSeconds = val / 100
		case "." + oidIfInOctets:
			m.BandwidthInMB = float64(val) / 1_048_576
		case "." + oidIfOutOctets:
			m.BandwidthOutMB = float64(val) / 1_048_576
		case "." + oidHrCpuLoad:
			m.CPUUsagePercent = float64(val)
		case "." + oidHrMemUsed:
			memUsedRaw = val
		case "." + oidHrMemTotal:
			memTotalRaw = val
		case "." + oidHrMemAllocUnit:
			memAlloc = val
		}
	}
	if memAlloc > 0 {
		m.RAMUsageMB = int((memUsedRaw * memAlloc) / (1024 * 1024))
		m.RAMTotalMB = int((memTotalRaw * memAlloc) / (1024 * 1024))
	} else if memUsedRaw > 0 {
		// fallback: assume 1KiB allocation units (common on Linux net-snmp)
		m.RAMUsageMB = int(memUsedRaw / 1024)
		m.RAMTotalMB = int(memTotalRaw / 1024)
	}

	var used, size, alloc int64
	for _, pdu := range result.Variables {
		v := gosnmp.ToBigInt(pdu.Value).Int64()
		switch pdu.Name {
		case "." + oidHrStorageUsed:
			used = v
		case "." + oidHrStorageSize:
			size = v
		case "." + oidHrStorageAlloc:
			alloc = v
		}
	}
	if size > 0 && alloc > 0 {
		m.DiskUsagePercent = float64(used) / float64(size) * 100
	}
	return m, nil
}
