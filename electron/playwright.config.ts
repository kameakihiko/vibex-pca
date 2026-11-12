import { defineConfig } from '@playwright/test';

// One folder for each step of a CI job: a run of Playwright empties its own folder, and took the failures of the step before.
const out = process.env.VIBEX_TEST_OUT || 'test-results';

// No test reads the real values of a team: not the site file of this computer, and not the owner's release settings.
// The scripts under test get made-up ones (tests/release.spec.ts plays the server in a temp folder).
process.env.VIBEX_PCA_SITE_FILE = '/nonexistent/vibex-pca-no-site-file.json';
process.env.VIBEX_PCA_RELEASE_ENV = '/nonexistent/vibex-pca-no-release-env';
process.env.VIBEX_PCA_FEED_SSH = 'feed@feed.invalid';
process.env.VIBEX_PCA_FEED_DIR = '/srv/feed/vibex-updates';
process.env.VIBEX_PCA_REPO = 'example-owner/vibex-pca';
delete process.env.VIBEX_FENCE_HOST;

export default defineConfig({
  testDir: 'tests',
  outputDir: out,
  timeout: 120_000,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: `${out}-html` }]],
  use: { trace: 'retain-on-failure' },
});
