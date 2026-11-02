import { AuditLogService } from '../audit-log.service';

test('OAuth fields of the AI Budget completion are never stored in the audit log', async () => {
  const create = jest.fn().mockResolvedValue({});
  const svc = new AuditLogService({ auditLog: { create } } as never);
  await svc.create({
    action: 'create', entity: 'integrations',
    changes: { code: 'auth-code', state: 'st', code_verifier: 'v', refresh_token: 'rt', access_token: 'at', keep: 'visible' },
  });
  const changes = create.mock.calls[0][0].data.changes;
  expect(changes).toEqual({
    code: '[REDACTED]', state: '[REDACTED]', code_verifier: '[REDACTED]', refresh_token: '[REDACTED]', access_token: '[REDACTED]', keep: 'visible',
  });
});
