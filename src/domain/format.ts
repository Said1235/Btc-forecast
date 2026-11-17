const usd = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const formatPrice = (n: number) => usd.format(n);
export const formatSigned = (n: number) => (n > 0 ? "+" : n < 0 ? "−" : "") + usd.format(Math.abs(n));
export const formatPct = (n: number) => (n > 0 ? "+" : n < 0 ? "−" : "") + Math.abs(n).toFixed(2) + "%";
export const formatPoints = (n: number) => `${n} ${n === 1 ? "point" : "points"}`;
export const shortAddress = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
