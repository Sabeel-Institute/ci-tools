import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * No tracked source file holds a NUL byte, or another control byte that makes
 * tools treat it as binary.
 *
 *   sabeel-ci check-text-sources
 *
 * A functions source file once held a raw NUL inside a template literal used
 * as a Map-key separator. It compiled and ran, but `file` called it "data", Git
 * diffed it as binary, and grep silently skipped the whole file: during a
 * dead-code audit a live constant looked unreferenced and was nearly deleted.
 * A search that answers "no matches" for a file it cannot read is worse than
 * none. Write control characters as escapes (`\u0000`): the same value at run
 * time, and a source every tool reads.
 */
export const SOURCES = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|yml|yaml|sh|rules|gradle|py)$/;

/** The first control byte in `buffer` that is not tab, LF, VT, FF or CR: { index, byte }, or null. */
export function controlByte(buffer) {
  const index = buffer.findIndex((byte) => byte < 9 || (byte > 13 && byte < 32));
  return index < 0 ? null : { index, byte: buffer[index] };
}

/** Every tracked source file in the working directory's repository with a control byte: { file, line, byte }. */
export function offenders(files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter((file) => SOURCES.test(file))) {
  const found = [];
  for (const file of files) {
    let buffer;
    try {
      buffer = readFileSync(file);
    } catch {
      continue; // deleted or unreadable in the working tree: not this check's business
    }
    const bad = controlByte(buffer);
    if (bad) found.push({ file, line: buffer.subarray(0, bad.index).toString('utf8').split('\n').length, byte: bad.byte });
  }
  return { files: files.length, found };
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 2) {
    console.error('usage: sabeel-ci check-text-sources');
    process.exit(2);
  }
  const { files, found } = offenders();
  if (!found.length) {
    console.log(`check-text-sources: ${files} files, all plain text`);
    process.exit(0);
  }
  console.error('check-text-sources: control bytes in source files');
  for (const { file, line, byte } of found) {
    console.error(`  ${file}:${line}  byte 0x${byte.toString(16).padStart(2, '0')}  write it as an escape (e.g. \\u0000) so grep and Git can read the file`);
  }
  process.exit(1);
}
