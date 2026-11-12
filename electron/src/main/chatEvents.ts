import { randomUUID } from 'node:crypto';
import path from 'node:path';

// What `claude -p --output-format stream-json` says, what its transcript files hold, and the lines the app writes to it.
// Ported from Vibex/Claude/ClaudeEvent.swift and the capability parts of ClaudeCatalog.swift. No Electron here.

export interface ChatTool { id: string; name: string; /// String values as they are; anything else as JSON.
  input: Record<string, string> }
export interface ChatImage { mediaType: string; data: string }
export interface ChatToolResult { toolUseId: string; text: string; images: ChatImage[]; isError: boolean }
export interface ChatCommand { name: string; summary: string; argumentHint: string }
export interface ChatModelOption { value: string; title: string; summary: string; effortLevels: string[] }

export interface ChatRequest {
  id: string;
  tool: ChatTool;
  /// The input exactly as sent, because the answer has to echo it.
  rawInput: unknown;
  /// What "always allow" means here, as Claude Code suggested it.
  suggestions: unknown[] | null;
}

export type ChatEvent =
  | { type: 'started'; session: string; model: string | null; commands: string[] }
  | { type: 'permissionMode'; mode: string }
  | { type: 'textDelta'; text: string }
  | { type: 'text'; text: string }
  | { type: 'toolUse'; tool: ChatTool }
  | { type: 'toolResult'; result: ChatToolResult }
  | { type: 'userText'; text: string }
  | { type: 'userImages'; images: ChatImage[] }
  | { type: 'permission'; request: ChatRequest }
  | { type: 'permissionCancelled'; id: string }
  /// Claude Code asks for something else that a chat cannot show. It waits for an answer, so it gets one.
  | { type: 'unanswerable'; id: string; subtype: string }
  | { type: 'turnEnded'; seconds: number; isError: boolean; message: string | null }
  | { type: 'conversationReset'; session: string }
  | { type: 'status'; status: string | null }
  | { type: 'compacted' }
  | { type: 'commandsChanged'; commands: ChatCommand[] }
  | { type: 'contextUsage'; percent: number }
  | { type: 'toolStarting'; name: string }
  | { type: 'toolInputDelta'; text: string }
  | { type: 'controlFailed'; message: string; requestId?: string };

type Json = Record<string, any>;
const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/// Only these go into an <img>; a page's svg stays out, whatever it says it is.
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function imageOf(block: Json): ChatImage | null {
  const source = block.source;
  if (!isObject(source) || typeof source.data !== 'string') return null;
  const mediaType = str(source.media_type) ?? 'image/png';
  if (!IMAGE_TYPES.has(mediaType) || !/^[A-Za-z0-9+/]+={0,2}$/.test(source.data)) return null;
  return { mediaType, data: source.data };
}

const flatten = (input: Json): Record<string, string> =>
  Object.fromEntries(Object.entries(input).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(sorted(v))]));

/// As JSONSerialization's .sortedKeys: the same input reads the same each time.
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (isObject(value)) return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sorted(value[k])]));
  return value;
}

/// The first sentence, without the "(user)" Claude Code adds to say where a skill lives.
function commandSummary(text: string): string {
  const cleaned = text.replace(/\s*\([^)]*\)\s*$/, '').replace(/^\([^)]*\)\s*/, '');
  return cleaned.split('\n')[0].split('. ')[0];
}

export function commandsOf(list: unknown): ChatCommand[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((c) => {
    if (!isObject(c) || typeof c.name !== 'string' || c.name.startsWith('__')) return [];
    return [{ name: c.name, summary: commandSummary(str(c.description) ?? ''), argumentHint: str(c.argumentHint) ?? '' }];
  });
}

export function modelsOf(list: unknown): ChatModelOption[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((m) => {
    if (!isObject(m) || typeof m.value !== 'string' || typeof m.displayName !== 'string') return [];
    return [{ value: m.value, title: m.displayName, summary: str(m.description) ?? '', effortLevels: Array.isArray(m.supportedEffortLevels) ? m.supportedEffortLevels.filter((e: unknown) => typeof e === 'string') : [] }];
  });
}

