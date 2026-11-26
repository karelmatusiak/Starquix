// src/ai/hooks/useAIAgent.ts
// Tool-calling AI agent hook. Autonomous command execution via AI SDK tool use.

import { useCallback, useRef } from 'react';
import { t } from '@/i18n';
import toast from 'react-hot-toast';
import { useDispatch, useYjsValue, useEditorDoc } from '@/store';
import { useUndoContext } from '@/context/UndoContext';
import { useClassStore } from '@/context';
import { useScannedElements, useScannedElementsRef, useSelectionContext } from '@/context/SelectionContext';
import {
  selectCurrentPageId,
  selectCurrentBreakpoint,
} from '@/store/selectors';
import { generateWithTools, type AgentCallbacks, type AgentMessage } from '../AIService';
import type { ScannedComponent } from '@/hooks/useComponentLibrary';
import { useLayoutLibrary } from '@/hooks/useLayoutLibrary';
import type { ToolSet } from 'ai';
import { useAI } from '../AIContext';
import { classifyAIFailure, aiFailureCopy } from '../failure';
import { resolveImageGen } from '../imageGen';
import { generateCommandTools, type ToolCallLogEntry } from '../tools/commandTools';
import { buildToolCtx, createBatchGuard } from '../tools/buildToolCtx';
import { isMockEnabled, runMockAgent } from '../dev/mockRunner';
import { buildAutoContext, formatAutoContext, buildPageStructureContext, buildVariablesContext, buildBlogContext } from '../tools/autoContext';
import { loadCustomPrompts, DEFAULT_SYSTEM_PROMPT } from '../prompts/userPrompts';
import { getActiveStyleSection, loadBundledThemes } from '../styles/styleLibrary';
import { CONFIRM_RULE } from '../tools/commandRegistry';
import type { AIMessage, AIContextElement, AIActivity, AIThought, AIFailureCode } from '../types';
import { hasChatKey } from '../types';
import { extractAffectedKey, extractTouchedKey } from '../utils/activityKeys';
import { formatActivitiesForModel, upsertThought, closeThoughts } from '../utils/activityFeed';
import { StreamPreviewFeed } from '../utils/partialArgs';
import type { StreamPreviewEmit } from '../utils/partialArgs';

/** Emit-time breakpoint stamping: a mid-run switch must retarget the preview
 *  to the frame the user is watching (run-start capture killed it — task-129). */
export function createPreviewDispatchers(bpRef: { current: string | null | undefined }) {
  const bp = () => bpRef.current ?? 'base';
  return {
    emit: (e: StreamPreviewEmit) =>
      window.dispatchEvent(new CustomEvent('sq:ai-stream-preview', { detail: { ...e, breakpoint: bp() } })),
    endEmit: (cancelled?: boolean) =>
      window.dispatchEvent(new CustomEvent('sq:ai-stream-preview-end', { detail: { breakpoint: bp(), cancelled: !!cancelled } })),
  };
}

function createMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

export type FinishState = 'completed' | 'needs-continue' | 'failed';

/**
 * Resolve the honest finish state from real stream metadata.
 * Never fabricates "Done." — a capped half-finished run is needs-continue,
 * and a silent-but-successful run gets an explicit action count.
 */
export function resolveFinishState(m: { finishReason: string; stepsUsed: number; stepCap: number; toolCalls: number; fullText: string }): { state: FinishState; fallbackText: string } {
  if (m.finishReason === 'error') return { state: 'failed', fallbackText: t('The run failed.') };
  if (m.stepsUsed >= m.stepCap) return { state: 'needs-continue', fallbackText: t('Stopped at the {0}-step limit with work remaining.', { 0: m.stepCap }) };
  if (!m.fullText && m.toolCalls > 0) return { state: 'completed', fallbackText: t('Finished — {0} action{1} executed (no summary given).', { 0: m.toolCalls, 1: m.toolCalls !== 1 ? 's' : '' }) };
  if (!m.fullText) return { state: 'completed', fallbackText: t('No actions were taken. Try rephrasing the request.') };
  return { state: 'completed', fallbackText: '' };
}

/** Prompt sent when the user clicks Continue on a needs-continue message. */
const CONTINUE_PROMPT = t('Continue: finish the remaining items from your plan. Re-check the action log above for what is already done.');

/** A capped run resumes itself this many times per user prompt before falling
 *  back to the manual Continue button (runaway/cost bound: 4×stepCap total). */
export const MAX_AUTO_CONTINUES = 3;

export function shouldAutoContinue(state: FinishState, autoRoundsUsed: number): boolean {
  return state === 'needs-continue' && autoRoundsUsed < MAX_AUTO_CONTINUES;
}

/** Mark every still-running activity as resolved (run ended/aborted/errored). */
export function finalizeActivities(activities: AIActivity[], status: 'done' | 'error'): AIActivity[] {
  return activities.map(a => (a.status === 'running' ? { ...a, status } : a));
}

/** Settle a cancelled run's message: cancelled work that ran IS done work —
 *  a red X would misread as failure (task-126 design ledger). */
