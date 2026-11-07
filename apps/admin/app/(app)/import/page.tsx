'use client';
import { useRef, useState } from 'react';
import { ApiError } from '@/lib/api';
import { Card, Field, PageTitle, Toggle, useToast } from '@/components/ui';

type Report = { dryRun: boolean; totalRows: number; imported: number; updated: number; failed: number; errors: Array<{ row: number; reason: string }>; warnings: Array<{ row: number; reason: string }>; durationMs: number };

export default function ImportPage() {
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [live, setLive] = useState(true);
  const [upsert, setUpsert] = useState(false);
  const [busy, setBusy] = useState<'check' | 'import' | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);

  const run = async (dryRun: boolean) => {
    if (!file) return;
    setBusy(dryRun ? 'check' : 'import'); setError(null); setReport(null);
    try {
      const type = file.name.toLowerCase().endsWith('.xlsx') ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv';
      const q = new URLSearchParams({ filename: file.name, dryRun: String(dryRun), status: live ? 'ACTIVE' : 'DRAFT', mode: upsert ? 'upsert' : 'create' });
      const r = await fetch(`/api/store/import/products?${q}`, { method: 'POST', headers: { 'content-type': type }, body: file });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new ApiError(r.status, Array.isArray(data.message) ? data.message.join('. ') : data.message || 'Could not read the file');
      setReport(data);
      if (!dryRun) toast.push(`${data.imported + data.updated} product${data.imported + data.updated === 1 ? '' : 's'} imported`);
    } catch (e: any) { setError(e.message); } finally { setBusy(null); }
  };

  return (
    <div className="flex flex-col gap-4">
      <PageTitle title="Import products" sub="From a CSV or Excel sheet" />
      <Card className="flex flex-col gap-4">
        <p className="text-sm text-ink-2">Columns: <b>name, price, mrp</b> (required) and description, sku, stock, category, hsn_code, image_filename. Prices in rupees. Upload photos first so <i>image_filename</i> can match them.</p>
        <div className="flex gap-2">
          <a className="btn-secondary flex-1" href="/api/store/import/products/template?format=xlsx">Excel template</a>
          <a className="btn-secondary flex-1" href="/api/store/import/products/template?format=csv">CSV template</a>
        </div>
      </Card>
      <Card className="flex flex-col gap-4">
        <button type="button" onClick={() => ref.current?.click()} className={`rounded-xl border-2 border-dashed p-6 text-center tap ${file ? 'border-brand bg-brand-soft' : 'border-line'}`}>
          {file ? <><div className="font-semibold">{file.name}</div><div className="text-sm text-ink-3">{(file.size / 1024).toFixed(0)} KB · tap to change</div></> : <><div className="font-semibold">Choose a file</div><div className="text-sm text-ink-3">.csv or .xlsx, up to 5,000 products</div></>}
        </button>
        <input ref={ref} type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="hidden" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setReport(null); setError(null); }} />
        <Toggle checked={live} onChange={setLive} label="Make products live right away" hint={live ? 'Customers can buy them as soon as the import finishes' : 'Imported as drafts; make them live later'} />
        <Toggle checked={upsert} onChange={setUpsert} label="Update products that already exist" hint="Matches by SKU and updates price, stock and details" />
        {error && <p className="text-sm text-bad bg-bad-soft rounded-xl px-3 py-2" role="alert">{error}</p>}
        <div className="grid grid-cols-2 gap-3">
          <button className="btn-secondary" disabled={!file || !!busy} onClick={() => run(true)}>{busy === 'check' ? 'Checking…' : 'Check only'}</button>
          <button className="btn-primary" disabled={!file || !!busy} onClick={() => run(false)}>{busy === 'import' ? 'Importing…' : 'Import'}</button>
        </div>
      </Card>
      {report && (
        <Card className="flex flex-col gap-3">
          <h2 className="font-semibold text-lg">{report.dryRun ? 'Check result (nothing saved yet)' : 'Import finished'}</h2>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-xl bg-ok-soft p-3"><div className="text-2xl font-bold text-ok">{report.imported}</div><div className="text-xs text-ok">{report.dryRun ? 'would import' : 'imported'}</div></div>
            <div className="rounded-xl bg-brand-soft p-3"><div className="text-2xl font-bold text-brand">{report.updated}</div><div className="text-xs text-brand">{report.dryRun ? 'would update' : 'updated'}</div></div>
            <div className={`rounded-xl p-3 ${report.failed ? 'bg-bad-soft' : 'bg-paper'}`}><div className={`text-2xl font-bold ${report.failed ? 'text-bad' : ''}`}>{report.failed}</div><div className={`text-xs ${report.failed ? 'text-bad' : 'text-ink-3'}`}>skipped</div></div>
          </div>
          <p className="text-xs text-ink-3">{report.totalRows} rows read in {(report.durationMs / 1000).toFixed(1)} s</p>
          {report.errors.length > 0 && (
            <div>
              <h3 className="font-semibold text-bad mb-1">Rows that were skipped</h3>
              <p className="text-xs text-ink-3 mb-2">Row numbers are the ones you see in Excel (row 1 is the heading). Fix these rows and import the file again; already-imported rows are skipped as duplicates unless you tick "update".</p>
              <ul className="divide-y divide-line rounded-xl border border-line">
                {report.errors.map((e, i) => <li key={i} className="flex gap-3 p-3 text-sm"><span className="font-mono font-semibold text-ink-2 w-14 shrink-0">Row {e.row}</span><span>{e.reason}</span></li>)}
              </ul>
            </div>
          )}
          {report.warnings.length > 0 && (
            <div>
              <h3 className="font-semibold text-note mb-1">Imported, but have a look</h3>
              <ul className="divide-y divide-line rounded-xl border border-line">
                {report.warnings.map((e, i) => <li key={i} className="flex gap-3 p-3 text-sm"><span className="font-mono font-semibold text-ink-2 w-14 shrink-0">Row {e.row}</span><span>{e.reason}</span></li>)}
              </ul>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
