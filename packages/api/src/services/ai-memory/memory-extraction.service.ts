import { PrismaClient } from '@prisma/client';
import { logger } from '../../utils/logger';
import { Locale } from '../../i18n';
import { AIMemoryService } from './ai-memory.service';
import { sanitizeForPrompt } from '../ai-chat/utils';
import { isAiBudgetTool } from '../ai-chat/tools/ai-budget.tools';

// ============================================
// TYPES
// ============================================

interface ToolCallInfo {
  name: string;
  arguments?: Record<string, unknown>;
}

// Threshold for creating frequent_entity memories
const FREQUENCY_THRESHOLD = 3;

// Patterns for explicit preference extraction (multilingual)
// NOTE: \b does NOT work with Cyrillic/Polish characters in JS regex
// because \b relies on \w which only matches [a-zA-Z0-9_].
// For non-ASCII languages we use (?:^|[\s,.!?;:]) as word boundary.
// All patterns use capture group 1 for the full extracted phrase.
const WB = '(?:^|[\\s,.!?;:])'; // word boundary for Cyrillic/Polish
const PREFERENCE_PATTERNS: Array<{ pattern: RegExp; category: 'user_preference' | 'business_fact' }> = [
  // English (\b works fine for ASCII)
  { pattern: /\b((?:i always|i prefer|by default|my usual|i typically|i normally)\s.{5,100})/i, category: 'user_preference' },
  { pattern: /\b((?:my company|our company|we use|our nip|my nip|our business)\s.{5,100})/i, category: 'business_fact' },
  // Polish
  { pattern: new RegExp(`${WB}((?:zawsze|preferuję|domyślnie|zwykle|zazwyczaj|wolę)\\s.{5,100})`, 'i'), category: 'user_preference' },
  { pattern: new RegExp(`${WB}((?:moja firma|nasza firma|używamy|nasz nip|mój nip|nasz biznes)\\s.{5,100})`, 'i'), category: 'business_fact' },
  // Russian
  { pattern: new RegExp(`${WB}((?:я всегда|я предпочитаю|по умолчанию|обычно|как правило)\\s.{5,100})`, 'i'), category: 'user_preference' },
  { pattern: new RegExp(`${WB}((?:моя компания|наша компания|мы используем|наш нип|мой бизнес)\\s.{5,100})`, 'i'), category: 'business_fact' },
];

// Tool categories for workflow pattern detection
const TOOL_CATEGORIES: Record<string, string> = {
  get_contractors: 'contractors',
  create_contractor: 'contractors',
  update_contractor: 'contractors',
  delete_contractor: 'contractors',
  get_invoices: 'invoices',
  get_invoice_details: 'invoices',
  create_invoice: 'invoices',
  update_invoice: 'invoices',
  delete_invoice: 'invoices',
  send_invoice: 'invoices',
  get_payments: 'payments',
  get_payment_details: 'payments',
  add_payment: 'payments',
  get_expenses: 'expenses',
  get_expense_details: 'expenses',
  get_financial_summary: 'financial',
  get_company_info: 'company',
  get_employees: 'hr',
  get_employee_details: 'hr',
  calculate_payroll: 'payroll',
  save_payroll_record: 'payroll',
  get_vehicles: 'vehicles',
  send_to_ksef: 'ksef',
  check_ksef_status: 'ksef',
};

// ============================================
// MEMORY EXTRACTION SERVICE
// ============================================

export class AIMemoryExtractionService {
  constructor(
    private readonly memoryService: AIMemoryService,
    private readonly prisma: PrismaClient
  ) {}

  /**
   * Extract memories from a conversation exchange (fire-and-forget)
   */
  async extractFromConversation(
    userId: string,
    conversationId: string,
    userMessage: string,
    _assistantResponse: string,
    toolsUsed: string[],
    _locale: Locale
  ): Promise<void> {
    try {
      // AI Budget data never reaches AI memory: its tool names are not tracked, and an exchange that
      // used one is not mined for preferences (the message may be about private spending).
      const usedAiBudget = toolsUsed.some(isAiBudgetTool);
      const trackedTools = usedAiBudget ? toolsUsed.filter(name => !isAiBudgetTool(name)) : toolsUsed;

      // Strategy 1: Track tool usage
      if (trackedTools.length > 0) {
        await this.trackToolUsage(userId, conversationId, trackedTools);
      }

      // Strategy 2: Extract explicit preferences from user message
      if (!usedAiBudget) {
        await this.extractExplicitPreferences(userId, conversationId, userMessage);
      }

      // Strategy 3: Analyze tool patterns (runs periodically)
      await this.analyzeToolPatterns(userId, conversationId);
    } catch (err) {
      logger.warn('Memory extraction failed', { err, userId, conversationId });
    }
  }

