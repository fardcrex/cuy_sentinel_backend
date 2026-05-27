# Cuy Sentinel — Guía de Demo: Caídas y Recuperaciones

Guía paso a paso para demostrar el monitoreo en tiempo real de servicios SNMP y nodos de base de datos.

---

## Requisitos previos

Todo el stack debe estar corriendo antes de iniciar:

```bash
docker compose up -d
docker ps --format "table {{.Names}}\t{{.Status}}"
```

Estado esperado:

```
NAMES          STATUS
node_api       Up X minutes (healthy)
go_collector   Up X minutes (healthy)
haproxy        Up X minutes (healthy)
patroni1       Up X minutes
patroni2       Up X minutes
etcd           Up X minutes
passbolt       Up X minutes
chkmonitor     Up X minutes
```

---

## Credenciales de acceso a la API

```
Email:    master@cuy.local
Password: sentinel2025
Base URL: http://localhost:3000
```

Obtener token JWT:

```bash
curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"master@cuy.local","password":"sentinel2025"}' | jq .token
```

Guardar el token en una variable para los siguientes comandos:

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"master@cuy.local","password":"sentinel2025"}' | jq -r .token)
```

---

## Consultas SQL de referencia

Conectarse a la base de datos (a través del primary vía HAProxy):

```bash
docker exec patroni1 psql -U postgres -h 127.0.0.1
# o si patroni1 está caído:
docker exec patroni2 psql -U postgres -h 127.0.0.1
```

### Ver últimos eventos de servicios

```sql
SELECT
  ms.service_name,
  se.event_type,
  se.started_at,
  se.ended_at,
  se.cause,
  se.resolved
FROM service_events se
JOIN monitored_services ms ON ms.id = se.service_id
ORDER BY se.started_at DESC
LIMIT 20;
```

### Ver métricas recientes

```sql
SELECT
  ms.service_name,
  m.service_status,
  m.cpu_usage_percent,
  m.ram_usage_mb,
  m.snmp_latency_ms,
  m.collected_at
FROM metrics m
JOIN monitored_services ms ON ms.id = m.service_id
ORDER BY m.collected_at DESC
LIMIT 20;
```

### Ver últimas ejecuciones del colector

```sql
SELECT started_at, finished_at, services_polled, success, error_message
FROM collector_runs
ORDER BY started_at DESC
LIMIT 10;
```

### Ver eventos activos (sin resolver)

```sql
SELECT ms.service_name, se.event_type, se.started_at, se.cause
FROM service_events se
JOIN monitored_services ms ON ms.id = se.service_id
WHERE se.resolved = false AND se.ended_at IS NULL
ORDER BY se.started_at DESC;
```

---

## Demo 1: Caída de servicio SNMP (Passbolt)

El colector encuesta cada 15 segundos. Al bajar el contenedor, en el próximo ciclo registra el evento `down`.

### Paso 1 — Verificar estado inicial

```bash
curl -s http://localhost:3000/api/monitoring/events/active \
  -H "Authorization: Bearer $TOKEN" | jq .
```

Debe devolver un array vacío `[]` si todo está online.

### Paso 2 — Bajar Passbolt

```bash
docker stop passbolt
```

### Paso 3 — Esperar el próximo ciclo del colector (≤15 segundos)

Observar los logs del colector en tiempo real:

```bash
docker logs -f go_collector
```

Buscar una línea como:

```
⚠ Passbolt DOWN — event <uuid> opened
```

### Paso 4 — Verificar el evento en la API

```bash
# Eventos activos
curl -s http://localhost:3000/api/monitoring/events/active \
  -H "Authorization: Bearer $TOKEN" | jq .

# Métricas recientes (status = offline)
curl -s "http://localhost:3000/api/monitoring/events/recent?limit=5" \
  -H "Authorization: Bearer $TOKEN" | jq .
```

### Paso 5 — Verificar en la base de datos

```sql
SELECT ms.service_name, se.event_type, se.started_at, se.cause, se.resolved
FROM service_events se
JOIN monitored_services ms ON ms.id = se.service_id
ORDER BY se.started_at DESC LIMIT 5;
```

### Paso 6 — Levantar Passbolt

```bash
docker start passbolt
```

### Paso 7 — Verificar recuperación (≤15 segundos)

En los logs del colector:

```
✓ Passbolt RECOVERED — event <uuid> closed
```

En la API — el evento activo desaparece y aparece uno de tipo `recovered`:

```bash
curl -s http://localhost:3000/api/monitoring/events/active \
  -H "Authorization: Bearer $TOKEN" | jq .

curl -s "http://localhost:3000/api/monitoring/events/recent?limit=5" \
  -H "Authorization: Bearer $TOKEN" | jq .
```

---

## Demo 2: Caída de servicio SNMP (ChkMonitor)

Mismos pasos que Demo 1, cambiando el contenedor:

```bash
# Bajar
docker stop chkmonitor

# ... esperar 15s, verificar logs y API ...

# Levantar
docker start chkmonitor
```

---

## Demo 3: Caída de la réplica de base de datos (Patroni2)

Patroni2 es la réplica. Caer la réplica no interrumpe las escrituras, pero sí elimina la redundancia.

### Paso 1 — Verificar estado inicial de los nodos

```bash
curl -s http://localhost:3000/api/monitoring/db-nodes \
  -H "Authorization: Bearer $TOKEN" | jq .