export function buildCancelledSettle(activities: AIActivity[], streamedText: string) {
  return {
    activities: finalizeActivities(activities, 'done'),
    content: streamedText || 'Cancelled.',
    status: 'complete' as const,
  };
}

/** Resolve the FIRST running activity with the tool's result (calls resolve FIFO). */
export function resolveActivity(activities: AIActivity[], toolName: string, success: boolean, detail: string): AIActivity[] {
  const idx = activities.findIndex(a => a.status === 'running' && a.toolName === toolName);
  if (idx === -1) return activities;
  const next = [...activities];
  next[idx] = { ...next[idx], status: success ? 'done' : 'error', detail: detail || undefined };
  return next;
}

/**
 * @param componentLibrary Passed in from the caller (Editor already holds the
 * scanned library) instead of calling useComponentLibrary here — that hook
 * fetches per mount, and scan-components is expensive (SSR preview per component).
 */
export function useAIAgent(
  componentLibrary: ScannedComponent[] = [],
  projectId = '',
  // task-133 Task 9: LIVE getter for the local runtime's current page FILE
  // (structural write target). Editor threads it through Footer; omitted
  // (non-local callers/tests) = null, which the local tool branches refuse
  // honestly.
  getCurrentPageFile?: () => string | null,
) {
  const doc = useEditorDoc();
  const dispatch = useDispatch();
  const currentPageId = useYjsValue(selectCurrentPageId);
  const { selectedKey } = useSelectionContext();
  const currentBreakpoint = useYjsValue(selectCurrentBreakpoint);
  const { takeSnapshot, claimSnapshot, undo, redo, canUndo, canRedo, pushStructuralUndo } = useUndoContext();
  const { layouts } = useLayoutLibrary();
  const { saveAll } = useClassStore();
  const { scannedElements } = useScannedElements();
  // Live ref for toolCtx.getScannedElements — tools must see the fresh scan
  // after a mid-run page switch, not the per-run render snapshot above.
  const { scannedElementsRef } = useScannedElementsRef();
  // Live ref for stream-preview stamping — mid-run breakpoint switches must
  // follow the user (task-129), same pattern as scannedElementsRef above.
  const breakpointRef = useRef(currentBreakpoint);
  breakpointRef.current = currentBreakpoint;

  // Once-per-batch snapshot guard (one Cmd+Z per run; continue-run keeps it).
  // Lives in a ref so the ctx rebuilt per submit shares one batch.
  const batchRef = useRef(createBatchGuard());

  // Auto-continue rounds used for the current user prompt (reset on manual submit)
  const autoContinueRoundsRef = useRef(0);

  const {
    config,
    activeSessionId,
    contextElements,
    messages: chatHistory,
    setIsGenerating,
    setStreamedContent,
    setError,
    addMessage,
    updateMessage,
    clearContextElements,
    markActiveKey,
    clearActiveKeys,
    recordTouchedKey,
    abortRef,
  } = useAI();

  const activeSessionRef = useRef(activeSessionId);
  activeSessionRef.current = activeSessionId;
  const runNumberRef = useRef(0);

  /** Submit prompt in agent mode (tool-calling).
   *  opts.continueRun resumes a needs-continue run: the batch snapshot is kept
   *  (one Cmd+Z reverts both segments) and a fixed continue prompt is sent. */
  const submitAgentPrompt = useCallback(
    async (prompt: string, contextOverride?: AIContextElement[], opts?: { continueRun?: boolean }) => {
      if (!config || !hasChatKey(config)) {
        setError(aiFailureCopy('configuration').title);
        return;
      }

      if (opts?.continueRun) prompt = CONTINUE_PROMPT;

      const attachedElements = contextOverride ?? [...contextElements];
      if (!contextOverride) {
        clearContextElements();
      }

      // Reset state
      setError(null);
      setStreamedContent('');
      setIsGenerating(true);
      if (!opts?.continueRun) {
        batchRef.current.reset();
        autoContinueRoundsRef.current = 0;
      }

      const abortController = new AbortController();
      abortRef.current = abortController;
      const runNumber = ++runNumberRef.current;
      const runSession = activeSessionRef.current;
      const ownsRun = () => abortRef.current === abortController;
      const isLive = () => ownsRun() && !abortController.signal.aborted;
      const setRunError = (failure: AIFailureCode) => {
        if (ownsRun() && activeSessionRef.current === runSession) setError(aiFailureCopy(failure).title);
      };

      // Add user message
      const userMsg: AIMessage = {
        id: createMessageId(),
        role: 'user',
        content: prompt,
        timestamp: Date.now(),
        contextElements: attachedElements.length > 0 ? attachedElements : undefined,
      };
      addMessage(userMsg);

      // Add placeholder assistant message
      const assistantMsgId = createMessageId();
      const assistantMsg: AIMessage = {
        id: assistantMsgId,
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        status: 'streaming',
      };
      addMessage(assistantMsg);

      // Build system prompt: custom override or default, plus current editor state and page structure
      const customPrompts = loadCustomPrompts();
      const basePrompt = customPrompts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
      const autoContext = buildAutoContext(doc, selectedKey);
      const pageStructure = buildPageStructureContext(scannedElements);
      const variablesContext = buildVariablesContext(doc);
      const blogContext = buildBlogContext(doc, currentPageId);
      await loadBundledThemes(); // themes.json is lazy — a bundled active style must resolve
      // CONFIRM_RULE rides outside the user-editable base prompt: a custom prompt must never unlock a public deploy.
      // The part that is the same on every request comes first and is measured (stableChars below), so the
      // provider's prompt cache keeps it across a run's tool steps. Nothing per-request may go into it or ahead of it.
      const stablePrompt = [basePrompt, CONFIRM_RULE, getActiveStyleSection(projectId)].filter(Boolean).join('\n\n');
      const systemPrompt = [stablePrompt, formatAutoContext(autoContext), variablesContext, blogContext, pageStructure]
        .filter(Boolean)
        .join('\n\n');

      // Prepend context elements as a simple block before the user message
      let augmentedPrompt = prompt;
      const validElements = attachedElements.filter(el => el.key);
      if (validElements.length > 0) {
        const refs = validElements
          .map(el => {
            const lines: string[] = [`- sourceKey: "${el.key}" | tag: <${el.tagName}>`];
            if (el.classes) lines.push(`  classes: "${el.classes}"`);
            if (el.html) lines.push(`  html:\n${el.html}`);
            return lines.join('\n');
          })
          .join('\n');
        augmentedPrompt = `## Context Elements\nUse the sourceKey value below when calling update_element_by_key.\n${refs}\n\n${prompt}`;
      }

      // Build execution context for command tools — the SAME builder the MCP
      // session uses (src/mcp), over this hook's per-run batch guard.
      const { ctx: toolCtx } = buildToolCtx({
        doc,
        dispatch,
        claimSnapshot,
        takeSnapshot,
        selectedElementKey: selectedKey,
        getScannedElements: () => scannedElementsRef.current,
        getCurrentPageFile: getCurrentPageFile ?? (() => null),
        pushStructuralUndo,
        availability: {
          hasPexelsKey: Boolean(config?.pexelsApiKey),
          hasImageGen: resolveImageGen(config ?? null) !== null,
        },
        componentLibrary,
        layoutLibrary: layouts,
        // canUndo/canRedo are booleans captured per render — staleness within a
        // batch is acceptable (the stack only changes via this same batch).
        history: { undo, redo, canUndo: () => canUndo, canRedo: () => canRedo },
      }, batchRef.current);

      const allTools = generateCommandTools(toolCtx) as ToolSet;

      // Track tool calls for the structured activity feed
      const toolCallLog: ToolCallLogEntry[] = [];
      let activities: AIActivity[] = [];
      let thoughts: AIThought[] = [];
      let streamedText = '';
      let textAnchors: NonNullable<AIMessage['textAnchors']> = [];
      // One thought block per step, anchored to the activity row it precedes so the
      // finished message reads in real order. Blocks are appended, never replaced —
      // overwriting one string lost every step's reasoning but the last.
      // Reasoning arrives token-by-token, and updateMessage re-renders every
      // useAI() consumer (Layers tree, every Pages node). Publishing at most
      // ~10×/s costs nothing visible and keeps a 50s thinking phase off the
      // critical path. thoughtsDirty carries the tail into the next flush.
      let thoughtFlushAt = 0;
      let thoughtsDirty = false;
      const THOUGHT_FLUSH_MS = 100;
      const publishThoughts = () => {
        thoughtsDirty = false;
        thoughtFlushAt = Date.now();
        updateMessage(assistantMsgId, { thoughts, status: 'streaming' });
      };
      const recordThought = (text: string, blockId: string) => {
        thoughts = upsertThought(thoughts, {
          id: blockId,
          text,
          activityIndex: activities.length,
          now: Date.now(),
        });
        thoughtsDirty = true;
        if (Date.now() - thoughtFlushAt >= THOUGHT_FLUSH_MS) publishThoughts();
      };
      /** Close every open block — the step stopped thinking and started doing.
       *  Also the flush point for any throttled tail. */
      const settleThoughts = () => {
        const closed = closeThoughts(thoughts, Date.now());
        if (closed === thoughts && !thoughtsDirty) return;
        thoughts = closed;
        thoughtsDirty = false;
        updateMessage(assistantMsgId, { thoughts });
      };
      // The single settle for a cancelled run — used by onAbort (SDK graceful
      // abort part) and the thrown-AbortError catch net. Keep it one mechanism.
      const settleCancelled = () => {
        settleThoughts(); // a Stop mid-thought must not leave the block counting forever
        const settled = buildCancelledSettle(activities, streamedText);
        activities = settled.activities;
        updateMessage(assistantMsgId, settled);
      };
      const pushActivity = (toolName: string, label: string, key?: string) => {
        activities = [...activities, {
          id: `${assistantMsgId}-a${activities.length}`,
          toolName,
          label,
          status: 'running',
          key,
          startedAt: Date.now(),
        }];
        updateMessage(assistantMsgId, { activities, status: 'streaming' });
      };
      // A new tool call means we recovered from any in-flight retry — settle the
      // synthetic rate_limit rows so they stop spinning forever (they resolve at
      // run end otherwise). No-op when none are running.
      const resolveRetryRows = () => {
        if (!activities.some(a => a.status === 'running' && a.toolName === 'rate_limit')) return;
        activities = activities.map(a =>
          a.status === 'running' && a.toolName === 'rate_limit' ? { ...a, status: 'done', detail: 'recovered' } : a);
        updateMessage(assistantMsgId, { activities, status: 'streaming' });
      };

      // Track active keys for activity indicators. The FIFO carries the call's
      // (toolName, args) so the touched badge can read created ids from the
      // RESULT (add_page_content etc. only know their element id there).
      const activeKeysList: string[] = [];
      const pendingKeyFifo: Array<{ toolName: string; args: Record<string, unknown> }> = [];
      // Canvas overlays can only anchor to element keys — page:/variable: keys
      // (panel indicators) never resolve in the iframe and would pin the
      // bridge's unresolved-retry flag, rebuilding overlays on every RENDER.
      const canvasHighlightKeys = () =>
        activeKeysList.filter(k => !k.startsWith('page:') && !k.startsWith('variable:'));
      // runActive rides every dispatch: the bridge gates the one-by-one commit
      // stagger on it. It CANNOT be inferred from keys at RENDER time — the
      // first commit's RENDER reliably beats the first result-time key
      // dispatch (confirmed via [SQ-DBG] runtime logs 2026-07-23).
      const dispatchHighlights = (runActive: boolean) =>
        window.dispatchEvent(new CustomEvent('sq:ai-active-highlights', {
          detail: { keys: runActive ? canvasHighlightKeys() : [], runActive },
        }));
      dispatchHighlights(true); // run started — arm BEFORE any tool can commit

      // Live canvas preview while tool-call args stream — breakpoint read at
      // emit time (ref), so a mid-run switch follows the user (task-129).
      const { emit, endEmit } = createPreviewDispatchers(breakpointRef);
      const previewFeed = new StreamPreviewFeed(emit, endEmit);

      try {
        // Build conversation history from previous completed messages
        const history: { role: 'user' | 'assistant' | 'system'; content: string }[] = chatHistory
          .filter(m => m.id !== assistantMsgId && m.content && m.status !== 'streaming')
          .slice(-20)
          // Activities re-serialize as the text action log so continue runs
          // still see what was already done.
          .map(m => ({
            role: m.role,
            content: m.activities?.length ? `${formatActivitiesForModel(m.activities)}\n\n${m.content}` : m.content,
          }));

        // Token guard: drop oldest history when the request would blow the context window.
        // ponytail: chars/4 estimate; real tokenizer if this misfires in practice
        const MAX_PROMPT_CHARS = 400_000; // ~100k tokens
        const historyMsgs = [...history];
        while (historyMsgs.length > 2 && (systemPrompt.length + augmentedPrompt.length + historyMsgs.reduce((n, m) => n + m.content.length, 0)) > MAX_PROMPT_CHARS) {
          historyMsgs.shift();
        }

        const messages: AgentMessage[] = [
          { role: 'system', content: systemPrompt, stableChars: stablePrompt.length },
          ...historyMsgs.slice(0, -1),
          { role: 'user', content: augmentedPrompt },
        ];

        let completionSave: Promise<void> | null = null;
        const agentCallbacks: AgentCallbacks = {
            onText: (text) => {
              if (!isLive()) return;
              // `text` is the whole reply so far: text that grows after a tool row starts a new run there.
              if (text.length > streamedText.length && textAnchors[textAnchors.length - 1]?.activityIndex !== activities.length) {
                textAnchors = [...textAnchors, { activityIndex: activities.length, offset: streamedText.length }];
              }
              streamedText = text;
              updateMessage(assistantMsgId, {
                content: text,
                textAnchors,
                status: 'streaming',
              });
            },
            onReasoning: (text, blockId) => {
              if (!isLive()) return;
              recordThought(text, blockId);
            },
            onToolCall: (toolName, args) => {
              if (!isLive()) return;
              settleThoughts(); // thinking for this step is over — collapse the block
              resolveRetryRows(); // a real call landed → retry (if any) recovered
              // Args complete = this call's stream is over. End the feed HERE,
              // not at tool-result: tools execute eagerly, so result(A) lands
              // AFTER input-start(B) when a step carries several calls —
              // ending there set active=false mid-B and dropped every
              // remaining delta (no preview/stroke/dissolve at all for B).
              // Ending before execution also guarantees END reaches the
              // bridge before the commit's RENDER, which the pending-hold
              // swap requires (RENDER-first left a 2s duplicate section).
              previewFeed.end();
              const argsRecord = args as Record<string, unknown>;
              const affectedKey = extractAffectedKey(toolName, argsRecord);
              pendingKeyFifo.push({ toolName, args: argsRecord });
              if (affectedKey && !activeKeysList.includes(affectedKey)) {
                activeKeysList.push(affectedKey);
                markActiveKey(affectedKey);
              }
              dispatchHighlights(true);

              pushActivity(toolName, formatToolCallAction(toolName, args), affectedKey ?? undefined);
            },
            // One feed line per 429 the SDK is retrying. toolName 'rate_limit'
            // never matches a real tool, so resolveActivity skips it; the row
            // spins through the backoff and finalizeActivities settles it at
            // run end (done on recovery, error on final failure).
            onRateLimit: (status) => { if (isLive()) pushActivity('rate_limit',
              status === 429 ? 'Rate-limited by provider — retrying…' : 'Provider unavailable — retrying…'); },
            onToolInputStart: (toolName) => { if (isLive()) previewFeed.start(toolName); },
            onToolInputDelta: (delta) => { if (isLive()) previewFeed.delta(delta); },
            // Feed ends in onToolCall (see comment there); the bridge's
            // pending-hold keeps the container visible through execution
            // until the commit's RENDER swaps it out.
            onToolResult: (toolName, result) => {
              if (!isLive()) return;
              const typedResult = result as Record<string, unknown>;
              const success = typedResult?.success !== false && !typedResult?.error;
              // The confirm gate held a tool for the user's OK (CONFIRM_RULE): the agent asks next — not a failure.
              const waiting = typedResult?.needsConfirmation === true;
              const message = (typedResult?.message as string) || (typedResult?.error as string) || `${toolName} completed`;

              if (!success && !waiting) {
                console.error(`[AI] Tool "${toolName}" failed:`, message, typedResult);
              }

              toolCallLog.push({
                tool: toolName,
                params: {},
                result: { success, message },
                timestamp: Date.now(),
              });

              const pendingCall = pendingKeyFifo.shift() ?? null;
              if (pendingCall && success) {
                const touchedKey = extractTouchedKey(pendingCall.toolName, pendingCall.args, typedResult);
                if (touchedKey) {
                  recordTouchedKey(touchedKey);
                  // Creates only know their element id HERE (activityKeys.ts) —
                  // join the live-highlight set so a new section carries the
                  // orbit stroke until the run ends, like arg-keyed edits do.
                  if (!activeKeysList.includes(touchedKey)) {
                    activeKeysList.push(touchedKey);
                    markActiveKey(touchedKey);
                    dispatchHighlights(true);
                  }
                }
              }

              // strip the " — " prefix formatToolResultSuffix carries from the old text log
              const detail = waiting ? 'waiting for your OK' : success ? formatToolResultSuffix(toolName, typedResult).replace(/^ — /, '') : 'This action could not finish.';
              activities = resolveActivity(activities, toolName, success || waiting, detail);
              updateMessage(assistantMsgId, { activities, status: 'streaming' });
            },
            onComplete: (fullText, meta) => {
              if (!isLive()) { settleCancelled(); return; }
              settleThoughts(); // a run that never called a tool still has an open block
              clearActiveKeys();
              dispatchHighlights(false);

              // The runner's callback is synchronous. Retain its async save
              // completion and await it below before ending this run.
              completionSave = saveAll().then(() => {
              if (!isLive()) { settleCancelled(); return; }
              // meta is absent only for the dev mock runner — treat as a clean stop.
              const { state, fallbackText } = resolveFinishState({
                finishReason: meta?.finishReason ?? 'stop',
                stepsUsed: meta?.stepsUsed ?? 0,
                stepCap: meta?.stepCap ?? 40,
                toolCalls: toolCallLog.length,
                fullText,
              });
              const displayText = fullText || fallbackText;

              activities = finalizeActivities(activities, state === 'failed' ? 'error' : 'done');
              updateMessage(assistantMsgId, {
                content: displayText,
                // The anchors index the streamed text: a reply that isn't its continuation (a fallback) shows after the feed.
                textAnchors: displayText.startsWith(streamedText) ? textAnchors : undefined,
                activities,
                status: state === 'needs-continue' ? 'needs-continue' : state === 'failed' ? 'error' : 'complete',
                failure: state === 'failed' ? 'unknown' : undefined,
              });

              if (state !== 'failed' && toolCallLog.length > 0) {
                const successCount = toolCallLog.filter(t => t.result.success).length;
                toast.success(t("Executed {0} action{1}", { 0: successCount, 1: successCount !== 1 ? 's' : '' }));
              }

              // Big tasks: resume a step-capped run automatically instead of
              // parking on the Continue button. Bounded per user prompt; the
              // batch snapshot is kept, so one Cmd+Z still reverts everything.
              if (shouldAutoContinue(state, autoContinueRoundsRef.current)) {
                autoContinueRoundsRef.current += 1;
                toast(`Step limit hit — continuing (${autoContinueRoundsRef.current}/${MAX_AUTO_CONTINUES})`);
                // Defer so this run's finally block unwinds (isGenerating/abortRef)
                // before the next run arms them.
                setTimeout(() => {
                  if (runNumberRef.current === runNumber && activeSessionRef.current === runSession && !abortController.signal.aborted) {
                    void submitAgentPrompt(CONTINUE_PROMPT, undefined, { continueRun: true });
                  }
                }, 0);
              }
              }, error => {
                console.error('[AI] completion save failed:', error);
                setRunError('save');
                activities = finalizeActivities(activities, 'error');
                updateMessage(assistantMsgId, {
                  content: fullText,
                  activities, status: 'error', failure: 'save',
                });
              });
            },
            onAbort: () => {
              if (ownsRun()) { clearActiveKeys(); dispatchHighlights(false); }
              settleCancelled();
            },
            onError: (error) => {
              if (!isLive()) { settleCancelled(); return; }
              console.error('[AI] request failed:', error);
              const failure = classifyAIFailure(error);
              settleThoughts();
              clearActiveKeys();
              dispatchHighlights(false);
              setRunError(failure);
              activities = finalizeActivities(activities, 'error');
              updateMessage(assistantMsgId, {
                content: streamedText,
                failure,
                activities,
                status: 'error',
              });
            },
          };

        if (isMockEnabled()) {
          await runMockAgent(allTools, agentCallbacks, augmentedPrompt, { currentPageId });
        } else {
          await generateWithTools(config, messages, allTools, agentCallbacks, abortController.signal);
        }
        await completionSave;
      } catch (err) {
        if (isLive() && (err as Error)?.name !== 'AbortError') {
          console.error('[AI] request failed:', err);
          const failure = classifyAIFailure(err);
          setRunError(failure);
          settleThoughts();
          activities = finalizeActivities(activities, 'error');
          updateMessage(assistantMsgId, {
            status: 'error',
            content: streamedText, failure, activities,
          });
        } else {
          // Second net: SDK v6 aborts settle via onAbort (graceful 'abort' part,
          // no throw) — this branch only catches a genuinely thrown AbortError
          // from mock/misc paths.
          settleCancelled();
        }
      } finally {
        if (ownsRun()) {
          dispatchHighlights(false); // idempotent; covers the abort path
          // Cancelled runs restore original text; no commit follows (task-128).
          previewFeed.end(abortController.signal.aborted);
          setIsGenerating(false);
          abortRef.current = null;
        }
      }
    },
    [
      config, doc, contextElements, clearContextElements, scannedElements,
      dispatch, takeSnapshot, claimSnapshot, undo, redo, canUndo, canRedo, componentLibrary, layouts, currentPageId, selectedKey, projectId,
      getCurrentPageFile, pushStructuralUndo,
      setError, setStreamedContent, setIsGenerating, addMessage, updateMessage, abortRef,
      markActiveKey, clearActiveKeys, recordTouchedKey, saveAll,
    ],
  );

  /** Cancel ongoing generation */
  const cancelGeneration = useCallback(() => {
    abortRef.current?.abort();
    setIsGenerating(false);
    clearActiveKeys();
    // runActive:false keeps the contract uniform — the bridge must not rely on
    // the keys-length fallback (task-126 C1).
    window.dispatchEvent(new CustomEvent('sq:ai-active-highlights', { detail: { keys: [], runActive: false } }));
  }, [abortRef, setIsGenerating, clearActiveKeys]);

  return {
    submitAgentPrompt,
    cancelGeneration,
  };
}

