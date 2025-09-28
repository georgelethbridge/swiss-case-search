const { useState, useRef } = React;
const html = htm.bind(React.createElement);

function App() {
  const [file, setFile] = useState(null);
  const [job, setJob] = useState(null);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const backend = 'https://swissreg-batch.onrender.com';
  const inputRef = useRef(null);
  const [debugInfo, setDebugInfo] = useState(null);


  function onDrop(e) {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (f) setFile(f);
  }

  async function startJob() {
    setError('');
    setDebugInfo(null);
    if (!file) return;
    const form = new FormData();
    form.append('file', file);

    // IMPORTANT: ask backend to capture debug
    const r = await fetch(`${backend}/api/jobs?debug=full`, { method: 'POST', body: form });
    const j = await r.json();
    if (!r.ok) { setError(j.error || 'Upload failed'); return; }

    setJob(j);
    setProgress({ done: 0, total: j.total });

    const ev = new EventSource(`${backend}/api/jobs/${j.jobId}/stream`);
    ev.onmessage = (m) => setProgress(JSON.parse(m.data));
    ev.addEventListener('complete', async () => {
      ev.close();
      // fetch results + per-row _debug
      const res = await fetch(`${backend}/api/jobs/${j.jobId}/full`);
      const full = await res.json();
      setDebugInfo(full);
    });
  }


  async function download() {
    if (!job) return;
    const r = await fetch(`${backend}/api/jobs/${job.jobId}/download`);
    if (!r.ok) { const j = await r.json().catch(()=>({})); setError(j.error || 'Not ready'); return; }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `swissreg-results-${job.jobId}.xlsx`; a.click();
    URL.revokeObjectURL(url);
  }

  const percent = progress.total ? Math.floor((progress.done / progress.total) * 100) : 0;

  return html`
  <div class="max-w-3xl mx-auto">
    <h1 class="text-2xl font-bold mb-4">Swissreg Batch</h1>
    <p class="mb-3 text-sm">Upload an XLSX with required headings. After confirm, the server will call Swissreg for each row and append results. Progress shows below. When complete, download the augmented file. Add <code>?api=...</code> query to point to your backend.</p>

    <div class="grid gap-3">
      <div class="p-6 rounded-2xl bg-white shadow dropzone text-center"
           onDragOver=${e=>e.preventDefault()}
           onDrop=${onDrop}
           onClick=${() => inputRef.current?.click()}>
        ${file ? html`<div><strong>${file.name}</strong> - ${(file.size/1024/1024).toFixed(2)} MB</div>`
              : html`<div>Drag and drop spreadsheet here, or click to select</div>`}
        <input type="file" accept=".xlsx" hidden ref=${inputRef} onChange=${e=> setFile(e.target.files[0])} />
      </div>

      ${file && !confirmed && html`
        <button class="px-4 py-2 rounded-xl bg-blue-600 text-white w-fit" onClick=${() => { setConfirmed(true); startJob(); }}>Confirm and start</button>
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
        <button class="px-4 py-2 rounded-xl bg-emerald-600 text-white w-fit" onClick=${download}>Download results</button>
      `}

      ${job && progress.done === progress.total && html`
        <div class="flex gap-3">
          <button class="px-4 py-2 rounded-xl bg-emerald-600 text-white" onClick=${download}>Download results</button>
          <button class="px-4 py-2 rounded-xl bg-indigo-600 text-white" onClick=${async () => {
            const r = await fetch(`${backend}/api/jobs/${job.jobId}/download-split`);
            if (!r.ok) { const j = await r.json().catch(()=>({})); setError(j.error || 'Not ready'); return; }
            const blob = await r.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = `swissreg-split-${job.jobId}.zip`; a.click();
            URL.revokeObjectURL(url);
          }}>Download split files</button>
        </div>
      `}


      ${error && html`<div class="text-red-700">${error}</div>`}
    </div>
      ${job && progress.done === progress.total && html`
        ${debugInfo && html`
          <details class="mt-6 bg-gray-100 p-4 rounded-xl">
            <summary class="cursor-pointer font-semibold">Debug (request & response)</summary>
            <pre class="mt-2 text-xs whitespace-pre-wrap overflow-x-auto">${
              JSON.stringify(
                // show the first row’s _debug payload, or the whole object if missing
                debugInfo.results?.[0]?._debug ?? debugInfo,
                null, 2
              )
            }</pre>
          </details>
        `}

    `}
  </div>`

}

ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));