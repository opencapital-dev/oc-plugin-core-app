# core-app → oc-plugin-sdk v0.2.0 migration plan

Hard cutover, single-user local, no back-compat. core-app is the portfolio-admin app plugin. v0.2.0 deleted gateway HTTP publish, control-plane HTTP, read-gateway/DSL, SQLite, and JWT/org identity, replacing them with direct pgwire `Client.Exec`/`Query` (RisingWave) + `Client.PGExec`/`PGQuery` (Postgres) + `datakey`.

## Authoritative write contracts (from the old gateway sink, org_id removed)

**Portfolio event** → RisingWave `portfolio_events_log`:
```sql
INSERT INTO portfolio_events_log
  (source_id, event_type, portfolio_id, instrument_id, business_ts, ingest_ts, source, plugin_id, trace_id, payload, rw_key)
VALUES ($1,$2,$3,$4, to_timestamp($5/1e6), now(), $6, $7, $8, $9, $10)
```
- `rw_key = datakey.EventKey(pluginID, sourceID)` (i.e. `pluginID|sourceID`)
- `plugin_id = "core-app"` (from `cfg.PluginID`); `source = "core-app"`
- `business_ts` is int-µs in the handler → pass as microseconds; cast to timestamptz
- INSERT on existing rw_key upserts (RW native PK upsert)

**Option mark** → RisingWave `data_log`:
```sql
INSERT INTO data_log
  (source_namespace, source_id, portfolio_id, observed_at, ingest_ts, source, plugin_id, trace_id, payload, rw_key)
VALUES ($1,$2,$3, to_timestamp($4/1e6), now(), $5, $6, $7, $8)
```
- namespace `"prices.option_mark"`; `rw_key = datakey.DataKey(pluginID, namespace, portfolioID, sourceID, observedAt)`

**Event delete (tombstone)** → `DELETE FROM portfolio_events_log WHERE rw_key = $1` with `rw_key = datakey.EventKey(pluginID, sourceID)`.

**route→event_type:** trades→`TRADE`, dividends→`DIVIDEND`, cashflows→`CASHFLOW`, fx-conversions→`FX_CONVERSION`, transfer-ins→`TRANSFER_IN`, option-exercises→`OPTION_EXERCISE`, option-assignments→`OPTION_ASSIGNMENT`, option-expiries→`OPTION_EXPIRY`.

## Portfolios CRUD → Postgres `control_db.portfolios` (PGExec/PGQuery)

Table (org_id dropped): `portfolios(portfolio_id UUID PK, base_currency VARCHAR, attributes JSONB, updated_at TIMESTAMPTZ, updated_by VARCHAR)`.
- **List** (`GET /ref/portfolios`): `PGQuery("SELECT portfolio_id, base_currency, attributes FROM portfolios ORDER BY portfolio_id")`.
- **Create** (`POST /ref/portfolios`): `PGExec("INSERT INTO portfolios (portfolio_id, base_currency, attributes, updated_by) VALUES ($1,$2,$3,$4) ON CONFLICT (portfolio_id) DO UPDATE SET base_currency=EXCLUDED.base_currency, attributes=EXCLUDED.attributes, updated_at=now(), updated_by=EXCLUDED.updated_by", id, ccy, attrsJSON, "core-app")`. Drop `org_id` from the body.

## Instruments read → RisingWave `instruments_catalog` (Query)

Replace `ReadGatewayQuery("instruments_used{} @latest")` with:
`Query("SELECT instrument_id, kind, contract_multiplier FROM instruments_catalog WHERE portfolio_id = $1", portfolioID)`.
(Verify the exact column names against `dataplane/risingwave/schemas/08-ingestor-discovery/03-instruments_catalog.sql` in the opencapital repo; adjust the projection if the surface view names differ. org_id scoping removed.)

## Tasks

### Task 1 — SDK dep + settings
- go.mod: `github.com/ignacioballester/oc-plugin-sdk v0.1.0` → `github.com/opencapital-dev/oc-plugin-sdk v0.2.0` + `replace github.com/opencapital-dev/oc-plugin-sdk => ../oc-plugin-sdk`; change all import paths; `go mod tidy`.
- settings: drop `gatewayUrl`/`controlPlaneUrl` reads; the SDK `NewFromSettings` now parses `risingwaveHost`/`risingwavePort` + `postgresHost`/`postgresPort`/`controlDb` from jsonData. Keep `pluginId`, `otelExporterOtlpEndpoint`, `platformToken`.

### Task 2 — shared pgwire write helpers (`events_common.go`)
Add helpers the handlers call (DRY — one INSERT, not eight):
- `func (a *App) insertEvent(ctx, eventType, sourceID, portfolioID string, instrumentID *string, businessTsMicros int64, payloadJSON string) error` — runs the portfolio_events_log INSERT with `datakey.EventKey(a.cfg.PluginID, sourceID)`.
- `func (a *App) insertData(ctx, namespace, sourceID, portfolioID string, observedAtMicros int64, payloadJSON string) error` — data_log INSERT with `datakey.DataKey(...)`.
- `func (a *App) deleteEvent(ctx, sourceID string) error` — DELETE by `datakey.EventKey(a.cfg.PluginID, sourceID)`.
Keep `marshalPayload`.

### Task 3 — repoint the 8 write handlers + tombstone
trades(199)/dividends(111)/cashflows(108)/fx-conversions(143)/transfer-ins(158)/options exercise(142)/expiry(203) → `a.insertEvent(ctx, "<TYPE>", ...)`; option mark(273) → `a.insertData`; event delete(handlers_events.go:30) → `a.deleteEvent`. Drop `PublishPortfolioEvent`/`PublishData`/`PublishEventTombstones` and `PublishResult` usage.

### Task 4 — portfolios CRUD → Postgres (`handlers_ref.go`)
List(110) → `PGQuery`; Create(140) → `PGExec` INSERT…ON CONFLICT. Drop `ControlPlaneCall`, the `org_id` body field, and the `IdentityFrom` org extraction (228-238).

### Task 5 — instruments read → RW (`handlers_ref.go:167`)
Replace `ReadGatewayQuery` with `Query` against `instruments_catalog`; keep the response shape `InstrumentEntity{instrument_id, kind, contract_multiplier}`.

### Task 6 — drop auth/identity + delete SQLite scaffolding
- `app.go`: `handlerCtx`/`WithRequest` (100-110) → loopback trust; drop the 401-on-no-identity. Drop `IdentityFrom` usage. `NewFromSettings` stays (new coords). `Close()` stays.
- Delete `sqlite_migrations.go` + `migrations/` (ui_drafts is unused scaffolding; not ported — add a Postgres table later if drafts are needed).

### Task 7 — build + tests green
`go build ./... && go vet ./... && go test ./...`. Update/adjust tests to the pgwire model (mock the SDK Client's Exec/Query/PGExec/PGQuery, or test the SQL-building helpers). Straggler grep empty: `PublishPortfolioEvent|PublishData|ControlPlaneCall|ReadGatewayQuery|IdentityFrom|OrgID|SessionJWT|OpenDB|ignacioballester`.
