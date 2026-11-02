'use client';

import { useState, useCallback, useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import axios, { AxiosError } from 'axios';
import { API_URL } from '@/lib/config';

// Extract a readable error message from axios errors
function extractErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const axiosError = error as AxiosError<{ message?: string }>;
    // Use backend error message if available
    if (axiosError.response?.data?.message) {
      return axiosError.response.data.message;
    }
    // Network error (backend unreachable)
    if (axiosError.code === 'ERR_NETWORK' || !axiosError.response) {
      return 'NETWORK_ERROR';
    }
    return axiosError.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'UNKNOWN_ERROR';
}

// ============================================
// TYPES
// ============================================

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: string;
  authorId?: string;
  authorName?: string;
  toolCalls?: {
    id: string;
    name: string;
    arguments: string;
  }[];
  metadata?: {
    model?: string;
    provider?: string;
    tokens?: {
      prompt: number;
      completion: number;
    };
  };
}

export interface TTSMetadata {
  locale: 'en' | 'pl' | 'ru';
  audioBase64?: string;
  skipped?: boolean;
  skipReason?: 'disabled' | 'code_heavy' | 'table_content' | 'no_api_key' | 'error';
}

export interface Conversation {
  id: string;
  title: string;
  topic?: string;
  lastMessage?: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  isShared?: boolean;
  containsPrivateAiBudgetData?: boolean;
  ownerName?: string;
}

export interface ConversationDetail {
  id: string;
  userId: string;
  title: string;
  topic?: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
  isShared?: boolean;
  containsPrivateAiBudgetData?: boolean;
  organizationId?: string;
  ownerName?: string;
}

// ============================================
// API FUNCTIONS
// ============================================

const getAuthHeaders = () => {
  const token = localStorage.getItem('token');
  return {
    Authorization: `Bearer ${token}`,
  };
};

const fetchConversations = async (): Promise<Conversation[]> => {
  const response = await axios.get(`${API_URL}/api/ai/conversations`, {
    headers: getAuthHeaders(),
  });
  return response.data.data;
};

const fetchConversation = async (id: string): Promise<ConversationDetail> => {
  const response = await axios.get(`${API_URL}/api/ai/conversations/${id}`, {
    headers: getAuthHeaders(),
  });
  return response.data.data;
};

const createConversation = async (title?: string): Promise<{ id: string; title: string }> => {
  const response = await axios.post(
    `${API_URL}/api/ai/conversations`,
    { title },
    { headers: getAuthHeaders() }
  );
  return response.data.data;
};

const sendMessage = async (
  conversationId: string,
  content: string,
  provider?: 'openai' | 'google',
  ttsEnabled?: boolean
): Promise<{
  userMessage: ChatMessage;
  assistantMessage: ChatMessage;
  toolsUsed?: string[];
  tts?: TTSMetadata;
}> => {
  const response = await axios.post(
    `${API_URL}/api/ai/conversations/${conversationId}/messages`,
    { content, provider, ttsEnabled },
    { headers: getAuthHeaders() }
  );
  return response.data.data;
};

const deleteConversation = async (id: string): Promise<void> => {
  await axios.delete(`${API_URL}/api/ai/conversations/${id}`, {
    headers: getAuthHeaders(),
  });
};

const fetchSharedConversations = async (): Promise<Conversation[]> => {
  const response = await axios.get(`${API_URL}/api/ai/conversations/shared`, {
    headers: getAuthHeaders(),
  });
  return response.data.data;
};

const shareConversation = async (id: string): Promise<void> => {
  await axios.post(`${API_URL}/api/ai/conversations/${id}/share`, {}, {
    headers: getAuthHeaders(),
  });
};

const unshareConversation = async (id: string): Promise<void> => {
  await axios.post(`${API_URL}/api/ai/conversations/${id}/unshare`, {}, {
    headers: getAuthHeaders(),
  });
};

// ============================================
// HOOK
// ============================================

