import type { AiBudgetLabel, AiBudgetLabelSource } from './ai-budget.types';

export interface LabelState {
  externalId: string;
  type: string;
  label: AiBudgetLabel;
  labelSource: AiBudgetLabelSource;
}

/**
 * Automatic labelling. Manual labels always win; at most one company.
 * A still-granted existing company keeps the role. Otherwise a lone business
 * account becomes company; several unlabelled business accounts are all
 * other_business and the user must choose. Everything else is private.
 * Accounts with an unknown type (hidden by AI Budget) are never company.
 */
export function computeAutoLabels(
  granted: { externalId: string; type: string; active: boolean }[],
  existing: LabelState[],
): { labels: LabelState[]; needsCompanyChoice: boolean } {
  const prior = new Map(existing.map((l) => [l.externalId, l]));
  const isBusiness = (type: string): boolean => type === 'business';
  // Auto-promotion needs an active business account. An unavailable account (type '') can never be company.
  const eligible = (g: { type: string; active: boolean }): boolean => g.active && g.type !== '';
  const available = (g: { type: string }): boolean => g.type !== '';

  // Ruling 7: a prior company on an inactive-but-visible account keeps the role (manual wins).
  const keptCompany =
    granted.find((g) => available(g) && prior.get(g.externalId)?.label === 'company' && prior.get(g.externalId)?.labelSource === 'manual') ??
    granted.find((g) => available(g) && prior.get(g.externalId)?.label === 'company');

  // Business accounts the user manually set to other_business/private are not candidates for company.
  const candidates = granted.filter((g) => {
    if (!eligible(g) || !isBusiness(g.type)) return false;
    const p = prior.get(g.externalId);
    return !(p?.labelSource === 'manual' && (p.label === 'other_business' || p.label === 'private'));
  });
  const autoCompanyId = !keptCompany && candidates.length === 1 ? candidates[0].externalId : undefined;
  const companyId = keptCompany?.externalId ?? autoCompanyId;

  const labels: LabelState[] = granted.map((g) => {
    const p = prior.get(g.externalId);
    if (!available(g)) {
      // A previous company (or any label) on an unavailable account is dropped.
      return { externalId: g.externalId, type: g.type, label: 'private', labelSource: 'auto' };
    }
    if (p?.labelSource === 'manual' && p.label !== 'company') {
      return { externalId: g.externalId, type: g.type, label: p.label, labelSource: 'manual' };
    }
    if (g.externalId === companyId) {
      return { externalId: g.externalId, type: g.type, label: 'company', labelSource: p?.labelSource === 'manual' ? 'manual' : 'auto' };
    }
    return {
      externalId: g.externalId,
      type: g.type,
      label: isBusiness(g.type) ? 'other_business' : 'private',
      labelSource: 'auto',
    };
  });

  const needsCompanyChoice = !labels.some((l) => l.label === 'company') && candidates.length >= 2;

  return { labels, needsCompanyChoice };
}

/** Manual relabel. Choosing a company demotes any previous company to other_business. */
export function applyLabelChange(current: LabelState[], externalId: string, label: AiBudgetLabel): LabelState[] {
  return current.map((l) => {
    if (l.externalId === externalId) return { ...l, label, labelSource: 'manual' };
    if (label === 'company' && l.label === 'company') return { ...l, label: 'other_business', labelSource: 'manual' };
    return l;
  });
}
