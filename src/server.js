import { createReadStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openLeadStore, ValidationError } from './lead-import.js';

const defaultWebRoot = fileURLToPath(new URL('../dist', import.meta.url));
const maxCsvBytes = 256 * 1024;
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

async function readCsv(request) {
  let size = 0;
  const chunks = [];
  // Drain oversized requests while retaining at most the configured limit.
  for await (const chunk of request) {
    size += chunk.length;
    if (size <= maxCsvBytes) chunks.push(chunk);
  }
  return size <= maxCsvBytes ? Buffer.concat(chunks).toString('utf8') : null;
}

export function createLeadServer(store, { webRoot = defaultWebRoot } = {}) {
  const root = resolve(webRoot);
  return createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (pathname === '/api/leads' && request.method === 'GET') {
        return json(response, 200, { leads: store.list() });
      }
      if (pathname === '/api/import/preview' || pathname === '/api/import/commit') {
        if (request.method !== 'POST') {
          response.setHeader('allow', 'POST');
          return json(response, 405, { error: 'Use POST with CSV text.' });
        }
        const contentType = request.headers['content-type']?.split(';')[0].trim().toLowerCase();
        if (contentType !== 'text/csv') {
          return json(response, 415, { error: 'Send the CSV as text/csv.' });
        }
        const csv = await readCsv(request);
        if (csv === null) return json(response, 413, { error: 'Keep CSV files under 256 KiB.' });
        const result = pathname.endsWith('/preview') ? store.preview(csv) : store.commit(csv);
        return json(response, 200, result);
      }
      if (pathname === '/api/leads') {
        response.setHeader('allow', 'GET');
        return json(response, 405, { error: 'Use GET to list leads.' });
      }
      if (request.method !== 'GET' || pathname.startsWith('/api/')) {
        return json(response, 404, { error: 'Page not found.' });
      }
      const file = resolve(root, pathname === '/' ? 'index.html' : `.${pathname}`);
      if (!file.startsWith(root + sep)) return json(response, 404, { error: 'Page not found.' });
      const mime = mimeTypes[extname(file)];
      if (!mime || !(await stat(file).catch(() => null))?.isFile()) {
        return json(response, 404, { error: 'Page not found.' });
      }
      response.writeHead(200, {
        'content-type': mime,
        'x-content-type-options': 'nosniff',
      });
      const stream = createReadStream(file);
      stream.on('error', () => response.destroy());
      stream.pipe(response);
    } catch (error) {
      if (error instanceof ValidationError) return json(response, 400, { error: error.message });
      console.error(error);
      if (!response.headersSent) return json(response, 500, { error: 'An unexpected error occurred.' });
      response.destroy();
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const filename = resolve(process.env.LEAD_DB_PATH || '.data/leads.sqlite');
  await mkdir(dirname(filename), { recursive: true });
  const store = openLeadStore(filename);
  const server = createLeadServer(store);
  const port = Number(process.env.PORT || 4173);
  server.once('close', () => store.close());
  server.listen(port, '127.0.0.1', () => {
    console.log(`Lead Import Review is running at http://127.0.0.1:${server.address().port}`);
  });
  process.once('SIGINT', () => server.close());
  process.once('SIGTERM', () => server.close());
}
