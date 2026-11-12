import net from 'node:net';

// What the app does when ssh runs it as SSH_ASKPASS (fork: Askpass/vibex-askpass.c). ssh runs it for its OWN prompts
// only, with the prompt as the first argument; text the server prints can never run it. It sends the prompt and this
// ticket over the app's socket and prints the answer. Any failure prints nothing and ends with code 1, so ssh fails the
// login; nothing is ever typed into a terminal.
const WAIT_MS = 180_000;

export function runAskpassHelper(prompt: string): void {
  const socketPath = process.env.VIBEX_ASKPASS_SOCKET;
  const key = process.env.VIBEX_ASKPASS_KEY;
  const fail = () => process.exit(1);
  if (!socketPath || !key || typeof prompt !== 'string') return fail();
  const socket = net.connect(socketPath);
  const chunks: Buffer[] = [];
  const timer = setTimeout(fail, WAIT_MS);
  let answered = false;
  // After a whole reply, the socket closing is normal: stdout may still be writing, and an exit here would lose the answer.
  const failUnlessAnswered = () => { if (!answered) fail(); };
  socket.on('error', failUnlessAnswered);
  socket.on('data', (chunk: Buffer) => {
    if (answered) return;
    chunks.push(chunk);
    const reply = Buffer.concat(chunks);
    const answer = frameAnswer(reply);
    if (answer === undefined) return;
    clearTimeout(timer);
    if (answer === null) return fail();
    answered = true;
    process.stdout.write(Buffer.concat([answer, Buffer.from('\n')]), () => {
      reply.fill(0);
      process.exit(0);
    });
  });
  // The other end went before a whole reply came.
  socket.on('end', failUnlessAnswered);
  // One framed line, and the socket stays open: a Windows named pipe has no half-close (a shutdown with a read pending
  // closes both ends), so the helper must never end its side to say that the request is over.
  socket.write(`${JSON.stringify({ key, hint: process.env.SSH_ASKPASS_PROMPT ?? '', prompt })}\n`);
}

/// A reply is "NO\n", or "OK\n", the answer and "\n" (an answer never holds a line end). Undefined: not whole yet.
function frameAnswer(reply: Buffer): Buffer | null | undefined {
  const first = reply.indexOf(10);
  if (first < 0) return undefined;
  if (reply.subarray(0, first).toString() !== 'OK') return null;
  const last = reply.indexOf(10, first + 1);
  return last < 0 ? undefined : reply.subarray(first + 1, last);
}
