# Cuy Sentinel Backend

Backend monorepo para el panel de monitoreo Cuy Sentinel.
Proyecto universitario — Programación de Interfaces y Dispositivos Periféricos.

Equipo: Jair Conislla Bocangel · Daniel Rojas Sanchez · Jheampierre Ralli Peralta.

---

## Estructura del proyecto

```
cuy_sentinel_backend/
├── go_collector/
│   ├── internal/
│   │   ├── collector/
│   │   │   ├── collector.go          # Interfaces: SNMPTarget, Collector, Metrics
│   │   │   └── snmp_collector.go     # Implementación SNMP real (gosnmp)
│   │   └── storage/
│   │       ├── storage.go            # Interfaces: Storage, MetricRecord, MonitoredService
│   │       └── postgres_storage.go  # SaveMetric + RecordDown + RecordRecovered + ActiveEvent
│   ├── main.go                       # Loop de polling con state machine online↔offline
│   ├── go.mod                        # gosnmp v1.37.0 + lib/pq v1.10.9
│   └── Dockerfile                    # Multi-stage build golang:1.22 → alpine:3.19
├── node_api/
│   ├── src/
│   │   ├── index.js                  # Express + Socket.IO + pg LISTEN/NOTIFY → broadcast
│   │   ├── db.js                     # Pool pg → HAProxy
│   │   ├── auth.js                   # signToken + requireAuth (JWT HS256, 8h)
│   │   └── routes/
│   │       ├── auth.js               # POST /api/auth/login, /api/auth/logout
│   │       ├── users.js              # GET /api/users, PATCH /api/users/:id/role
│   │       ├── services.js           # GET /api/services
│   │       ├── metrics.js            # GET /api/metrics/latest, GET /api/metrics/:serviceId
│   │       └── alerts.js            # GET /api/alerts, PATCH /api/alerts/:id/resolve, GET /api/thresholds
│   ├── package.json                  # Express, Socket.IO, bcrypt, jsonwebtoken, pg
│   └── Dockerfile                    # node:20-alpine
├── patroni/
│   ├── Dockerfile                    # postgres:15 + patroni[etcd3] + psycopg2
│   ├── patroni1.yml                  # Nodo pg1 (primary inicial)
│   └── patroni2.yml                  # Nodo pg2 (replica inicial)
├── haproxy/
│   └── haproxy.cfg                   # :5432 → primary, :5433 → replicas, :7000 stats
├── init/
│   └── 01_schema.sql                 # 8 tablas + índices + pg_notify trigger + seed data
├── docker-compose.yml               # Orquesta los 8 servicios en red `sentinel`
└── README.md
```

---

## Arquitectura

```
Flutter → Node.js API (:3000) → HAProxy (:5432 writes / :5433 reads)
                                      ↙                  ↘
                              Patroni nodo 1        Patroni nodo 2
                               (primary)             (replica)
                                      ↑
                                    etcd
                                 (consenso HA)

Go collector → SNMP → Passbolt (:1161) / ChkMonitor (:2161)
Go collector → HAProxy (:5432) → PostgreSQL
                └── metrics (cada 5 min)
                └── service_events (down / recovered automático)
```

El Go collector detecta transiciones de estado:
- Servicio **cae** → abre fila en `service_events` con `event_type = 'down'`
- Servicio **se recupera** → cierra la fila (`ended_at`) e inserta `event_type = 'recovered'`

Cuando el collector inserta una métrica, el trigger `pg_notify` dispara y Node.js hace broadcast vía Socket.IO a todos los clientes Flutter conectados.

---

## Guía de arranque

### Paso 1 — Levantar el stack completo

```bash
docker compose up -d --build
```

Esperar ~30 segundos. Patroni necesita tiempo para conectarse a etcd y elegir el nodo primary.

### Paso 2 — Verificar que Patroni eligió primary

