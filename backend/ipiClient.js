import fetch from 'node-fetch';
import Pino from 'pino';

const log = Pino({ name: 'ipiClient' });

const env = (k, def) => process.env[k] ?? def;
const IDP_TOKEN_URL = env('IDP_TOKEN_URL');
const IPI_CLIENT_ID = env('IPI_CLIENT_ID', 'datadelivery-api-client');
const IPI_API_URL   = env('IPI_API_URL');
const IPI_USERNAME  = env('IPI_USERNAME');
const IPI_PASSWORD  = env('IPI_PASSWORD');

let tokenCache = { access: null, refresh: null, obtainedAt: 0, expiresIn: 0, refreshExpiresIn: 0 };

function nowSec() { return Math.floor(Date.now() / 1000); }

async function getBearer() {
  const n = nowSec();
  if (tokenCache.access && (n - tokenCache.obtainedAt) < tokenCache.expiresIn - 30) return tokenCache.access;
  if (tokenCache.refresh && (n - tokenCache.obtainedAt) < tokenCache.refreshExpiresIn - 30) {
    const body = new URLSearchParams({ grant_type: 'refresh_token', client_id: IPI_CLIENT_ID, refresh_token: tokenCache.refresh });
    const r = await fetch(IDP_TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    if (r.ok) return save(await r.json());
    log.warn({ code: r.status }, 'refresh failed - falling back to password');
  }
  if (!IPI_USERNAME || !IPI_PASSWORD) throw new Error('Missing IPI credentials');
  const body = new URLSearchParams({ grant_type: 'password', client_id: IPI_CLIENT_ID, username: IPI_USERNAME, password: IPI_PASSWORD });
  const r = await fetch(IDP_TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  if (!r.ok) throw new Error(`Login failed ${r.status} ${await r.text()}`);
  return save(await r.json());
}

function save(payload) {
  tokenCache = {
    access: payload.access_token,
    refresh: payload.refresh_token,
    obtainedAt: nowSec(),
    expiresIn: Number(payload.expires_in) || 0,
    refreshExpiresIn: Number(payload.refresh_expires_in || 30*24*3600)
  };
  return tokenCache.access;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildRequestXml(epUpper) {
  const uuid = crypto.randomUUID?.() || Math.random().toString(36).slice(2);
  const head = "<?xml version='1.0' encoding='UTF-8'?>";
  const open = `<ApiRequest uuid="${uuid}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns="urn:ige:schema:xsd:datadeliverycore-1.0.0" xmlns:pat="urn:ige:schema:xsd:datadeliverypatent-1.0.0">`;
  const mid1 = '<Action type="PatentSearch">';
  const mid2 = '<pat:PatentSearchRequest xmlns="urn:ige:schema:xsd:datadeliverycommon-1.0.0">';
  const q = `<Query><Any>${escapeXml(epUpper)}</Any></Query>`;
  const close = '</pat:PatentSearchRequest></Action></ApiRequest>';
  return head + open + mid1 + mid2 + q + close;
}

// Minimal ST.96 XML extraction using regex and string ops for performance
// We extract only the fields needed by CH_REGISTER_INFO
function extractFields(xml) {
  // helper pickers - allow optional namespace prefix like pat:, com:
  const pick = (re) => (xml.match(re)?.[1] || '').trim();

  // Latest legal status (sort by EventDate desc)
  const reEvent = new RegExp(
    `<(?:\\w+:)?StatusEventData[\\s\\S]*?` +
      `<(?:\\w+:)?EventDate[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?EventDate>[\\s\\S]*?` +
      `<(?:\\w+:)?StatusEventCode>[\\s\\S]*?` +
        `<(?:\\w+:)?KeyEventCode[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?KeyEventCode>[\\s\\S]*?` +
        `(?:<(?:\\w+:)?DetailedEventCode[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?DetailedEventCode>)?` +
      `[\\s\\S]*?<\\/(?:\\w+:)?StatusEventData>`,
    'gi'
  );
  const events = Array.from(xml.matchAll(reEvent)).map(m => ({
    date: (m[1] || '').trim(),
    key:  (m[2] || '').trim(),
    det:  (m[3] || '').trim()
  }));
  events.sort((a,b) => a.date < b.date ? 1 : (a.date > b.date ? -1 : 0));
  const last = events[0] || { date: '', key: '', det: '' };
  const statusCode = last.key && last.det ? `${last.key}/${last.det}` : (last.key || last.det || '');

  // --- Representative (allow attributes on the opening tag)
  let representative = '';

  // primary: PersonFullName inside RegisteredPractitioner
  let m = xml.match(
    /<(?:\w+:)?RegisteredPractitioner(?:\s[^>]*)?>[\s\S]*?<(?:\w+:)?PersonFullName[^>]*>([\s\S]*?)<\/(?:\w+:)?PersonFullName>[\s\S]*?<\/(?:\w+:)?RegisteredPractitioner>/i
  );
  if (m && m[1]) representative = m[1].trim();

  // fallback: OrganizationNameText inside RegisteredPractitioner
  if (!representative) {
    m = xml.match(
      /<(?:\w+:)?RegisteredPractitioner(?:\s[^>]*)?>[\s\S]*?<(?:\w+:)?OrganizationNameText[^>]*>([\s\S]*?)<\/(?:\w+:)?OrganizationNameText>[\s\S]*?<\/(?:\w+:)?RegisteredPractitioner>/i
    );
    if (m && m[1]) representative = m[1].trim();
  }

  // second fallback: any NameText inside RegisteredPractitioner
  if (!representative) {
    m = xml.match(
      /<(?:\w+:)?RegisteredPractitioner(?:\s[^>]*)?>[\s\S]*?<(?:\w+:)?NameText[^>]*>([\s\S]*?)<\/(?:\w+:)?NameText>[\s\S]*?<\/(?:\w+:)?RegisteredPractitioner>/i
    );
    if (m && m[1]) representative = m[1].trim();
  }


  // Filing and Grant dates
  const filingDate = pick(
    new RegExp(
      `<(?:\\w+:)?ApplicationIdentification>[\\s\\S]*?<(?:\\w+:)?FilingDate[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?FilingDate>[\\s\\S]*?<\\/(?:\\w+:)?ApplicationIdentification>`,
      'i'
    )
  );
  const grantDate = pick(
    new RegExp(
      `<(?:\\w+:)?PatentGrantIdentification>[\\s\\S]*?<(?:\\w+:)?GrantDate[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?GrantDate>[\\s\\S]*?<\\/(?:\\w+:)?PatentGrantIdentification>`,
      'i'
    )
  );

  // --- Owners: collect per-owner name + address, address lines joined with comma
  const ownerBlocks = Array.from(
    xml.matchAll(/<(?:\w+:)?Owner\b[\s\S]*?<\/(?:\w+:)?Owner>/gi)
  );

  const owners = ownerBlocks.map(b => {
    const chunk = b[0];

    const name =
      (chunk.match(/<(?:\w+:)?PersonFullName[^>]*>([\s\S]*?)<\/(?:\w+:)?PersonFullName>/i)?.[1] || '').trim()
      || (chunk.match(/<(?:\w+:)?OrganizationNameText[^>]*>([\s\S]*?)<\/(?:\w+:)?OrganizationNameText>/i)?.[1] || '').trim()
      || (chunk.match(/<(?:\w+:)?NameText[^>]*>([\s\S]*?)<\/(?:\w+:)?NameText>/i)?.[1] || '').trim();

    const addrLines = Array.from(
      chunk.matchAll(/<(?:\w+:)?AddressLineText[^>]*>([\s\S]*?)<\/(?:\w+:)?AddressLineText>/gi)
    ).map(m => (m[1] || '').trim()).filter(Boolean);

    const country =
      (chunk.match(/<(?:\w+:)?CountryCode[^>]*>([\s\\S]*?)<\/(?:\w+:)?CountryCode>/i)?.[1] || '').trim();

    const address = [...addrLines, country].filter(Boolean).join(', '); // comma separated

    return { name, address };
  });

  // keep both joined strings and arrays
  const ownerNamesArr = owners.map(o => o.name).filter(Boolean);
  const ownerAddressesArr = owners.map(o => o.address).filter(Boolean);
  const ownerNames = ownerNamesArr.join(' | ');
  const ownerAddresses = ownerAddressesArr.join(' | ');

  // --- Check for NotInForce data ---
  const notInForceDate =
    (xml.match(/<(?:\w+:)?NotInForceDate[^>]*>([\s\S]*?)<\/(?:\w+:)?NotInForceDate>/i)?.[1] || '').trim();
  const reasonNotInForce =
    (xml.match(/<(?:\w+:)?ReasonNotInForceCategory[^>]*>([\s\S]*?)<\/(?:\w+:)?ReasonNotInForceCategory>/i)?.[1] || '').trim();

  // --- Replace status fields if NotInForce data exists ---
  const effectiveStatus = notInForceDate
    ? `Not in force: ${reasonNotInForce || 'Unknown reason'}`
    : statusCode;
  const effectiveDate = notInForceDate || (last.date || '');

  return {
    statusCode: effectiveStatus,
    lastChangeDate: effectiveDate,
    representative,
    filingDate,
    grantDate,
    ownerNames,
    ownerAddresses,
    ownerNamesArr,
    ownerAddressesArr
  };
}


async function callSwissreg(epUpper, attempt = 0) {
  const token = await getBearer();
  const xml = buildRequestXml(epUpper);
  const res = await fetch(IPI_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/xml',
      'authorization': `Bearer ${token}`,
      'accept': 'application/xml',
      'accept-encoding': 'gzip',
      'connection': 'keep-alive'
    },
    body: xml
  });

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('retry-after') || '1');
    const ms = (retryAfter * 1000) + Math.floor(Math.random() * 300);
    log.warn({ retryAfter }, '429 received - backing off');
    await new Promise(r => setTimeout(r, ms));
    return callSwissreg(epUpper, attempt + 1);
  }

  if (!res.ok) {
    const text = await res.text();
    // transient errors - backoff with jitter and retry up to MAX_RETRIES
    if ([408, 409, 420, 500, 502, 503, 504].includes(res.status) && attempt < (Number(process.env.MAX_RETRIES || 5))) {
      const backoff = Math.min(2000 * Math.pow(1.7, attempt), 15000) + Math.floor(Math.random()*400);
      log.warn({ status: res.status, attempt, backoff }, 'transient error - retrying');
      await new Promise(r => setTimeout(r, backoff));
      return callSwissreg(epUpper, attempt + 1);
    }
    throw new Error(`IPI API error ${res.status}: ${text.slice(0, 300)}`);
  }

  const xmlText = await res.text();
  // Sanity: verify exact publication number match exists
  // normalize whitespace in both the XML values and the requested EP
  const want = epUpper.replace(/\s+/g, '').toUpperCase();
  const pubs = Array.from(
    xmlText.matchAll(/<(?:\w+:)?(?:PublicationNumber|PatentNumber)[^>]*>([^<]*)<\/(?:\w+:)?(?:PublicationNumber|PatentNumber)>/gi)
  ).map(m => (m[1] || '').replace(/\s+/g, '').toUpperCase());


  const exact = pubs.includes(want);
  if (!exact) throw new Error(`No exact PublicationNumber match for ${epUpper}`);

  return extractFields(xmlText);
}

