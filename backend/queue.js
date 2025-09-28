import Bottleneck from 'bottleneck';
import { callSwissreg, callSwissregWithDebug } from './ipiClient.js';


const limiter = new Bottleneck({
  maxConcurrent: Number(process.env.RATE_MAX_CONCURRENT || 1),
  minTime: Number(process.env.RATE_MIN_TIME_MS || 600)
});

// In-memory job store - for large jobs and high availability, swap to Redis backed queue
const jobs = new Map();

function createJob(rows) {
  const id = Math.random().toString(36).slice(2);
  const job = { id, total: rows.length, done: 0, startedAt: Date.now(), finishedAt: null, rows, results: [], errors: [], status: 'running' };
  jobs.set(id, job);
  // start processing
  rows.forEach((row, idx) => {
    limiter.schedule(() => processRow(job, idx, row)).catch(err => {
      // should not happen - processRow handles own errors
      console.error(err);
    });
  });
  return job;
}

async function processRow(job, idx, row) {
  const ep = String(row.__ep || '').trim().toUpperCase();
  try {
    if (!/^EP\d+$/.test(ep)) throw new Error(`Invalid EP format: ${ep}`);
    const { data, debug } = await callSwissregWithDebug(ep);
    job.results[idx] = data;
    job.debug = debug; // store debug info (only last one shown)

    job.results[idx] = {
      statusCode: data.statusCode,
      lastChangeDate: data.lastChangeDate,
      representative: data.representative,
      filingDate: data.filingDate,
      grantDate: data.grantDate,
      ownerNames: data.ownerNames,
      ownerAddresses: data.ownerAddresses
    };
  } catch (e) {
    job.results[idx] = {
      statusCode: `ERROR: ${e.message || String(e)}`,
      lastChangeDate: '', representative: '', filingDate: '', grantDate: '', ownerNames: '', ownerAddresses: ''
    };
    job.errors.push({ idx, ep, error: e.message || String(e) });
  } finally {
    job.done += 1;
    if (job.done === job.total) {
      job.finishedAt = Date.now();
      job.status = 'finished';
    }
  }
}

function getJob(id) { return jobs.get(id) || null; }

export { createJob, getJob };