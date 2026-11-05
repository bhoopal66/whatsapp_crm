// Copies the MediaPipe runtime into public/ so it loads from our own
// origin. forVisionTasks(base) without useModule requests exactly these
// two; the *_module_* pair is never loaded.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(root, 'node_modules/@mediapipe/tasks-vision/wasm');
const to = join(root, 'public/meeting-effects/wasm');
const files = ['vision_wasm_internal.js', 'vision_wasm_internal.wasm'];

const missing = files.filter((f) => !existsSync(join(from, f)));
if (missing.length) {
  console.error(`copy-meeting-effects: ${missing} missing in ${from}`);
  process.exit(1);
}
mkdirSync(to, { recursive: true });
for (const f of files) copyFileSync(join(from, f), join(to, f));
console.log(`copy-meeting-effects: copied ${files.length} files`);