/** Format a tool call into a human-readable action line */
export function formatToolCallAction(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case 'update_element_by_key': {
      const parts: string[] = [];
      if (args.classes !== undefined) parts.push('classes');
      if (args.textContent !== undefined) parts.push('text');
      return t("Updating {0} on {1}", { 0: parts.join(' & '), 1: args.sourceKey });
    }
    case 'add_page': {
      const page = (args.page as Record<string, unknown>) || args;
      return t("Creating page \"{0}\"", { 0: page?.name || 'Untitled' });
    }
    case 'update_page':
      return t("Renaming page to \"{0}\"", { 0: args.name });
    case 'remove_page':
      return t("Deleting page {0}", { 0: args.pageId });
    case 'read_source_elements':
      return t("Reading available source elements");
    case 'read_page_content':
      return t("Reading page elements");
    case 'read_component_content':
      return t("Reading element markup");
    case 'read_element_html':
      return args.sourceKey ? t("Reading HTML for {0}", { 0: args.sourceKey }) : t("Reading page HTML structure");
    case 'verify_layout':
      return t("Verifying layout of {0} element{1}", { 0: (args.keys as string[])?.length ?? 0, 1: ((args.keys as string[])?.length ?? 0) !== 1 ? 's' : '' });
    case 'add_page_content':
      return t("Adding {0} to page", { 0: (args.type as string) || 'content' });
    case 'read_variables':
      return t("Reading design variables");
    case 'update_variable_value':
      return t("Updating variable {0}", { 0: args.variableId });
    case 'create_variable':
      return t("Creating variable --{0}", { 0: args.name });
    case 'delete_variable':
      return t("Deleting variable {0}", { 0: args.variableId });
    // Blog tools
    case 'read_collections':
      return args.collectionName ? t("Reading collection \"{0}\"", { 0: args.collectionName }) : t("Reading content collections");
    case 'read_collection_posts':
      return t("Reading posts in \"{0}\"", { 0: args.collectionName });
    case 'read_blog_slots':
      return t("Reading blog slots");
    case 'read_blog_card_template':
      return t("Reading card template for {0}", { 0: args.slotKey });
    case 'read_post_page':
      return t("Reading post page bindings");
    case 'create_collection':
      return t("Creating collection \"{0}\"", { 0: args.name });
    case 'create_post':
      return t("Creating post \"{0}\" in \"{1}\"", { 0: args.slug, 1: args.collectionName });
    case 'update_post':
      return t("Updating post \"{0}\" in \"{1}\"", { 0: args.slug, 1: args.collectionName });
    case 'delete_post':
      return t("Deleting post \"{0}\" from \"{1}\"", { 0: args.slug, 1: args.collectionName });
    case 'update_blog_card_classes':
      return t("Updating card \"{0}\" classes", { 0: args.selector });
    case 'update_blog_settings':
      return t("Updating blog slot settings");
    case 'bind_blog_collection':
      return t("Binding slot to collection \"{0}\"", { 0: args.collectionName });
    case 'set_post_page_binding':
      return t("Binding \"{0}\" to field \"{1}\"", { 0: args.elementKey, 1: args.fieldName });
    // Structure tools
    case 'delete_element':
      return t("Deleting element {0}", { 0: args.elementId });
    case 'delete_instance_child':
      return t("Deleting \"{0}\" inside {1}", { 0: args.selector, 1: args.instanceId });
    case 'move_element':
      return t("Moving element {0}", { 0: args.elementKey });
    case 'reorder_page_elements':
      return t("Reordering page sections");
    case 'set_child_order':
      return t("Reordering children of {0}", { 0: args.parentKey });
    case 'set_grid_placement':
      return t("Placing {0} in the grid", { 0: args.key });
    // Drawn elements
    case 'add_drawn_element':
      return t("Drawing <{0}> on the page", { 0: args.tag });
    case 'delete_drawn_element':
      return t("Deleting drawn element {0}", { 0: args.elementKey });
    // History
    case 'undo':
      return t("Undoing the last change");
    case 'redo':
      return t("Redoing the last change");
    // Link / image / SEO
    case 'update_link_attribute':
      return t("Setting link {0} on {1}", { 0: args.attribute, 1: args.elementId });
    case 'unwrap_link':
      return t("Removing link wrapper from {0}", { 0: args.elementId });
    case 'generate_image': {
      const p = typeof args.prompt === 'string' ? args.prompt : '';
      return p ? t("Generating image: \"{0}{1}\" (can take a minute)", { 0: p.slice(0, 50), 1: p.length > 50 ? '…' : '' }) : t("Generating image (can take a minute)");
    }
    case 'search_stock_images':
      return t("Searching stock photos: \"{0}\"", { 0: args.query });
    case 'update_image_attribute':
      return t("Setting image {0} on {1}", { 0: args.attribute, 1: args.elementId });
    case 'update_page_seo':
      return t("Updating SEO {0}", { 0: args.field });
    // Pages / project
    case 'set_home_page':
      return t("Making {0} the home page", { 0: args.pageId });
    case 'move_page':
      return t("Moving page {0}", { 0: args.pageId });
    case 'rename_project':
      return t("Renaming project to \"{0}\"", { 0: args.name });
    case 'export_project':
      return t("Exporting the project as a zip");
    case 'deploy_project':
      return t("Deploying to {0}", { 0: args.provider });
    // Variables schema
    case 'create_variable_collection':
      return t("Creating variable collection \"{0}\"", { 0: args.name });
    case 'delete_variable_collection':
      return t("Deleting variable collection {0}", { 0: args.collectionId });
    case 'add_variable_mode':
      return t("Adding mode \"{0}\"", { 0: args.name });
    case 'rename_variable_mode':
      return t("Renaming mode to \"{0}\"", { 0: args.name });
    case 'rename_variable':
      return t("Renaming variable to --{0}", { 0: args.name });
    case 'retype_variable':
      return t("Changing variable type to {0}", { 0: args.newType });
    // Blog schema
    case 'add_collection_field':
      return t("Adding field \"{0}\" to \"{1}\"", { 0: args.fieldName, 1: args.collectionName });
    case 'rename_collection_field':
      return t("Renaming field \"{0}\" to \"{1}\"", { 0: args.fieldName, 1: args.newName });
    case 'delete_collection_field':
      return t("Deleting field \"{0}\" from \"{1}\"", { 0: args.fieldName, 1: args.collectionName });
    case 'rename_collection':
      return t("Renaming collection \"{0}\" to \"{1}\"", { 0: args.collectionName, 1: args.newName });
    case 'delete_collection':
      return t("Deleting collection \"{0}\"", { 0: args.collectionName });
    case 'bind_content_field':
      return t("Binding \"{0}\" to field \"{1}\"", { 0: args.elementKey, 1: args.fieldName });
    case 'unbind_blog_slot':
      return t("Unbinding blog slot {0}", { 0: args.slotKey });
    // Instances
    case 'reset_instance':
      return t("Resetting instance {0} to master", { 0: args.instanceId });
    case 'make_component':
      return t("Making a component from {0}", { 0: args.key });
    case 'create_component':
      return t("Creating component \"{0}\"", { 0: args.name });
    case 'set_component_category':
      return args.category ? t("Moving {0} into folder \"{1}\"", { 0: args.componentPath, 1: args.category }) : t("Removing {0} from its folder", { 0: args.componentPath });
    case 'place_component_instance':
      return t("Placing component {0}", { 0: args.componentPath });
    case 'push_instance_to_source':
      return t("Pushing {0} to source", { 0: args.instanceId });
    // Layouts
    case 'read_layouts':
      return t("Reading available layouts");
    case 'apply_layout':
      return t("Applying layout \"{0}\"", { 0: args.layoutName });
    case 'detach_layout':
      return t("Detaching the page layout");
    case 'set_layout_props':
      return t("Updating layout props");
    default:
      return toolName;
  }
}

