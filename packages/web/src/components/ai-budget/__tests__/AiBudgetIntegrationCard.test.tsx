import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { AiBudgetIntegrationCard } from '../AiBudgetIntegrationCard';
import type { AiBudgetStatusDto, AiBudgetAccountDto } from '@/types/ai-budget.types';
import en from '@/i18n/locales/en.json';

const t = en.aiBudget;

const account = (over: Partial<AiBudgetAccountDto> = {}): AiBudgetAccountDto => ({
  id: 'row-1',
  externalId: 'ext-1',
  name: 'Acme Ltd',
  type: 'business',
  currency: 'PLN',
  access: 'read_write',
  active: true,
  inactiveReason: null,
  label: 'company',
  labelSource: 'auto',
  ...over,
});

const connected = (
  accounts: AiBudgetAccountDto[],
  over: Partial<NonNullable<AiBudgetStatusDto['connection']>> = {},
): AiBudgetStatusDto => ({
  available: true,
  connection: {
    status: 'active',
    lastSyncedAt: '2026-11-01T10:00:00.000Z',
    lastSyncError: null,
    needsCompanyChoice: false,
    accounts,
    ...over,
  },
});

const makeMutations = () => ({
  connect: { mutate: jest.fn(), isPending: false },
  disconnect: { mutate: jest.fn(), isPending: false },
  setLabel: { mutate: jest.fn(), isPending: false },
  sync: { mutate: jest.fn(), isPending: false },
});

const renderCard = (status: AiBudgetStatusDto, mutations = makeMutations()) => {
  render(<AiBudgetIntegrationCard status={status} translations={t} mutations={mutations} locale="en" />);
  return mutations;
};

describe('AiBudgetIntegrationCard', () => {
  test('unavailable hides the connect button', () => {
    renderCard({ available: false, connection: null });
    expect(screen.queryByRole('button', { name: /connect/i })).toBeNull();
    expect(screen.getByText(t.settings.error.unavailable)).toBeInTheDocument();
  });

  test('not connected shows the connect button', () => {
    const m = renderCard({ available: true, connection: null });
    fireEvent.click(screen.getByRole('button', { name: t.settings.connect }));
    expect(m.connect.mutate).toHaveBeenCalled();
  });

  test('connected: rows show label, auto/manual hint and read-only badge', () => {
    renderCard(
      connected([
        account(),
        account({ id: 'row-2', name: 'Savings', type: 'personal', label: 'private', labelSource: 'manual', access: 'read' }),
      ]),
    );
    expect(screen.getByText(t.settings.status.active)).toBeInTheDocument();
    expect(screen.getByText('Acme Ltd')).toBeInTheDocument();
    expect(screen.getByText(t.settings.labelAuto)).toBeInTheDocument();
    expect(screen.getByText(t.settings.labelManual)).toBeInTheDocument();
    expect(screen.getAllByText(t.settings.readOnly)).toHaveLength(1);
    expect(screen.getByRole('combobox', { name: 'Label for Acme Ltd' })).toHaveValue('company');
  });

  test('choosing company on another account calls setLabel(id, "company")', () => {
    const m = renderCard(
      connected([
        account({ id: 'row-1', label: 'other_business', labelSource: 'auto' }),
        account({ id: 'row-2', name: 'Other Co', label: 'other_business', labelSource: 'auto' }),
      ]),
    );
    fireEvent.change(screen.getByRole('combobox', { name: 'Label for Other Co' }), { target: { value: 'company' } });
    expect(m.setLabel.mutate).toHaveBeenCalledWith({ accountId: 'row-2', label: 'company' });
  });

  test('needsCompanyChoice renders the choice prompt', () => {
    const m = renderCard(
      connected(
        [
          account({ id: 'row-1', name: 'Alpha', label: 'other_business' }),
          account({ id: 'row-2', name: 'Beta', label: 'other_business' }),
          account({ id: 'row-3', name: 'Home', type: 'personal', label: 'private' }),
        ],
        { needsCompanyChoice: true },
      ),
    );
    const prompt = screen.getByTestId('company-choice-prompt');
    expect(within(prompt).getByText(t.settings.chooseCompany)).toBeInTheDocument();
    expect(within(prompt).getByText('Alpha')).toBeInTheDocument();
    expect(within(prompt).getByText('Beta')).toBeInTheDocument();
    expect(within(prompt).queryByText('Home')).toBeNull();
    fireEvent.click(within(prompt).getByRole('button', { name: /Beta/ }));
    expect(m.setLabel.mutate).toHaveBeenCalledWith({ accountId: 'row-2', label: 'company' });
  });

  test('needs_reconnect shows the reconnect banner and button', () => {
    const m = renderCard(connected([account()], { status: 'needs_reconnect' }));
    expect(screen.getByText(t.settings.reconnectBanner)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: t.settings.reconnect }));
    expect(m.connect.mutate).toHaveBeenCalled();
  });

  test('disconnect asks for confirmation before calling disconnect', () => {
    const m = renderCard(connected([account()]));
    fireEvent.click(screen.getByRole('button', { name: t.settings.disconnect }));
    expect(m.disconnect.mutate).not.toHaveBeenCalled();
    expect(screen.getByText(t.settings.disconnectConfirm)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: t.settings.cancel }));
    expect(m.disconnect.mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: t.settings.disconnect }));
    const confirm = screen.getAllByRole('button', { name: t.settings.disconnect }).at(-1)!;
    fireEvent.click(confirm);
    expect(m.disconnect.mutate).toHaveBeenCalledTimes(1);
  });

  test('an unavailable account shows the localized text and cannot be labelled', () => {
    renderCard(connected([account({ name: '', type: '', active: false, inactiveReason: 'role', label: 'private' })]));
    expect(screen.getByText(t.settings.unavailable)).toBeInTheDocument();
    expect(screen.getByText(t.settings.inactiveReason.role)).toBeInTheDocument();
    expect(screen.getByRole('combobox')).toBeDisabled();
  });

  test('the company choice offers only active, available business accounts', () => {
    renderCard(
      connected(
        [
          account({ id: 'row-1', name: 'Alpha', label: 'other_business' }),
          account({ id: 'row-2', name: 'Beta', label: 'other_business' }),
          account({ id: 'row-3', name: 'Paused', label: 'other_business', active: false, inactiveReason: 'grant_inactive' }),
        ],
        { needsCompanyChoice: true },
      ),
    );
    const prompt = screen.getByTestId('company-choice-prompt');
    expect(within(prompt).getByText('Alpha')).toBeInTheDocument();
    expect(within(prompt).queryByText('Paused')).toBeNull();
  });

  test('a grant_inactive reason is localized and an unknown reason such as __proto__ falls back to the generic text', () => {
    renderCard(connected([
      account({ id: 'row-1', name: 'One', active: false, inactiveReason: 'grant_inactive', label: 'private' }),
      account({ id: 'row-2', name: 'Two', active: false, inactiveReason: '__proto__', label: 'private' }),
    ]));
    expect(screen.getByText(t.settings.inactiveReason.grant_inactive)).toBeInTheDocument();
    expect(screen.getAllByText(t.settings.inactive).length).toBeGreaterThan(0);
  });
});
