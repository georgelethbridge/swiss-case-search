import express from 'express';
import cors from 'cors';
import multer from 'multer';
import pino from 'pino-http';
import { createJob, getJob } from './queue.js';
import JSZip from 'jszip';
import { parseWorkbook, appendResultsToWorkbook, writeWorkbook, buildSubsetWorkbook } from './xlsxUtil.js';

const app = express();
app.use(cors({ origin: ['https://www.georgelethbridge.com'] }));
app.use(pino());
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// Health
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// Upload and create job
app.post('/api/jobs', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    // accept ?debug=true or ?debug=full
    const debugFlag = String(req.query.debug || '').toLowerCase();
    const debug = debugFlag === 'true' || debugFlag === 'full';

    const { rows, wsName, wb } = parseWorkbook(req.file.buffer);
    const job = createJob(rows);
    // cache workbook in job for later merge
    job._wsName = wsName;
    job._wb = wb;
    job._debug = debug;

    // ⬇️ remove appendColumns
    res.json({ jobId: job.id, total: job.total, debug });
  } catch (e) {
    req.log.error(e, 'failed to create job');
    res.status(400).json({ error: e.message || String(e) });
  }
});

// Polling endpoint - simple
app.get('/api/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Not found' });
  res.json({ id: job.id, total: job.total, done: job.done, status: job.status, errors: job.errors.slice(0, 10) });
});

// SSE stream for progress
app.get('/api/jobs/:id/stream', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).end();
  res.setHeader('content-type', 'text/event-stream');
  res.setHeader('cache-control', 'no-cache');
  res.setHeader('connection', 'keep-alive');
  res.flushHeaders();

  const interval = setInterval(() => {
    const data = { done: job.done, total: job.total, status: job.status };
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    if (job.status === 'finished') {
      clearInterval(interval);
      res.write(`event: complete\n`);
      res.write(`data: ${JSON.stringify({ done: job.done, total: job.total })}\n\n`);
      res.end();
    }
  }, 1000);

  req.on('close', () => clearInterval(interval));
});

// Job details including results (and _debug per row)
app.get('/api/jobs/:id/full', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Not found' });
  if (job.status !== 'finished') return res.status(409).json({ error: 'Job not finished' });

  res.json({
    id: job.id,
    total: job.total,
    done: job.done,
    status: job.status,
    results: job.results, // includes _debug when debug=true
    errors: job.errors
  });
});

// Download split: one XLSX per unique first line of 'Sales Order Correspondence Address'
app.get('/api/jobs/:id/download-split', async (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Not found' });
  if (job.status !== 'finished') return res.status(409).json({ error: 'Job not finished' });

  // group rows by first line of Sales Order Correspondence Address
  const firstLine = (s) => String(s || '').split(/\r?\n/)[0].trim() || 'Unknown';
  const keyField = 'Sales Order Correspondence Address';
  const groups = new Map(); // key -> { rows: [], results: [] }

  job.rows.forEach((row, idx) => {
    const key = firstLine(row[keyField]);
    if (!groups.has(key)) groups.set(key, { rows: [], results: [] });
    groups.get(key).rows.push(row);
    groups.get(key).results.push(job.results[idx] || {});
  });

  // zip builder
  const zip = new JSZip();
  const safe = (s) => s.replace(/[^\w\-]+/g, '_').replace(/_+/g, '_').slice(0, 80) || 'client';

  // build a workbook per group and add to zip
  for (const [client, bundle] of groups.entries()) {
    const wb = buildSubsetWorkbook(bundle.rows, bundle.results, 'Sheet1');
    const buf = writeWorkbook(wb);
    zip.file(`${safe(client)}.xlsx`, buf);
  }

  const zipBuf = await zip.generateAsync({ type: 'nodebuffer' });
  res.setHeader('content-type', 'application/zip');
  res.setHeader('content-disposition', `attachment; filename="swissreg-split-${job.id}.zip"`);
  res.send(zipBuf);
});


// Download result
app.get('/api/jobs/:id/download', async (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Not found' });
  if (job.status !== 'finished') return res.status(409).json({ error: 'Job not finished' });
  const wb = appendResultsToWorkbook(job._wb, job._wsName, job.rows, job.results);
  const buf = writeWorkbook(wb);
  res.setHeader('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('content-disposition', `attachment; filename="swissreg-results-${job.id}.xlsx"`);
  res.send(buf);
});

const port = Number(process.env.PORT || 10000);
app.listen(port, () => {
  console.log(`listening on :${port}`);
});
