/* global React, ReactDOM, htm */
const { useState, useRef } = React;
const html = htm.bind(React.createElement);

function App() {
  const [file, setFile] = useState(null);
  const [job, setJob] = useState(null);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const [caseCount, setCaseCount] = useState(null);
  const [epColDetected, setEpColDetected] = useState('');


  // Split-by controls (will be populated by backend)
  const [canSplit, setCanSplit] = useState(false);
  const [availableSplits, setAvailableSplits] = useState([]);
  const [splitBy, setSplitBy] = useState('address_name');

  // Debug payload
  const [debugInfo, setDebugInfo] = useState(null);
  const [showDebug, setShowDebug] = useState(false);

  // EP column selection (when backend can’t find it)
  const [epNeeded, setEpNeeded] = useState(false);
  const [epOptions, setEpOptions] = useState([]);
  const [epChoice, setEpChoice] = useState('');
  const [pendingFile, setPendingFile] = useState(null);

  const [downloadingSplit, setDownloadingSplit] = useState(false);
  const [splitProgress, setSplitProgress] = useState(0);


  const inputRef = useRef(null);

  const backend = 'https://swissreg-batch.onrender.com';

  // Heuristic to pick the EP column from headers
  function inferEpColumn(headers = []) {
    const canonical = h => String(h || '').trim().toLowerCase();
    const score = (h) => {
      const s = canonical(h);
      let pts = 0;
      if (/\b(ep|publication|grant)\b/.test(s)) pts += 2;
      if (/\b(number|no|no\.|#)\b/.test(s)) pts += 1;
      if (/^ep\b/.test(s)) pts += 3;
      return pts;
    };
    let best = '', bestScore = -1;
    headers.forEach(h => {
      const sc = score(h);
      if (sc > bestScore) { best = h; bestScore = sc; }
    });
    return bestScore > 0 ? best : '';
  }

  // Normalise EP publication number to "EPNNNNNNN" (7 digits)
  // returns "" when it doesn't look valid
  function normalizeEP(v) {
    const s = String(v || '').replace(/[^A-Za-z0-9]/g,'').toUpperCase();
    // Candidates like EP1234567 or EP0123456
    const m = s.match(/^EP(\d{7})$/);
    return m ? `EP${m[1]}` : '';
  }

  // Parse first sheet, infer column, count usable EPs
  async function precountCases(file) {
    try {
      setCaseCount(null);
      setEpColDetected('');

      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const wsName = wb.SheetNames[0];
      const ws = wb.Sheets[wsName];
      const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

      if (!rows.length) { setCaseCount(0); return; }

      const headers = Object.keys(rows[0]);
      const epCol = inferEpColumn(headers);
      setEpColDetected(epCol);

      const cnt = rows.reduce((n, r) => {
        const raw = epCol ? r[epCol] : '';
        return n + (normalizeEP(raw) ? 1 : 0);
      }, 0);

      setCaseCount(cnt);
    } catch {
      // soft fail – just don’t show a count
      setCaseCount(null);
    }
}


  function onDrop(e) {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) {
      setFile(f);
      setPendingFile(f);
      // reset states for a fresh run
      setError('');
      setJob(null);
      setConfirmed(false);
      setEpNeeded(false);
      setEpOptions([]);
      setEpChoice('');
      setDebugInfo(null);
      precountCases(f);

    }
  }

  function onDrag(e, over) {
    e.preventDefault();
    setDragOver(over);
  }

  async function startJob(epColOverride) {
    setError('');
    setDebugInfo(null);
    const f = pendingFile || file;
    if (!f) return;

    const form = new FormData();
    form.append('file', f);

    // if we already know the EP column, tell the backend
    const qs = new URLSearchParams({ debug: 'full' });
    if (epColOverride) qs.set('epCol', epColOverride);

    const r = await fetch(`${backend}/api/jobs?` + qs.toString(), { method: 'POST', body: form });

    if (r.status === 422) {
      // Backend couldn't find the EP column. Show the dropdown.
      let j = {};
      try { j = await r.json(); } catch {}
      if (j && j.error === 'no_ep_column' && Array.isArray(j.headers)) {
        setEpNeeded(true);
        setEpOptions(j.headers);
        setEpChoice(''); // force user to pick
        setError('');
        return;
      }
    }

    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      setError(j.error || 'Upload failed');
      return;
    }

    // job accepted
    setJob(j);
    setProgress({ done: 0, total: j.total || 0 });
    setCanSplit(!!j.canSplit);
    setAvailableSplits(Array.isArray(j.availableSplits) ? j.availableSplits : []);
    if (j.availableSplits && j.availableSplits.length) {
      setSplitBy(j.availableSplits[0]);
    }
    setConfirmed(true);

    const ev = new EventSource(`${backend}/api/jobs/${j.jobId}/stream`);
    ev.onmessage = (m) => setProgress(JSON.parse(m.data));
    ev.addEventListener('complete', async () => {
      ev.close();
      const res = await fetch(`${backend}/api/jobs/${j.jobId}/full`);
      const full = await res.json();
      setDebugInfo(full);
    });
  }

  async function continueAfterChoosingEp() {
    if (!epChoice) {
      setError('Please select the EP column.');
      return;
    }
    setError('');
    await startJob(epChoice);
  }

  async function downloadResults() {
    if (!job) return;
    const r = await fetch(`${backend}/api/jobs/${job.jobId}/download`);
    if (!r.ok) { const j = await r.json().catch(()=>({})); setError(j.error || 'Not ready'); return; }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `swissreg-results-${job.jobId}.xlsx`; a.click();
    URL.revokeObjectURL(url);
  }

  async function downloadSplit() {
    if (!job || downloadingSplit) return;
    setDownloadingSplit(true);
    setSplitProgress(0);
    setError('');

    try {
      // 1) Start the split task
      const startRes = await fetch(`${backend}/api/jobs/${job.jobId}/split?splitBy=${encodeURIComponent(splitBy)}`, {
        method: 'POST'
      });
      const startJson = await startRes.json();
      if (!startRes.ok) throw new Error(startJson.error || 'Failed to start split');
      const taskId = startJson.taskId;

      // 2) Stream progress
      await new Promise((resolve, reject) => {
        const ev = new EventSource(`${backend}/api/split/${taskId}/stream`);
        ev.onmessage = (m) => {
          const { percent } = JSON.parse(m.data);
          setSplitProgress(percent || 0);
        };
        ev.addEventListener('complete', async () => {
          ev.close();
          // 3) Download the finished ZIP
          const r = await fetch(`${backend}/api/split/${taskId}/download`);
          if (!r.ok) {
            const j = await r.json().catch(()=>({}));
            reject(new Error(j.error || 'Not ready'));
            return;
          }
          const blob = await r.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url; a.download = `swissreg-split-${job.jobId}.zip`; a.click();
          URL.revokeObjectURL(url);
          resolve();
        });
        ev.onerror = () => {
          ev.close();
          reject(new Error('Progress stream error'));
        };
      });

    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setDownloadingSplit(false);
      setSplitProgress(0);
    }
  }


  const percent = progress.total ? Math.floor((progress.done / progress.total) * 100) : 0;

  return html`
  <div class="max-w-3xl mx-auto">
    <div class="flex items-start justify-between">
      <h1 class="text-2xl font-bold mb-4">Swissreg Batch Tool</h1>
      <button class="text-sm underline" onClick=${() => setShowDebug(s => !s)}>
        ${showDebug ? 'Hide debugging' : 'Show debugging'}
      </button>
    </div>
    <p class="mb-3 text-sm">
      Upload an Excel (.xlsx) file with European Patent publication numbers. This tool will query Swissreg
      and append results to your sheet. When complete, download the results or split per client.
    </p>

    <div class="grid gap-3">
      <div
        class=${"p-6 rounded-2xl bg-white shadow dropzone text-center border-2 " + (dragOver ? "border-blue-500" : "border-dashed border-slate-300")}
        onDragOver=${(e)=>onDrag(e,true)}
        onDragLeave=${(e)=>onDrag(e,false)}
        onDrop=${onDrop}
        onClick=${() => inputRef.current?.click()}
      >
        ${file
          ? html`
              <div class="flex flex-col items-center gap-1">
                <div>
                  <strong>${file.name}</strong> – ${(file.size/1024/1024).toFixed(2)} MB
                </div>
                ${caseCount !== null && html`
                  <div class="text-xs bg-emerald-50 text-emerald-700 px-2 py-0.5 rounded-full">
                    ${caseCount} ${caseCount === 1 ? 'case' : 'cases'} detected
                    ${epColDetected ? html`<span class="text-slate-500">(column: ${epColDetected})</span>` : ''}
                  </div>
                `}
              </div>
            `
          : html`<div>Drag and drop spreadsheet here, or click to select</div>`
        }

        <input type="file" accept=".xlsx" hidden ref=${inputRef} onChange=${e=> {
          const f = e.target.files[0];
          setFile(f || null);
          setPendingFile(f || null);
          if (f) precountCases(f);
          setError('');
          setJob(null);
          setConfirmed(false);
          setEpNeeded(false);
          setEpOptions([]);
          setEpChoice('');
          setDebugInfo(null);
        }} />
      </div>

      ${file && !confirmed && !epNeeded && html`
        <div class="flex gap-3">
          <button class="px-4 py-2 rounded-xl bg-blue-600 text-white" onClick=${() => startJob()}>Confirm and start</button>
          <button class="px-4 py-2 rounded-xl bg-slate-200" onClick=${() => {
            setFile(null); setPendingFile(null); setError(''); setJob(null); setConfirmed(false);
            setEpNeeded(false); setEpOptions([]); setEpChoice(''); setDebugInfo(null);
          }}>Reset</button>
        </div>
      `}

      ${epNeeded && html`
        <div class="bg-white rounded-2xl p-4 shadow">
          <div class="font-semibold mb-2">Select the column that contains the EP publication number</div>
          <div class="text-xs text-slate-600 mb-3">
            We couldn't auto-detect the EP column. Choose it below and click Continue.
          </div>
          <div class="flex flex-wrap gap-3 items-center">
            <select class="border rounded px-2 py-1" value=${epChoice} onChange=${e => setEpChoice(e.target.value)}>
              <option value="">-- Select column --</option>
              ${epOptions.map(h => html`<option value=${h}>${h}</option>`)}
            </select>
            <button
              class=${"px-4 py-2 rounded-xl text-white " + (epChoice ? "bg-blue-600" : "bg-blue-300 cursor-not-allowed")}
              disabled=${!epChoice}
              onClick=${continueAfterChoosingEp}
            >Continue</button>
            <button class="px-4 py-2 rounded-xl bg-slate-200" onClick=${() => {
              setEpNeeded(false); setEpOptions([]); setEpChoice('');
            }}>Cancel</button>
          </div>
        </div>
      `}

      ${job && html`
        <div class="bg-white rounded-2xl p-4 shadow">
          <div class="mb-2 text-sm">Job ${job.jobId} - ${progress.done}/${progress.total}</div>
          <div class="w-full bg-slate-200 rounded h-3 overflow-hidden">
            <div class="bg-blue-600 h-3" style=${{ width: percent + '%' }}></div>
          </div>
          <div class="mt-2 text-sm">${percent}%</div>
        </div>
      `}

      ${job && progress.done === progress.total && html`
          <div class="flex items-center gap-3">
            <button
              type="button"
              class="px-4 py-2 rounded-xl bg-emerald-600 text-white"
              onClick=${downloadResults}
            >
              Download results
            </button>

            ${canSplit && html`
              <div class="flex items-center gap-2">
                <label class="text-sm text-slate-700">Split by:</label>
                <select
                  class="border rounded px-2 py-1"
                  value=${splitBy}
                  onChange=${e => setSplitBy(e.target.value)}
                >
                  ${availableSplits.map(opt => html`
                    <option value=${opt}>
                      ${opt === 'client'
                        ? 'Client account name'
                        : opt === 'address_name'
                          ? 'Sales order correspondence address – name'
                          : 'Sales order correspondence address – email'}
                    </option>
                  `)}
                </select>

                <button
                  type="button"
                  class=${"px-4 py-2 rounded-xl text-white " +
                          (downloadingSplit ? "bg-indigo-400 cursor-wait" : "bg-indigo-600")}
                  disabled=${downloadingSplit}
                  aria-busy=${downloadingSplit}
                  onClick=${downloadSplit}
                >
                  ${downloadingSplit ? `Preparing… ${splitProgress}%` : 'Download split files'}
                </button>
              </div>
            `}
          </div>

          ${downloadingSplit && html`
            <div class="w-full bg-slate-200 rounded h-2 overflow-hidden">
              <div class="bg-indigo-600 h-2" style=${{ width: `${splitProgress}%` }}></div>
            </div>
          `}
        </div>


      `}

      ${error && html`<div class="text-red-700">${error}</div>`}

      ${showDebug && debugInfo && html`
        <details class="mt-6 bg-gray-100 p-4 rounded-xl" open>
          <summary class="cursor-pointer font-semibold">Debug (request & response)</summary>
          <pre class="mt-2 text-xs whitespace-pre-wrap overflow-x-auto">${
            JSON.stringify(debugInfo.results?.[0]?._debug ?? debugInfo, null, 2)
          }</pre>
        </details>
      `}
    </div>
  </div>`;
}

ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));
