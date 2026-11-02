'use client';

import React, { useState, useRef, useEffect } from 'react';
import { Globe, User, LogOut, Shield, MoreVertical, HelpCircle, Plug } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/ui/theme-toggle';
import {
  ProfileEditModal,
  type ProfileTranslations,
  ApiCredentialsModal,
  type ApiCredentialsTranslations,
  type TelegramLinkTranslations,
} from '@/components/profile';
import { HelpButton, HelpPanel, type HelpPanelTranslations } from '@/components/help';
import { useAuth } from '@/contexts/AuthContext';

type Locale = 'en' | 'pl' | 'ru';

const localeLabels: Record<Locale, string> = {
  en: 'EN',
  pl: 'PL',
  ru: 'RU',
};

export interface HeaderUserMenuProps {
  locale: Locale;
  onLocaleChange: (locale: Locale) => void;
  logoutLabel: string;
  profileTranslations: ProfileTranslations;
  apiCredentialsTranslations: ApiCredentialsTranslations;
  helpTranslations: HelpPanelTranslations;
  telegramTranslations?: TelegramLinkTranslations;
  /** Extra controls rendered inline on desktop, before the shared controls (e.g. plan badge, TTS). */
  desktopExtras?: React.ReactNode;
  /** Extra controls rendered inside the mobile "more" menu (e.g. TTS). */
  mobileExtras?: React.ReactNode;
}

/**
 * Shared user-controls cluster for the app header: language switcher, theme
 * toggle, help, profile (+ modals), admin link and logout. Depends only on
 * globally-available contexts (Auth, Locale, Theme), so it can be reused on any
 * authenticated page — the chat header injects its chat-only controls (plan
 * badge, TTS) through the `desktopExtras` / `mobileExtras` slots.
 */
