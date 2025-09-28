import fs from 'fs/promises';
import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';

let _template;

/** Load the HTML template once */
async function loadTemplate() {
  if (!_template) {
    const url = new URL('./templates/poa.html', import.meta.url);
    _template = await fs.readFile(url, 'utf8');
  }
  return _template;
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;');
}

/** Replace tokens in the HTML */
function fillTemplate(html, { name, address }) {
  return html
    .replaceAll('{applicant_name}', escapeHtml(name))
    .replaceAll('{applicant_address}', escapeHtml(address));
}

/** Render many HTML strings to PDF buffers reusing a single browser instance */
async function renderManyToPdf(htmlList) {
  // Configure serverless Chrome for Render
  const executablePath = await chromium.executablePath();

  const browser = await puppeteer.launch({
    headless: chromium.headless,               // true in serverless
    executablePath,                            // provided by @sparticuz/chromium
    args: chromium.args,                       // hardened args that work on serverless
    defaultViewport: chromium.defaultViewport, // sane defaults
    ignoreHTTPSErrors: true
  });

  const page = await browser.newPage();
  const bufs = [];
  for (const html of htmlList) {
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({ format: 'A4', printBackground: true });
    bufs.push(pdf);
  }
  await browser.close();
  return bufs;
}

export { loadTemplate, fillTemplate, renderManyToPdf };
