/* global React, ReactDOM, htm */
const { useState, useRef } = React;
const html = htm.bind(React.createElement);

// --- Minimal design system (drop in once) ---
const Card = ({title, actions, children, subtle=false}) => html`
  <section class=${"rounded-2xl p-6 shadow-sm " + (subtle ? "bg-slate-50 border border-slate-200" : "bg-white border border-slate-200")}>
    ${title && html`
      <header class="flex items-center justify-between mb-4">
        <h3 class="text-lg font-semibold text-slate-900">${title}</h3>
        ${actions || null}
      </header>
    `}
    <div class="space-y-3">
      ${children}
    </div>
  </section>
`;

const Button = ({kind="solid", color="slate", disabled, busy, onClick, children}) => {
  const base = "inline-flex items-center justify-center gap-2 px-4 py-2 rounded-xl font-medium transition-colors shadow-sm";
  const palette = {
    emerald: disabled ? "bg-emerald-300 text-white" : "bg-emerald-600 hover:bg-emerald-700 text-white",
    indigo:  disabled ? "bg-indigo-300 text-white"  : "bg-indigo-600 hover:bg-indigo-700 text-white",
    slate:   disabled ? "bg-slate-400 text-white"   : "bg-slate-800 hover:bg-slate-700 text-white",
    outline: "border border-slate-300 text-slate-700 bg-white hover:bg-slate-50"
  };
  const cls = kind === "outline" ? palette.outline : palette[color] || palette.slate;
  return html`
    <button type="button" class=${base + " " + cls}
      disabled=${disabled} aria-busy=${busy} onClick=${onClick}>
      ${children}
    </button>
  `;
};

const Field = ({label, hint, children}) => html`
  <div class="space-y-1">
    ${label && html`<label class="text-sm font-medium text-slate-800">${label}</label>`}
    ${children}
    ${hint && html`<p class="text-xs text-slate-500">${hint}</p>`}
  </div>
`;

const Select = ({value, onChange, children}) => html`
  <select class="w-full sm:w-auto border border-slate-300 rounded-xl px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
    value=${value} onChange=${onChange}>
    ${children}
  </select>
`;

const FilePicker = ({onChange, accept=".xlsx"}) => html`
  <label class="inline-flex items-center gap-2 px-3 py-2 rounded-xl border border-slate-300 bg-slate-50 hover:bg-slate-100 cursor-pointer">
    <input type="file" accept=${accept} class="sr-only"
      onChange=${e => onChange?.(e.target.files?.[0] || null)} />
    <span class="text-sm font-medium text-slate-700">📄 Choose file</span>
  </label>
`;

