// Jest setup provided by Grafana scaffolding
import './.config/jest-setup';

import { EventBusSrv } from '@grafana/data';
import { setAppEvents } from '@grafana/runtime';

// getAppEvents() is unset in the jest environment; src/lib/toast.ts calls it
// on every alert emit, so give it a real in-memory bus.
setAppEvents(new EventBusSrv());
