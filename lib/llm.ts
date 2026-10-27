// The one place that decides which provider serves LLM calls. We call Anthropic directly
// (NOTES.md, M2): the AI Gateway's free tier blocks Claude models, and we already have
// Anthropic credit. The brief allows any provider.
//
// To go back to the Vercel AI Gateway, change the return line to `return id;` (a plain
// string routes through the gateway), set LLM_MODEL to a gateway id such as
// anthropic/claude-sonnet-5.5, and set AI_GATEWAY_API_KEY.
import { anthropic } from '@ai-sdk/anthropic';
import type { LanguageModel } from 'ai';

// Direct Anthropic ids use dashes (claude-sonnet-5-5); gateway ids use dots (anthropic/claude-sonnet-5.5).
const DEFAULT_MODEL = 'claude-sonnet-5-5';

export function llm(id = process.env.LLM_MODEL || DEFAULT_MODEL): LanguageModel {
  return anthropic(id); // reads ANTHROPIC_API_KEY
}