  /**
   * Record tool calls for pattern analysis
   */
  async trackToolUsage(
    userId: string,
    conversationId: string,
    toolsUsed: string[],
    toolArguments?: ToolCallInfo[]
  ): Promise<void> {
    const records = toolsUsed.map((toolName, i) => ({
      userId,
      toolName,
      arguments: (toolArguments?.[i]?.arguments as any) ?? undefined,
      conversationId,
    }));

    await this.prisma.aIToolUsage.createMany({ data: records });

    logger.debug('Tool usage tracked', { userId, tools: toolsUsed });
  }

  /**
   * Extract explicit preferences from user message using pattern matching
   */
  private async extractExplicitPreferences(
    userId: string,
    conversationId: string,
    userMessage: string
  ): Promise<void> {
    for (const { pattern, category } of PREFERENCE_PATTERNS) {
      const match = userMessage.match(pattern);
      if (match && match[1]) {
        const extracted = sanitizeForPrompt(match[1].trim(), 200);
        if (!extracted) continue;
        // Create a stable key from the first 50 chars
        const key = `${category}:${extracted.slice(0, 50).toLowerCase().replace(/[^a-zа-яёąćęłńóśźż0-9]+/gi, '_')}`;

        await this.memoryService.upsertMemory(userId, {
          category,
          source: 'explicit',
          key,
          value: extracted,
          confidence: 0.8, // Higher confidence for explicit statements
          conversationId,
        });

        logger.debug('Explicit preference extracted', { userId, category, key });
      }
    }
  }

  /**
   * Analyze tool usage patterns and create memories for frequent entities
   */
  private async analyzeToolPatterns(userId: string, conversationId: string): Promise<void> {
    // Analyze frequent tools
    const toolCounts = await this.prisma.aIToolUsage.groupBy({
      by: ['toolName'],
      where: { userId },
      _count: true,
      orderBy: { _count: { toolName: 'desc' } },
      take: 10,
    });

    for (const tc of toolCounts) {
      if (tc._count < FREQUENCY_THRESHOLD) continue;

      const category = TOOL_CATEGORIES[tc.toolName];
      if (!category) continue;

      const key = `frequent_tool:${tc.toolName}`;
      const confidence = Math.min(0.3 + tc._count * 0.05, 1.0);

      await this.memoryService.upsertMemory(userId, {
        category: 'workflow_pattern',
        source: 'tool_usage',
        key,
        value: `Frequently uses ${tc.toolName} (${tc._count} times) — ${category} operations`,
        metadata: { toolName: tc.toolName, count: tc._count, category },
        confidence,
        conversationId,
      });
    }

    // Analyze frequent contractor queries from tool arguments
    await this.analyzeContractorPatterns(userId, conversationId);
  }

  /**
   * Detect frequently queried contractors from tool arguments
   */
  private async analyzeContractorPatterns(userId: string, conversationId: string): Promise<void> {
    // Get recent contractor-related tool calls with arguments
    const contractorTools = await this.prisma.aIToolUsage.findMany({
      where: {
        userId,
        toolName: { in: ['get_contractors', 'get_invoice_details', 'create_invoice'] },
        arguments: { not: null as any },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    // Extract contractor names/NIPs from arguments
    const entityCounts = new Map<string, { count: number; name: string; nip?: string }>();

    for (const call of contractorTools) {
      const args = call.arguments as Record<string, unknown> | null;
      if (!args) continue;

      // Look for name or nip in arguments
      const name = (args.name || args.contractor_name || args.contractorName) as string | undefined;
      const nip = (args.nip || args.contractor_nip) as string | undefined;

      if (name) {
        const key = name.toLowerCase().trim();
        const current = entityCounts.get(key) || { count: 0, name, nip };
        current.count++;
        if (nip) current.nip = nip;
        entityCounts.set(key, current);
      }
    }

    // Create memories for frequently queried contractors
    for (const [, entity] of entityCounts) {
      if (entity.count < FREQUENCY_THRESHOLD) continue;

      const key = `contractor:${entity.name.toLowerCase().trim().replace(/\s+/g, '_')}`;
      const nipInfo = entity.nip ? ` (NIP: ${entity.nip})` : '';
      const confidence = Math.min(0.3 + entity.count * 0.1, 1.0);

      await this.memoryService.upsertMemory(userId, {
        category: 'frequent_entity',
        source: 'tool_usage',
        key,
        value: `Contractor "${entity.name}"${nipInfo} — queried ${entity.count} times`,
        metadata: { name: entity.name, nip: entity.nip, count: entity.count },
        confidence,
        conversationId,
      });
    }
  }
}
