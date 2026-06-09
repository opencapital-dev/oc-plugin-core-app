import { test } from './fixtures';

/**
 * Visual review screenshots — captures each major page so the operator
 * (and reviewers) can eyeball spacing, hierarchy, badge colours, etc.
 *
 * Run with: `npm run e2e -- --grep screenshots`
 *
 * Screenshots land under `test-results/screenshots/`.
 */

test.describe('portfolio-admin visual review', () => {
  test('admin landing page', async ({ gotoPage, page }) => {
    await gotoPage('/admin');
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: 'test-results/screenshots/admin-page.png', fullPage: true });
  });

  test('events page (Trades tab)', async ({ gotoPage, page }) => {
    await gotoPage('/events');
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: 'test-results/screenshots/events-trades.png', fullPage: true });
  });

  test('instruments page', async ({ gotoPage, page }) => {
    await gotoPage('/instruments');
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: 'test-results/screenshots/instruments.png', fullPage: true });
  });

  test('import wizard step 1', async ({ gotoPage, page }) => {
    await gotoPage('/import');
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: 'test-results/screenshots/import-step1.png', fullPage: true });
  });

  test('portfolios CRUD page', async ({ gotoPage, page }) => {
    await gotoPage('/portfolios');
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: 'test-results/screenshots/portfolios.png', fullPage: true });
  });
});
