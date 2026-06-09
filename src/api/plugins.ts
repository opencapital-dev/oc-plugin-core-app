// Self-service plugin catalog (ADR-0050) client. These calls go to the
// control-plane public surface at /api/* via Caddy single-origin —
// authenticated by the user's Grafana session cookie. NOT through the
// plugin's backend Resource endpoint (that authenticates as the plugin,
// not the human admin).

export type CatalogEntry = {
  plugin_id: string;
  display_name: string;
  description: string;
  required: boolean;
  installed: boolean;
  installed_at?: string;
  uninstall_state?: string;
  uninstall_keys_done?: number;
  uninstall_keys_total?: number;
};

export type MeOrg = {
  org_id: string;
  short_id: string;
  name: string;
  role: string;
  base_currency: string;
  grafana_org_id?: number;
};

export type MeResponse = {
  user_id: string;
  login: string;
  email: string;
  has_org: boolean;
  orgs: MeOrg[];
};

export type UninstallStatus = {
  plugin_id: string;
  org_id: string;
  state: string;
  keys_total?: number;
  keys_done: number;
  last_error?: string;
};

// Resolve which control_db org corresponds to the current Grafana org.
// /api/me returns every membership the caller has. The frontend picks
// the entry whose Grafana mapping matches via list intersect — the
// catalog page only operates on the org the user is currently in.
export async function getMe(): Promise<MeResponse> {
  const r = await fetch('/api/me', { credentials: 'include' });
  if (!r.ok) {
    throw new Error(`me ${r.status}`);
  }
  return r.json();
}

export async function listPlugins(orgID: string): Promise<CatalogEntry[]> {
  const r = await fetch(`/api/orgs/${orgID}/plugins`, { credentials: 'include' });
  if (!r.ok) {
    throw new Error(`list plugins ${r.status}: ${await r.text()}`);
  }
  return r.json();
}

export async function installPlugin(orgID: string, pluginID: string): Promise<void> {
  const r = await fetch(`/api/orgs/${orgID}/plugins/${pluginID}`, {
    method: 'POST',
    credentials: 'include',
  });
  if (!r.ok) {
    throw new Error(`install ${r.status}: ${await r.text()}`);
  }
}

export async function uninstallPlugin(orgID: string, pluginID: string): Promise<void> {
  const r = await fetch(`/api/orgs/${orgID}/plugins/${pluginID}`, {
    method: 'DELETE',
    credentials: 'include',
  });
  if (!r.ok) {
    throw new Error(`uninstall ${r.status}: ${await r.text()}`);
  }
}

export async function getUninstallStatus(orgID: string, pluginID: string): Promise<UninstallStatus> {
  const r = await fetch(`/api/orgs/${orgID}/plugins/${pluginID}/uninstall-status`, {
    credentials: 'include',
  });
  if (!r.ok) {
    throw new Error(`status ${r.status}: ${await r.text()}`);
  }
  return r.json();
}
