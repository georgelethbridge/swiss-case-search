import fs from 'fs/promises';
import puppeteer from 'puppeteer';

let _template;

export async function loadTemplate() {
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

export function fillTemplate(html, { name, address }) {
  return html
    .replaceAll('{applicant_name}', escapeHtml(name))
    .replaceAll('{applicant_address}', escapeHtml(address));
}

export async function renderManyToPdf(htmlList) {
  let browser;
  try {
    browser = await puppeteer.launch({
      args: ['--no-sandbox','--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.emulateMediaType('screen'); // ensures printBackground renders consistently

    const bufs = [];
    for (const html of htmlList) {
      await page.setContent(html, { waitUntil: 'networkidle0', timeout: 60000 });
      const pdf = await page.pdf({
        format: 'A4',
        printBackground: true,
        timeout: 60000
      });
      bufs.push(pdf);
    }
    return bufs;
  } finally {
    if (browser) await browser.close();
  }
}
