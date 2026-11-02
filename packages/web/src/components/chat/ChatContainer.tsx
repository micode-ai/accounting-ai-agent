'use client';

import React, { useState, useEffect, useRef } from 'react';
import { MessageSquarePlus, X, DollarSign, Crown, AlertTriangle, FileCheck, LayoutDashboard, Brain, Building2, Gift, BookmarkCheck, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AppVersion } from '@/components/ui/app-version';
import Link from 'next/link';
import { useChat } from '@/hooks/useChat';
import { useAuth } from '@/contexts/AuthContext';
import { useAiBudgetStatus } from '@/hooks/useAiBudget';
import { useLocale } from '@/contexts/LocaleContext';
import { ConversationList } from './ConversationList';
import { MessageList } from './MessageList';
import { ChatInput } from './ChatInput';
import { ChatHeader } from './ChatHeader';
import { SharePrivateDataDialog } from './SharePrivateDataDialog';
import { WfirmaWelcomeModal } from '@/components/onboarding/WfirmaWelcomeModal';
import { markFirstLoginComplete } from '@/lib/api/auth';
import { CurrentPlanBadge, UsageWidget } from '@/components/subscription';
import { useSubscription } from '@/hooks/useSubscription';
import { TTSProvider, useAutoSpeak, useTTS } from '@/contexts/TTSContext';
import { AIMemoryPanel } from './AIMemoryPanel';
import { PromptShortcutsPanel } from './PromptShortcutsPanel';
import { TaxDeadlineNudges } from './TaxDeadlineNudges';
import { OrganizationPanel } from '@/components/organization/OrganizationPanel';
import { useTaxDeadlines } from '@/hooks/useTaxDeadlines';
import enTranslations from '@/i18n/locales/en.json';
import plTranslations from '@/i18n/locales/pl.json';
import ruTranslations from '@/i18n/locales/ru.json';

const translations = {
  en: enTranslations,
  pl: plTranslations,
  ru: ruTranslations,
};

