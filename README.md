# Cuy Sentinel Backend

Backend monorepo para el panel de monitoreo Cuy Sentinel.
Contiene: Node.js API, Go SNMP collector, Patroni HA PostgreSQL, etcd, HAProxy.

## Arquitectura

```
Flutter → Node.js API (:3000) → HAProxy (:5432 writes / :5433 reads)
                                    ↓                    ↓
                               Patroni nodo 1      Patroni nodo 2
                               (primary)           (replica)
                                    ↑
                                  etcd
                                (consenso)

Go collector → SNMP → Passbolt (:1161) / ChkMonitor (:2161)
Go collector → HAProxy → PostgreSQL (metrics + service_events)
```

## Inicio rápido

### 1. Levantar el stack

```bash
docker compose up -d --build
```

Esperar ~30 segundos para que Patroni elija el nodo primary.

### 2. Verificar que Patroni eligió primary

```bash
# Nodo 1 debe ser primary (200 OK)
curl http://localhost:8008/primary

# Nodo 2 debe ser replica (503)
curl http://localhost:8009/primary
```

### 3. Aplicar el schema de base de datos

```bash
PGPASSWORD=app_secret_2025 psql \
  -h localhost -p 5432 \
  -U app -d postgres \
  -f init/01_schema.sql
```

### 4. Verificar el API

```bash
curl http://localhost:3000/health
# {"status":"ok"}

curl -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"master@cuy.local","password":"sentinel2025"}'
# {"token":"eyJ...","user":{"role":"master",...}}
```

### 5. HAProxy stats dashboard

Abrir en browser: http://localhost:7000

## Demo de failover (presentación)

### Paso 1: Verificar estado inicial

```bash
curl http://localhost:8008/primary   # 200 → nodo 1 es PRIMARY
curl http://localhost:8009/replica   # 200 → nodo 2 es REPLICA
```

### Paso 2: Simular caída del primary

```bash
docker compose stop patroni1
```

### Paso 3: Esperar elección automática (~15 segundos)

```bash
sleep 15
curl http://localhost:8009/primary   # 200 → nodo 2 promovido a PRIMARY
```

### Paso 4: Verificar que el API sigue funcionando

```bash
curl http://localhost:3000/health    # {"status":"ok"} — sin interrupciones
```

### Paso 5: Ver en HAProxy stats

http://localhost:7000 → backend `pg_primary`: patroni1 en DOWN, patroni2 en UP

### Paso 6: Recuperar nodo 1 (vuelve como replica)

```bash
docker compose start patroni1
sleep 20
curl http://localhost:8008/replica   # 200 → nodo 1 volvió como REPLICA
```

## Credenciales

| Servicio | Usuario | Password |
|---|---|---|
| PostgreSQL superuser | postgres | postgres_pass_2025 |
| PostgreSQL app user | app | app_secret_2025 |
| Panel (master) | master@cuy.local | sentinel2025 |

## Puertos expuestos

| Puerto | Servicio |
|---|---|
| 3000 | Node.js API |
| 5432 | HAProxy → PostgreSQL writes (primary) |
| 5433 | HAProxy → PostgreSQL reads (replicas) |
| 5434 | Patroni nodo 1 (debug directo) |
| 5435 | Patroni nodo 2 (debug directo) |
| 7000 | HAProxy stats dashboard |
| 8008 | Patroni REST API nodo 1 |
| 8009 | Patroni REST API nodo 2 |
| 8080 | Passbolt web |
| 8081 | ChkMonitor web |
| 1161/udp | Passbolt SNMP |
| 2161/udp | ChkMonitor SNMP |
| 2379 | etcd client |
