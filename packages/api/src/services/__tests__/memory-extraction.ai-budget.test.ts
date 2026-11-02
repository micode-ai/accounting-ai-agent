import { AIMemoryExtractionService } from '../ai-memory/memory-extraction.service';
import type { AIMemoryService } from '../ai-memory/ai-memory.service';

jest.mock('../../utils/logger', () => ({ logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

function setup() {
  const prisma = {
    aIToolUsage: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      groupBy: jest.fn().mockResolvedValue([]),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
  const memoryService = { upsertMemory: jest.fn().mockResolvedValue(undefined) };
  const svc = new AIMemoryExtractionService(memoryService as unknown as AIMemoryService, prisma as never);
  return { prisma, memoryService, svc };
}

describe('AIMemoryExtractionService and AI Budget tools', () => {
  test('AI Budget tool names are not tracked and preference extraction is skipped for that exchange', async () => {
    const { prisma, memoryService, svc } = setup();
    await svc.extractFromConversation('u1', 'c1', 'I prefer lunch at Bistro', 'resp', ['ai_budget_get_expenses', 'get_invoices'], 'en');
    expect(prisma.aIToolUsage.createMany).toHaveBeenCalledWith({ data: [expect.objectContaining({ toolName: 'get_invoices' })] });
    expect(memoryService.upsertMemory).not.toHaveBeenCalled();
  });

  test('an exchange that used only AI Budget tools tracks nothing', async () => {
    const { prisma, memoryService, svc } = setup();
    await svc.extractFromConversation('u1', 'c1', 'I prefer lunch at Bistro', 'resp', ['ai_budget_list_accounts'], 'en');
    expect(prisma.aIToolUsage.createMany).not.toHaveBeenCalled();
    expect(memoryService.upsertMemory).not.toHaveBeenCalled();
  });

  test('without AI Budget tools the explicit preference is still extracted', async () => {
    const { prisma, memoryService, svc } = setup();
    await svc.extractFromConversation('u1', 'c1', 'I prefer lunch at Bistro', 'resp', ['get_invoices'], 'en');
    expect(prisma.aIToolUsage.createMany).toHaveBeenCalledTimes(1);
    expect(memoryService.upsertMemory).toHaveBeenCalledWith('u1', expect.objectContaining({ source: 'explicit' }));
  });
});
