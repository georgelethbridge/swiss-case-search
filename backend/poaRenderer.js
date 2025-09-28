import fs from 'fs/promises';
import puppeteer from 'puppeteer';

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
  const browser = await puppeteer.launch({ args: ['--no-sandbox','--disable-setuid-sandbox'] });
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
