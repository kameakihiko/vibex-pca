// The words on a file chip of a server chat (chat-first plan, step P2). No DOM here, so the tests read it in Node.

export interface ChipUpload {
  phase: 'waiting' | 'sending' | 'saving' | 'done' | 'failed' | 'refused';
  percent: number;
  /// The file's size in MiB, one decimal.
  mib: number;
  error: string | null;
}

export interface ChipLine {
  text: string;
  tone: 'quiet' | 'busy' | 'ok' | 'error';
  /// 0 to 100 while bytes go; null when no bar shows.
  bar: number | null;
}

/// The line under the file name, or null for a file that waits for Send.
export function uploadLine(upload: ChipUpload | null | undefined): ChipLine | null {
  if (!upload) return null;
  switch (upload.phase) {
    case 'waiting':
      return null;
    case 'sending':
      return { text: `Sending ${upload.percent}% of ${upload.mib} MiB`, tone: 'busy', bar: upload.percent };
    case 'saving':
      return { text: 'Saving on the server', tone: 'busy', bar: 100 };
    case 'done':
      return { text: 'On the server', tone: 'ok', bar: null };
    case 'failed':
    case 'refused':
      return { text: upload.error ?? 'The file did not go.', tone: 'error', bar: null };
  }
}
