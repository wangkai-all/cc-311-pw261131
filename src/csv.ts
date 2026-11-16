/** Minimal RFC-4180 CSV parser with line-aware errors. */

export interface CsvParseResult {
  headers: string[];
  rows: { values: string[]; line: number }[];
  errors: { line: number; message: string; raw: string }[];
}

export function parseCsv(text: string): CsvParseResult {
  const rows: { values: string[]; line: number }[] = [];
  const errors: { line: number; message: string; raw: string }[] = [];
  let headers: string[] = [];

  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  let line = 1;
  let recordStartLine = 1;
  let i = 0;
  const n = text.length;

  const pushRecord = (rawLine: string) => {
    const lineNo = recordStartLine;
    if (record.length === 0 && rawLine.trim() === '') {
      line++;
      recordStartLine = line;
      return;
    }
    if (headers.length === 0) {
      headers = record.map((h) => h.trim());
      if (new Set(headers).size !== headers.length) {
        errors.push({ line: lineNo, message: 'duplicate column names in header', raw: rawLine.slice(0, 200) });
      }
    } else if (record.length !== headers.length) {
      errors.push({
        line: lineNo,
        message: `expected ${headers.length} columns, found ${record.length}`,
        raw: rawLine.slice(0, 200),
      });
    } else {
      rows.push({ values: record, line: lineNo });
    }
    record = [];
    line++;
    recordStartLine = line;
  };

  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      if (ch === '\n') line++;
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ',') {
      record.push(field);
      field = '';
      i++;
      continue;
    }
    if (ch === '\r') {
      i++;
      continue;
    }
    if (ch === '\n') {
      record.push(field);
      field = '';
      pushRecord(record.join(','));
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    pushRecord(record.join(','));
  }
  if (inQuotes) {
    errors.push({ line: recordStartLine, message: 'unterminated quoted field at end of file', raw: '' });
  }
  return { headers, rows, errors };
}

export function toObjects(parsed: CsvParseResult): { row: Record<string, string>; line: number; raw: string }[] {
  return parsed.rows.map((r) => {
    const obj: Record<string, string> = {};
    parsed.headers.forEach((h, idx) => {
      obj[h] = r.values[idx] ?? '';
    });
    return { row: obj, line: r.line, raw: r.values.join(',') };
  });
}
