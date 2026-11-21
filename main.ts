// Harness entry point: Node 22 runs `node /bot/main.ts`.
// Reads every case, answers each with solve.js's run(), and writes the
// answers out. Case shapes handled: { input: { text, header } } and a bare
// { text, header }; cases.json may be a bare array or { cases: [...] }.
// The answers are written under several names so the harness finds them
// whichever one it reads.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './solve.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const raw = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8'));
const cases = Array.isArray(raw) ? raw : raw.cases;
const answers: unknown[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  const c = cases[i] as { input?: { text: string; header: boolean }; text?: string; header?: boolean };
  const input = c.input ?? (c as { text: string; header: boolean });
  answers[i] = run(input);
}
mkdirSync(outputDir, { recursive: true });
for (const name of ['answers.json', 'results.json', 'result.json', 'output.json']) {
  writeFileSync(join(outputDir, name), JSON.stringify(answers));
}
