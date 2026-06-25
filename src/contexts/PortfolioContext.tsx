import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { AppEvents } from '@grafana/data';
import { listPortfolios, type PortfolioEntity } from '../api/reference';
import { appEvents } from '../lib/toast';

const STORAGE_KEY = 'core-app:selectedPortfolio';
const URL_PARAM = 'portfolio';

type PortfolioContextValue = {
  portfolios: PortfolioEntity[];
  selected: string | null;
  selectedPortfolio: PortfolioEntity | null;
  setSelected: (id: string | null) => void;
  loading: boolean;
  refresh: () => Promise<void>;
};

const Ctx = createContext<PortfolioContextValue | null>(null);

/**
 * Global portfolio selection. Reads/writes the `?portfolio=` URL query
 * param so deep links work; falls back to localStorage when no param is
 * present. Every page that needs a portfolio reads from this context via
 * `usePortfolio()`.
 */
export function PortfolioProvider({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();

  const [portfolios, setPortfolios] = useState<PortfolioEntity[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await listPortfolios();
      setPortfolios(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load portfolios';
      appEvents.emit(AppEvents.alertError, [message]);
      setPortfolios([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Derive the currently-selected portfolio. URL param wins, then localStorage,
  // then "first available portfolio" as a soft default.
  const params = new URLSearchParams(location.search);
  const urlPortfolio = params.get(URL_PARAM);
  const stored = typeof window !== 'undefined' ? window.localStorage.getItem(STORAGE_KEY) : null;
  const fallback = portfolios.length > 0 ? portfolios[0].portfolio_id : null;
  const selected = urlPortfolio || stored || fallback;

  // Validate selection against the actual list once loaded — drop stale
  // selections from localStorage when the portfolio has been deleted.
  const validatedSelection = useMemo(() => {
    if (!selected) {
      return null;
    }
    if (portfolios.length === 0) {
      return loading ? selected : null;
    }
    return portfolios.some((p) => p.portfolio_id === selected) ? selected : null;
  }, [selected, portfolios, loading]);

  const setSelected = useCallback(
    (id: string | null) => {
      if (id) {
        window.localStorage.setItem(STORAGE_KEY, id);
      } else {
        window.localStorage.removeItem(STORAGE_KEY);
      }
      const search = new URLSearchParams(location.search);
      if (id) {
        search.set(URL_PARAM, id);
      } else {
        search.delete(URL_PARAM);
      }
      const q = search.toString();
      navigate(`${location.pathname}${q ? `?${q}` : ''}`, { replace: true });
    },
    [location.pathname, location.search, navigate],
  );

  const selectedPortfolio = useMemo(
    () => portfolios.find((p) => p.portfolio_id === validatedSelection) ?? null,
    [portfolios, validatedSelection],
  );

  const value: PortfolioContextValue = {
    portfolios,
    selected: validatedSelection,
    selectedPortfolio,
    setSelected,
    loading,
    refresh,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePortfolio(): PortfolioContextValue {
  const value = useContext(Ctx);
  if (!value) {
    throw new Error('usePortfolio must be called inside <PortfolioProvider>');
  }
  return value;
}
