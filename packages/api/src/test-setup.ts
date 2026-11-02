/**
 * Jest test setup file
 * This file is executed before each test file
 */

// Load environment variables from .env file for integration tests
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load .env file from the api package root
// Use override: true to ensure .env values take precedence over system environment variables
const envPath = path.resolve(__dirname, '../.env');
console.log('Loading .env from:', envPath);
const result = dotenv.config({ path: envPath, override: true });

if (result.error) {
  console.warn('Warning: Could not load .env file:', result.error.message);
} else {
  console.log('✓ .env file loaded successfully');
  console.log('Parsed env vars:', Object.keys(result.parsed || {}).filter(k => k.startsWith('WFIRMA')));
  console.log('wFirma keys loaded:', {
    accessKey: !!process.env.WFIRMA_ACCESS_KEY,
    secretKey: !!process.env.WFIRMA_SECRET_KEY,
    appKey: !!process.env.WFIRMA_APP_KEY,
    accessKeyValue: process.env.WFIRMA_ACCESS_KEY?.substring(0, 10),
  });
}

// LangSmith stays off in tests whatever a developer .env says (.env.example ships tracing on): a test that
// needs tracing opts in itself, with the client stubbed. Any LangSmith HTTP call that still slips through
// (either bundled langsmith copy) is blocked and recorded; tracing tests assert it stays empty.
process.env.LANGCHAIN_TRACING_V2 = 'false';
for (const key of ['LANGSMITH_TRACING', 'LANGCHAIN_TRACING', 'LANGSMITH_TRACING_V2', 'LANGCHAIN_API_KEY', 'LANGSMITH_API_KEY']) {
  delete process.env[key];
}
const langsmithOutbound: string[] = [];
(globalThis as Record<symbol, unknown>)[Symbol.for('ls:fetch_implementation')] = async (url: unknown) => {
  langsmithOutbound.push(String(url));
  throw new Error(`Outbound LangSmith request blocked in tests: ${String(url)}`);
};
(globalThis as Record<string, unknown>).__langsmithOutbound = langsmithOutbound;

// Mock environment variables for tests (only if not already set)
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-key-min-32-characters-long';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret-key-min-32-characters-long';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test_db';
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// Mock console methods to reduce noise in tests (but allow errors)
global.console = {
  ...console,
  log: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
  warn: console.warn, // Keep warnings
  error: console.error, // Keep errors for debugging
};

// Mock Prisma client
jest.mock('./lib/prisma', () => ({
  prisma: {
    user: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    $disconnect: jest.fn(),
  },
}));

// Mock Redis client
jest.mock('./lib/redis', () => ({
  redis: {
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
    exists: jest.fn(),
    expire: jest.fn(),
    disconnect: jest.fn(),
  },
}));

// Mock logger
jest.mock('./utils/logger', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));