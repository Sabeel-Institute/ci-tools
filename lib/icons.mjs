import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import subsetFont from 'subset-font';

/**
 * An app's icon font: the Material Icons glyphs it names, and nothing else.
 *
 * The stock `@expo/vector-icons/MaterialIcons` set is 2,234 glyphs (357 KB,
 * 156 KB over the wire). On the web its font is fetched only once the first
 * icon mounts, after the bundle, and @expo/vector-icons gives it 12 s: on a
 * slow connection it lost that race and every icon on screen stayed blank. An
 * app lists the names it draws in `app/src/icons/names.json`; `sabeel-ci icons`
 * writes the glyph map and the font beside it, and the app commits all three
 * so Metro and the type checker see them without a build step.
 * `iconProblems`, run by the app's unit tests, fails when any of them lags.
 */
export const ICONS_DIR = 'app/src/icons';
export const NAMES = 'names.json';
export const GLYPHMAP = 'glyphmap.json';
export const FONT = 'icons.ttf';

const UPSTREAM = '@expo/vector-icons/build/vendor/react-native-vector-icons';

/**
 * The glyph map and font for `names`, from the @expo/vector-icons the app at
 * `root` installs (its version, not this package's).
 *
 * @param {string[]} names
 * @param {string} [root] the app repository
 * @returns {Promise<{ glyphMap: Record<string, number>, font: Buffer }>}
 */
export async function buildIcons(names, root = '.') {
  const require = createRequire(join(resolve(root), 'app', 'package.json'));
  /** @type {Record<string, number>} */
  const upstream = require(`${UPSTREAM}/glyphmaps/MaterialIcons.json`);
  const unknown = names.filter((name) => !Object.hasOwn(upstream, name));
  if (unknown.length) throw new Error(`not Material Icons glyph names: ${unknown.join(', ')}`);
  const glyphMap = Object.fromEntries([...names].sort().map((name) => [name, upstream[name]]));
  const full = await readFile(require.resolve(`${UPSTREAM}/Fonts/MaterialIcons.ttf`));
  const font = await subsetFont(full, String.fromCodePoint(...Object.values(glyphMap)), { targetFormat: 'truetype' });
  return { glyphMap, font };
}

/**
 * The names in `glyphMap` whose code point the TrueType `font` does not draw:
 * unmapped in its Unicode cmap (format 4 or 12), mapped to .notdef, or mapped
 * to a glyph with no outline. Read from the bytes, independent of the tool
 * that wrote them.
 *
 * @param {Buffer} font
 * @param {Record<string, number>} glyphMap
 * @returns {string[]}
 */
export function undrawnGlyphs(font, glyphMap) {
  const tables = new Map();
  for (let i = 0, n = font.readUInt16BE(4); i < n; i++) {
    const record = 12 + i * 16;
    tables.set(font.toString('latin1', record, record + 4), font.readUInt32BE(record + 8));
  }
  const table = (tag) => {
    if (!tables.has(tag)) throw new Error(`the font has no ${tag} table`);
    return tables.get(tag);
  };

  const glyphOf = new Map();
  const cmap = table('cmap');
  for (let i = 0, n = font.readUInt16BE(cmap + 2); i < n; i++) {
    const sub = cmap + font.readUInt32BE(cmap + 4 + i * 8 + 4);
    const format = font.readUInt16BE(sub);
    if (format === 4) {
      const segments = font.readUInt16BE(sub + 6) / 2;
      const ends = sub + 14;
      const starts = ends + segments * 2 + 2;
      const deltas = starts + segments * 2;
      const ranges = deltas + segments * 2;
      for (let s = 0; s < segments; s++) {
        const start = font.readUInt16BE(starts + s * 2);
        const end = font.readUInt16BE(ends + s * 2);
        const delta = font.readInt16BE(deltas + s * 2);
        const range = font.readUInt16BE(ranges + s * 2);
        for (let code = start; code <= end && code !== 0xffff; code++) {
          const glyph = range ? font.readUInt16BE(ranges + s * 2 + range + (code - start) * 2) : code;
          if (glyph !== 0) glyphOf.set(code, (glyph + delta) & 0xffff);
        }
      }
    } else if (format === 12) {
      for (let g = 0, n = font.readUInt32BE(sub + 12); g < n; g++) {
        const group = sub + 16 + g * 12;
        const start = font.readUInt32BE(group);
        const end = font.readUInt32BE(group + 4);
        const first = font.readUInt32BE(group + 8);
        for (let code = start; code <= end; code++) glyphOf.set(code, first + code - start);
      }
    }
  }

  const longOffsets = font.readInt16BE(table('head') + 50) === 1;
  const loca = table('loca');
  const offset = (glyph) => (longOffsets ? font.readUInt32BE(loca + glyph * 4) : font.readUInt16BE(loca + glyph * 2) * 2);
  return Object.entries(glyphMap)
    .filter(([, code]) => {
      const glyph = glyphOf.get(code);
      return !glyph || offset(glyph + 1) === offset(glyph);
    })
    .map(([name]) => name);
}

/** The names the app lists. */
export async function readNames(root = '.') {
  return JSON.parse(await readFile(join(root, ICONS_DIR, NAMES), 'utf8'));
}

/** The app's three icon files, read. */
export async function readIcons(root = '.') {
  const dir = join(root, ICONS_DIR);
  return {
    names: await readNames(root),
    glyphMap: JSON.parse(await readFile(join(dir, GLYPHMAP), 'utf8')),
    font: await readFile(join(dir, FONT)),
  };
}

/**
 * Everything wrong with the app's icon files; empty when the font draws every
 * name the list holds and both generated files are what `sabeel-ci icons`
 * makes of it today.
 *
 * @param {string} [root] the app repository
 * @returns {Promise<string[]>}
 */
export async function iconProblems(root = '.') {
  const { names, glyphMap, font } = await readIcons(root);
  if (!names.length) return [`${ICONS_DIR}/${NAMES} names no icons`];
  const problems = [];
  if (JSON.stringify(names) !== JSON.stringify([...new Set(names)].sort())) {
    problems.push(`${ICONS_DIR}/${NAMES} must list each name once, in order`);
  }
  const built = await buildIcons(names, root);
  const stale = [];
  if (JSON.stringify(glyphMap) !== JSON.stringify(built.glyphMap)) stale.push(GLYPHMAP);
  if (!font.equals(built.font)) stale.push(FONT);
  if (stale.length) problems.push(`out of date with ${NAMES} (run sabeel-ci icons): ${stale.join(', ')}`);
  const undrawn = undrawnGlyphs(font, glyphMap);
  if (undrawn.length) problems.push(`${ICONS_DIR}/${FONT} does not draw: ${undrawn.join(', ')}`);
  return problems;
}
