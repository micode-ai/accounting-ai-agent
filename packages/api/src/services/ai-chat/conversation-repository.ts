import { PrismaClient, AIConversation } from '@prisma/client';
import { logger } from '../../utils/logger';
import {
  ChatMessage,
  AIConversationData,
  ConversationListItem,
  ConversationGraphState,
} from '../../types/ai-chat.types';
import { generateConversationTitle } from './utils';

export class ConversationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Find a conversation by ID with authorization:
   * - owner access, OR
   * - shared access for active members of the same organization
   */
  async findAuthorized(conversationId: string, userId: string): Promise<AIConversation | null> {
    const own = await this.prisma.aIConversation.findFirst({
      where: { id: conversationId, userId, deletedAt: null },
    });
    if (own) return own;

    const shared = await this.prisma.aIConversation.findFirst({
      where: { id: conversationId, isShared: true, deletedAt: null },
    });
    if (!shared?.organizationId) return null;

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { organizationId: true, orgMembershipStatus: true },
    });

    if (user?.organizationId === shared.organizationId && user.orgMembershipStatus === 'active') {
      return shared;
    }
    return null;
  }

  async create(userId: string, title?: string): Promise<AIConversation> {
    const conversation = await this.prisma.aIConversation.create({
      data: {
        userId,
        title: title || generateConversationTitle(),
        messages: [] as any,
        graphState: {} as any,
      },
    });
    logger.info('Created new conversation', { conversationId: conversation.id, userId });
    return conversation;
  }

  async list(userId: string, limit: number = 50, query?: string): Promise<ConversationListItem[]> {
    const rows = await this.prisma.aIConversation.findMany({
      where: {
        userId,
        deletedAt: null,
        ...(query ? { title: { contains: query, mode: 'insensitive' } } : {}),
      },
      orderBy: { updatedAt: 'desc' },
      take: limit,
    });

    return rows.map(conv => {
      const messages = (conv.messages as any[]) as ChatMessage[];
      const last = [...messages].reverse().find(m => m.role === 'user');
      return {
        id: conv.id,
        title: conv.title,
        topic: conv.topic || undefined,
        lastMessage: last?.content?.substring(0, 100),
        messageCount: messages.filter(m => m.role !== 'system').length,
        containsPrivateAiBudgetData: conv.containsPrivateAiBudgetData || undefined,
        createdAt: conv.createdAt,
        updatedAt: conv.updatedAt,
      };
    });
  }

  async getWithMessages(conversationId: string, userId: string): Promise<AIConversationData | null> {
    const conv = await this.findAuthorized(conversationId, userId);
    if (!conv) return null;

    const messages = (conv.messages as any[]) as ChatMessage[];

    let ownerName: string | undefined;
    if (conv.isShared) {
      const owner = await this.prisma.user.findUnique({
        where: { id: conv.userId },
        select: { firstName: true, lastName: true },
      });
      ownerName = owner
        ? [owner.firstName, owner.lastName].filter(Boolean).join(' ') || undefined
        : undefined;
    }

    return {
      id: conv.id,
      userId: conv.userId,
      title: conv.title,
      topic: conv.topic || undefined,
      messages,
      graphState: conv.graphState as ConversationGraphState,
      isShared: conv.isShared || undefined,
      organizationId: conv.organizationId || undefined,
      ownerName,
      containsPrivateAiBudgetData: conv.containsPrivateAiBudgetData || undefined,
      createdAt: conv.createdAt,
      updatedAt: conv.updatedAt,
      deletedAt: conv.deletedAt || undefined,
    };
  }

  async listShared(userId: string, limit: number = 50): Promise<ConversationListItem[]> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { organizationId: true, orgMembershipStatus: true },
    });

    if (!user?.organizationId || user.orgMembershipStatus !== 'active') return [];

    const rows = await this.prisma.aIConversation.findMany({
      where: { organizationId: user.organizationId, isShared: true, deletedAt: null },
      orderBy: { updatedAt: 'desc' },
      take: limit,
      include: { user: { select: { firstName: true, lastName: true } } },
    });

    return rows.map(conv => {
      const messages = (conv.messages as any[]) as ChatMessage[];
      const last = [...messages].reverse().find(m => m.role === 'user');
      const ownerName = [conv.user.firstName, conv.user.lastName].filter(Boolean).join(' ') || undefined;
      return {
        id: conv.id,
        title: conv.title,
        topic: conv.topic || undefined,
        lastMessage: last?.content?.substring(0, 100),
        messageCount: messages.filter(m => m.role !== 'system').length,
        isShared: true,
        ownerName,
        containsPrivateAiBudgetData: conv.containsPrivateAiBudgetData || undefined,
        createdAt: conv.createdAt,
        updatedAt: conv.updatedAt,
      };
    });
  }

  async share(conversationId: string, userId: string): Promise<void> {
    const conv = await this.prisma.aIConversation.findFirst({
      where: { id: conversationId, userId, deletedAt: null },
    });
    if (!conv) throw new Error('Conversation not found');

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { organizationId: true, orgMembershipStatus: true },
    });
    if (!user?.organizationId || user.orgMembershipStatus !== 'active') {
      throw new Error('User does not belong to an organization');
    }

    await this.prisma.aIConversation.update({
      where: { id: conversationId },
      data: { isShared: true, organizationId: user.organizationId, sharedAt: new Date() },
    });
    logger.info('Conversation shared', { conversationId, userId, orgId: user.organizationId });
  }

  async unshare(conversationId: string, userId: string): Promise<void> {
    const conv = await this.prisma.aIConversation.findFirst({
      where: { id: conversationId, userId, deletedAt: null },
    });
    if (!conv) throw new Error('Conversation not found');

    await this.prisma.aIConversation.update({
      where: { id: conversationId },
      data: { isShared: false, sharedAt: null },
    });
    logger.info('Conversation unshared', { conversationId, userId });
  }

  async softDelete(conversationId: string, userId: string): Promise<void> {
    const conv = await this.findAuthorized(conversationId, userId);
    if (!conv) throw new Error('Conversation not found');

    await this.prisma.aIConversation.update({
      where: { id: conversationId },
      data: { deletedAt: new Date() },
    });
    logger.info('Conversation deleted', { conversationId, userId });
  }

  async updateMessages(conversationId: string, messages: ChatMessage[], title: string): Promise<void> {
    await this.prisma.aIConversation.update({
      where: { id: conversationId },
      data: { title, messages: messages as any, updatedAt: new Date() },
    });
  }

  /** Set once an AI Budget tool put private or other-business data into the thread; never cleared. */
  async markContainsPrivateAiBudgetData(conversationId: string): Promise<void> {
    await this.prisma.aIConversation.update({
      where: { id: conversationId },
      data: { containsPrivateAiBudgetData: true },
    });
  }

  async getUserDisplayName(userId: string): Promise<string | undefined> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { firstName: true, lastName: true },
    });
    return user ? [user.firstName, user.lastName].filter(Boolean).join(' ') || undefined : undefined;
  }
}
