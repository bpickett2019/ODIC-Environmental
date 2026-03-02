import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

// Screenshot 1: Upload overlay (initial state)
await page.goto('http://localhost:5173');
await page.waitForTimeout(2500);
await page.screenshot({ path: 'screenshots/01-upload-overlay.png' });

// Debug: dump page content
const bodyText = await page.textContent('body');
console.log('Page text (first 300 chars):', bodyText.slice(0, 300));

// Click on the report card (click on the text "Test Report")
const reportCard = page.getByText('Test Report', { exact: true });
const found = await reportCard.count();
console.log('Found "Test Report":', found);

if (found > 0) {
  await reportCard.click();
  await page.waitForTimeout(3000);

  // Screenshot 2: Dashboard with report loaded (empty — 0 docs)
  await page.screenshot({ path: 'screenshots/02-dashboard-empty.png' });

  // Screenshot 3: Sidebar detail
  await page.screenshot({
    path: 'screenshots/03-sidebar-empty.png',
    clip: { x: 0, y: 0, width: 400, height: 900 }
  });

  // Screenshot 4: Header
  await page.screenshot({
    path: 'screenshots/04-header.png',
    clip: { x: 0, y: 0, width: 1440, height: 60 }
  });

  // Screenshot 5: Preview area
  await page.screenshot({
    path: 'screenshots/05-preview-area.png',
    clip: { x: 380, y: 50, width: 1060, height: 850 }
  });
} else {
  console.log('No report card found. Page might not have loaded.');
}

await browser.close();
console.log('Done');
