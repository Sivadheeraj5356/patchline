import { api } from './client.js';

// Charge a card token directly
export async function chargeCard(cardToken, amountCents) {
  const res = await api.post('/v1/charges', { card_token: cardToken, amount_cents: amountCents });
  return res.status === 'succeeded';
}
