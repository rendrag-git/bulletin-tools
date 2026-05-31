import { chmodSync } from 'node:fs';

for (const binPath of ['dist/bin/bulletin-post.js', 'dist/bin/bulletin-doctor.js']) {
  chmodSync(binPath, 0o755);
}
