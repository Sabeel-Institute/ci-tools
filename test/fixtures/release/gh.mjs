// GitHub's CLI: records each call, with what a release would upload and the
// pull request's body, and answers as GitHub would.
import { existsSync, readFileSync } from 'node:fs';
import { log } from './log.mjs';

const args = process.argv.slice(2);
const extra = {};
const body = args.indexOf('--body-file');
if (body > 0) extra.body = readFileSync(args[body + 1], 'utf8');
const notes = args.indexOf('--notes-file');
if (notes > 0) {
  extra.notes = readFileSync(args[notes + 1], 'utf8');
  extra.assets = args.slice(notes + 2).map((path) => ({ path, exists: existsSync(path) }));
}
log('gh', extra);
if (args[0] === 'pr' && args[1] === 'create') console.log('https://github.com/Sabeel-Institute/example/pull/7');
if (args[0] === 'run' && args[1] === 'list') console.log(JSON.stringify([{ databaseId: 99 }]));