```bash
# Nodo 1 debe responder 200 (es primary)
curl http://localhost:8008/primary

# Nodo 2 debe responder 503 (es replica, no primary)
curl http://localhost:8009/primary

# Nodo 2 debe responder 200 en /replica
curl http://localhost:8009/replica
```

### Paso 3 — Aplicar el schema de base de datos

Solo se hace una vez. Requiere `psql` instalado localmente.

```bash
PGPASSWORD=app_secret_2025 psql \
  -h localhost -p 5432 \
  -U app -d postgres \
  -f init/01_schema.sql
```

### Paso 4 — Verificar el API

```bash
# Health check
curl http://localhost:3000/health
# → {"status":"ok"}

# Login con el usuario master
curl -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"master@cuy.local","password":"sentinel2025"}'
# → {"token":"eyJ...","user":{"role":"master",...}}
```

### Paso 5 — HAProxy stats dashboard

Abrir en el browser: **http://localhost:7000**

Muestra en tiempo real qué nodo es primary (UP) y cuál es replica.

---

## Demo de failover

Este es el punto clave de la presentación: demostrar que si un nodo PostgreSQL cae, el sistema continúa funcionando sin intervención manual.

### 1. Verificar estado inicial

```bash
curl http://localhost:8008/primary   # 200 → nodo 1 es PRIMARY
curl http://localhost:8009/replica   # 200 → nodo 2 es REPLICA
```

### 2. Matar el nodo primary

```bash
docker compose stop patroni1
```

### 3. Esperar la elección automática (~15 segundos)

Patroni detecta la caída vía etcd. El nodo 2 se promueve automáticamente a primary.

```bash
sleep 15
curl http://localhost:8009/primary   # 200 → nodo 2 es el nuevo PRIMARY
```

### 4. Verificar que el API sigue respondiendo

```bash
curl http://localhost:3000/health    # {"status":"ok"} — sin cortes
```

HAProxy redirigió automáticamente las escrituras al nuevo primary.

### 5. Mostrar en HAProxy stats

**http://localhost:7000** → backend `pg_primary`: patroni1 aparece en **DOWN**, patroni2 en **UP**.

### 6. Recuperar el nodo caído (vuelve como replica)

```bash
docker compose start patroni1
sleep 20
curl http://localhost:8008/replica   # 200 → nodo 1 volvió como REPLICA
```

---

## Credenciales

| Servicio | Usuario | Password |
|---|---|---|
| PostgreSQL superuser | `postgres` | `postgres_pass_2025` |
| PostgreSQL app (API + collector) | `app` | `app_secret_2025` |
| Panel master | `master@cuy.local` | `sentinel2025` |
| Replicación Patroni | `replicator` | `replicator_pass_2025` |

---

## Puertos expuestos

| Puerto | Servicio |
|---|---|
| `3000` | Node.js API (REST + Socket.IO) |
| `5432` | HAProxy → escrituras → nodo primary |
| `5433` | HAProxy → lecturas → réplicas |
| `5434` | Patroni nodo 1 (acceso directo debug) |
| `5435` | Patroni nodo 2 (acceso directo debug) |
| `7000` | HAProxy stats dashboard |
| `8008` | Patroni REST API nodo 1 (`/primary`, `/replica`) |
| `8009` | Patroni REST API nodo 2 (`/primary`, `/replica`) |
| `8080` | Passbolt web |
| `8081` | ChkMonitor web |
| `1161/udp` | Passbolt SNMP |
| `2161/udp` | ChkMonitor SNMP |
| `2379` | etcd client |

---

## Stack tecnológico

| Componente | Tecnología |
|---|---|
| API REST + WebSocket | Node.js 20, Express, Socket.IO |
| Autenticación | JWT (HS256, 8h), bcrypt |
| Collector SNMP | Go 1.22, gosnmp |
| Base de datos | PostgreSQL 15 |
| Alta disponibilidad BD | Patroni 3.x + etcd 3.5 |
| Proxy / failover | HAProxy 2.8 |
| Orquestación | Docker Compose v2 |
