import { computeAutoLabels, applyLabelChange } from '../ai-budget-labels';

test('single business account becomes company, others private', () => {
  const r = computeAutoLabels([{ externalId: 'b', type: 'business', active: true }, { externalId: 'p', type: 'personal', active: true }, { externalId: 's', type: 'shared', active: true }], []);
  expect(r.labels.map(l => [l.externalId, l.label, l.labelSource])).toEqual([['b','company','auto'],['p','private','auto'],['s','private','auto']]);
  expect(r.needsCompanyChoice).toBe(false);
});
test('several business accounts ask for a choice and none is company', () => {
  const r = computeAutoLabels([{ externalId: 'b1', type: 'business', active: true }, { externalId: 'b2', type: 'business', active: true }], []);
  expect(r.labels.every(l => l.label === 'other_business')).toBe(true);
  expect(r.needsCompanyChoice).toBe(true);
});
test('manual labels survive recomputation and an existing company stays the only one', () => {
  const existing = [{ externalId: 'b1', type: 'business', label: 'company', labelSource: 'manual' } as const,
                    { externalId: 'p', type: 'personal', label: 'other_business', labelSource: 'manual' } as const];
  const r = computeAutoLabels([{ externalId: 'b1', type: 'business', active: true }, { externalId: 'p', type: 'personal', active: true }, { externalId: 'b2', type: 'business', active: true }], existing);
  expect(r.labels.find(l => l.externalId === 'b2')!.label).toBe('other_business');
  expect(r.labels.find(l => l.externalId === 'p')!.label).toBe('other_business');
  expect(r.labels.filter(l => l.label === 'company')).toHaveLength(1);
  expect(r.needsCompanyChoice).toBe(false);
});
test('a manual private label on the only business account is respected', () => {
  const r = computeAutoLabels([{ externalId: 'b', type: 'business', active: true }],
    [{ externalId: 'b', type: 'business', label: 'private', labelSource: 'manual' }]);
  expect(r.labels[0].label).toBe('private');
  expect(r.needsCompanyChoice).toBe(false);
});
test('an account with unknown type is never company', () => {
  const r = computeAutoLabels([{ externalId: 'x', type: '', active: true }], []);
  expect(r.labels[0].label).toBe('private');
});
test('choosing a new company demotes the previous one to other_business', () => {
  const next = applyLabelChange([{ externalId: 'b1', type: 'business', label: 'company', labelSource: 'auto' },
    { externalId: 'b2', type: 'business', label: 'other_business', labelSource: 'auto' }], 'b2', 'company');
  expect(next).toEqual([{ externalId: 'b1', type: 'business', label: 'other_business', labelSource: 'manual' },
    { externalId: 'b2', type: 'business', label: 'company', labelSource: 'manual' }]);
});
test('a non-company change only touches its own row', () => {
  const next = applyLabelChange([{ externalId: 'b1', type: 'business', label: 'company', labelSource: 'auto' },
    { externalId: 'p', type: 'personal', label: 'private', labelSource: 'auto' }], 'p', 'other_business');
  expect(next[0].label).toBe('company');
  expect(next[1]).toMatchObject({ label: 'other_business', labelSource: 'manual' });
});

test('manual company on an unknown-type account is dropped to private', () => {
  const r = computeAutoLabels([{ externalId: 'x', type: '', active: false }],
    [{ externalId: 'x', type: 'business', label: 'company', labelSource: 'manual' }]);
  expect(r.labels[0]).toMatchObject({ label: 'private', labelSource: 'auto' });
  const r2 = computeAutoLabels([{ externalId: 'x', type: '', active: true }],
    [{ externalId: 'x', type: '', label: 'company', labelSource: 'manual' }]);
  expect(r2.labels[0].label).toBe('private');
});
test('manual company on an inactive-but-visible business account keeps the role and blocks auto-promotion', () => {
  const r = computeAutoLabels([{ externalId: 'b1', type: 'business', active: false }, { externalId: 'b2', type: 'business', active: true }],
    [{ externalId: 'b1', type: 'business', label: 'company', labelSource: 'manual' }]);
  expect(r.labels.find((l) => l.externalId === 'b1')).toMatchObject({ label: 'company', labelSource: 'manual' });
  expect(r.labels.find((l) => l.externalId === 'b2')!.label).toBe('other_business');
  expect(r.needsCompanyChoice).toBe(false);
});
test('auto company on an inactive-but-visible account keeps the role', () => {
  const r = computeAutoLabels([{ externalId: 'b1', type: 'business', active: false }, { externalId: 'b2', type: 'business', active: true }, { externalId: 'b3', type: 'business', active: true }],
    [{ externalId: 'b1', type: 'business', label: 'company', labelSource: 'auto' }]);
  expect(r.labels.filter((l) => l.label === 'company').map((l) => l.externalId)).toEqual(['b1']);
  expect(r.needsCompanyChoice).toBe(false);
});
test('an unavailable company loses the role and the remaining single business becomes company', () => {
  const r = computeAutoLabels([{ externalId: 'b1', type: '', active: false }, { externalId: 'b2', type: 'business', active: true }],
    [{ externalId: 'b1', type: 'business', label: 'company', labelSource: 'manual' }]);
  expect(r.labels.find((l) => l.externalId === 'b1')).toMatchObject({ label: 'private', labelSource: 'auto' });
  expect(r.labels.find((l) => l.externalId === 'b2')!.label).toBe('company');
});
test('dropping an unavailable company asks for a choice when two eligible business accounts remain', () => {
  const r = computeAutoLabels([{ externalId: 'b1', type: '', active: false }, { externalId: 'b2', type: 'business', active: true }, { externalId: 'b3', type: 'business', active: true }],
    [{ externalId: 'b1', type: 'business', label: 'company', labelSource: 'manual' }]);
  expect(r.labels.filter((l) => l.label === 'company')).toHaveLength(0);
  expect(r.needsCompanyChoice).toBe(true);
});
test('no choice needed when the other business accounts were labelled by hand', () => {
  const r = computeAutoLabels([{ externalId: 'b1', type: 'business', active: true }, { externalId: 'b2', type: 'business', active: true }],
    [{ externalId: 'b1', type: 'business', label: 'other_business', labelSource: 'manual' }]);
  expect(r.needsCompanyChoice).toBe(false);
});
test('a manually private business account does not block auto-promotion of the only other business account', () => {
  const r = computeAutoLabels(
    [{ externalId: 'b1', type: 'business', active: true }, { externalId: 'b2', type: 'business', active: true }],
    [{ externalId: 'b1', type: 'business', label: 'private', labelSource: 'manual' }]);
  expect(r.labels.find((l) => l.externalId === 'b1')).toMatchObject({ label: 'private', labelSource: 'manual' });
  expect(r.labels.find((l) => l.externalId === 'b2')).toMatchObject({ label: 'company', labelSource: 'auto' });
  expect(r.needsCompanyChoice).toBe(false);
});
