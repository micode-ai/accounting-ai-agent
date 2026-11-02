jest.mock('../../../lib/prisma', () => ({ prisma: { telegramLink: { update: jest.fn() } } }));
jest.mock('../../../utils/logger', () => ({ logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

import { AIChatRouter } from '../ai-chat-router';
import type { AIChatService } from '../../ai-chat/ai-chat.service';

function setup(chatType: string) {
  const svc = {
    createConversation: jest.fn(),
    sendMessage: jest.fn().mockResolvedValue({ assistantMessage: { content: 'ok' } }),
  };
  const ctx = { chat: { type: chatType }, message: { text: 'how much did I spend?' }, sendChatAction: jest.fn(), reply: jest.fn() };
  const router = new AIChatRouter(svc as unknown as AIChatService);
  return { svc, ctx, router };
}

const link = { id: 'l1', userId: 'u1', activeConversationId: 'c1' };

test('a private chat with the bot sees every AI Budget account', async () => {
  const { svc, ctx, router } = setup('private');
  await router.route(ctx as never, link);
  expect(svc.sendMessage).toHaveBeenCalledWith('c1', 'u1', 'how much did I spend?', undefined, { aiBudgetCompanyOnly: false });
});

test.each(['group', 'supergroup', 'channel'])('a %s chat runs with the company-only AI Budget scope', async (type) => {
  const { svc, ctx, router } = setup(type);
  await router.route(ctx as never, link);
  expect(svc.sendMessage).toHaveBeenCalledWith('c1', 'u1', 'how much did I spend?', undefined, { aiBudgetCompanyOnly: true });
});

test('an unknown chat type fails closed to company-only', async () => {
  const { svc, ctx, router } = setup('private');
  (ctx as { chat?: unknown }).chat = undefined;
  await router.route(ctx as never, link);
  expect(svc.sendMessage.mock.calls[0][4]).toEqual({ aiBudgetCompanyOnly: true });
});
