import XLSX from 'xlsx';

const REQUIRED_COLS = [
  'Client Account Name','Client Reference','Client Default Correspondence Email','User Email','Sales Order Link','Sales Order Correspondence Address','Application Number','Patent Number','Filing Date','Applicant Names'
];

const APPEND_COLS = ['StatusCode','LastChangeDate','Representative','FilingDate','GrantDate','OwnerNames','OwnerAddresses','OwnersPaired'];

function parseWorkbook(buf) {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const wsName = wb.SheetNames[0];
  const ws = wb.Sheets[wsName];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

  // Validate headings minimally - tolerate extra columns and variant spacing
  const headers = Object.keys(rows[0] || {});
  const missing = REQUIRED_COLS.filter(h => !headers.includes(h));
  if (missing.length) {
    throw new Error(`Missing required column(s): ${missing.join(', ')}`);
  }

  // Attach __ep for queue consumption
  const augmented = rows.map(r => ({ ...r, __ep: r['Patent Number'] }));
  return { rows: augmented, headers, wsName, wb };
}

function appendResultsToWorkbook(wb, wsName, rows, results) {
  const combined = rows.map((r, i) => ({ ...r, ...mapResult(results[i]) }));
  const ws = XLSX.utils.json_to_sheet(combined, { header: [...Object.keys(rows[0] || {}), ...APPEND_COLS] });
  wb.Sheets[wsName] = ws;
  return wb;
}

function mapResult(res) {
  if (!res) return Object.fromEntries(APPEND_COLS.map(h => [h, '']));
  return {
    StatusCode: res.statusCode || '',
    LastChangeDate: res.lastChangeDate || '',
    Representative: res.representative || '',
    FilingDate: res.filingDate || '',
    GrantDate: res.grantDate || '',
    OwnerNames: res.ownerNames || '',
    OwnerAddresses: res.ownerAddresses || '',
    OwnersPaired: res.ownersPaired || ''
  };
}

function writeWorkbook(wb) {
  return XLSX.write(wb, { bookType: 'xlsx', type: 'buffer', compression: true });
}

export { parseWorkbook, appendResultsToWorkbook, writeWorkbook, APPEND_COLS };