-- v6 Phase 3: portfolio-admin per-(plugin, org) SQLite store.
--
-- The canonical portfolios + instruments tables live in control_db (control
-- plane owns them in v6; portfolio-admin is a UI/API write-through). What
-- stays in the plugin's local SQLite is purely operator scratch state:
-- recent draft event payloads the operator was filling in, last-used
-- portfolio + instrument selections per page, etc. The table is created
-- empty here so the SDK's first OpenDB call has something to migrate; the
-- handlers populate it as features need it.
CREATE TABLE IF NOT EXISTS ui_drafts (
    draft_id    TEXT    PRIMARY KEY,
    draft_kind  TEXT    NOT NULL,
    payload     TEXT    NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    updated_by  TEXT
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS ui_drafts_kind_idx ON ui_drafts (draft_kind, updated_at);