const ProgressBar = ({value}) => html`
  <div class="h-2 w-full bg-slate-100 rounded-full overflow-hidden">
    <div class="bg-emerald-600 h-2" style=${{ width: (value||0) + '%' }}></div>
  </div>
`;


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

  const [hasDownloadedResults, setHasDownloadedResults] = useState(false);
  const [downloadingPoAsOnly, setDownloadingPoAsOnly] = useState(false);

  const [poaSheetFile, setPoaSheetFile] = useState(null);
  const [downloadingPoAsFromSheet, setDownloadingPoAsFromSheet] = useState(false);




  const inputRef = useRef(null);

  const backend = 'https://swissreg-batch.onrender.com';

  // Heuristic to pick the EP column from headers
  function inferEpColumn(headers = [], rows = []) {
    const canon = h => String(h || '').trim().toLowerCase();

    // Score header names; demote anything that looks like "application"
    const scoreHeader = (h) => {
      const s = canon(h);
      let pts = 0;
      if (s.startsWith('ep')) pts += 5;
      if (/\bpublication\b/.test(s)) pts += 3;
      if (/\bgrant\b/.test(s)) pts += 2;
      if (/\b(number|no|no\.|#)\b/.test(s)) pts += 1;
      // if (/\bapplication\b/.test(s)) pts -= 4;   // <-- push "Application Number" down
      return pts;
    };

    // sort by score (desc)
    const ordered = headers
      .map(h => ({ h, score: scoreHeader(h) }))
      .sort((a, b) => b.score - a.score);

    // pick the first candidate that actually contains an EP in sample rows
    const sample = rows.slice(0, 200);
    for (const { h, score } of ordered) {
      if (score <= 0) break; // nothing convincing left
      const hits = sample.reduce((n, r) => n + (normalizeEP(r[h]) ? 1 : 0), 0);
      if (hits > 0) return h;
    }
    return '';
  }

  // Extract/normalize "EPNNNNNNN" even if there are spaces or kind codes (e.g. "EP 2305232 B1")
  function normalizeEP(v) {
    const s = String(v || '').toUpperCase();
    const m = s.match(/\bEP\s*\d{7}\b/);      // find "EP 1234567" anywhere
    if (!m) return '';
    return m[0].replace(/\s+/g, '');         // "EP 1234567" -> "EP1234567"
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
      const epCol = inferEpColumn(headers, rows);   // <-- pass rows too
      setEpColDetected(epCol);

      const cnt = rows.reduce((n, r) => n + (normalizeEP(epCol ? r[epCol] : '') ? 1 : 0), 0);
      setCaseCount(cnt);
    } catch {
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
    setHasDownloadedResults(true);
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

  async function downloadPoAsOnly() {
    if (!job) return;
    try {
      setDownloadingPoAsOnly(true);
      const resp = await fetch(`${backend}/api/jobs/${job.jobId}/download-poas-only`, {
        method: 'POST'
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || `Download failed with ${resp.status}`);
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `poas-${job.jobId}.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setDownloadingPoAsOnly(false);
    }
  }

  async function downloadPoAsFromSheet() {
    if (!job || !poaSheetFile) return;
    try {
      setDownloadingPoAsFromSheet(true);
      const fd = new FormData();
      fd.append('file', poaSheetFile, poaSheetFile.name || 'results.xlsx');
      const resp = await fetch(`${backend}/api/jobs/${job.jobId}/poas-from-sheet`, {
        method: 'POST',
        body: fd
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || `Download failed (${resp.status})`);
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `poas-from-sheet-${job.jobId}.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setDownloadingPoAsFromSheet(false);
    }
  }




  const percent = progress.total ? Math.floor((progress.done / progress.total) * 100) : 0;

  return html`
    <div class="max-w-4xl mx-auto space-y-6">

      <!-- Page header -->
      <div class="flex items-start justify-between">
        <h1 class="text-2xl font-bold">Swissreg Batch Tool</h1>
        <button class="text-sm underline" onClick=${() => setShowDebug(s => !s)}>
          ${showDebug ? 'Hide debugging' : 'Show debugging'}
        </button>
      </div>
      <p class="text-sm text-slate-600">
        Upload an Excel (.xlsx) file with European Patent publication numbers. This tool will query Swissreg
        and append results to your sheet. When complete, download the results or split per client.
      </p>

      <!-- Upload card -->
      ${Card({
        title: "Upload - EP publication numbers",
        children: html`
          <div
            class=${"p-6 rounded-2xl bg-white shadow-sm border-2 text-center cursor-pointer " +
                    (dragOver ? "border-blue-500" : "border-dashed border-slate-300")}
            onDragOver=${(e)=>onDrag(e,true)}
            onDragLeave=${(e)=>onDrag(e,false)}
            onDrop=${onDrop}
            onClick=${() => inputRef.current?.click()}
          >
            ${file
              ? html`
                  <div class="flex flex-col items-center gap-1">
                    <div class="text-slate-800 font-medium">
                      ${file.name} – ${(file.size/1024/1024).toFixed(2)} MB
                    </div>
                    ${caseCount !== null && html`
                      <div class="text-xs bg-emerald-50 text-emerald-700 px-2 py-0.5 rounded-full inline-flex gap-1">
                        <span>${caseCount} ${caseCount === 1 ? 'case' : 'cases'} detected</span>
                        ${epColDetected ? html`<span class="text-slate-500">(column: ${epColDetected})</span>` : null}
                      </div>
                    `}
                  </div>
                `
              : html`<div class="text-slate-600">Drag and drop spreadsheet here, or click to select</div>`
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

          ${file && html`
            <div class="flex flex-wrap gap-3 pt-3">
              <button class="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white"
                      onClick=${() => startJob()}>
                Confirm and start
              </button>
              <button class="px-4 py-2 rounded-xl border border-slate-300 bg-white hover:bg-slate-50"
                      onClick=${() => {
                        setFile(null); setPendingFile(null); setError(''); setJob(null); setConfirmed(false);
                        setEpNeeded(false); setEpOptions([]); setEpChoice(''); setDebugInfo(null);
                      }}>
                Reset
              </button>
            </div>
          `}
        `
      })}

      <!-- EP column chooser -->
      ${epNeeded && Card({
        title: "Select EP publication column",
        children: html`
          <p class="text-xs text-slate-600">
            We couldn't auto-detect the EP column. Choose it below and click Continue.
          </p>
          <div class="flex flex-wrap gap-3 items-center">
            <select class="border rounded-xl px-3 py-2 text-sm bg-white"
                    value=${epChoice}
                    onChange=${e => setEpChoice(e.target.value)}>
              <option value="">-- Select column --</option>
              ${epOptions.map(h => html`<option value=${h}>${h}</option>`)}
            </select>

            <button
              class=${"px-4 py-2 rounded-xl text-white " + (epChoice ? "bg-blue-600 hover:bg-blue-700" : "bg-blue-300 cursor-not-allowed")}
              disabled=${!epChoice}
              onClick=${continueAfterChoosingEp}
            >Continue</button>

            <button class="px-4 py-2 rounded-xl border border-slate-300 bg-white hover:bg-slate-50"
                    onClick=${() => { setEpNeeded(false); setEpOptions([]); setEpChoice(''); }}>
              Cancel
            </button>
          </div>
        `
      })}

      <!-- Progress -->
      ${job && Card({
        title: "Processing",
        actions: html`<span class="text-sm text-slate-500">Job ${job.jobId || job}</span>`,
        children: html`
          <div class="w-full bg-slate-200 rounded h-3 overflow-hidden">
            <div class="bg-blue-600 h-3" style=${{ width: percent + '%' }}></div>
          </div>
          <div class="text-sm text-slate-600">${percent}%</div>
        `
      })}

      <!-- Results + split + re-upload -->
      ${job && progress.done === progress.total && html`
        <section class="space-y-6">

          ${Card({
            title: "Results - ready to download",
            children: html`
              <div class="flex flex-wrap gap-3">
                <button
                  type="button"
                  class="flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-medium"
                  onClick=${downloadResults}
                >
                  ⬇️ Download results
                </button>

                <button
                  type="button"
                  class=${"flex items-center gap-2 px-4 py-2 rounded-xl font-medium text-white " +
                          (downloadingPoAsOnly ? "bg-slate-400 cursor-wait" : "bg-slate-800 hover:bg-slate-700")}
                  disabled=${downloadingPoAsOnly}
                  aria-busy=${downloadingPoAsOnly}
                  onClick=${downloadPoAsOnly}
                >
                  ${downloadingPoAsOnly ? "⏳ Preparing PoAs…" : "📄 Download PoAs only"}
                </button>
              </div>

              ${canSplit && html`
                <div class="pt-2 grid sm:grid-cols-[auto_1fr_auto] items-center gap-3">
                  <div class="text-sm text-slate-700 font-medium">Split by</div>
                  <select
                    class="border border-slate-300 rounded-xl px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                    value=${splitBy}
                    onChange=${e => setSplitBy(e.target.value)}
                  >
                    ${availableSplits.map(opt => html`
                      <option value=${opt}>
                        ${opt === 'client'
                          ? 'Client account name'
                          : opt === 'address_name'
                            ? 'Sales order address - name'
                            : 'Sales order address - email'}
                      </option>
                    `)}
                  </select>

                  <button
                    type="button"
                    class=${"flex items-center gap-2 px-4 py-2 rounded-xl text-white font-medium " +
                            (downloadingSplit ? "bg-indigo-400 cursor-wait" : "bg-indigo-600 hover:bg-indigo-700")}
                    disabled=${downloadingSplit}
                    aria-busy=${downloadingSplit}
                    onClick=${downloadSplit}
                  >
                    ${downloadingSplit ? `⏳ Preparing… ${splitProgress}%` : '📦 Download split files'}
                  </button>
                </div>
              `}

              ${downloadingSplit && html`
                <div class="pt-2 w-full bg-slate-200 rounded h-2 overflow-hidden">
                  <div class="bg-indigo-600 h-2" style=${{ width: `${splitProgress}%` }}></div>
                </div>
              `}
            `
          })}

          ${Card({
            title: "Re-upload edited results to generate PoAs",
            children: html`
              <p class="text-sm text-slate-600">
                Uses OwnerN and OwnerNAddress columns only. If an owner appears with multiple addresses, separate PoAs will be created.
              </p>
              <div class="flex flex-col sm:flex-row sm:items-center gap-3">
                <label class="inline-flex items-center gap-2 px-3 py-2 rounded-xl border border-slate-300 bg-slate-50 hover:bg-slate-100 cursor-pointer">
                  <input
                    type="file"
                    accept=".xlsx"
                    class="sr-only"
                    onChange=${e => {
                      const f = e.target.files?.[0];
                      setReuploadFile(f || null);
                    }}
                  />
                  <span class="text-sm font-medium text-slate-700">📄 Choose .xlsx file</span>
                </label>

                ${reuploadFile && html`
                  <span class="text-sm text-slate-500 truncate max-w-[320px] italic">
                    ${reuploadFile.name}
                  </span>
                `}

                <button
                  type="button"
                  class=${"flex items-center gap-2 px-4 py-2 rounded-xl text-white font-medium " +
                          (downloadingFromSheet ? "bg-slate-400 cursor-wait" : "bg-slate-800 hover:bg-slate-700")}
                  disabled=${downloadingFromSheet || !reuploadFile}
                  aria-busy=${downloadingFromSheet}
                  onClick=${downloadPoAsFromSheet}
                >
                  ${downloadingFromSheet ? "⏳ Preparing PoAs…" : "📄 Download PoAs from sheet"}
                </button>
              </div>
            `
          })}
        </section>
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
  `;

}

ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));
