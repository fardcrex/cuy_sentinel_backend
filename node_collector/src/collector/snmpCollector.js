'use strict';

const snmp = require('net-snmp');

const OIDS = {
  sysUptime:      '1.3.6.1.2.1.1.3.0',
  ifInOctets:     '1.3.6.1.2.1.2.2.1.10.1',
  ifOutOctets:    '1.3.6.1.2.1.2.2.1.16.1',
  hrStorageUsed:  '1.3.6.1.2.1.25.2.3.1.6.1',
  hrStorageSize:  '1.3.6.1.2.1.25.2.3.1.5.1',
  hrStorageAlloc: '1.3.6.1.2.1.25.2.3.1.4.1',
  hrMemUsed:      '1.3.6.1.2.1.25.2.3.1.6.2',
  hrMemTotal:     '1.3.6.1.2.1.25.2.3.1.5.2',
  hrMemAllocUnit: '1.3.6.1.2.1.25.2.3.1.4.2',
  hrCpuLoad:      '1.3.6.1.2.1.25.3.3.1.2.1',
};

function collect(target) {
  return new Promise((resolve) => {
    const start = Date.now();

    const session = snmp.createSession(target.host, target.community, {
      port: target.port,
      version: snmp.Version2c,
      timeout: 5000,
      retries: 1,
    });

    session.get(Object.values(OIDS), (error, varbinds) => {
      const latencyMs = Date.now() - start;
      session.close();

      if (error) {
        resolve({ serviceUp: false, snmpLatencyMs: latencyMs });
        return;
      }

      const vals = {};
      for (const vb of varbinds) {
        if (snmp.isVarbindError(vb)) continue;
        const oid = vb.oid.replace(/^\./, '');
        // Counter64 arrives as a Buffer; all others are plain numbers.
        vals[oid] = Buffer.isBuffer(vb.value)
          ? Number(vb.value.readBigUInt64BE(0))
          : Number(vb.value);
      }

      const get = (oid) => vals[oid] ?? 0;

      const memUsed  = get(OIDS.hrMemUsed);
      const memTotal = get(OIDS.hrMemTotal);
      const memAlloc = get(OIDS.hrMemAllocUnit);
      const storUsed  = get(OIDS.hrStorageUsed);
      const storSize  = get(OIDS.hrStorageSize);
      const storAlloc = get(OIDS.hrStorageAlloc);

      let ramUsageMB = 0;
      let ramTotalMB = 0;
      if (memAlloc > 0) {
        ramUsageMB = Math.floor((memUsed * memAlloc) / (1024 * 1024));
        ramTotalMB = Math.floor((memTotal * memAlloc) / (1024 * 1024));
      } else if (memUsed > 0) {
        // fallback: assume 1 KiB allocation units (common on Linux net-snmp)
        ramUsageMB = Math.floor(memUsed / 1024);
        ramTotalMB = Math.floor(memTotal / 1024);
      }

      const diskUsagePercent =
        storSize > 0 && storAlloc > 0
          ? (storUsed / storSize) * 100
          : 0;

      resolve({
        serviceUp:        true,
        snmpLatencyMs:    latencyMs,
        uptimeSeconds:    Math.floor(get(OIDS.sysUptime) / 100),
        bandwidthInMB:    get(OIDS.ifInOctets) / 1_048_576,
        bandwidthOutMB:   get(OIDS.ifOutOctets) / 1_048_576,
        cpuUsagePercent:  get(OIDS.hrCpuLoad),
        ramUsageMB,
        ramTotalMB,
        diskUsagePercent,
      });
    });
  });
}

module.exports = { collect };
