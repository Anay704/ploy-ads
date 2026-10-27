'use client';

import type { ChatStatus } from 'ai';
import { ArrowRightIcon, CheckCircle2Icon, SparklesIcon } from 'lucide-react';
import type { AgentUIMessage } from '@/lib/agent';
import { Conversation, ConversationContent, ConversationScrollButton } from '@/components/ai-elements/conversation';
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message';
import { PromptInput, PromptInputFooter, PromptInputSubmit, PromptInputTextarea } from '@/components/ai-elements/prompt-input';
import { Shimmer } from '@/components/ai-elements/shimmer';
import { Task, TaskContent, TaskTrigger } from '@/components/ai-elements/task';
import { Tool, ToolContent, ToolHeader } from '@/components/ai-elements/tool';
import { ResearchChecklist } from '@/components/research-checklist';
import type { ConfirmPart, ResearchPart } from '@/components/campaign-state';

function ResearchTool({ part }: { part: ResearchPart }) {
  const output = part.state === 'output-available' ? part.output : undefined;
  const running = !output || output.status === 'running';
  const title =
    output?.status === 'done'
      ? `Researched ${output.brand.shortName}: ${output.catalogCount} products`
      : output?.status === 'not_shopify'
        ? 'Not a Shopify store'
        : 'Researching the store';
  return (
    // Open while it runs so progress is visible; collapsed once done, the card takes over.
    <Tool defaultOpen={running} key={running ? 'running' : 'done'} className="mb-0 bg-white">
      <ToolHeader type={part.type} state={running ? 'input-available' : part.state} title={title} />
      <ToolContent>
        {part.state === 'output-error' ? (
          <p className="text-sm text-red-700">{part.errorText}</p>
        ) : (
          <Task defaultOpen>
            <TaskTrigger title={running ? 'Research steps' : `${output?.steps.length ?? 0} steps done`} />
            <TaskContent>
              <ResearchChecklist steps={output?.steps ?? []} finished={output?.status === 'done'} />
            </TaskContent>
          </Task>
        )}
      </ToolContent>
    </Tool>
  );
}

function BriefTool({ part }: { part: ConfirmPart }) {
  if (part.state === 'output-available') {
    const a = part.output;
    return (
      <div className="flex items-start gap-3 rounded-xl border bg-white p-3 text-sm">
        <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-emerald-600" />
        <div>
          <p className="font-medium">Brief approved</p>
          <p className="text-zinc-500">
            {a.products.map((p) => p.title).join(', ')} · {a.goal}
          </p>
        </div>
      </div>
    );
  }
  if (part.state === 'input-available') {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-[color-mix(in_oklab,var(--brand)_45%,white)] bg-[color-mix(in_oklab,var(--brand)_10%,white)] p-3 text-sm">
        <SparklesIcon className="size-4 shrink-0 text-[var(--brand-text)]" />
        <p className="flex-1">
          <span className="font-medium">Your brief is ready.</span> Check it on the right, then generate.
        </p>
        <ArrowRightIcon className="size-4 animate-[nudge_1.6s_ease-in-out_infinite] text-zinc-500" />
      </div>
    );
  }
  return <Shimmer className="text-sm">Preparing your brief…</Shimmer>;
}

export function ChatPanel({
  messages,
  status,
  error,
  onSend,
}: {
  messages: AgentUIMessage[];
  status: ChatStatus;
  error?: Error;
  onSend: (text: string) => void;
}) {
  const last = messages.at(-1);
  const thinking = status === 'submitted' || (status === 'streaming' && last?.role === 'assistant' && last.parts.every((p) => p.type === 'step-start'));

  return (
    <aside className="flex min-h-0 flex-col border-r bg-zinc-50/60">
      <Conversation>
        <ConversationContent className="gap-5">
          {messages.map((m) => (
            <Message key={m.id} from={m.role}>
              <MessageContent className="w-full group-[.is-user]:w-fit">
                {m.parts.map((part, i) => {
                  const key = `${m.id}-${i}`;
                  switch (part.type) {
                    case 'text':
                      return m.role === 'user' ? <p key={key}>{part.text}</p> : <MessageResponse key={key}>{part.text}</MessageResponse>;
                    case 'tool-researchStore':
                      return <ResearchTool key={key} part={part} />;
                    case 'tool-confirmBrief':
                      return <BriefTool key={key} part={part} />;
                    default:
                      return null;
                  }
                })}
              </MessageContent>
            </Message>
          ))}
          {thinking && <Shimmer className="text-sm">Thinking…</Shimmer>}
          {error && (
            <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              Something went wrong: {error.message}
            </p>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="border-t bg-white p-3">
        <PromptInput
          onSubmit={({ text }) => {
            if (text.trim()) onSend(text.trim());
          }}
        >
          <PromptInputTextarea placeholder="Ask Ploy to change something…" className="min-h-12" />
          <PromptInputFooter className="justify-end">
            <PromptInputSubmit status={status} />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </aside>
  );
}
