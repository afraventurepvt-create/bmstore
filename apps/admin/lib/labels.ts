/** Plain-language labels for the fixed vocabulary. */
export const ORDER_STATUS: Record<string, { label: string; tone: 'new' | 'work' | 'ok' | 'bad' | 'muted' }> = {
  PENDING: { label: 'New', tone: 'new' },
  CONFIRMED: { label: 'Confirmed', tone: 'work' },
  PACKED: { label: 'Packed', tone: 'work' },
  SHIPPED: { label: 'Shipped', tone: 'work' },
  DELIVERED: { label: 'Delivered', tone: 'ok' },
  CANCELLED: { label: 'Cancelled', tone: 'bad' },
  RETURNED: { label: 'Returned', tone: 'muted' },
};
export const NEXT_STATUS: Record<string, Array<{ to: string; label: string; primary?: boolean }>> = {
  PENDING: [{ to: 'CONFIRMED', label: 'Confirm order', primary: true }, { to: 'CANCELLED', label: 'Cancel' }],
  CONFIRMED: [{ to: 'PACKED', label: 'Mark packed', primary: true }, { to: 'CANCELLED', label: 'Cancel' }],
  PACKED: [{ to: 'SHIPPED', label: 'Mark shipped', primary: true }, { to: 'CANCELLED', label: 'Cancel' }],
  SHIPPED: [{ to: 'DELIVERED', label: 'Mark delivered', primary: true }, { to: 'RETURNED', label: 'Returned to us' }],
  DELIVERED: [{ to: 'RETURNED', label: 'Customer returned it' }],
  CANCELLED: [],
  RETURNED: [],
};
export const PAYMENT_STATUS: Record<string, string> = { PENDING: 'Payment due', PAID: 'Paid', FAILED: 'Payment failed', REFUNDED: 'Refunded', PARTIALLY_REFUNDED: 'Partly refunded' };
export const PAYMENT_MODE: Record<string, string> = { COD: 'Cash on delivery', ONLINE: 'Paid online' };
export const PRODUCT_STATUS: Record<string, string> = { DRAFT: 'Draft', ACTIVE: 'Live', ARCHIVED: 'Archived' };
export const WHATSAPP_HELP = 'https://wa.me/919403892971';
