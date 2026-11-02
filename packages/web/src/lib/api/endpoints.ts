/**
 * API Endpoints
 * 
 * Centralized API endpoint definitions
 */

export const API_ENDPOINTS = {
  // Auth
  AUTH: {
    CONFIG: '/api/auth/config',
    REGISTER: '/api/auth/register',
    LOGIN: '/api/auth/login',
    LOGOUT: '/api/auth/logout',
    REFRESH: '/api/auth/refresh',
    ME: '/api/auth/me',
    PROFILE: '/api/auth/profile',
    OAUTH_GOOGLE: '/api/auth/oauth/google',
    FORGOT_PASSWORD: '/api/auth/forgot-password',
    RESET_PASSWORD: '/api/auth/reset-password',
    COMPLETE_PROFILE: '/api/auth/complete-profile',
  },

  // Users
  USERS: {
    LOCALE: '/api/users/locale',
    PROFILE: '/api/users/profile',
    UPDATE: '/api/users/update',
    ANALYTICS: '/api/users/me/analytics',
  },

  // Invoices
  INVOICES: {
    LIST: '/api/invoices',
    GET: (id: string) => `/api/invoices/${id}`,
    CREATE: '/api/invoices',
    UPDATE: (id: string) => `/api/invoices/${id}`,
    DELETE: (id: string) => `/api/invoices/${id}`,
  },

  // Customers
  CUSTOMERS: {
    LIST: '/api/customers',
    GET: (id: string) => `/api/customers/${id}`,
    CREATE: '/api/customers',
    UPDATE: (id: string) => `/api/customers/${id}`,
    DELETE: (id: string) => `/api/customers/${id}`,
  },

  // AI
  AI: {
    CONVERSATIONS: '/api/ai/conversations',
    CONVERSATION: (id: string) => `/api/ai/conversations/${id}`,
    SEND_MESSAGE: (id: string) => `/api/ai/conversations/${id}/messages`,
    RECOMMENDATIONS: '/api/ai/recommendations',
    ANALYZE: '/api/ai/analyze',
  },

  // AI Costs
  AI_COSTS: {
    DASHBOARD: '/api/ai/costs/dashboard',
    SUMMARY: '/api/ai/costs/summary',
    DAILY: '/api/ai/costs/daily',
    BY_MODEL: '/api/ai/costs/by-model',
    CONVERSATIONS: '/api/ai/costs/conversations',
    CONVERSATION_DETAIL: (id: string) => `/api/ai/costs/conversations/${id}`,
    CONVERSATION_RUNS: (id: string) => `/api/ai/costs/conversations/${id}/runs`,
  },

  // Dashboard
  DASHBOARD: {
    SUMMARY: '/api/dashboard/summary',
    AI_BUDGET: '/api/dashboard/ai-budget',
    PERSONAL: '/api/dashboard/personal',
  },

  // AI Budget integration
  AI_BUDGET: {
    STATUS: '/api/integrations/ai-budget/status',
    CONNECT: '/api/integrations/ai-budget/connect',
    COMPLETE: '/api/integrations/ai-budget/complete',
    DISCONNECT: '/api/integrations/ai-budget/disconnect',
    LABEL: (id: string) => `/api/integrations/ai-budget/accounts/${id}/label`,
    SYNC: '/api/integrations/ai-budget/sync',
    DISMISS: '/api/integrations/ai-budget/reconciliation/dismissals',
  },

  // Tax Calendar
  TAX_CALENDAR: {
    UPCOMING: '/api/tax-calendar/upcoming',
  },
} as const;
