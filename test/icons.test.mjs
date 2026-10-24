import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FONT, GLYPHMAP, ICONS_DIR, NAMES, buildIcons, iconProblems, undrawnGlyphs } from '../lib/icons.mjs';
import { writeIcons } from '../scripts/icons.mjs';

// A five-glyph cut of Material Icons (Apache 2.0) in @expo/vector-icons' layout.
const VECTOR_ICONS = resolve(import.meta.dirname, 'fixtures/vector-icons');
const fixtures = [];

afterEach(() => {
  for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** An app repository whose app/ installs the fixture @expo/vector-icons and lists `names`. */
function app(names) {
  const root = mkdtempSync(join(tmpdir(), 'ci-tools-icons-'));
  fixtures.push(root);
  mkdirSync(join(root, 'app/node_modules/@expo'), { recursive: true });
  writeFileSync(join(root, 'app/package.json'), '{ "name": "app", "private": true }\n');
  symlinkSync(VECTOR_ICONS, join(root, 'app/node_modules/@expo/vector-icons'));
  mkdirSync(join(root, ICONS_DIR), { recursive: true });
  writeFileSync(join(root, ICONS_DIR, NAMES), `${JSON.stringify(names)}\n`);
  return root;
}

describe('icon font', () => {
  it('maps each name to its Material Icons code point and draws every one', async () => {
    const { glyphMap, font } = await buildIcons(['search', 'add'], app([]));
    expect(glyphMap).toEqual({ add: 57669, search: 59574 });
    expect(undrawnGlyphs(font, glyphMap)).toEqual([]);
  });

  it('names a glyph the font does not draw', async () => {
    const root = app([]);
    const { font } = await buildIcons(['add'], root);
    expect(undrawnGlyphs(font, { add: 57669, close: 58829, edit: 58313 })).toEqual(['close', 'edit']);
  });

  it('refuses a name Material Icons does not have', async () => {
    await expect(buildIcons(['add', 'no-such-icon'], app([]))).rejects.toThrow('not Material Icons glyph names: no-such-icon');
  });

  it('writes files that pass, and fails each way they can lag', async () => {
    const root = app(['add', 'close']);
    await writeIcons(root);
    expect(await iconProblems(root)).toEqual([]);

    // A name added without running sabeel-ci icons.
    writeFileSync(join(root, ICONS_DIR, NAMES), '["add", "close", "edit"]\n');
    expect(await iconProblems(root)).toEqual([`out of date with ${NAMES} (run sabeel-ci icons): ${GLYPHMAP}, ${FONT}`]);

    // A font that lost a glyph the map still names.
    await writeIcons(root);
    const map = JSON.parse(readFileSync(join(root, ICONS_DIR, GLYPHMAP), 'utf8'));
    writeFileSync(join(root, ICONS_DIR, FONT), (await buildIcons(['add', 'close'], root)).font);
    expect(undrawnGlyphs(readFileSync(join(root, ICONS_DIR, FONT)), map)).toEqual(['edit']);
    expect(await iconProblems(root)).toEqual([
      `out of date with ${NAMES} (run sabeel-ci icons): ${FONT}`,
      `${ICONS_DIR}/${FONT} does not draw: edit`,
    ]);

    // Out of order, or empty.
    writeFileSync(join(root, ICONS_DIR, NAMES), '["close", "add", "edit"]\n');
    expect(await iconProblems(root)).toContain(`${ICONS_DIR}/${NAMES} must list each name once, in order`);
    writeFileSync(join(root, ICONS_DIR, NAMES), '[]\n');
    expect(await iconProblems(root)).toContain(`${ICONS_DIR}/${NAMES} names no icons`);
  });
});
