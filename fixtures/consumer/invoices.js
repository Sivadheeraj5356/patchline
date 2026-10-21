import { api } from './client.js';

// List recent pending invoices for the dashboard
export async function listPendingInvoices() {
  const res = await api.get('/v1/invoices', { params: { limit: 20, status: 'pending' } });
  return res.invoices.map((inv) => ({
    id: inv.id,
    total: inv.amount_cents / 100,
    state: inv.status,
  }));
}

export async function createInvoice(email, amountCents) {
  const res = await api.post('/v1/invoices', { customer_email: email, amount_cents: amountCents });
  return res.id;
}