export function useChat() {
  const queryClient = useQueryClient();
  const [currentConversationId, setCurrentConversationId] = useState<string | null>(null);
  const [pendingMessage, setPendingMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [latestTTS, setLatestTTS] = useState<TTSMetadata | null>(null);

  // Fetch conversations list
  const {
    data: conversations = [],
    isLoading: isLoadingConversations,
    refetch: refetchConversations,
  } = useQuery({
    queryKey: ['conversations'],
    queryFn: fetchConversations,
  });

  // Fetch current conversation details
  // Poll shared conversations every 5s so other members see new messages in real time
  const {
    data: currentConversation,
    isLoading: isLoadingConversation,
  } = useQuery({
    queryKey: ['conversation', currentConversationId],
    queryFn: () => fetchConversation(currentConversationId!),
    enabled: !!currentConversationId,
    refetchInterval: (query) => {
      const data = query.state.data;
      return data?.isShared ? 5000 : false;
    },
  });

  // Create conversation mutation
  const createConversationMutation = useMutation({
    mutationFn: (title?: string) => createConversation(title),
    onSuccess: (data) => {
      setCurrentConversationId(data.id);
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
    },
  });

  // Send message mutation
  const sendMessageMutation = useMutation({
    mutationFn: ({
      conversationId,
      content,
      provider,
      ttsEnabled,
    }: {
      conversationId: string;
      content: string;
      provider?: 'openai' | 'google';
      ttsEnabled?: boolean;
    }) => sendMessage(conversationId, content, provider, ttsEnabled),
    onMutate: async ({ content }) => {
      // Optimistic update: show user message immediately
      setPendingMessage(content);
      setErrorMessage(null);
    },
    onSuccess: (data) => {
      setPendingMessage(null);
      // Store TTS data from response (for backend TTS integration)
      if (data.tts) {
        setLatestTTS(data.tts);
      }
      // Refetch conversation to get updated messages
      queryClient.invalidateQueries({ queryKey: ['conversation', currentConversationId] });
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
      // Refresh usage data (wFirma/AI message counters may have changed)
      queryClient.invalidateQueries({ queryKey: ['subscription-usage'] });
    },
    onError: (error) => {
      setPendingMessage(null);
      setErrorMessage(extractErrorMessage(error));
    },
  });

  // Fetch shared conversations (poll every 10s to show new shared chats)
  const {
    data: sharedConversations = [],
  } = useQuery({
    queryKey: ['shared-conversations'],
    queryFn: fetchSharedConversations,
    refetchInterval: 10000,
  });

  // Share conversation mutation
  const shareConversationMutation = useMutation({
    mutationFn: shareConversation,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
      queryClient.invalidateQueries({ queryKey: ['shared-conversations'] });
      queryClient.invalidateQueries({ queryKey: ['conversation', currentConversationId] });
    },
  });

  // Unshare conversation mutation
  const unshareConversationMutation = useMutation({
    mutationFn: unshareConversation,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
      queryClient.invalidateQueries({ queryKey: ['shared-conversations'] });
      queryClient.invalidateQueries({ queryKey: ['conversation', currentConversationId] });
    },
  });

  // Delete conversation mutation
  const deleteConversationMutation = useMutation({
    mutationFn: deleteConversation,
    onSuccess: (_, deletedId) => {
      // Remove cached conversation data so stale messages don't linger
      queryClient.removeQueries({ queryKey: ['conversation', deletedId] });
      if (currentConversationId === deletedId) {
        setCurrentConversationId(null);
      }
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
    },
  });

  // Auto-select first conversation or create new one
  useEffect(() => {
    if (!currentConversationId && conversations.length > 0 && !isLoadingConversations) {
      setCurrentConversationId(conversations[0].id);
    }
  }, [conversations, currentConversationId, isLoadingConversations]);

  // Send message handler
  const handleSendMessage = useCallback(
    async (content: string, provider?: 'openai' | 'google', ttsEnabled?: boolean) => {
      if (!content.trim()) return;

      // If no conversation, create one first
      if (!currentConversationId) {
        const newConv = await createConversationMutation.mutateAsync(undefined);
        sendMessageMutation.mutate({
          conversationId: newConv.id,
          content,
          provider,
          ttsEnabled,
        });
      } else {
        sendMessageMutation.mutate({
          conversationId: currentConversationId,
          content,
          provider,
          ttsEnabled,
        });
      }
    },
    [currentConversationId, createConversationMutation, sendMessageMutation]
  );

  // Create new conversation handler
  const handleCreateConversation = useCallback(async () => {
    await createConversationMutation.mutateAsync(undefined);
  }, [createConversationMutation]);

  // Select conversation handler
  const handleSelectConversation = useCallback((id: string) => {
    setCurrentConversationId(id);
  }, []);

  // Delete conversation handler
  const handleDeleteConversation = useCallback(
    async (id: string) => {
      await deleteConversationMutation.mutateAsync(id);
    },
    [deleteConversationMutation]
  );

  // Share conversation handler
  const handleShareConversation = useCallback(
    async (id: string) => {
      await shareConversationMutation.mutateAsync(id);
    },
    [shareConversationMutation]
  );

  // Unshare conversation handler
  const handleUnshareConversation = useCallback(
    async (id: string) => {
      await unshareConversationMutation.mutateAsync(id);
    },
    [unshareConversationMutation]
  );

  // Get messages with pending message (empty when no conversation selected)
  const messages = currentConversationId ? (currentConversation?.messages || []) : [];
  const allMessages = pendingMessage
    ? [
        ...messages,
        {
          id: 'pending-user',
          role: 'user' as const,
          content: pendingMessage,
          timestamp: new Date().toISOString(),
        },
      ]
    : messages;

  return {
    // State
    conversations,
    currentConversation,
    currentConversationId,
    messages: allMessages,
    sharedConversations,

    // Loading states
    isLoading: sendMessageMutation.isPending,
    isLoadingConversations,
    isLoadingConversation,
    isCreatingConversation: createConversationMutation.isPending,

    // Error states
    error: sendMessageMutation.error,
    errorMessage,
    clearError: () => setErrorMessage(null),

    // TTS data from backend (LangChain integrated)
    latestTTS,
    clearTTS: () => setLatestTTS(null),

    // Actions
    sendMessage: handleSendMessage,
    createConversation: handleCreateConversation,
    selectConversation: handleSelectConversation,
    deleteConversation: handleDeleteConversation,
    shareConversation: handleShareConversation,
    unshareConversation: handleUnshareConversation,
    refetchConversations,
  };
}