/// Slash command plumbing and system reminders in a transcript are not something the person typed.
function userEvent(text: string): ChatEvent[] {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith('<') || trimmed.startsWith('[Request interrupted')) return [];
  return [{ type: 'userText', text: trimmed }];
}

function userBlock(block: Json): ChatEvent[] {
  switch (block.type) {
    case 'text':
      return userEvent(str(block.text) ?? '');
    case 'image': {
      const image = imageOf(block);
      return image ? [{ type: 'userImages', images: [image] }] : [];
    }
    case 'tool_result': {
      if (typeof block.tool_use_id !== 'string') return [];
      let text = str(block.content) ?? '';
      const images: ChatImage[] = [];
      for (const part of Array.isArray(block.content) ? block.content : []) {
        if (!isObject(part)) continue;
        if (typeof part.text === 'string') text += (text ? '\n' : '') + part.text;
        const image = part.source ? imageOf(part) : null;
        if (image) images.push(image);
      }
      return [{ type: 'toolResult', result: { toolUseId: block.tool_use_id, text, images, isError: block.is_error === true } }];
    }
    default:
      return [];
  }
}

const blocksOf = (object: Json): Json[] => (Array.isArray(object.message?.content) ? object.message.content.filter(isObject) : []);

export function parseChatLine(line: string): ChatEvent[] {
  let object: unknown;
  try {
    object = JSON.parse(line);
  } catch {
    return [];
  }
  if (!isObject(object) || typeof object.type !== 'string') return [];
  // A subagent's own steps stay inside its Agent card.
  if (typeof object.parent_tool_use_id === 'string' || object.isSidechain === true) return [];
  switch (object.type) {
    case 'system':
      switch (object.subtype) {
        case 'init': {
          if (typeof object.session_id !== 'string') return [];
          const started: ChatEvent = { type: 'started', session: object.session_id, model: str(object.model), commands: Array.isArray(object.slash_commands) ? object.slash_commands.filter((c: unknown) => typeof c === 'string') : [] };
          return typeof object.permissionMode === 'string' ? [started, { type: 'permissionMode', mode: object.permissionMode }] : [started];
        }
        case 'status': {
          const said: ChatEvent[] = object.status === null || object.status === undefined || object.status === 'compacting' ? [{ type: 'status', status: str(object.status) }] : [];
          // Its mode changes on its own too, as after a plan or a setMode: this line and each init say so.
          return typeof object.permissionMode === 'string' ? [...said, { type: 'permissionMode', mode: object.permissionMode }] : said;
        }
        case 'api_retry':
          return [{ type: 'status', status: `Claude's service did not answer. Trying again (attempt ${Number(object.attempt) || 1} of ${Number(object.max_retries) || 1}).` }];
        case 'compact_boundary':
          return [{ type: 'compacted' }];
        case 'commands_changed':
          return [{ type: 'commandsChanged', commands: commandsOf(object.commands) }];
        default:
          return [];
      }
    case 'conversation_reset':
      return typeof object.new_conversation_id === 'string' ? [{ type: 'conversationReset', session: object.new_conversation_id }] : [];
    case 'control_response': {
      const response = object.response;
      if (!isObject(response)) return [];
      if (response.subtype === 'error') return typeof response.error === 'string' ? [{ type: 'controlFailed', message: response.error, ...(typeof response.request_id === 'string' ? { requestId: response.request_id } : {}) }] : [];
      const reply = response.response;
      if (!isObject(reply) || reply.totalTokens === undefined || typeof reply.percentage !== 'number') return [];
      return [{ type: 'contextUsage', percent: Math.round(reply.percentage) }];
    }
    case 'stream_event': {
      const event = object.event;
      if (!isObject(event)) return [];
      if (event.type === 'content_block_start') {
        const block = event.content_block;
        return isObject(block) && block.type === 'tool_use' && typeof block.name === 'string' ? [{ type: 'toolStarting', name: block.name }] : [];
      }
      if (event.type !== 'content_block_delta' || !isObject(event.delta)) return [];
      if (event.delta.type === 'text_delta' && typeof event.delta.text === 'string') return [{ type: 'textDelta', text: event.delta.text }];
      if (event.delta.type === 'input_json_delta' && typeof event.delta.partial_json === 'string') return [{ type: 'toolInputDelta', text: event.delta.partial_json }];
      return [];
    }
    case 'assistant':
      return blocksOf(object).flatMap((block): ChatEvent[] => {
        if (block.type === 'text' && typeof block.text === 'string') return [{ type: 'text', text: block.text }];
        if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
          return [{ type: 'toolUse', tool: { id: block.id, name: block.name, input: flatten(isObject(block.input) ? block.input : {}) } }];
        }
        return [];
      });
    case 'user': {
      if (object.isMeta === true) return [];
      if (typeof object.message?.content === 'string') return userEvent(object.message.content);
      return blocksOf(object).flatMap(userBlock);
    }
    case 'control_request': {
      const request = object.request;
      if (typeof object.request_id !== 'string' || !isObject(request)) return [];
      if (request.subtype !== 'can_use_tool') return typeof request.subtype === 'string' ? [{ type: 'unanswerable', id: object.request_id, subtype: request.subtype }] : [];
      if (typeof request.tool_name !== 'string') return [];
      const input = isObject(request.input) ? request.input : {};
      const suggestions = Array.isArray(request.permission_suggestions) && request.permission_suggestions.length ? request.permission_suggestions : null;
      return [{ type: 'permission', request: { id: object.request_id, tool: { id: str(request.tool_use_id) ?? object.request_id, name: request.tool_name, input: flatten(input) }, rawInput: input, suggestions } }];
    }
    case 'control_cancel_request':
      return typeof object.request_id === 'string' ? [{ type: 'permissionCancelled', id: object.request_id }] : [];
    case 'result': {
      const isError = object.is_error === true;
      return [{ type: 'turnEnded', seconds: (typeof object.duration_ms === 'number' ? object.duration_ms : 0) / 1000, isError, message: isError ? str(object.result) ?? (Array.isArray(object.errors) ? str(object.errors[0]) : null) : null }];
    }
    default:
      return [];
  }
}

