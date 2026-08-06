const CARD_ORDER_KEY = 'meterm-card-display-order';

export function loadCardOrder(): string[] {
  try {
    const raw = localStorage.getItem(CARD_ORDER_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return [];
}

export function saveCardOrder(order: string[]): void {
  localStorage.setItem(CARD_ORDER_KEY, JSON.stringify(order));
}