export function HeaderUserMenu({
  locale,
  onLocaleChange,
  logoutLabel,
  profileTranslations,
  apiCredentialsTranslations,
  helpTranslations,
  telegramTranslations,
  desktopExtras,
  mobileExtras,
}: HeaderUserMenuProps) {
  const [isProfileModalOpen, setIsProfileModalOpen] = useState(false);
  const [isApiCredentialsModalOpen, setIsApiCredentialsModalOpen] = useState(false);
  const [isHelpPanelOpen, setIsHelpPanelOpen] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const mobileMenuRef = useRef<HTMLDivElement>(null);
  const { logout, isAdmin } = useAuth();

  // Close mobile menu on outside click
  useEffect(() => {
    if (!isMobileMenuOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (mobileMenuRef.current && !mobileMenuRef.current.contains(e.target as Node)) {
        setIsMobileMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isMobileMenuOpen]);

  const languageSelect = (
    <select
      value={locale}
      onChange={(e) => onLocaleChange(e.target.value as Locale)}
      className="text-xs font-medium bg-transparent border-none cursor-pointer focus:ring-0 focus:outline-none text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 py-1 [color-scheme:light] dark:[color-scheme:dark]"
    >
      {Object.entries(localeLabels).map(([val, label]) => (
        <option key={val} value={val} className="bg-white text-gray-900 dark:bg-gray-800 dark:text-gray-100">
          {label}
        </option>
      ))}
    </select>
  );

  return (
    <>
      {/* Desktop controls */}
      {desktopExtras}

      <div className="hidden sm:block">
        <HelpButton onClick={() => setIsHelpPanelOpen(true)} />
      </div>

      <div className="hidden sm:block">
        <ThemeToggle />
      </div>

      <div className="hidden sm:flex items-center gap-1 text-gray-600 dark:text-gray-400 px-1">
        <Globe className="w-4 h-4" />
        {languageSelect}
      </div>

      <Button
        variant="ghost"
        size="sm"
        onClick={() => setIsProfileModalOpen(true)}
        className="hidden sm:flex items-center gap-1 text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100 px-3"
        title={profileTranslations.title}
      >
        <User className="w-4 h-4" />
      </Button>

      {isAdmin && (
        <Link href="/admin" className="hidden sm:block">
          <Button
            variant="ghost"
            size="sm"
            className="flex items-center gap-1 text-purple-600 hover:text-purple-800 dark:text-purple-400 dark:hover:text-purple-300"
            title="Admin"
          >
            <Shield className="w-4 h-4" />
          </Button>
        </Link>
      )}

      <Button
        variant="ghost"
        size="sm"
        onClick={logout}
        className="hidden sm:flex items-center gap-1 text-gray-600 hover:text-red-600 dark:text-gray-400 dark:hover:text-red-400 px-3"
        title={logoutLabel}
      >
        <LogOut className="w-4 h-4" />
      </Button>

      {/* Mobile more menu — contains all actions hidden on mobile */}
      <div className="relative sm:hidden" ref={mobileMenuRef}>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
          className="px-1.5 text-gray-600 dark:text-gray-400"
        >
          <MoreVertical className="w-4 h-4" />
        </Button>

        {isMobileMenuOpen && (
          <div className="absolute right-0 top-full mt-1 w-56 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-50 py-1">
            {/* Profile */}
            <button
              onClick={() => { setIsProfileModalOpen(true); setIsMobileMenuOpen(false); }}
              className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              <User className="w-4 h-4" />
              {profileTranslations.title}
            </button>

            {/* Integrations */}
            <Link
              href="/settings/integrations"
              onClick={() => setIsMobileMenuOpen(false)}
              className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              <Plug className="w-4 h-4" />
              {profileTranslations.integrations || 'Integrations'}
            </Link>

            {/* Language */}
            <div className="flex items-center gap-3 px-4 py-2.5 text-sm text-gray-700 dark:text-gray-300">
              <Globe className="w-4 h-4" />
              <select
                value={locale}
                onChange={(e) => { onLocaleChange(e.target.value as Locale); setIsMobileMenuOpen(false); }}
                className="text-sm bg-transparent border-none cursor-pointer focus:ring-0 focus:outline-none text-gray-700 dark:text-gray-300 py-0 [color-scheme:light] dark:[color-scheme:dark]"
              >
                {Object.entries(localeLabels).map(([val, label]) => (
                  <option key={val} value={val} className="bg-white text-gray-900 dark:bg-gray-800 dark:text-gray-100">
                    {label}
                  </option>
                ))}
              </select>
            </div>

            {/* Theme */}
            <div className="flex items-center justify-between px-4 py-2.5">
              <span className="text-sm text-gray-700 dark:text-gray-300">Theme</span>
              <ThemeToggle />
            </div>

            <div className="border-t border-gray-200 dark:border-gray-700 my-1" />

            {/* Help */}
            <button
              onClick={() => { setIsHelpPanelOpen(true); setIsMobileMenuOpen(false); }}
              className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              <HelpCircle className="w-4 h-4" />
              {helpTranslations.title}
            </button>

            {/* Slot for page-specific mobile actions (e.g. TTS) */}
            {mobileExtras}

            {/* Admin */}
            {isAdmin && (
              <Link
                href="/admin"
                onClick={() => setIsMobileMenuOpen(false)}
                className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-purple-600 dark:text-purple-400 hover:bg-gray-100 dark:hover:bg-gray-700"
              >
                <Shield className="w-4 h-4" />
                Admin
              </Link>
            )}

            <div className="border-t border-gray-200 dark:border-gray-700 my-1" />

            {/* Logout */}
            <button
              onClick={() => { logout(); setIsMobileMenuOpen(false); }}
              className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-red-600 dark:text-red-400 hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              <LogOut className="w-4 h-4" />
              {logoutLabel}
            </button>
          </div>
        )}
      </div>

      {/* Profile Edit Modal */}
      <ProfileEditModal
        open={isProfileModalOpen}
        onOpenChange={setIsProfileModalOpen}
        translations={profileTranslations}
        onOpenApiCredentials={() => setIsApiCredentialsModalOpen(true)}
      />

      {/* API Credentials Modal */}
      <ApiCredentialsModal
        open={isApiCredentialsModalOpen}
        onOpenChange={setIsApiCredentialsModalOpen}
        translations={apiCredentialsTranslations}
        telegramTranslations={telegramTranslations}
      />

      {/* Help Panel */}
      <HelpPanel
        open={isHelpPanelOpen}
        onClose={() => setIsHelpPanelOpen(false)}
        initialCategory="aiChat"
        translations={helpTranslations}
      />
    </>
  );
}
