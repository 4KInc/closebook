// Money is integer cents everywhere. Parsing and formatting live here so nothing else touches floats.

export function cents(value) {
  if (value == null || value === '') return 0;
  // A number goes through its decimal text, so a float that is not a whole number of cents
  // (0.1 + 0.2) is refused instead of rounded.
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new Error(`not an amount: ${value}`); return cents(String(value)); }
  const s = String(value).trim().replace(/[$,\s]/g, '');
  const neg = /^\(.*\)$/.test(s) || s.startsWith('-');
  const digits = s.replace(/[()\-+]/g, '');
  if (!/^\d*(\.\d{0,2})?$/.test(digits) || digits === '' || digits === '.') throw new Error(`not an amount: ${value}`);
  const [whole, frac = ''] = digits.split('.');
  const v = Number(whole || '0') * 100 + Number((frac + '00').slice(0, 2));
  return neg ? -v : v;
}

export function fmt(c, currency = 'USD') {
  const sign = c < 0 ? '-' : '';
  const a = Math.abs(c);
  const s = `${Math.floor(a / 100).toLocaleString('en-US')}.${String(a % 100).padStart(2, '0')}`;
  return currency === 'USD' ? `${sign}$${s}` : `${sign}${s} ${currency}`;
}
