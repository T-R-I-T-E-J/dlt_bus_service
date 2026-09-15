export function refundStage(refund: { status: string; providerRefundId?: string | null; providerStatus?: string | null }) {
  if (refund.status === 'REFUNDED') return 'REFUNDED';
  if (refund.status === 'REFUND_FAILED') return 'FAILED';
  if (refund.providerRefundId) return 'PROVIDER_REFUND_CREATED';
  if (refund.providerStatus === 'dispatching') return 'DISPATCHING';
  return 'PENDING_DISPATCH';
}

export function presentRefund<T extends { status: string; providerRefundId?: string | null; providerStatus?: string | null }>(refund: T) {
  return { ...refund, obligationCreated: true, stage: refundStage(refund) };
}

export function safeCsvCell(value: unknown): string {
  let text = value == null ? '' : String(value);
  if (/^[\s]*[=+@-]/.test(text)) text = "'" + text;
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}
