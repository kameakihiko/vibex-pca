---
name: pca-memory-and-notes
description: Where notes and memory live in Vibex, and how to write them. Use when the person asks to remember something, save a decision, write a note, or find an earlier fact. Write facts, not chat.
---

# Memory and notes in Vibex

Vibex has a Notes section. It lists Markdown files from two places. Claude reads and writes the same files.

## Where things live

- **Project memory:** the folder `.claude/memory` inside the project. If the project has none, Claude Code keeps one under its own folder (`projects/<project>/memory` in the Claude config folder). Put facts about this project here.
- **Notes folder:** one folder inside the person's notes vault (Obsidian). Put longer notes and plans here.
- Open the Notes section in the left bar to see both. A click opens a note. Search needs every word; `#tag` finds a tag.
- A file whose name looks like a credential ("password", "key", "token") is never listed. Do not write secrets in any note.

## What to write

Write facts that stay true and help later. Do not copy the chat.

1. One fact in each file or each short section.
2. Start with the fact, then the reason, then the date ("as of 2026-10-31").
3. Name things in full: the system, the document number, the folder. Do not write "see above" or "this".
4. Add a line `created:` and a line `review_by:` with dates.
5. Link related notes with `[[Note name]]`.

## What not to write

- Anything a person can read in the code, the files or the git history.
- Personal data: names, phone numbers, chat ids, client amounts.
- Keys, passwords, tokens.
- Steps of a task that is finished. Write the result and the decision instead.

## Before you write

1. Search the notes for the same fact. If one exists, change it; do not make a second one.
2. After you write, read the file back and check that it holds a fact and no chat text.
3. If the index file exists, add one line for the new file.
