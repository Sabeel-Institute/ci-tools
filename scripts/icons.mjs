import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FONT, GLYPHMAP, ICONS_DIR, buildIcons, readNames } from '../lib/icons.mjs';

/**
 * Writes the app's icon glyph map and font from its list of names
 * (lib/icons.mjs). Run after editing `app/src/icons/names.json`.
 *
 *   sabeel-ci icons
 */
export async function writeIcons(root = '.') {
  const { glyphMap, font } = await buildIcons(await readNames(root), root);
  await writeFile(join(root, ICONS_DIR, GLYPHMAP), `${JSON.stringify(glyphMap, null, 2)}\n`);
  await writeFile(join(root, ICONS_DIR, FONT), font);
  return { count: Object.keys(glyphMap).length, bytes: font.length };
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 2) {
    console.error('usage: sabeel-ci icons');
    process.exit(2);
  }
  try {
    const { count, bytes } = await writeIcons();
    console.log(`${ICONS_DIR}/${FONT}: ${count} icons, ${bytes} bytes`);
  } catch (error) {
    console.error(`\n${error.message}\n`);
    process.exit(1);
  }
}