```

Salida esperada:

```json
[
  { "name": "patroni1", "role": "primary", "state": "running", "reachable": true },
  { "name": "patroni2", "role": "replica", "state": "streaming", "reachable": true }
]
```

También se puede consultar Patroni directamente:

```bash
curl -s http://localhost:8008/patroni | jq '{role,state,timeline}'
curl -s http://localhost:8009/patroni | jq '{role,state,timeline}'
```

### Paso 2 — Bajar la réplica

```bash
docker stop patroni2
```

### Paso 3 — Verificar que el primary sigue operativo

El colector y la API siguen escribiendo sin interrupciones (HAProxy `:5432` apunta solo al primary):

```bash
curl -s http://localhost:3000/api/monitoring/db-nodes \
  -H "Authorization: Bearer $TOKEN" | jq .
```

Salida esperada:

```json
[
  { "name": "patroni1", "role": "primary", "state": "running", "reachable": true },
  { "name": "patroni2", "role": "down",    "state": null,      "reachable": false }
]
```

### Paso 4 — Verificar que el colector sigue escribiendo métricas

```bash
docker logs --tail=10 go_collector
```

Las líneas `✓ Passbolt — online` y `✓ ChkMonitor — online` deben seguir apareciendo cada 15s.

### Paso 5 — Levantar la réplica

```bash
docker start patroni2
```

Patroni2 se reconecta automáticamente como réplica y comienza a sincronizar WAL desde el primary. Puede tardar 30–60 segundos en aparecer como `streaming`.

```bash
# Monitorear hasta que vuelva como replica
watch -n5 'curl -s http://localhost:8009/patroni | jq "{role,state}"'
```

---

## Demo 4: Failover del primary (Patroni1)

Esta es la prueba más crítica. Al caer el primary, Patroni promueve automáticamente la réplica como nuevo primary. HAProxy redirige el tráfico al nuevo primary sin cambios de configuración.

> **Importante:** el colector perderá la conexión brevemente durante la elección del nuevo primary (≈10–30 segundos). Esto es normal y esperado.

### Paso 1 — Verificar estado inicial

```bash
curl -s http://localhost:3000/api/monitoring/db-nodes \
  -H "Authorization: Bearer $TOKEN" | jq .
```

Ambos nodos deben estar `reachable: true`. Patroni1 debe ser `primary`.

### Paso 2 — Bajar el primary

```bash
docker stop patroni1
```

### Paso 3 — Observar el failover en los logs del colector

```bash
docker logs -f go_collector
```

Durante la elección verás errores de conexión. Luego Patroni2 es promovido y el colector se reconecta:

```
db connect attempt 1 failed (...), retrying in 2s…
db connect attempt 2 failed (...), retrying in 4s…
db connected
✓ Passbolt — online
✓ ChkMonitor — online
```

### Paso 4 — Verificar el nuevo primary

```bash
curl -s http://localhost:3000/api/monitoring/db-nodes \
  -H "Authorization: Bearer $TOKEN" | jq .
```

Salida esperada:

```json
[
  { "name": "patroni1", "role": "down",    "state": null,      "reachable": false },
  { "name": "patroni2", "role": "primary", "state": "running", "reachable": true, "timeline": 2 }
]
```

El campo `timeline` aumentó (de 1 a 2), lo que confirma que ocurrió un failover.

### Paso 5 — Verificar que las métricas siguieron escribiéndose

```sql
SELECT collected_at, service_status
FROM metrics
ORDER BY collected_at DESC
LIMIT 10;
```

Los timestamps deben ser continuos salvo la brecha de ≈10–30s del failover.

### Paso 6 — Verificar el estado del HAProxy

```bash
curl -s http://localhost:7000 | grep -E "patroni|Status"
```

O abrir el dashboard de HAProxy en el navegador: [http://localhost:7000](http://localhost:7000)

### Paso 7 — Reintegrar Patroni1 como réplica

```bash
docker start patroni1
```

Patroni1 detecta que hay un primary más nuevo (timeline superior) y se une como réplica automáticamente:

```bash
curl -s http://localhost:8008/patroni | jq '{role,state,timeline}'
# Esperado: { "role": "replica", "state": "streaming", "timeline": 2 }
```

---

## Demo 5: Caída simultánea de ambos servicios SNMP

Demuestra que el colector procesa múltiples caídas en el mismo ciclo.

```bash
# Bajar ambos
docker stop passbolt chkmonitor

# Esperar ≤15s y verificar
curl -s http://localhost:3000/api/monitoring/events/active \
  -H "Authorization: Bearer $TOKEN" | jq '[.[] | {service: .monitored_services.service_name, type: .event_type}]'

# Recuperar
docker start passbolt chkmonitor
```

---

## Endpoints de referencia rápida

| Endpoint | Descripción |
|---|---|
| `GET /api/monitoring/events/active` | Eventos de servicios activos (sin resolver) |
| `GET /api/monitoring/events/recent?limit=30` | Últimos N eventos (down + recovered) |
| `GET /api/monitoring/events?serviceId=<uuid>` | Historial de eventos de un servicio |
| `GET /api/monitoring/db-nodes` | Estado actual de los nodos Patroni (primary/replica/down) |
| `GET /api/monitoring/collector?limit=50` | Historial de ejecuciones del colector |
| `GET /health` (puerto 3000) | Health del node_api |
| `GET /health` (puerto 9090) | Health del go_collector |
| `GET /patroni` (puerto 8008) | Estado Patroni del nodo 1 |
| `GET /patroni` (puerto 8009) | Estado Patroni del nodo 2 |

---

## Reset completo del entorno

Para empezar desde cero (borra todos los datos):

```bash
docker compose down -v
docker compose up -d
```

Para solo reiniciar sin borrar datos:

```bash
docker compose restart
```
