import XLSX from 'xlsx';

const REQUIRED_COLS = [
  'Client Account Name',
  'Client Reference',
  'Client Default Correspondence Email',
  'User Email',
  'Sales Order Link',
  'Sales Order Correspondence Address',
  'Application Number',
  'Patent Number',
  'Filing Date',
  'Applicant Names'
];

const BASE_APPEND_COLS = [
  'StatusCode',
  'LastChangeDate',
  'Representative',
  'FilingDate',
  'GrantDate'
];

function parseWorkbook(buf) {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const wsName = wb.SheetNames[0];
  const ws = wb.Sheets[wsName];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

  // minimal header validation
  const headers = Object.keys(rows[0] || {});
  const missing = REQUIRED_COLS.filter(h => !headers.includes(h));
  if (missing.length) {
    throw new Error(`Missing required column(s): ${missing.join(', ')}`);
  }

  // attach __ep for queue consumption
  const augmented = rows.map(r => ({ ...r, __ep: r['Patent Number'] }));
  return { rows: augmented, headers, wsName, wb };
}

function appendResultsToWorkbook(wb, wsName, rows, results) {
  // max owners across all rows
  const maxOwners = results.reduce((m, r) => {
    const n = Array.isArray(r && r.ownerNamesArr) ? r.ownerNamesArr.length : 0;
    return Math.max(m, n);
  }, 0);

  // build headers: original + base append + dynamic owner pairs
  const originalHeaders = Object.keys(rows[0] || {});
  const dynamicOwnerHeaders = [];
  for (let i = 1; i <= maxOwners; i++) {
    dynamicOwnerHeaders.push(`Owner${i}`);
    dynamicOwnerHeaders.push(`Owner${i}Address`);
  }
  const headers = [...originalHeaders, ...BASE_APPEND_COLS, ...dynamicOwnerHeaders];

  // build data rows with dynamic owner pairs
  const combined = rows.map((r, i) => {
    const res = results[i] || {};
    const ownerNamesArr = Array.isArray(res.ownerNamesArr) ? res.ownerNamesArr : [];
    const ownerAddressesArr = Array.isArray(res.ownerAddressesArr) ? res.ownerAddressesArr : [];

    const out = {
      ...r,
      StatusCode: res.statusCode || '',
      LastChangeDate: res.lastChangeDate || '',
      Representative: res.representative || '',
      FilingDate: res.filingDate || '',
      GrantDate: res.grantDate || ''
    };

    for (let k = 0; k < maxOwners; k++) {
      out[`Owner${k + 1}`] = ownerNamesArr[k] || '';
      out[`Owner${k + 1}Address`] = ownerAddressesArr[k] || '';
    }
    return out;
  });

  const ws = XLSX.utils.json_to_sheet(combined, { header: headers });
  wb.Sheets[wsName] = ws;
  if (!wb.SheetNames) wb.SheetNames = [];
  if (!wb.SheetNames.includes(wsName)) wb.SheetNames.push(wsName);
  return wb;

}

function buildSubsetWorkbook(rows, results, sheetName = 'Sheet1') {
  const wb = XLSX.utils.book_new();
  return appendResultsToWorkbook(wb, sheetName, rows, results);
}


function writeWorkbook(wb) {
  return XLSX.write(wb, { bookType: 'xlsx', type: 'buffer', compression: true });
}

export { parseWorkbook, appendResultsToWorkbook, writeWorkbook, buildSubsetWorkbook };

