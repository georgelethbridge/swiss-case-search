const { useState, useRef } = React;
const html = htm.bind(React.createElement);

function App() {
  const [file, setFile] = useState(null);
  const [caseCount, setCaseCount] = useState(0); 
  const [job, setJob] = useState(null);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [debugInfo, setDebugInfo] = useState(null);
  const [showDebug, setShowDebug] = useState(false);
  const [downloading, setDownloading] = useState(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const backend = 'https://swissreg-batch.onrender.com';
  const inputRef = useRef(null);
  const [splitBy, setSplitBy] = useState('address_name'); // 'client' | 'address_name' | 'address_email'

    // helper: read xlsx and count rows from first sheet
  async function countRowsInXlsx(file) {
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const wsName = wb.SheetNames[0];
      const ws = wb.Sheets[wsName];
      const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

      // Count only rows we would really process (Patent Number present)
      const count = rows.filter(r => String(r['Patent Number'] || '').trim()).length;
      return count;
    } catch (e) {
      console.error('XLSX parse failed:', e);
      return 0;
    }
  }



  // handle drag + drop
  function onDrop(e) {
    e.preventDefault();
    setIsDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) {
      setFile(f);
      countRowsInXlsx(f).then(setCaseCount).catch(() => setCaseCount(0));
    }
  }

  async function onPick(e) {
    const f = e.target.files?.[0];
    if (f) {
      setFile(f);
      try { setCaseCount(await countRowsInXlsx(f)); } catch { setCaseCount(0); }
    }
  }


  // start job
  async function startJob() {
    setError('');
    setDebugInfo(null);
    if (!file) return;
    const form = new FormData();
    form.append('file', file);

    const r = await fetch(`${backend}/api/jobs?debug=full`, { method: 'POST', body: form });
    const j = await r.json();
    if (!r.ok) { setError(j.error || 'Upload failed'); return; }

    setJob(j);
    setProgress({ done: 0, total: j.total });

    const ev = new EventSource(`${backend}/api/jobs/${j.jobId}/stream`);
    ev.onmessage = (m) => setProgress(JSON.parse(m.data));
    ev.addEventListener('complete', async () => {
      ev.close();
      const res = await fetch(`${backend}/api/jobs/${j.jobId}/full`);
      const full = await res.json();
      setDebugInfo(full);
    });
  }

    // Reset
  function resetAll() {
    setFile(null);
    setCaseCount(0);
    setJob(null);
    setProgress({ done: 0, total: 0 });
    setError('');
    setConfirmed(false);
    setDebugInfo(null);
    setShowDebug(false);
    setDownloading(null);
  }


  // download results XLSX
  async function download(type) {
    if (!job) return;
    const url = type === 'split'
      ? `${backend}/api/jobs/${job.jobId}/download-split?splitBy=${encodeURIComponent(splitBy)}`
      : `${backend}/api/jobs/${job.jobId}/download`;
    setDownloading(type);
    try {
      const r = await fetch(url);
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setError(j.error || 'Not ready');
        return;
      }
      const blob = await r.blob();
      const dlUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = dlUrl;
      a.download = type === 'split'
        ? `swissreg-split-${job.jobId}.zip`
        : `swissreg-results-${job.jobId}.xlsx`;
      a.click();
      URL.revokeObjectURL(dlUrl);
    } finally {
      setDownloading(null);
    }
  }

  const percent = progress.total ? Math.floor((progress.done / progress.total) * 100) : 0;

  return html`
    <div class="max-w-3xl mx-auto relative">
      ${debugInfo && html`
        <button
          class="absolute top-0 right-0 px-3 py-1 text-sm bg-gray-800 text-white rounded-lg hover:bg-gray-700"
          onClick=${() => setShowDebug(!showDebug)}
        >
          ${showDebug ? 'Hide Debugging' : 'Show Debugging'}
        </button>
      `}

      <h1 class="text-3xl font-bold mb-3 text-center">Swissreg Batch Tool</h1>

      <p class="text-sm text-gray-700 mb-6 leading-relaxed">
        Upload an Excel (.xlsx) file with European Patent publication numbers.
        This tool will query Swissreg and append results to your sheet. When complete, download the results or split per client.
      </p>

      <div
        class=${"p-6 rounded-2xl bg-white shadow dropzone text-center border-2 border-dashed transition-all " + (isDragOver ? "drag-over" : "border-gray-300")}
        onDragOver=${e => { e.preventDefault(); }}
        onDragEnter=${() => setIsDragOver(true)}
        onDragLeave=${() => setIsDragOver(false)}
        onDrop=${onDrop}
        onClick=${() => inputRef.current?.click()}
      >
        ${file
          ? html`<div>
              <strong>${file.name}</strong> - ${(file.size/1024/1024).toFixed(2)} MB
              <div class="text-sm text-gray-600 mt-1">
                ${Number.isFinite(caseCount) ? `${caseCount} cases detected` : 'Counting…'}
              </div>
            </div>`
          : html`<div class="text-gray-500">Drag and drop spreadsheet here, or click to select</div>`}
        <input type="file" accept=".xlsx" hidden ref=${inputRef} onChange=${onPick} />
      </div>

      ${file && !confirmed && html`
        <div class="flex justify-center gap-3 mt-4">
          <button
            class="px-5 py-2 rounded-xl bg-blue-600 text-white hover:bg-blue-700 transition-all"
            onClick=${() => { setConfirmed(true); startJob(); }}
          >
            Confirm and start
          </button>
          <button
            class="px-5 py-2 rounded-xl bg-gray-100 text-gray-800 hover:bg-gray-200 transition-all"
            onClick=${resetAll}
          >
            Reset
          </button>
        </div>
      `}

      ${job && html`
        <div class="bg-white rounded-2xl p-4 shadow mt-6">
          <div class="mb-2 text-sm">Job ${job.jobId} - ${progress.done}/${progress.total}</div>
          <div class="w-full bg-slate-200 rounded h-3 overflow-hidden">
            <div class="bg-blue-600 h-3 transition-all" style=${{ width: percent + '%' }}></div>
          </div>
          <div class="mt-2 text-sm">${percent}% complete</div>
        </div>
      `}

    ${job && progress.done === progress.total && html`

      <div class="mt-4 bg-white p-3 rounded-xl shadow flex flex-wrap items-center gap-3">
        <label class="text-sm text-gray-700">Split by:</label>
        <select
          class="border rounded-lg px-3 py-2 text-sm"
          value=${splitBy}
          onChange=${e => setSplitBy(e.target.value)}
        >
          <option value="client">Client account name</option>
          <option value="address_name">Sales order correspondence address - name (first line)</option>
          <option value="address_email">Sales order correspondence address - email (last line or any email)</option>
        </select>
        <span class="text-xs text-gray-500">Used for the ZIP splitting and PoA generation grouping. Email falls back to name then client when missing.</span>
      </div>


      <div class="flex flex-wrap gap-3 mt-4">
        <button
          class="px-4 py-2 rounded-xl bg-emerald-600 text-white disabled:opacity-60"
          disabled=${downloading === 'results'}
          onClick=${() => download('results')}
        >
          ${downloading === 'results' ? 'Downloading…' : 'Download results'}
        </button>
        <button class="px-4 py-2 rounded-xl bg-indigo-600 text-white disabled:opacity-60"
          disabled=${downloading === 'split'}
          onClick=${() => download('split')}
        >

          ${downloading === 'split' ? 'Downloading…' : 'Download split files'}
        </button>
      </div>
    `}

    ${error && html`<div class="text-red-700 mt-3">${error}</div>`}

    ${showDebug && debugInfo && html`
      <div class="mt-6 bg-gray-100 p-4 rounded-xl">
        <h3 class="font-semibold mb-2">Debug Information</h3>
        <pre class="text-xs whitespace-pre-wrap overflow-x-auto">${
          JSON.stringify(
            debugInfo.results?.[0]?._debug ?? debugInfo,
            null,
            2
          )
        }</pre>
      </div>
    `}
  </div>
  `;
}

ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));
