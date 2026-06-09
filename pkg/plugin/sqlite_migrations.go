package plugin

import "embed"

// migrationsFS holds the SQLite-dialect schema for this plugin's per-(plugin,
// org) data.db. pluginclient.OpenDB runs Up() once on first use per
// (plugin, org). golang-migrate's iofs source resolves the "migrations/"
// subdirectory.
//
//go:embed migrations/*.sql
var migrationsFS embed.FS