async function callSwissregWithDebug(epUpper) {
  const token = await getBearer();
  const xml = buildRequestXml(epUpper);
  const res = await fetch(IPI_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/xml',
      'authorization': `Bearer ${token}`,
      'accept': 'application/xml',
    },
    body: xml
  });

  const text = await res.text().catch(() => '');
  const want = String(epUpper).replace(/\s+/g, '').toUpperCase();
  const pubs = Array.from(
    text.matchAll(/<(?:\w+:)?(?:PublicationNumber|PatentNumber)[^>]*>([^<]*)<\/(?:\w+:)?(?:PublicationNumber|PatentNumber)>/gi)
  ).map(m => (m[1] || '').replace(/\s+/g, '').toUpperCase());

  const matched = pubs.includes(want);

  const data = matched && res.ok
    ? extractFields(text)
    : { statusCode: `ERROR: ${!res.ok ? `HTTP ${res.status}` : `No exact PublicationNumber match for ${epUpper}`}`,
        lastChangeDate: '', representative: '', filingDate: '', grantDate: '', ownerNames: '', ownerAddresses: '' };

  // This is the key bit: return all info for the frontend to show
  return {
    data,
    debug: {
      requestXml: xml,
      responseXml: text,
      compare: { want, pubs, matched }
    }
  };
}

export { callSwissreg, callSwissregWithDebug };
