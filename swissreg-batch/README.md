# Swissreg Batch Webapp

## Deploy backend on Render
1. New Web Service - Node
2. Root: `swissreg-batch/backend`
3. Build command: `npm install`
4. Start command: `npm start`
5. Set env vars from `.env.example`. Use RATE_MIN_TIME_MS=600 and RATE_MAX_CONCURRENT=1 initially.
6. Enable automatic deploys.

## Host frontend
- GitHub Pages or Render Static Site. Publish `swissreg-batch/frontend`.
- Pass your backend URL via query: `https://your-gh-username.github.io/swissreg-batch-frontend?api=https://your-backend.onrender.com`

## Notes on limits and penalties
- Single concurrency and 600 ms spacing keep RPS ~1.6. Increase cautiously.
- 429 handled with Retry-After header and jitter, plus exponential backoff for 5xx. Token is reused and refreshed.
- For 2k rows, backend will stream progress. Large files up to 25 MB supported. If you need durability across restarts, swap in Redis for job store and Bottleneck Redis connection.

## Columns appended
`StatusCode, LastChangeDate, Representative, FilingDate, GrantDate, OwnerNames, OwnerAddresses`

The output preserves original columns and appends these at the end.

## Security
- Only credentials stored as Render environment variables. No secrets client side.
- CORS is open by default - restrict `cors({ origin: [your-frontend-origin] })` in `server.js` for production.

## Compatibility with your Apps Script
- Field extraction mirrors CH_REGISTER_INFO and CH_REGISTER_INFO_BATCH contract.
- If you need full XML parsing fidelity, replace regex extraction with a proper XML parser like `xmldom` + `xpath`. The current approach is fast and adequate for these fields.