function ChatContainerInner() {
  const {
    conversations,
    currentConversation,
    currentConversationId,
    messages,
    isLoading,
    isLoadingConversations,
    isLoadingConversation,
    isCreatingConversation,
    errorMessage,
    clearError,
    sendMessage,
    createConversation,
    selectConversation,
    deleteConversation,
    sharedConversations,
    latestTTS,
    clearTTS,
    shareConversation,
    unshareConversation,
  } = useChat();

  const { user } = useAuth();
  const aiBudgetAvailable = useAiBudgetStatus().data?.available === true;

  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [showWfirmaWelcome, setShowWfirmaWelcome] = useState(false);
  const [showSubscriptionWelcome, setShowSubscriptionWelcome] = useState(false);
  const [showMemoryPanel, setShowMemoryPanel] = useState(false);
  const [showOrgPanel, setShowOrgPanel] = useState(false);
  const [showShortcutsPanel, setShowShortcutsPanel] = useState(false);
  const [shortcutPrefill, setShortcutPrefill] = useState<string | undefined>(undefined);
  const { locale, setLocale } = useLocale();
  const [shareWarningOpen, setShareWarningOpen] = useState(false);
  const t = translations[locale].chat;
  const onboardingTranslations = translations[locale].onboarding;
  const { isPro, isLoading: isLoadingSubscription } = useSubscription();
  const { deadlines: taxDeadlines, isLoading: isLoadingTaxDeadlines } = useTaxDeadlines(locale);

  // Auto-speak functionality for new AI messages
  const { triggerAutoSpeak, shouldAutoSpeak } = useAutoSpeak();
  const { ttsEnabled } = useTTS();
  const lastMessageIdRef = useRef<string | null>(null);
  const wasLoadingRef = useRef(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Auto-speak when a new AI message arrives (after loading completes)
  // Now integrated with LangChain - uses backend TTS when available
  useEffect(() => {
    if (!shouldAutoSpeak) return;

    // Track loading state transitions
    if (isLoading) {
      wasLoadingRef.current = true;
      return;
    }

    // When loading completes and we were loading before
    if (wasLoadingRef.current && messages.length > 0) {
      wasLoadingRef.current = false;
      const lastMessage = messages[messages.length - 1];

      // Only speak new assistant messages
      if (
        lastMessage.role === 'assistant' &&
        lastMessage.id !== lastMessageIdRef.current
      ) {
        lastMessageIdRef.current = lastMessage.id;

        // Use backend TTS (LangChain integrated) if available
        if (latestTTS?.audioBase64 && !latestTTS.skipped) {
          try {
            // Stop any currently playing audio
            if (audioRef.current) {
              audioRef.current.pause();
              audioRef.current = null;
            }

            // Play backend-generated audio
            const audio = new Audio(`data:audio/mpeg;base64,${latestTTS.audioBase64}`);
            audioRef.current = audio;
            audio.play().catch(err => {
              console.warn('Failed to play backend TTS audio:', err);
              // Fallback to browser TTS
              triggerAutoSpeak(lastMessage.content, lastMessage.id);
            });

            // Clear TTS data after playing
            clearTTS();
          } catch (error) {
            console.warn('Backend TTS playback error:', error);
            // Fallback to browser TTS
            triggerAutoSpeak(lastMessage.content, lastMessage.id);
            clearTTS();
          }
        } else if (!latestTTS?.skipped) {
          // Fallback to browser TTS (when backend TTS not available)
          triggerAutoSpeak(lastMessage.content, lastMessage.id);
          if (latestTTS) clearTTS();
        } else {
          // TTS was skipped (code-heavy, tables, etc.) - clear it
          if (latestTTS) clearTTS();
        }
      }
    }
  }, [messages, isLoading, shouldAutoSpeak, triggerAutoSpeak, latestTTS, clearTTS]);

  // Check for wFirma welcome modal flag on mount
  useEffect(() => {
    const shouldShowWfirmaWelcome = localStorage.getItem('showWfirmaWelcome');
    if (shouldShowWfirmaWelcome === 'true') {
      setShowWfirmaWelcome(true);
    }
  }, []);

  // Check for subscription welcome banner flag on mount (for Free users)
  useEffect(() => {
    if (!isLoadingSubscription && !isPro) {
      const hasSeenSubscriptionWelcome = localStorage.getItem('hasSeenSubscriptionWelcome');
      if (!hasSeenSubscriptionWelcome) {
        setShowSubscriptionWelcome(true);
      }
    }
  }, [isPro, isLoadingSubscription]);

  const handleWfirmaWelcomeClose = async () => {
    setShowWfirmaWelcome(false);
    localStorage.removeItem('showWfirmaWelcome');
    // Mark first login as complete on the server
    try {
      await markFirstLoginComplete();
    } catch (error) {
      console.error('Failed to mark first login complete:', error);
    }
  };

  const handleSubscriptionWelcomeClose = () => {
    setShowSubscriptionWelcome(false);
    localStorage.setItem('hasSeenSubscriptionWelcome', 'true');
  };

  const handleSendMessage = async (content: string) => {
    await sendMessage(content, undefined, ttsEnabled);
  };

  const handleNudgeClick = (prompt: string) => {
    setIsSidebarOpen(false);
    sendMessage(prompt, undefined, ttsEnabled);
  };

  const handleNewChat = async () => {
    await createConversation();
    setIsSidebarOpen(false);
  };

  const handleSelectConversation = (id: string) => {
    selectConversation(id);
    setIsSidebarOpen(false);
  };

  return (
    <div className="flex fixed inset-0 bg-gray-50 dark:bg-gray-900">
      {/* Mobile sidebar overlay */}
      {isSidebarOpen && (
        <div
          className="fixed inset-0 bg-black bg-opacity-50 z-20 lg:hidden"
          onClick={() => setIsSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <div
        className={`
          fixed lg:static inset-y-0 left-0 z-30
          w-72 bg-white dark:bg-gray-800 border-r border-gray-200 dark:border-gray-700
          transform transition-transform duration-300 ease-in-out
          ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
        `}
      >
        <div className="flex flex-col h-full">
          {/* Sidebar header */}
          <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{t.sidebar.title}</h2>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleNewChat}
                disabled={isCreatingConversation}
                className="text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
              >
                <MessageSquarePlus className="w-5 h-5" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setIsSidebarOpen(false)}
                className="lg:hidden"
              >
                <X className="w-5 h-5" />
              </Button>
            </div>
          </div>

          {/* Conversation list */}
          <div className="flex-1 overflow-y-auto">
            <ConversationList
              conversations={conversations}
              sharedConversations={sharedConversations}
              currentId={currentConversationId}
              onSelect={handleSelectConversation}
              onDelete={deleteConversation}
              isLoading={isLoadingConversations}
              translations={t.sidebar}
              sharedTranslations={t.shared}
            />
          </div>

          {/* Tax deadline nudges */}
          <div className="border-t border-gray-200 dark:border-gray-700">
            <TaxDeadlineNudges
              deadlines={taxDeadlines}
              isLoading={isLoadingTaxDeadlines}
              translations={t.taxDeadlineNudges}
              onNudgeClick={handleNudgeClick}
            />
          </div>

          {/* Sidebar footer with Plan, Usage, AI Costs link, and Version */}
          <div className="mt-auto px-4 bg-gray-50 dark:bg-gray-900/50 border-t border-gray-200 dark:border-gray-700">
            {/* Current Plan Badge */}
            <div className="py-3 border-b border-gray-200 dark:border-gray-700">
              <Link href="/subscription" className="block">
                <div className="flex items-center justify-between px-3 py-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors">
                  <CurrentPlanBadge showUpgradeLink={false} />
                  <span className="text-xs text-gray-500 dark:text-gray-400">Manage →</span>
                </div>
              </Link>
            </div>
            {/* Usage Widget - shows wFirma (Free) or AI messages (Pro with app key) */}
            <div className="py-2 border-b border-gray-200 dark:border-gray-700">
              <UsageWidget compact />
            </div>
            {/* Dashboard link */}
            <div className="py-2 border-b border-gray-200 dark:border-gray-700">
              <Link
                href="/dashboard"
                className="flex items-center gap-2 px-3 py-2 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
              >
                <LayoutDashboard className="w-4 h-4" />
                <span>{translations[locale].dashboard.title}</span>
              </Link>
              {aiBudgetAvailable && (
                <Link
                  href="/dashboard/personal"
                  className="flex items-center gap-2 px-3 py-2 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
                >
                  <Lock className="w-4 h-4" />
                  <span>{translations[locale].aiBudget.personal.navLink}</span>
                </Link>
              )}
            </div>
            {/* KSeF link */}
            <div className="py-2 border-b border-gray-200 dark:border-gray-700">
              <Link
                href="/ksef"
                className="flex items-center gap-2 px-3 py-2 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
              >
                <FileCheck className="w-4 h-4" />
                <span>KSeF</span>
              </Link>
            </div>
            {/* Prompt Shortcuts link */}
            <div className="py-2 border-b border-gray-200 dark:border-gray-700">
              <button
                onClick={() => setShowShortcutsPanel(true)}
                className="flex items-center gap-2 px-3 py-2 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors w-full text-left"
              >
                <BookmarkCheck className="w-4 h-4" />
                <span>{translations[locale].promptShortcuts.sidebarLink}</span>
              </button>
            </div>
            {/* AI Memory link */}
            <div className="py-2 border-b border-gray-200 dark:border-gray-700">
              <button
                onClick={() => setShowMemoryPanel(true)}
                className="flex items-center gap-2 px-3 py-2 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors w-full text-left"
              >
                <Brain className="w-4 h-4" />
                <span>{translations[locale].aiMemory.sidebarLink}</span>
              </button>
            </div>
            {/* Organization link */}
            <div className="py-2 border-b border-gray-200 dark:border-gray-700">
              <button
                onClick={() => setShowOrgPanel(true)}
                className="flex items-center gap-2 px-3 py-2 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors w-full text-left"
              >
                <Building2 className="w-4 h-4" />
                <span>{translations[locale].organization.sidebarLink}</span>
              </button>
            </div>
            {/* Referral link */}
            <div className="py-2 border-b border-gray-200 dark:border-gray-700">
              <Link
                href="/referral"
                className="flex items-center gap-2 px-3 py-2 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
              >
                <Gift className="w-4 h-4" />
                <span>{translations[locale].referral.sidebarLink}</span>
              </Link>
            </div>
            {/* AI Costs and Version */}
            <div className="py-3 flex items-center justify-between">
              <Link
                href="/dashboard/costs"
                className="flex items-center gap-2 px-3 py-2 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
              >
                <DollarSign className="w-4 h-4" />
                <span>{t.aiCosts}</span>
              </Link>
              <AppVersion />
            </div>
          </div>
        </div>
      </div>

      {/* Main chat area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Chat header */}
        <ChatHeader
          conversation={currentConversation}
          onMenuClick={() => setIsSidebarOpen(true)}
          onNewChat={handleNewChat}
          isCreatingConversation={isCreatingConversation}
          translations={t.header}
          profileTranslations={translations[locale].profile}
          apiCredentialsTranslations={translations[locale].apiCredentials}
          helpTranslations={translations[locale].help}
          ttsTranslations={t.tts}
          sharedTranslations={t.shared}
          telegramTranslations={translations[locale].telegram}
          locale={locale}
          onLocaleChange={setLocale}
          onShareToggle={
            currentConversation && currentConversation.userId === user?.id
              ? () => {
                  if (currentConversation.isShared) {
                    unshareConversation(currentConversation.id);
                  } else if (currentConversation.containsPrivateAiBudgetData) {
                    setShareWarningOpen(true);
                  } else {
                    shareConversation(currentConversation.id);
                  }
                }
              : undefined
          }
          isShared={currentConversation?.isShared}
          isOwner={currentConversation?.userId === user?.id}
        />

        <SharePrivateDataDialog
          open={shareWarningOpen}
          onCancel={() => setShareWarningOpen(false)}
          onConfirm={() => {
            setShareWarningOpen(false);
            if (currentConversation) shareConversation(currentConversation.id);
          }}
          t={{ ...translations[locale].aiBudget.share }}
        />

        {/* Subscription Welcome Banner */}
        {showSubscriptionWelcome && !isPro && (
          <div className="mx-4 mt-4 p-4 bg-gradient-to-r from-blue-50 to-purple-50 dark:from-blue-900/20 dark:to-purple-900/20 border border-blue-200 dark:border-blue-800 rounded-lg shadow-sm">
            <div className="flex items-start gap-3">
              <div className="flex-shrink-0 w-10 h-10 bg-blue-100 dark:bg-blue-900/50 rounded-full flex items-center justify-center">
                <Crown className="w-5 h-5 text-blue-600" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-1">
                  {t.subscriptionWelcome?.title || 'Welcome to eKsięgowy AI!'}
                </h3>
                <p className="text-sm text-gray-600 dark:text-gray-300 mb-3">
                  {t.subscriptionWelcome?.message || 'You are currently on the Free plan. Upgrade to Pro anytime for included API credits, unlimited wFirma requests, and priority support.'}
                </p>
                <Link
                  href="/pricing"
                  className="inline-flex items-center gap-1 text-sm font-medium text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
                >
                  {t.subscriptionWelcome?.upgradeButton || 'View Plans & Upgrade'} →
                </Link>
              </div>
              <button
                onClick={handleSubscriptionWelcomeClose}
                className="flex-shrink-0 p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                aria-label="Dismiss"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        {/* Messages */}
        <div className="flex-1 overflow-hidden">
          <MessageList
            messages={messages}
            isLoading={isLoading}
            isLoadingConversation={isLoadingConversation}
            translations={t.messages}
            toolsTranslations={t.tools}
            suggestionsTranslations={t.suggestions}
            ttsTranslations={t.tts}
            onSuggestionClick={handleSendMessage}
          />
        </div>

        {/* Error message */}
        {errorMessage && (
          <div className="mx-4 mb-2 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-red-800 dark:text-red-300">
                {t.messages.errorTitle || 'Error'}
              </p>
              <p className="text-sm text-red-700 dark:text-red-400 mt-0.5">
                {errorMessage === 'NETWORK_ERROR'
                  ? (t.messages.errorNetwork || 'Chat service is unavailable. Please check your connection.')
                  : errorMessage === 'UNKNOWN_ERROR'
                    ? (t.messages.errorDefault || 'Failed to send message. Please try again.')
                    : errorMessage}
              </p>
            </div>
            <button
              onClick={clearError}
              className="flex-shrink-0 p-1 text-red-400 hover:text-red-600 dark:hover:text-red-300 rounded transition-colors"
              aria-label={t.messages.errorDismiss || 'Dismiss'}
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Input */}
        <ChatInput
          onSend={handleSendMessage}
          disabled={isLoading}
          placeholder={
            !currentConversationId
              ? t.input.placeholderNew
              : t.input.placeholderDefault
          }
          translations={t.input}
          locale={locale}
          prefillValue={shortcutPrefill}
          onPrefillConsumed={() => setShortcutPrefill(undefined)}
          onShortcutsClick={() => setShowShortcutsPanel(true)}
        />
      </div>

      {/* wFirma Welcome Modal */}
      <WfirmaWelcomeModal
        open={showWfirmaWelcome}
        onClose={handleWfirmaWelcomeClose}
        translations={onboardingTranslations.wfirmaWelcome}
      />

      {/* Prompt Shortcuts Panel */}
      <PromptShortcutsPanel
        open={showShortcutsPanel}
        onClose={() => setShowShortcutsPanel(false)}
        onSelect={(prompt) => setShortcutPrefill(prompt)}
        translations={translations[locale].promptShortcuts}
      />

      {/* AI Memory Panel */}
      <AIMemoryPanel
        open={showMemoryPanel}
        onClose={() => setShowMemoryPanel(false)}
        translations={translations[locale].aiMemory}
      />

      {/* Organization Panel */}
      <OrganizationPanel
        open={showOrgPanel}
        onClose={() => setShowOrgPanel(false)}
        translations={translations[locale].organization}
      />
    </div>
  );
}

// Wrap ChatContainerInner with TTSProvider
export function ChatContainer() {
  const { locale } = useLocale();

  return (
    <TTSProvider locale={locale}>
      <ChatContainerInner />
    </TTSProvider>
  );
}
