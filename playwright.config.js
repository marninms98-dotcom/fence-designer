'use strict';

const fs = require('fs');
const { defineConfig } = require('@playwright/test');

const chromeCandidates = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);
const executablePath = chromeCandidates.find((candidate) => fs.existsSync(candidate));

module.exports = defineConfig({
  testDir: './tests',
  testMatch: /reported-regressions-playwright\.spec\.js/,
  timeout: 30000,
  fullyParallel: false,
  workers: 1,
  reporter: 'line',
  use: {
    headless: true,
    launchOptions: executablePath ? { executablePath } : {},
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
