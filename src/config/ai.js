export const CHAT_MODEL =
  process.env.OPENAI_CHAT_MODEL || process.env.OPENAI_MODEL || 'gpt-4o';

export const UTILITY_MODEL =
  process.env.OPENAI_UTILITY_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini';

export const INSIGHTS_MODEL =
  process.env.OPENAI_INSIGHTS_MODEL || process.env.OPENAI_MODEL || 'gpt-4.1-nano';
