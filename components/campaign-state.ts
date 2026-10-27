// Reads the campaign's phase out of the chat messages, so the chat panel and the workspace
// show the same thing: there is one source (the tool parts), not two pieces of state.

import type { InferUITools } from 'ai';
import type { AgentTools, AgentUIMessage, BriefApproval } from '@/lib/agent';

type Tools = InferUITools<AgentTools>;
export type ResearchOutput = Tools['researchStore']['output'];
export type ResearchDone = Extract<ResearchOutput, { status: 'done' }>;
export type BriefInput = Tools['confirmBrief']['input'];

type Part = AgentUIMessage['parts'][number];
export type ResearchPart = Extract<Part, { type: 'tool-researchStore' }>;
export type ConfirmPart = Extract<Part, { type: 'tool-confirmBrief' }>;

function lastPart<T extends Part['type']>(messages: AgentUIMessage[], type: T): Extract<Part, { type: T }> | undefined {
  for (let m = messages.length - 1; m >= 0; m--) {
    const parts = messages[m].parts;
    for (let p = parts.length - 1; p >= 0; p--) if (parts[p].type === type) return parts[p] as Extract<Part, { type: T }>;
  }
  return undefined;
}

export type Phase =
  | { kind: 'starting' }
  | { kind: 'researching'; part?: ResearchPart }
  | { kind: 'not_shopify' }
  | { kind: 'failed'; message: string }
  | { kind: 'review'; research?: ResearchDone; confirm: ConfirmPart & { input: BriefInput } }
  | { kind: 'confirmed'; research?: ResearchDone; confirm: ConfirmPart; approval: BriefApproval };

export function phaseOf(messages: AgentUIMessage[]): Phase {
  const research = lastPart(messages, 'tool-researchStore');
  const confirm = lastPart(messages, 'tool-confirmBrief');
  const done = research?.state === 'output-available' && research.output.status === 'done' ? research.output : undefined;

  if (confirm?.state === 'output-available') return { kind: 'confirmed', research: done, confirm, approval: confirm.output };
  if (confirm?.state === 'input-available') return { kind: 'review', research: done, confirm: confirm as ConfirmPart & { input: BriefInput } };
  if (research?.state === 'output-error') return { kind: 'failed', message: research.errorText };
  if (research?.state === 'output-available' && research.output.status === 'not_shopify') return { kind: 'not_shopify' };
  if (research) return { kind: 'researching', part: research };
  return { kind: 'starting' };
}

/** The checklist steps from a research part, whether still streaming or finished. */
export function stepsOf(part?: ResearchPart) {
  return part?.state === 'output-available' ? part.output.steps : [];
}
