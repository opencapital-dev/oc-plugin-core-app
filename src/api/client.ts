import { getBackendSrv } from '@grafana/runtime';

import { PLUGIN_RESOURCES } from '../constants';

export const REF_BASE = `${PLUGIN_RESOURCES}/ref`;

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
};

export async function refRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  return request<T>(`${REF_BASE}${path}`, options);
}

async function request<T>(url: string, options: RequestOptions): Promise<T> {
  const method = options.method ?? 'GET';
  const srv = getBackendSrv();
  switch (method) {
    case 'GET':
      return srv.get<T>(url);
    case 'DELETE':
      return srv.delete<T>(url);
    case 'POST':
      return srv.post<T>(url, options.body);
    case 'PUT':
      return srv.put<T>(url, options.body);
    case 'PATCH':
      return srv.patch<T>(url, options.body);
  }
}
