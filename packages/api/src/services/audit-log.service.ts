import { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger';

const SENSITIVE_FIELDS = [
  'password',
  'passwordhash',
  'token',
  'refreshtoken',
  'accesskey',
  'secretkey',
  'apikey',
  'llmapikey',
  'wfirmaaccesskey',
  'wfirmasecretkey',
  'authorization',
  'secret',
  // OAuth (AI Budget completion and token responses)
  'code',
  'state',
  'code_verifier',
  'codeverifier',
  'refresh_token',
  'access_token',
  'accesstoken',
];

function sanitizeChanges(body: unknown): unknown {
  if (!body || typeof body !== 'object') return body;
  if (Array.isArray(body)) return body.map(sanitizeChanges);

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (SENSITIVE_FIELDS.includes(key.toLowerCase())) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = sanitizeChanges(value);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

export interface CreateAuditLogData {
  userId?: string;
  action: string;
  entity: string;
  entityId?: string;
  changes?: unknown;
  ip?: string;
  userAgent?: string;
}

export interface GetAuditLogsParams {
  page?: number;
  limit?: number;
  userId?: string;
  action?: string;
  entity?: string;
  dateFrom?: string;
  dateTo?: string;
}

export interface AuditLogEntry {
  id: string;
  userId: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  changes: unknown;
  ip: string | null;
  userAgent: string | null;
  createdAt: Date;
  user: { email: string; firstName: string | null; lastName: string | null } | null;
}

export class AuditLogService {
  constructor(private prisma: PrismaClient) {}

  async create(data: CreateAuditLogData): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          userId: data.userId ?? null,
          action: data.action,
          entity: data.entity,
          entityId: data.entityId ?? null,
          changes: data.changes ? (sanitizeChanges(data.changes) as any) : null,
          ip: data.ip ?? null,
          userAgent: data.userAgent ?? null,
        },
      });
    } catch (error) {
      logger.error('AuditLogService.create failed', { error, data: { action: data.action, entity: data.entity } });
    }
  }

  async getAll(params: GetAuditLogsParams): Promise<{ logs: AuditLogEntry[]; total: number }> {
    const { page = 1, limit = 50, userId, action, entity, dateFrom, dateTo } = params;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (userId) where.userId = userId;
    if (action) where.action = { contains: action, mode: 'insensitive' };
    if (entity) where.entity = entity;
    if (dateFrom || dateTo) {
      where.createdAt = {};
      if (dateFrom) where.createdAt.gte = new Date(dateFrom);
      if (dateTo) where.createdAt.lte = new Date(dateTo);
    }

    const [logs, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          userId: true,
          action: true,
          entity: true,
          entityId: true,
          changes: true,
          ip: true,
          userAgent: true,
          createdAt: true,
          user: {
            select: {
              email: true,
              firstName: true,
              lastName: true,
            },
          },
        },
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return { logs: logs as AuditLogEntry[], total };
  }
}
