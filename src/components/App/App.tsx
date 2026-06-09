import React from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { type AppRootProps } from '@grafana/data';

import { ROUTES } from '../../constants';
import { PortfolioProvider } from '../../contexts/PortfolioContext';
import { AdminPage } from '../../pages/AdminPage';
import { EventsPage } from '../../pages/EventsPage';
import { ImportPage } from '../../pages/ImportPage';
import { InstrumentsPage } from '../../pages/InstrumentsPage';
import { PluginsPage } from '../../pages/PluginsPage';
import { PortfoliosPage } from '../../pages/PortfoliosPage';

function App(_props: AppRootProps) {
  return (
    <PortfolioProvider>
      <Routes>
        <Route path={ROUTES.Admin} element={<AdminPage />} />
        <Route path={ROUTES.Portfolios} element={<PortfoliosPage />} />
        <Route path={ROUTES.Instruments} element={<InstrumentsPage />} />
        <Route path={ROUTES.Events} element={<EventsPage />} />
        <Route path={ROUTES.Import} element={<ImportPage />} />
        <Route path={ROUTES.Plugins} element={<PluginsPage />} />
        <Route path="*" element={<Navigate replace to={ROUTES.Admin} />} />
      </Routes>
    </PortfolioProvider>
  );
}

export default App;
