'use client';

import React from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogBody, DialogFooter } from '@/components/ui/dialog';

export interface SharePrivateDataDialogTranslations {
  privateDataWarning: string;
  confirm: string;
  cancel: string;
}

interface SharePrivateDataDialogProps {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  t: SharePrivateDataDialogTranslations;
}

export function SharePrivateDataDialog({ open, onConfirm, onCancel, t }: SharePrivateDataDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <DialogContent>
        <DialogBody>
          <p className="text-sm text-gray-700 dark:text-gray-200 pr-6">{t.privateDataWarning}</p>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>{t.cancel}</Button>
          <Button onClick={onConfirm}>{t.confirm}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
