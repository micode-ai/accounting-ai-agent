import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { SharePrivateDataDialog } from '../SharePrivateDataDialog';

const t = {
  privateDataWarning: 'This conversation contains private AI Budget data.',
  confirm: 'Share anyway',
  cancel: 'Cancel',
};

describe('SharePrivateDataDialog', () => {
  test('confirm calls onConfirm; cancel does not share', () => {
    const onConfirm = jest.fn();
    const onCancel = jest.fn();
    const { unmount } = render(<SharePrivateDataDialog open onConfirm={onConfirm} onCancel={onCancel} t={t} />);
    fireEvent.click(screen.getByRole('button', { name: t.cancel }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    unmount();
    render(<SharePrivateDataDialog open onConfirm={onConfirm} onCancel={onCancel} t={t} />);
    fireEvent.click(screen.getByRole('button', { name: t.confirm }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  test('dialog text is the private-data warning', () => {
    render(<SharePrivateDataDialog open onConfirm={jest.fn()} onCancel={jest.fn()} t={t} />);
    expect(screen.getByText(t.privateDataWarning)).toBeInTheDocument();
  });

  test('renders nothing when closed', () => {
    render(<SharePrivateDataDialog open={false} onConfirm={jest.fn()} onCancel={jest.fn()} t={t} />);
    expect(screen.queryByText(t.privateDataWarning)).toBeNull();
  });
});
