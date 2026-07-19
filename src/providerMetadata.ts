const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;
const ANSI_ESCAPE_SEQUENCE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g;

export function terminalSafeMetadata(value: string): string {
  return value.replace(ANSI_ESCAPE_SEQUENCE, '').replace(CONTROL_CHARACTERS, '');
}

/** Keep provider metadata safe for terminal rendering and stable comparisons. */
export function sanitizePlanType(value?: string | null): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = terminalSafeMetadata(value)
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
  return normalized ? normalized.slice(0, 48) : undefined;
}

/** Convert provider/internal tier identifiers into compact customer-facing labels. */
export function formatPlanLabel(value?: string | null): string {
  const plan = sanitizePlanType(value);
  if (!plan) return '—';
  switch (plan) {
    // OpenAI currently exposes the lower Pro entitlement as `prolite` through
    // account/rateLimits/read. It is still a customer-facing ChatGPT Pro tier.
    case 'prolite':
    case 'pro-lite':
      return 'PRO';
    case 'free':
      return 'FREE';
    case 'go':
      return 'GO';
    case 'plus':
      return 'PLUS';
    case 'pro':
      return 'PRO';
    case 'team':
      return 'TEAM';
    case 'business':
      return 'BUSINESS';
    case 'enterprise':
      return 'ENTERPRISE';
    default:
      return plan.replace(/-/g, ' ').toUpperCase();
  }
}
