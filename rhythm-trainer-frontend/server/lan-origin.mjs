// The packaged iOS app serves its local React assets at this exact origin.
// Browser same-origin/proxied traffic needs no CORS headers.
const NATIVE_ORIGIN = 'capacitor://localhost';
const METHODS = ['GET', 'POST', 'PUT', 'DELETE'];

export function applyLanCors(req, res) {
  res.setHeader('Vary', 'Origin');
  const allowed = req.headers.origin === NATIVE_ORIGIN;
  if (allowed) res.setHeader('Access-Control-Allow-Origin', NATIVE_ORIGIN);
  if (req.method !== 'OPTIONS') return false;
  const method = req.headers['access-control-request-method'];
  const headers = String(req.headers['access-control-request-headers'] ?? '')
    .split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (!allowed || !METHODS.includes(method) || headers.some((header) => header !== 'content-type')) {
    res.writeHead(403).end();
    return true;
  }
  res.setHeader('Access-Control-Allow-Methods', METHODS.join(', '));
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
  res.writeHead(204).end();
  return true;
}
