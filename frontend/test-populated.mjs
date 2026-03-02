import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

await page.goto('http://localhost:5173');
await page.waitForTimeout(1500);

// Screenshot 1: Upload overlay (initial state, no report selected)
await page.screenshot({ path: 'screenshots/f01-upload-overlay.png' });

// Click on "Test Report" to load it
const reportLink = page.getByText('Test Report', { exact: true });
if (await reportLink.isVisible()) {
  await reportLink.click();
  await page.waitForTimeout(2000);
}

// Screenshot 2: Full dashboard
await page.screenshot({ path: 'screenshots/f02-dashboard.png' });

// Scroll sidebar to bottom to see all sections
await page.evaluate(() => {
  const sidebar = document.querySelector('.overflow-y-auto');
  if (sidebar) sidebar.scrollTop = sidebar.scrollHeight;
});
await page.waitForTimeout(300);
await page.screenshot({
  path: 'screenshots/f03-sidebar-bottom.png',
  clip: { x: 0, y: 300, width: 400, height: 600 }
});

// Hover on a doc in App D section (which has 3 docs)
const aerialsDoc = page.getByText('6384674-ESAI-Aerials_1.pdf');
if (await aerialsDoc.isVisible()) {
  const parentRow = aerialsDoc.locator('xpath=ancestor::div[contains(@class, "group")]').first();
  await parentRow.hover();
  await page.waitForTimeout(500);
  await page.screenshot({
    path: 'screenshots/f04-doc-hover-appd.png',
    clip: { x: 0, y: 0, width: 400, height: 900 }
  });
}

// Click "All Reports" to go back
const allReports = page.getByText('All Reports');
if (await allReports.isVisible()) {
  await allReports.click();
  await page.waitForTimeout(1000);
  await page.screenshot({ path: 'screenshots/f05-back-to-overlay.png' });
}

await browser.close();
console.log('Done! All final screenshots saved.');
