const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2, minimumFractionDigits: 0 });
const inr2 = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 });

/** paise -> "₹1,299" / "₹1,299.50" */
export function rupees(paise: number | null | undefined, exact = false): string {
  const n = (paise ?? 0) / 100;
  return exact || n % 1 !== 0 ? inr2.format(n) : inr.format(n);
}
/** "1299.50" typed by a person -> paise, or null when it is not an amount */
export function toPaise(text: string): number | null {
  const s = text.replace(/[₹,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [r, p = ''] = s.split('.');
  return Number(r) * 100 + Number((p + '00').slice(0, 2));
}
export function fromPaise(paise: number | null | undefined): string {
  if (paise === null || paise === undefined) return '';
  return (paise / 100).toFixed(paise % 100 ? 2 : 0);
}
export const num = (n: number) => new Intl.NumberFormat('en-IN').format(n);
export const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
export const day = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
export const mb = (bytes: number) => (bytes / 1048576).toFixed(bytes > 100 * 1048576 ? 0 : 1) + ' MB';
