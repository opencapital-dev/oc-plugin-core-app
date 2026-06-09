import React, { useCallback, useEffect, useState } from 'react';
import { css } from '@emotion/css';

import { AppEvents, type GrafanaTheme2 } from '@grafana/data';
import { config } from '@grafana/runtime';
import { Badge, Button, ConfirmModal, Icon, LoadingPlaceholder, useStyles2 } from '@grafana/ui';

import { Page } from '../components/Page';
import { appEvents } from '../lib/toast';
import {
  type CatalogEntry,
  getMe,
  installPlugin,
  listPlugins,
  uninstallPlugin,
} from '../api/plugins';

/**
 * Plugins catalog (ADR-0050). Lists every plugin in the static
 * manifest registry; each row shows install state + a toggle.
 * Required plugins are non-removable.
 *
 * Auth: the page calls /api/* directly (same-origin via Caddy)
 * with the user's Grafana session cookie. Control-plane gates each
 * call on `user_org.role='admin'` for the current org.
 */
export function PluginsPage() {
  const styles = useStyles2(getStyles);
  const [orgID, setOrgID] = useState<string | null>(null);
  const [entries, setEntries] = useState<CatalogEntry[] | null>(null);
  const [busyID, setBusyID] = useState<string | null>(null);
  const [confirmUninstall, setConfirmUninstall] = useState<CatalogEntry | null>(null);

  // Map current Grafana org -> control_db org UUID via /api/me.
  useEffect(() => {
    (async () => {
      try {
        const me = await getMe();
        const currentGrafanaOrg = config.bootData.user.orgId;
        const match = me.orgs.find((o) => o.grafana_org_id === currentGrafanaOrg);
        if (!match) {
          appEvents.emit(AppEvents.alertError, [
            `No control-plane org maps to your current Grafana org (${currentGrafanaOrg}).`,
          ]);
          return;
        }
        setOrgID(match.org_id);
      } catch (err) {
        const m = err instanceof Error ? err.message : 'unknown';
        appEvents.emit(AppEvents.alertError, [`Plugins: failed to resolve org: ${m}`]);
      }
    })();
  }, []);

  const reload = useCallback(async () => {
    if (!orgID) {
      return;
    }
    try {
      const next = await listPlugins(orgID);
      setEntries(next);
    } catch (err) {
      const m = err instanceof Error ? err.message : 'unknown';
      appEvents.emit(AppEvents.alertError, [`Plugins: failed to list: ${m}`]);
    }
  }, [orgID]);

  useEffect(() => {
    if (orgID) {
      reload();
    }
  }, [orgID, reload]);

  async function handleInstall(entry: CatalogEntry) {
    if (!orgID) {
      return;
    }
    setBusyID(entry.plugin_id);
    try {
      await installPlugin(orgID, entry.plugin_id);
      appEvents.emit(AppEvents.alertSuccess, [`Installed ${entry.display_name}.`]);
      await reload();
    } catch (err) {
      const m = err instanceof Error ? err.message : 'unknown';
      appEvents.emit(AppEvents.alertError, [`Install failed: ${m}`]);
    } finally {
      setBusyID(null);
    }
  }

  async function handleUninstall(entry: CatalogEntry) {
    if (!orgID) {
      return;
    }
    setConfirmUninstall(null);
    setBusyID(entry.plugin_id);
    try {
      await uninstallPlugin(orgID, entry.plugin_id);
      appEvents.emit(AppEvents.alertSuccess, [
        `Uninstall of ${entry.display_name} started. Reload to see progress.`,
      ]);
      await reload();
    } catch (err) {
      const m = err instanceof Error ? err.message : 'unknown';
      appEvents.emit(AppEvents.alertError, [`Uninstall failed: ${m}`]);
    } finally {
      setBusyID(null);
    }
  }

  if (!orgID || entries === null) {
    return (
      <Page>
        <LoadingPlaceholder text="Loading plugin catalog…" />
      </Page>
    );
  }

  return (
    <Page>
      <h2 className={styles.h2}>Plugins</h2>
      <p className={styles.sub}>
        Required plugins ship by default and can&apos;t be removed. Optional plugins can be
        installed or uninstalled at any time. Uninstall deletes all data the plugin produced
        for this workspace.
      </p>

      <ul className={styles.list}>
        {entries.map((e) => (
          <li key={e.plugin_id} className={styles.row}>
            <div className={styles.left}>
              <div className={styles.title}>
                {e.display_name}
                {e.required && (
                  <span className={styles.badge}>
                    <Badge text="Required" color="blue" />
                  </span>
                )}
                {e.uninstall_state === 'in_progress' && (
                  <span className={styles.badge}>
                    <Badge text="Uninstalling…" color="orange" />
                  </span>
                )}
                {e.uninstall_state === 'failed' && (
                  <span className={styles.badge}>
                    <Badge text="Uninstall failed" color="red" />
                  </span>
                )}
              </div>
              <div className={styles.desc}>{e.description}</div>
              {e.installed_at && (
                <div className={styles.meta}>
                  Installed {new Date(e.installed_at).toLocaleDateString()}
                </div>
              )}
            </div>
            <div className={styles.right}>
              {e.installed ? (
                <Button
                  variant="destructive"
                  fill="outline"
                  icon="trash-alt"
                  disabled={e.required || busyID === e.plugin_id || e.uninstall_state === 'in_progress'}
                  onClick={() => setConfirmUninstall(e)}
                >
                  {e.uninstall_state === 'in_progress' ? 'Uninstalling…' : 'Uninstall'}
                </Button>
              ) : (
                <Button
                  icon="plus"
                  disabled={busyID === e.plugin_id}
                  onClick={() => handleInstall(e)}
                >
                  Install
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>

      {confirmUninstall && (
        <ConfirmModal
          isOpen
          icon="trash-alt"
          title={`Uninstall ${confirmUninstall.display_name}?`}
          body={
            <>
              <p>
                This will permanently delete every event {confirmUninstall.display_name} has
                published to this workspace, plus the plugin&apos;s per-org state. The
                operation streams in the background and can&apos;t be paused.
              </p>
              <p>
                Other plugins&apos; data is untouched. <strong>This can&apos;t be undone.</strong>
              </p>
            </>
          }
          confirmText="Uninstall and delete data"
          dismissText="Cancel"
          onConfirm={() => handleUninstall(confirmUninstall)}
          onDismiss={() => setConfirmUninstall(null)}
        />
      )}
    </Page>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  h2: css({
    margin: 0,
    fontSize: theme.typography.h2.fontSize,
  }),
  sub: css({
    color: theme.colors.text.secondary,
    marginTop: theme.spacing(0.5),
    marginBottom: theme.spacing(3),
    maxWidth: 720,
    lineHeight: 1.5,
  }),
  list: css({
    listStyle: 'none',
    padding: 0,
    margin: 0,
    display: 'grid',
    gap: theme.spacing(1.5),
  }),
  row: css({
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: theme.spacing(2),
    padding: theme.spacing(2.5, 3),
    backgroundColor: theme.colors.background.secondary,
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
  }),
  left: css({
    flex: 1,
    minWidth: 0,
  }),
  right: css({
    flexShrink: 0,
  }),
  title: css({
    fontSize: theme.typography.h4.fontSize,
    fontWeight: theme.typography.fontWeightMedium,
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
  }),
  badge: css({
    display: 'inline-flex',
  }),
  desc: css({
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
    marginTop: theme.spacing(0.5),
    lineHeight: 1.4,
  }),
  meta: css({
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
    marginTop: theme.spacing(0.5),
  }),
});

// Keep this import-side-effect-only so eslint doesn't strip Icon if
// future tweaks use it directly. (Plugin codebase convention.)
void Icon;
