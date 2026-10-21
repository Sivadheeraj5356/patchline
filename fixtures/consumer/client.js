// Thin wrapper around fetch for the Northwind Billing API
export const api = {
  base: 'https://api.northwind.example',
  async get(path, opts = {}) {
    const q = opts.params ? '?' + new URLSearchParams(opts.params) : '';
    const r = await fetch(this.base + path + q, { headers: this.headers() });
    return r.json();
  },
  async post(path, body) {
    const r = await fetch(this.base + path, { method: 'POST', headers: this.headers(), body: JSON.stringify(body) });
    return r.json();
  },
  headers() { return { 'Authorization': 'Bearer ' + process.env.NORTHWIND_KEY, 'Content-Type': 'application/json' }; },
};
