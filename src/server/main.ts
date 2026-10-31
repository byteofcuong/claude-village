import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Scanner } from './scanner.js';
import { createVillageServer } from './server.js';

const POLL_MS = 1000;
const here = dirname(fileURLToPath(import.meta.url));
const claudeHome = process.env['CV_CLAUDE_HOME'] ?? join(homedir(), '.claude');
const port = Number(process.env['CV_PORT'] ?? 4717);

// A bad request or a racing file must not end a viewer that is meant to stay open for hours.
process.on('uncaughtException', (err) => console.error('uncaught:', err.message));
process.on('unhandledRejection', (err) => console.error('unhandled:', (err as Error)?.message));

const scanner = new Scanner({ claudeHome });
const village = await createVillageServer({ clientDir: join(here, '..', 'client'), port });

let lastBody = '';
async function loop() {
  try {
    const snap = await scanner.poll();
    const body = JSON.stringify({ ...snap, at: 0 });
    if (body !== lastBody) {
      lastBody = body;
      village.publish(snap);
    }
  } catch (err) {
    console.error('poll failed:', (err as Error).message);
  }
  setTimeout(() => void loop(), POLL_MS);
}
void loop();
console.log(`Claude Village: http://127.0.0.1:${village.port}`);
