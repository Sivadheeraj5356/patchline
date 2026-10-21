import { listPendingInvoices } from './invoices.js';

export async function renderDashboard() {
  const rows = await listPendingInvoices();
  for (const row of rows) {
    console.log(`Invoice ${row.id}: $${row.total} (${row.state})`);
  }
}
