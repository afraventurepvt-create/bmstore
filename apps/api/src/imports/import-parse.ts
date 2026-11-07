import { BadRequestException } from '@nestjs/common';
import { parse } from 'csv-parse/sync';
import * as ExcelJS from 'exceljs';

/** Column names the import understands. Header matching is case/space-insensitive ("Image Filename" == image_filename). */
export const IMPORT_COLUMNS = ['name', 'description', 'price', 'mrp', 'sku', 'stock', 'category', 'hsn_code', 'image_filename'] as const;
export type ImportColumn = (typeof IMPORT_COLUMNS)[number];
export const REQUIRED_COLUMNS: ImportColumn[] = ['name', 'price', 'mrp'];
export const MAX_ROWS = 5000;

export interface RawRow { row: number; cells: Partial<Record<ImportColumn, string>> }
export interface ParsedFile { rows: RawRow[]; unknownColumns: string[] }

const normHeader = (h: unknown) => String(h ?? '').replace(/^﻿/, '').trim().toLowerCase().replace(/[\s-]+/g, '_');

export function detectFormat(filename: string, contentType?: string): 'csv' | 'xlsx' {
  const f = filename.toLowerCase();
  if (f.endsWith('.xlsx') || f.endsWith('.xlsm')) return 'xlsx';
  if (f.endsWith('.csv') || f.endsWith('.txt')) return 'csv';
  if (f.endsWith('.xls')) throw new BadRequestException('Old .xls files are not supported: save the sheet as .xlsx or .csv');
  if (contentType?.includes('spreadsheetml')) return 'xlsx';
  if (contentType?.includes('csv') || contentType?.startsWith('text/')) return 'csv';
  throw new BadRequestException('Upload a .csv or .xlsx file');
}

export async function parseImportFile(buf: Buffer, format: 'csv' | 'xlsx'): Promise<ParsedFile> {
  const table = format === 'csv' ? parseCsv(buf) : await parseXlsx(buf);
  if (!table.length) throw new BadRequestException('The file is empty');
  const headers = table[0].map(normHeader);
  const missing = REQUIRED_COLUMNS.filter((c) => !headers.includes(c));
  if (missing.length) throw new BadRequestException(`The first row must contain the column headings. Missing: ${missing.join(', ')}. Download the template to see the format.`);
  const known = new Set<string>(IMPORT_COLUMNS);
  const unknownColumns = [...new Set(headers.filter((h) => h && !known.has(h)))];
  const rows: RawRow[] = [];
  for (let i = 1; i < table.length; i++) {
    const line = table[i];
    if (line.every((v) => String(v ?? '').trim() === '')) continue; // blank line
    const cells: Partial<Record<ImportColumn, string>> = {};
    headers.forEach((h, j) => { if (known.has(h)) cells[h as ImportColumn] = String(line[j] ?? '').trim(); });
    rows.push({ row: i + 1, cells }); // row numbers as the user sees them in Excel (1 = headings)
    if (rows.length > MAX_ROWS) throw new BadRequestException(`At most ${MAX_ROWS} products per file. Split the file and import again.`);
  }
  return { rows, unknownColumns };
}

function parseCsv(buf: Buffer): string[][] {
  let text = buf.toString('utf8');
  if (text.includes('�')) text = buf.toString('latin1'); // not UTF-8: Excel "CSV" on Windows
  try {
    return parse(text, { bom: true, relax_column_count: true, relax_quotes: true, skip_empty_lines: true, trim: true, delimiter: [',', ';', '\t'] }) as string[][];
  } catch (e) {
    throw new BadRequestException(`Could not read the CSV: ${(e as Error).message.split('\n')[0]}`);
  }
}

async function parseXlsx(buf: Buffer): Promise<string[][]> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as any);
  } catch {
    throw new BadRequestException('Could not read the Excel file. Save it as .xlsx (Excel 2007 or newer) or as .csv');
  }
  const ws = wb.worksheets[0];
  if (!ws) throw new BadRequestException('The workbook has no sheet');
  const out: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    const vals: string[] = [];
    const arr = row.values as unknown[];
    for (let c = 1; c < arr.length; c++) vals.push(cellText(arr[c]));
    out[n - 1] = vals;
  });
  // eachRow skips empty rows but keeps numbering; fill holes so row numbers stay true to the sheet
  for (let i = 0; i < out.length; i++) out[i] ??= [];
  return out;
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    const o = v as any;
    if (o.richText) return o.richText.map((r: any) => r.text).join('');
    if (o.text !== undefined) return String(o.text);
    if (o.result !== undefined) return String(o.result);
    if (v instanceof Date) return v.toISOString();
    return '';
  }
  return String(v);
}

/** Template with headings and two example rows, as CSV or XLSX. */
export async function buildTemplate(format: 'csv' | 'xlsx'): Promise<{ body: Buffer; contentType: string; filename: string }> {
  const rows = [
    [...IMPORT_COLUMNS],
    ['Kanchipuram Silk Saree', 'Pure mulberry silk, zari border', '2499.00', '2999.00', 'SAR-001', '5', 'Sarees', '5007', 'saree-red.jpg'],
    ['Cotton Kurta', 'Hand block print', '799', '999', 'KUR-010', '20', 'Kurtas', '6204', 'kurta-blue.jpg'],
  ];
  if (format === 'csv') {
    const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    return { body: Buffer.from('﻿' + rows.map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n', 'utf8'), contentType: 'text/csv; charset=utf-8', filename: 'products-template.csv' };
  }
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Products');
  ws.addRows(rows);
  ws.getRow(1).font = { bold: true };
  ws.columns.forEach((c) => { c.width = 18; });
  const body = Buffer.from(await wb.xlsx.writeBuffer());
  return { body, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename: 'products-template.xlsx' };
}