// ------------------------------------------------------------------ the lines the app writes to its stdin

export function userLine(text: string, images: ChatImage[] = []): string {
  if (!images.length) return JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
  const content: Json[] = images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } }));
  if (text) content.push({ type: 'text', text });
  return JSON.stringify({ type: 'user', message: { role: 'user', content } });
}

const reply = (id: string, response: Json) => JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: id, response } });

export const allowLine = (id: string, input: unknown, permissions?: unknown[] | null) =>
  reply(id, { behavior: 'allow', updatedInput: input ?? {}, ...(permissions ? { updatedPermissions: permissions } : {}) });

export const denyLine = (id: string, message: string) => reply(id, { behavior: 'deny', message });

/// A question answered: AskUserQuestion takes the answers in its input.
export const answerLine = (id: string, input: unknown, answers: Record<string, string>) =>
  reply(id, { behavior: 'allow', updatedInput: { ...(isObject(input) ? input : {}), answers } });

/// The answers to what a chat cannot show: an elicitation is declined, and anything else is refused.
export const declineLine = (id: string) => reply(id, { action: 'cancel' });
export const refuseLine = (id: string, error: string) => JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: id, error } });

export const controlLine = (subtype: string, fields: Json = {}) =>
  JSON.stringify({ type: 'control_request', request_id: randomUUID(), request: { ...fields, subtype } });

// ------------------------------------------------------------------ transcripts

/// Claude Code keeps each session as JSON lines under <config>/projects/<folder as a slug>/.
export function transcriptFile(session: string, folder: string, configDir: string): string {
  const slug = [...folder].map((c) => (/[A-Za-z0-9]/.test(c) ? c : '-')).join('');
  return path.join(configDir, 'projects', slug, `${session}.jsonl`);
}
