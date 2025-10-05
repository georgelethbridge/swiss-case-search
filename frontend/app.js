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
      if (/\bpatent\b/.test(s)) pts += 3;
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
      const hits = sample.reduce((n, r) => n + (normalizeEP(r[h], h) ? 1 : 0), 0);

      if (hits > 0) return h;
    }
    return '';
  }

  // Extract/normalize "EPNNNNNNN" even if there are spaces or kind codes (e.g. "EP 2305232 B1")
  function normalizeEP(v, headerHint) {
    const s = String(v || '').toUpperCase();
    // 1) EP with optional spaces between digits: "EP 1 234 567", "EP1234567", "EP 1234567 B1"
    let m = s.match(/\bEP\s*\d(?:\s*\d){6}\b/);
    if (m) return m[0].replace(/\s+/g, '').replace(/\b(EP\d{7}).*/, '$1');

    // 2) If the header looks like a publication/patent/grant column, accept bare 7 digits (with or without spaces)
    if (headerHint && /\b(patent|publication|grant)\b/i.test(String(headerHint))) {
      const digits = s.replace(/\D/g, '');
      if (digits.length === 7) return 'EP' + digits;
    }
    return '';
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

      const cnt = rows.reduce((n, r) => n + (normalizeEP(epCol ? r[epCol] : '', epCol) ? 1 : 0), 0);
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
    a.href = url;
    const base = (job.originalName || 'results.xlsx').replace(/\.[^.]+$/, '');
    a.download = `${base} [${job.jobId}].xlsx`;
    a.click();
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

  const [poaDrag, setPoaDrag] = React.useState(false);
  const poaInputRef = React.useRef(null);

  const onPoaDrag = (e, isOver) => { e.preventDefault(); e.stopPropagation(); setPoaDrag(isOver); };
  const onPoaDrop = (e) => {
    e.preventDefault(); e.stopPropagation();
    setPoaDrag(false);
    const f = e.dataTransfer?.files?.[0];
    if (f) setPoaSheetFile(f);
  };


return html`
  <div class="max-w-3xl mx-auto">
    <div class="flex items-center justify-between mb-4">
      <h1 class="text-2xl font-bold">Switzerland Case Search & GPoA Generation</h1>
      <button
        class="flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg border border-slate-300 hover:bg-slate-100 transition"
        onClick=${() => setShowDebug(s => !s)}
        aria-label="Toggle debugging"
      >
        <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
            d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        ${showDebug ? 'Hide debugging' : 'Show debugging'}
      </button>
    </div>

    <p class="mb-3 text-sm">
      Upload an Excel (.xlsx) file with European Patent publication numbers. This tool will query Swissreg
      and append results to your sheet. When complete, download the results or split per client.
    </p>

    <div class="grid gap-4">
      <div
        class=${"p-6 rounded-2xl bg-white shadow text-center border-2 " + (dragOver ? "border-blue-500 bg-blue-50" : "border-dashed border-slate-300")}
        onDragOver=${(e)=>onDrag(e,true)}
        onDragLeave=${(e)=>onDrag(e,false)}
        onDrop=${onDrop}
        onClick=${() => inputRef.current?.click()}
        style=${{ cursor: 'pointer' }}
      >
        ${file
          ? html`
              <div class="flex flex-col items-center gap-1">
                <div>
                  <strong>${file.name}</strong> - ${(file.size/1024/1024).toFixed(2)} MB
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
            We could not auto-detect the EP column. Choose it below and click Continue.
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
          <div class="mt-2 text-sm">${percent + '%'}</div>
        </div>
      `}

      ${job && progress.done === progress.total && html`
        <div class="flex flex-col gap-3">
          <div class="flex flex-wrap items-center gap-3">
            <button
              type="button"
              class="px-4 py-2 rounded-xl bg-emerald-600 text-white"
              onClick=${downloadResults}
            >
              Download results
            </button>

            <button
              type="button"
              class=${"px-4 py-2 rounded-xl text-white " + (downloadingPoAsOnly ? "bg-slate-400 cursor-wait" : "bg-slate-700")}
              disabled=${downloadingPoAsOnly}
              aria-busy=${downloadingPoAsOnly}
              onClick=${downloadPoAsOnly}
            >
              ${downloadingPoAsOnly ? "Preparing PoAs…" : "Download PoAs only"}
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
                          ? 'Sales order correspondence address - name'
                          : 'Sales order correspondence address - email'}
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

      ${hasDownloadedResults && html`
        <section class="bg-white rounded-2xl p-5 shadow border border-slate-200">
          <div class="font-medium mb-3">Re-upload edited results to generate PoAs (sheet-only)</div>

          <div class="grid gap-6 md:grid-cols-[280px,1fr] md:items-center">
            <div
              class=${[
                'relative h-44 w-full rounded-xl border-2 border-dashed flex items-center justify-center text-center',
                'transition cursor-pointer select-none bg-white',
                poaDrag ? 'border-blue-400 bg-blue-50 ring-2 ring-blue-500/40' : 'border-slate-300 hover:border-slate-400'
              ].join(' ')}
              onDragEnter=${(e)=>onPoaDrag(e,true)}
              onDragOver=${(e)=>onPoaDrag(e,true)}
              onDragLeave=${(e)=>onPoaDrag(e,false)}
              onDrop=${onPoaDrop}
              onClick=${() => poaInputRef.current?.click()}
            >
              ${!poaSheetFile && html`
                <div class="space-y-1 px-4">
                  <svg xmlns="http://www.w3.org/2000/svg" class="mx-auto h-6 w-6 text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                    <path stroke-width="1.5" d="M12 16V4m0 0l-3.5 3.5M12 4l3.5 3.5M4 16.5a4.5 4.5 0 014.5-4.5h7a4.5 4.5 0 010 9h-9A4.5 4.5 0 014 16.5z"/>
                  </svg>
                  <p class="text-sm text-slate-700">Drop workbook or click</p>
                  <p class="text-xs text-slate-400">Accepted: .xlsx</p>
                </div>
              `}

              ${poaSheetFile && html`
                <div class="absolute inset-0 flex flex-col items-center justify-center gap-2">
                  <div class="inline-flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-1.5 border border-emerald-200">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 text-emerald-600" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                      <path stroke-width="2" d="M5 13l4 4L19 7"/>
                    </svg>
                    <span class="text-xs font-medium text-emerald-700 truncate max-w-[14rem]">${poaSheetFile.name}</span>
                  </div>
                  <button
                    type="button"
                    class="text-xs text-slate-500 hover:text-slate-700 underline"
                    onClick=${() => setPoaSheetFile(null)}
                  >Choose a different file</button>
                </div>
              `}

              <input
                ref=${poaInputRef}
                id="poaSheetInput"
                type="file"
                accept=".xlsx"
                class="hidden"
                onChange=${e => setPoaSheetFile(e.target.files?.[0] || null)}
              />
            </div>

            <div class="flex flex-col gap-4">
              <div class="space-y-2">
                <p class="text-sm text-slate-700">
                  Upload an edited workbook from the results above. If an owner name appears with multiple addresses,
                  separate PoAs are created (...(1), ...(2)).
                </p>
                <ul class="text-xs text-slate-500 space-y-1">
                  <li class="flex items-start gap-2">
                    <span class="mt-[2px] h-1.5 w-1.5 rounded-full bg-slate-400"></span>
                    Headers must be <span class="font-medium text-slate-700 ml-1">OwnerN</span> and <span class="font-medium text-slate-700 ml-1">OwnerNAddress</span>
                  </li>
                  <li class="flex items-start gap-2">
                    <span class="mt-[2px] h-1.5 w-1.5 rounded-full bg-slate-400"></span>
                    Only the first sheet is read
                  </li>
                </ul>
              </div>

              <div class="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  class=${[
                    'px-4 py-2 rounded-xl font-medium transition',
                    poaSheetFile && !downloadingPoAsFromSheet
                      ? 'bg-slate-900 text-white hover:bg-slate-800'
                      : 'bg-slate-200 text-slate-500 cursor-not-allowed'
                  ].join(' ')}
                  disabled=${downloadingPoAsFromSheet || !poaSheetFile}
                  aria-busy=${downloadingPoAsFromSheet}
                  onClick=${downloadPoAsFromSheet}
                >
                  ${downloadingPoAsFromSheet ? 'Preparing…' : 'Download PoAs from sheet'}
                </button>

                ${poaSheetFile && html`
                  <span class="text-xs text-slate-500">Ready to generate PoAs</span>
                `}
              </div>
            </div>
          </div>
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
  </div>`;

}

ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));
