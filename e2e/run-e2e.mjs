// Одноразовый e2e-раннер v5.html (playwright-core + кэшированный chromium MCP)
import { chromium } from 'playwright-core';
import { readFileSync } from 'fs';
import { homedir } from 'os';

const EXE = homedir() + '/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const scenarioPath = process.argv[2];
const scenarioSrc = readFileSync(scenarioPath, 'utf8');
const scenario = eval('(' + scenarioSrc + ')'); // файл содержит `async (page) => {...}`

const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--use-fake-ui-for-media-stream'] });
const page = await browser.newPage();
page.setDefaultTimeout(30000);
try {
  const out = await scenario(page);
  console.log(out);
  if (/\bFAIL |EXCEPTION/.test(String(out))) process.exitCode = 1;   // FAIL в выводе = ненулевой код (ревью Codex 14.07)
} catch (e) {
  console.log('RUNNER EXCEPTION: ' + e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
