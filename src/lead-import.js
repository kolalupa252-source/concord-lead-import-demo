import { DatabaseSync } from 'node:sqlite';
import { CsvError, parse } from 'csv-parse/sync';

const HEADERS = ['name', 'email', 'source'];
const MAX_ROWS = 500;
const MAX_CSV_BYTES = 256 * 1024;
const MAX_TEXT_LENGTH = 120;
const DOMAIN_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const EMAIL_PATTERN = new RegExp(`^[a-z0-9.!#$%&'*+/=?^_\x60{|}~-]+@(?:${DOMAIN_LABEL}\\.)+${DOMAIN_LABEL}$`);

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

function isValidEmail(email) {
  const localPart = email.split('@')[0];
  return email.length <= 254 && localPart.length <= 64
    && EMAIL_PATTERN.test(email)
    && !localPart.startsWith('.') && !localPart.endsWith('.') && !localPart.includes('..');
}

function countLineBreaks(text) {
  return text.match(/\r\n|[\r\n]/gu)?.length ?? 0;
}

function parseRows(csv) {
  if (typeof csv !== 'string' || !csv.trim()) {
    throw new ValidationError('Paste a CSV with the name, email, and source headers.');
  }
  if (Buffer.byteLength(csv) > MAX_CSV_BYTES) {
    throw new ValidationError('The CSV must be at most 256 KiB.');
  }

  const bytes = Buffer.from(csv);
  let records;
  try {
    records = parse(bytes, {
      bom: true,
      info: true,
      skip_empty_lines: true,
      relax_column_count: true,
      max_record_size: 4096,
      to: MAX_ROWS + 2,
    });
  } catch (error) {
    if (!(error instanceof CsvError)) throw error;
    const location = error.lines ? ` on line ${error.lines}` : '';
    if (error.code === 'CSV_MAX_RECORD_SIZE') {
      throw new ValidationError(`A CSV record${location} exceeds the parser's size limit.`);
    }
    throw new ValidationError(`Malformed CSV${location}. Check the commas and quotes.`);
  }

  const [header, ...data] = records;
  const names = header?.record.map((field) => field.trim().toLowerCase());
  if (names?.length !== HEADERS.length || HEADERS.some((field) => !names.includes(field))) {
    throw new ValidationError('The CSV must contain exactly these headers: name, email, source.');
  }
  if (data.length > MAX_ROWS) {
    throw new ValidationError(`Import at most ${MAX_ROWS} rows at a time.`);
  }

  const [nameColumn, emailColumn, sourceColumn] = HEADERS.map((field) => names.indexOf(field));
  let offset = header.info.bytes;
  let line = 1 + countLineBreaks(bytes.subarray(0, offset).toString());

  return data.map(({ record, info }) => {
    // Use byte offsets so quoted Windows line breaks each count as one line.
    const recordText = bytes.subarray(offset, info.bytes).toString();
    const skippedLines = countLineBreaks(recordText.match(/^[\r\n]*/u)[0]);
    const startLine = line + skippedLines;
    offset = info.bytes;
    line += countLineBreaks(recordText);

    return {
      line: startLine,
      name: (record[nameColumn] ?? '').trim(),
      email: (record[emailColumn] ?? '').trim().toLowerCase(),
      source: (record[sourceColumn] ?? '').trim(),
      columnCount: record.length,
    };
  });
}

function validationReason({ name, email, source, columnCount }) {
  if (columnCount !== HEADERS.length) return 'Expected three columns.';
  if (!name) return 'Name is required.';
  if (name.length > MAX_TEXT_LENGTH) return `Name exceeds ${MAX_TEXT_LENGTH} characters.`;
  if (!isValidEmail(email)) return 'Enter a valid email address.';
  if (!source) return 'Source is required.';
  if (source.length > MAX_TEXT_LENGTH) return `Source exceeds ${MAX_TEXT_LENGTH} characters.`;
  if (name.includes('\0') || source.includes('\0')) return 'Name and source cannot contain null characters.';
  return '';
}

function assessRows(parsedRows, hasEmail) {
  const accepted = new Set();
  const counts = { ready: 0, duplicate: 0, invalid: 0 };
  const rows = parsedRows.map(({ columnCount, ...row }) => {
    let reason = validationReason({ ...row, columnCount });
    let status = 'ready';

    if (reason) {
      status = 'invalid';
    } else if (hasEmail(row.email)) {
      status = 'duplicate';
      reason = 'Email is already in the lead list.';
    } else if (accepted.has(row.email)) {
      status = 'duplicate';
      reason = 'Email repeats in this CSV.';
    } else {
      accepted.add(row.email);
    }

    counts[status] += 1;
    return { ...row, status, reason };
  });

  return { rows, counts, inserted: 0 };
}

export function openLeadStore(filename) {
  const database = new DatabaseSync(filename);
  database.exec(`
    PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      source TEXT NOT NULL
    ) STRICT;
  `);

  const selectEmail = database.prepare('SELECT 1 FROM leads WHERE email = ?');
  const selectLeads = database.prepare('SELECT name, email, source FROM leads ORDER BY id');
  const insertLead = database.prepare('INSERT INTO leads (name, email, source) VALUES (?, ?, ?)');
  const hasEmail = (email) => Boolean(selectEmail.get(email));

  return {
    preview(csv) {
      return assessRows(parseRows(csv), hasEmail);
    },

    commit(csv) {
      const parsedRows = parseRows(csv);
      database.exec('BEGIN IMMEDIATE');
      try {
        const report = assessRows(parsedRows, hasEmail);
        for (const { name, email, source, status } of report.rows) {
          if (status === 'ready') insertLead.run(name, email, source);
        }
        database.exec('COMMIT');
        return { ...report, inserted: report.counts.ready };
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },

    list() {
      return selectLeads.all().map(({ name, email, source }) => ({ name, email, source }));
    },

    close() {
      database.close();
    },
  };
}
