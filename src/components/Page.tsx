import React, { type ReactNode } from 'react';
import { PluginPage } from '@grafana/runtime';

type Props = {
  children?: ReactNode;
  /** Accepted for source-compat with Grafana core <Page>; unused inside plugin. */
  navId?: string;
  pageNav?: { text?: string; active?: boolean };
  layout?: unknown;
};

export function Page({ children }: Props) {
  return <PluginPage>{children}</PluginPage>;
}

function Contents({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}

Page.Contents = Contents;