/** Format a tool result into a short suffix appended to the action line */
function formatToolResultSuffix(toolName: string, result: Record<string, unknown>): string {
  if (result?.error) {
    return t(" — failed: {0}", { 0: result.error });
  }
  if (result?.cancelled) {
    return t(" — cancelled by user");
  }
  if (result?.success === false && result?.message) {
    return t(" — failed: {0}", { 0: result.message });
  }

  switch (toolName) {
    case 'read_source_elements': {
      const elements = result?.elements as Array<unknown> | undefined;
      return t(" — {0} source elements", { 0: elements?.length || 0 });
    }
    case 'read_page_content': {
      const elements = result?.elements as Array<unknown> | undefined;
      return t(" — {0} elements", { 0: elements?.length || 0 });
    }
    case 'read_component_content':
      return result?.markup ? t(" — done") : t(" — not found");
    case 'read_element_html': {
      const truncated = result?.truncated ? ' (truncated)' : '';
      return result?.html ? t(" — done{0}", { 0: truncated }) : t(" — not found");
    }
    case 'verify_layout': {
      const findings = result?.findings as Array<unknown> | undefined;
      if (!findings) return t(" — failed");
      return findings.length === 0 ? t(" — clean") : t(" — {0} finding{1}", { 0: findings.length, 1: findings.length !== 1 ? 's' : '' });
    }
    case 'add_page_content': {
      if (result?.success === false) return t(" — failed");
      if ((result?.data as { emptyFrame?: boolean } | undefined)?.emptyFrame) return t(" — empty frame (invisible until filled)");
      return t(" — done");
    }
    case 'read_variables': {
      const cols = result?.collections as Array<unknown> | undefined;
      const varCount = cols?.reduce((n: number, c: unknown) => n + ((c as { variables?: unknown[] }).variables?.length ?? 0), 0) ?? 0;
      return t(" — {0} variable{1}", { 0: varCount, 1: varCount !== 1 ? 's' : '' });
    }
    case 'update_variable_value':
    case 'create_variable':
    case 'delete_variable':
      return result?.success !== false ? t(" — done") : t(" — failed");
    // Blog read tools
    case 'read_collections': {
      const cols = result?.collections as Array<unknown> | undefined;
      return t(" — {0} collection{1}", { 0: cols?.length ?? 0, 1: cols?.length !== 1 ? 's' : '' });
    }
    case 'read_collection_posts': {
      const posts = result?.posts as Array<unknown> | undefined;
      return t(" — {0} post{1}", { 0: posts?.length ?? 0, 1: posts?.length !== 1 ? 's' : '' });
    }
    case 'read_blog_slots': {
      const slots = result?.slots as Array<unknown> | undefined;
      return t(" — {0} slot{1}", { 0: slots?.length ?? 0, 1: slots?.length !== 1 ? 's' : '' });
    }
    case 'read_blog_card_template': {
      const selectors = result?.selectors as Array<unknown> | undefined;
      return t(" — {0} selectors", { 0: selectors?.length ?? 0 });
    }
    case 'read_post_page':
      return result?.collectionId ? t(" — done") : t(" — not found");
    // Blog write tools
    case 'create_collection':
    case 'create_post':
    case 'update_post':
    case 'delete_post':
    case 'update_blog_card_classes':
    case 'update_blog_settings':
    case 'bind_blog_collection':
    case 'set_post_page_binding':
      return result?.success !== false ? t(" — done") : t(" — failed");
    case 'deploy_project': {
      const url = (result?.data as { url?: string } | undefined)?.url;
      return url ? t(" — live at {0}", { 0: url }) : t(" — done");
    }
    case 'make_component':
    case 'create_component': {
      const name = (result?.data as { componentName?: string } | undefined)?.componentName;
      return name ? t(" — created \"{0}\"", { 0: name }) : t(" — done");
    }
    case 'read_layouts': {
      const layouts = result?.layouts as Array<unknown> | undefined;
      return t(" — {0} layout{1}", { 0: layouts?.length ?? 0, 1: layouts?.length !== 1 ? 's' : '' });
    }
    case 'generate_image':
      if (result?.success === false) return result?.cancelled ? t(" — cancelled") : t(" — failed");
      return t(" — stored, apply next");
    case 'search_stock_images': {
      const photos = result?.photos as Array<unknown> | undefined;
      return photos ? t(" — {0} candidate{1}", { 0: photos.length, 1: photos.length !== 1 ? 's' : '' }) : t(" — done");
    }
    default:
      return result?.success !== false ? t(" — done") : '';
  }
}
