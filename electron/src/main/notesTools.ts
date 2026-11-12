import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolContext } from './modules';
import { libraryFor, SERVER_NOTE, type NoteLibrary } from './notes';

/// The text of a search, as the macOS tool prints it (Vibex/MCP/Tools/NotesTools.swift).
export function report(library: NoteLibrary, query: string, limit: number): string {
  const c = library.config;
  const places = [c.memory && `memory: ${c.memory}`, c.notes && `notes: ${c.notes}`].filter(Boolean);
  if (!places.length) return 'This project has no memory store or notes folder. Keep a .claude/memory folder, or choose a notes folder in the Notes view.';
  const matches = library.search(query);
  const lines = [`${matches.length} of ${library.notes.length} notes match "${query}" (${places.join('; ')})`];
  for (const m of matches.slice(0, limit)) {
    lines.push(m.note.file);
    lines.push(...m.lines.map((l) => `  ${l.number}: ${l.text}`));
  }
  if (matches.length > limit) lines.push(`… ${matches.length - limit} more; narrow the query or raise limit.`);
  return lines.join('\n');
}

/// Read-only search over the project's notes: its memory store and its vault notes folder. No write tool: Claude keeps
/// writing memory files itself.
export function notesTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool('notes_search', {
    description: 'Search this project\'s notes, read-only: its Claude memory store (MEMORY.md and the fact files) and its Obsidian notes folder (chosen in the Notes view). Every word must match, ignoring case; "#tag" matches a tag. Returns each matching file\'s absolute path and up to three matching lines. Files whose names look like credentials are never searched.',
    inputSchema: {
      query: z.string().describe('Words to find, e.g. "deploy gate" or "#decision"'),
      limit: z.number().int().optional().describe('How many files at most (default 20, max 100)'),
      ...ctx.scope,
    },
  }, async ({ query, limit, project_path }: { query: string; limit?: number; project_path?: string }) => {
    const target = ctx.project(project_path);
    if (target.server) throw new Error(SERVER_NOTE);
    const library = await libraryFor(target);
    return ctx.said(report(library, query, Math.min(Math.max(limit ?? 20, 1), 100)), target);
  });
}
