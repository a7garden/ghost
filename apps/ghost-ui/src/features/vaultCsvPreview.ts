export const vaultCsvByteLimit = 1024 * 1024;

type PreviewRow = { record: number; title: string; origin: string; username: string };
export type CsvPreview = { rows: PreviewRow[]; omitted: number };

/** Read the Apple Passwords/Chrome row identities without retaining any password, OTP or note cells. */
export function previewVaultCsv(csv: string): CsvPreview | null {
  if (!csv.length || csv.includes('\0')) return null;
  const headers: string[] = [];
  const rows: PreviewRow[] = [];
  let record = 0, column = 0, omitted = 0;
  let titleColumn = -1, originColumn = -1, userColumn = -1, passwordColumn = -1;
  let title = '', address = '', username = '', hasPassword = false;
  let start = csv.charCodeAt(0) === 0xfeff ? 1 : 0;
  let end = start;
  let quoting: 'start' | 'plain' | 'quoted' | 'closed' = 'start';

  const finishField = () => {
    if (!record || column === titleColumn || column === originColumn || column === userColumn) {
      const value = quoting === 'closed' ? csv.slice(start, end).replaceAll('""', '"') : csv.slice(start, end);
      if (!record) headers.push(value.trim().toLowerCase());
      else if (column === titleColumn) title = value;
      else if (column === originColumn) address = value;
      else username = value;
    } else if (column === passwordColumn) hasPassword = end > start;
    column++;
  };
  const finishRecord = () => {
    if (!column && start === end) return true; // The Host ignores one-cell empty records.
    finishField();
    if (!record) {
      titleColumn = headers.indexOf('title');
      const nameColumn = headers.indexOf('name');
      if (titleColumn >= 0 && nameColumn >= 0) return false;
      if (titleColumn < 0) titleColumn = nameColumn;
      originColumn = headers.indexOf('url');
      userColumn = headers.indexOf('username');
      passwordColumn = headers.indexOf('password');
      if (headers.length > 128 || new Set(headers).size !== headers.length || Math.min(originColumn, userColumn, passwordColumn) < 0) return false;
    } else {
      if (record > 10_000 || column !== headers.length) return false;
      const origin = hasPassword ? previewOrigin(address) : null;
      if (origin) rows.push({ record, title: title.trim() || origin, origin, username });
      else omitted++;
    }
    record++;
    column = 0;
    title = address = username = '';
    hasPassword = false;
    return true;
  };

  for (let i = start; i < csv.length; i++) {
    const char = csv[i];
    if (quoting === 'quoted') {
      if (char === '"') { quoting = 'closed'; end = i; }
    } else if (quoting === 'closed' && char === '"') {
      quoting = 'quoted';
    } else if (char === ',' || char === '\r' || char === '\n') {
      if (char === ',') finishField();
      else {
        if (!finishRecord()) return null;
        if (char === '\r' && csv[i + 1] === '\n') i++;
      }
      start = end = i + 1;
      quoting = 'start';
    } else if (quoting === 'closed' || (quoting === 'plain' && char === '"')) {
      return null;
    } else if (char === '"') {
      start = end = i + 1;
      quoting = 'quoted';
    } else {
      end = i + 1;
      quoting = 'plain';
    }
  }
  if (quoting === 'quoted' || !finishRecord() || record < 2) return null;
  return { rows, omitted };
}

function previewOrigin(address: string): string | null {
  if (!address.startsWith('https://') || /[\s\p{Cc}\\]/u.test(address)) return null;
  const authority = address.slice(8).split(/[/?#]/, 1)[0];
  if (!authority || /[@%]/.test(authority)) return null;
  try {
    const url = new URL(address);
    return url.hostname.endsWith('.') || url.origin.length > 512 ? null : url.origin;
  } catch { return null; }
}
