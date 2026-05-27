# Cuy Sentinel — Guía de Ejercicios

Guía paso a paso para levantar, operar y demostrar el backend.
Equipo: Jair Conislla · Daniel Rojas · Jheampierre Ralli

---

## Índice

1. [Requisitos previos](#1-requisitos-previos)
2. [Puertos y credenciales](#2-puertos-y-credenciales)
3. [Levantar el stack](#3-levantar-el-stack)
4. [Verificar que todo está vivo](#4-verificar-que-todo-está-vivo)
5. [API REST — todos los endpoints](#5-api-rest--todos-los-endpoints)
6. [Demo de failover HA](#6-demo-de-failover-ha)
7. [Conectar Flutter al backend](#7-conectar-flutter-al-backend)
8. [Comandos de mantenimiento](#8-comandos-de-mantenimiento)
9. [Troubleshooting](#9-troubleshooting)

---

## 1. Requisitos previos

| Herramienta | Versión mínima | Verificar |
|---|---|---|
| Docker Desktop | 24+ | `docker --version` |
| Docker Compose | v2 (incluido) | `docker compose version` |
| psql (opcional) | cualquiera | `psql --version` |
| curl | cualquiera | `curl --version` |

> En Windows usar PowerShell o Git Bash para los comandos `curl`.

---

## 2. Puertos y credenciales

### Puertos expuestos en `localhost`

| Puerto | Servicio | Uso |
|---|---|---|
| `3000` | Node.js API | REST + Socket.IO |
| `5432` | HAProxy → primary | Escrituras PostgreSQL |
| `5433` | HAProxy → réplicas | Lecturas PostgreSQL |
| `5434` | Patroni nodo 1 (debug) | Acceso directo pg1 |
| `5435` | Patroni nodo 2 (debug) | Acceso directo pg2 |
| `7000` | HAProxy stats | Dashboard web |
| `8008` | Patroni REST nodo 1 | `/primary` `/replica` |
| `8009` | Patroni REST nodo 2 | `/primary` `/replica` |
| `1161/udp` | Passbolt SNMP mock | Datos simulados |
| `2161/udp` | ChkMonitor SNMP mock | Datos simulados |
| `2379` | etcd | Consenso HA |
| `9090` | Node collector health | `/health` |

### Credenciales

| Servicio | Usuario | Password |
|---|---|---|
| API (panel master) | `master@cuy.local` | `sentinel2025` |
| PostgreSQL app | `app` | `app_secret_2025` |
| PostgreSQL superuser | `postgres` | `postgres_pass_2025` |
| Replicación Patroni | `replicator` | `replicator_pass_2025` |
| JWT secret | — | `cuy_sentinel_jwt_secret_2025` |

---

## 3. Levantar el stack

### Primera vez (build + arranque)

```bash
docker compose up -d --build
```

Esperar ~30-40 segundos. Patroni necesita tiempo para conectarse a etcd y elegir el nodo primary.

### Arranques siguientes (sin rebuild)

```bash
docker compose up -d
```

### Ver logs en vivo

```bash
# Todos los servicios
docker compose logs -f

# Solo la API
docker compose logs -f node_api

# Solo Patroni nodo 1
docker compose logs -f patroni1
```

### Detener todo

```bash
docker compose down
```

### Detener y borrar volúmenes (reset completo de BD)

```bash
docker compose down -v
```

---

## 4. Verificar que todo está vivo

### 4.1 Estado de los contenedores

```bash
docker compose ps
```

Todos deben aparecer como `healthy` o `running`.

### 4.2 Patroni — quién es primary

```bash
# Nodo 1: 200 = es primary, 503 = es replica
curl http://localhost:8008/primary

# Nodo 2: 200 = es primary, 503 = es replica
curl http://localhost:8009/primary
```

Resultado esperado al inicio: nodo 1 → `200`, nodo 2 → `503`.

También disponible como dashboard visual: **http://localhost:7000**

### 4.3 API Node.js

```bash
curl http://localhost:3000/health
# {"status":"ok"}
```

### 4.4 Node collector

```bash
curl http://localhost:9090/health
```

### 4.5 Conexión directa a PostgreSQL (requiere psql)

```bash
# Vía HAProxy (primary — escrituras)
PGPASSWORD=app_secret_2025 psql -h localhost -p 5432 -U app -d postgres -c "SELECT version();"

# Vía HAProxy (réplica — lecturas)
PGPASSWORD=app_secret_2025 psql -h localhost -p 5433 -U app -d postgres -c "SELECT pg_is_in_recovery();"
```

---

## 5. API REST — todos los endpoints

Primero obtener el token JWT y guardarlo en una variable:

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"master@cuy.local","password":"sentinel2025"}' \
  | python -c "import sys,json; print(json.load(sys.stdin)['token'])")

echo $TOKEN
```

> En PowerShell reemplazar `$TOKEN` por `$env:TOKEN` y usar `Invoke-RestMethod` o instalar curl nativo.

---

### Auth

#### Login
```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"master@cuy.local","password":"sentinel2025"}'
```
Respuesta: `{ "token": "eyJ...", "user": { "id", "email", "displayName", "role" } }`

#### Logout
```bash
curl -X POST http://localhost:3000/api/auth/logout \
  -H "Authorization: Bearer $TOKEN"
```

---

### Usuarios

#### Listar todos los usuarios
```bash
curl http://localhost:3000/api/users \
  -H "Authorization: Bearer $TOKEN"
```

#### Ver logs de acceso (todos)
```bash
curl "http://localhost:3000/api/users/access-logs?limit=20" \
  -H "Authorization: Bearer $TOKEN"
```

#### Ver logs de acceso de un usuario específico
```bash
curl "http://localhost:3000/api/users/access-logs?userId=<uuid>" \
  -H "Authorization: Bearer $TOKEN"
```

#### Cambiar rol de usuario (solo master/admin)
```bash
curl -X PATCH http://localhost:3000/api/users/<uuid>/role \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"role":"admin"}'
```
Roles válidos: `viewer` | `admin` | `master`

---

### Servicios monitoreados

#### Listar servicios activos
```bash
curl http://localhost:3000/api/services \
  -H "Authorization: Bearer $TOKEN"
```
Devuelve Passbolt y ChkMonitor con sus IDs UUID.

---

### Métricas

#### Última métrica de cada servicio
```bash
curl http://localhost:3000/api/metrics/latest \
  -H "Authorization: Bearer $TOKEN"
```

#### Historial de un servicio (últimas 50 métricas)
```bash
curl "http://localhost:3000/api/metrics/<serviceId>?limit=50" \
  -H "Authorization: Bearer $TOKEN"
```

#### Historial con rango de fechas
```bash
curl "http://localhost:3000/api/metrics/<serviceId>?from=2025-01-01T00:00:00Z&to=2025-12-31T23:59:59Z&limit=100" \
  -H "Authorization: Bearer $TOKEN"
```

---

### Alertas

#### Alertas activas (no resueltas)
```bash
curl http://localhost:3000/api/alerts \
  -H "Authorization: Bearer $TOKEN"
```

#### Alertas activas desde una fecha
```bash
curl "http://localhost:3000/api/alerts?since=2025-01-01T00:00:00Z" \
  -H "Authorization: Bearer $TOKEN"
```

#### Historial completo de alertas
```bash
curl "http://localhost:3000/api/alerts/history?limit=50" \
  -H "Authorization: Bearer $TOKEN"
```

#### Umbrales configurados
```bash
curl http://localhost:3000/api/alerts/thresholds \
  -H "Authorization: Bearer $TOKEN"
```

#### Resolver una alerta (solo master/admin)
```bash
curl -X PATCH http://localhost:3000/api/alerts/<alertId>/resolve \
  -H "Authorization: Bearer $TOKEN"
```

---

### Monitoreo de eventos

#### Eventos activos (servicios actualmente caídos)
```bash
curl http://localhost:3000/api/monitoring/events/active \
  -H "Authorization: Bearer $TOKEN"
```

#### Eventos recientes (historial)
```bash
curl "http://localhost:3000/api/monitoring/events/recent?limit=30" \
  -H "Authorization: Bearer $TOKEN"
```

#### Eventos de un servicio específico
```bash
curl "http://localhost:3000/api/monitoring/events?serviceId=<uuid>&limit=20" \
  -H "Authorization: Bearer $TOKEN"
```

#### Historial de ejecuciones del collector
```bash
curl "http://localhost:3000/api/monitoring/collector?limit=20" \
  -H "Authorization: Bearer $TOKEN"
```

---

### Base de datos

#### Health de la instancia PostgreSQL
```bash
curl http://localhost:3000/api/db/health \
  -H "Authorization: Bearer $TOKEN"
```
Devuelve: latencia, storage MB, conexiones activas, cache hit %, tablas, filas totales.

#### Estadísticas por tabla
```bash
curl http://localhost:3000/api/db/tables \
  -H "Authorization: Bearer $TOKEN"
```

---

## 6. Demo de failover HA

Este es el ejercicio clave: demostrar que si un nodo PostgreSQL cae, el sistema sigue funcionando sin intervención manual.

### Paso 1 — Verificar estado inicial

```bash
curl http://localhost:8008/primary   # 200 → nodo 1 es PRIMARY
curl http://localhost:8009/replica   # 200 → nodo 2 es REPLICA
```

También verificar que la API responde:
```bash
curl http://localhost:3000/health    # {"status":"ok"}
```

### Paso 2 — Matar el nodo primary

```bash
docker compose stop patroni1
```

### Paso 3 — Esperar elección automática (~15 segundos)

Patroni detecta la caída vía etcd. El nodo 2 se promueve automáticamente.

```bash
# Esperar y verificar
curl http://localhost:8009/primary   # Ahora debe responder 200
```

### Paso 4 — Verificar que la API sigue respondiendo

```bash
curl http://localhost:3000/health    # {"status":"ok"} — sin cortes
```

HAProxy redirigió automáticamente las escrituras al nuevo primary.

### Paso 5 — Mostrar en HAProxy stats

Abrir **http://localhost:7000** en el browser.

- Backend `pg_primary`: `patroni1` → DOWN, `patroni2` → UP
- El collector y la API siguen operando normalmente

### Paso 6 — Recuperar el nodo caído (vuelve como replica)

```bash
docker compose start patroni1
```

Esperar ~20 segundos y verificar:

```bash
curl http://localhost:8008/replica   # 200 → nodo 1 volvió como REPLICA
```

### Paso 7 — Verificar sincronización

```bash
# Conectar al nodo 2 (ahora primary) y ver réplicas activas
PGPASSWORD=postgres_pass_2025 psql -h localhost -p 5435 -U postgres -d postgres \
  -c "SELECT client_addr, state, sync_state FROM pg_stat_replication;"
```

---

## 7. Conectar Flutter al backend

### Problema: `localhost` no funciona en Android

En el emulador Android, `localhost` apunta al propio emulador, no a tu PC.

| Entorno | URL base correcta |
|---|---|
| Emulador Android | `http://10.0.2.2:3000` |
| Dispositivo físico | `http://<IP-de-tu-PC>:3000` |
| iOS Simulator | `http://localhost:3000` |

### Obtener tu IP local (Windows)

```powershell
ipconfig
# Buscar "IPv4 Address" en tu adaptador WiFi/Ethernet
```

### Ejemplo de URL completa

```
http://10.0.2.2:3000/api/auth/login   ← emulador Android
http://192.168.1.100:3000/api/auth/login  ← dispositivo físico
```

### Socket.IO (tiempo real)

```
ws://10.0.2.2:3000   ← emulador Android
ws://192.168.1.100:3000  ← dispositivo físico
```

Eventos que emite el servidor:
- `metric` — nueva métrica del collector
- `alert` — nueva alerta disparada
- `active_alerts` — lista completa de alertas activas (actualizada)
- `active_events` — eventos de servicio activos (actualizada)
- `service_event` — nuevo evento de servicio (down/recovered)
- `collector_run` — nueva ejecución del collector
- `db_health` — salud de la BD (cada 30 seg)

---

## 8. Comandos de mantenimiento

### Ver estado de Patroni desde dentro del contenedor

```bash
docker exec -it patroni1 patronictl -c /etc/patroni/patroni.yml list
```

### Ejecutar SQL directamente en el primary

```bash
PGPASSWORD=app_secret_2025 psql -h localhost -p 5432 -U app -d postgres
```

### Ver métricas almacenadas

```sql
SELECT service_id, service_status, collected_at
FROM metrics
ORDER BY collected_at DESC
LIMIT 10;
```

### Ver eventos de servicio

```sql
SELECT ms.service_name, se.event_type, se.started_at, se.ended_at, se.resolved
FROM service_events se
JOIN monitored_services ms ON ms.id = se.service_id
ORDER BY se.started_at DESC;
```

### Reapliar el schema (si se borró la BD)

```bash
PGPASSWORD=app_secret_2025 psql \
  -h localhost -p 5432 \
  -U app -d postgres \
  -f init/01_schema.sql
```

### Generar un nuevo hash bcrypt para cambiar password

```bash
# Dentro del contenedor node_api
docker exec -it node_api node -e "require('bcrypt').hash('nueva_password',10).then(console.log)"
```

### Rebuild de un solo servicio

```bash
docker compose up -d --build node_api
docker compose up -d --build node_collector
```

### Reiniciar un servicio sin rebuild

```bash
docker compose restart node_api
```

---

## 9. Troubleshooting

### La API no responde

```bash
# Verificar que el contenedor está corriendo
docker compose ps node_api

# Ver los últimos logs
docker compose logs --tail=50 node_api

# El problema más común: HAProxy no está listo aún
# Esperar y reintentar, o verificar:
curl http://localhost:7000
```

### Patroni no elige primary

```bash
# Ver logs de patroni y etcd
docker compose logs --tail=50 patroni1 patroni2 etcd

# Verificar que etcd responde
curl http://localhost:2379/health
```

### "Failed to fetch" en Flutter

1. Verificar el puerto: la API corre en `:3000`, no `:3001`
2. Usar `10.0.2.2` en lugar de `localhost` en emulador Android
3. Verificar que el stack está levantado: `docker compose ps`

### El collector no inserta métricas

```bash
# Ver logs del collector
docker compose logs -f node_collector

# Verificar health
curl http://localhost:9090/health

# Ver últimas ejecuciones
curl "http://localhost:3000/api/monitoring/collector?limit=5" \
  -H "Authorization: Bearer $TOKEN"
```

### Resetear todo desde cero

```bash
docker compose down -v
docker compose up -d --build
```

Esperar 40 segundos y verificar con `docker compose ps`.
