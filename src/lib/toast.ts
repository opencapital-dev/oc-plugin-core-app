import { type AppEvent } from '@grafana/data';
import { getAppEvents } from '@grafana/runtime';

export const appEvents = {
  emit<T>(event: AppEvent<T>, payload: T): void {
    getAppEvents().publish({ type: event.name, payload });
  },
};
