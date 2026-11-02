/**
 * THE HELP FILMS' RECORDER, shared by the apps: each film an app scripts,
 * filmed on a phone and on a computer, narrated, as MP4 (H.264 + AAC) with
 * WebVTT captions. `scripts/films.mjs` (`sabeel-ci films record`) drives it.
 *
 * What an app supplies is its films module (`scripts/films/films.mjs`, default
 * export — see `checkFilms` for the shape): the catalogue its Help screen lists,
 * the scripts, a stack to film against, a fresh world per film, and how to sign
 * in off camera. Everything else — how a touch and a pointer are drawn, the
 * browser's confirmations drawn into the page, each step lasting as long as its
 * line, the mux and the captions — is the same for every app, and lives here.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

/** Breath between one line and the next. */
const GAP_MS = 450;
/** Held after the last line, so a film does not cut off on its last word. */
const TAIL_MS = 1200;

/** The id a step's narration is saved under: `<film>-<step>`, steps counted from 01. */
export const lineId = (filmId, index) => `${filmId}-${String(index + 1).padStart(2, '0')}`;

/** Every step's line, as the narration renderer reads it. */
export function linesOf(films) {
  return films.flatMap((f) => f.steps.map((s, i) => ({ id: lineId(f.id, i), text: s.say })));
}

/**
 * The films module, checked before anything is filmed. ONE LIST: every film
 * the catalogue names is scripted, and nothing unscripted is filmed; a step kept
 * to one cut names a cut there is, or it would be in neither. Returns the
 * problems, empty when there are none.
 */
export function checkFilms(mod) {
  const problems = [];
  for (const key of ['site', 'catalogue', 'variants', 'fileName', 'films', 'stack', 'world', 'signIn', 'ready']) {
    if (mod[key] === undefined) problems.push(`the films module exports no ${key}`);
  }
  if (problems.length) return problems;
  const scripted = new Set(mod.films.map((f) => f.id));
  const catalogued = new Set(mod.catalogue.map((v) => v.id));
  for (const id of catalogued) if (!scripted.has(id)) problems.push(`catalogued but not scripted: ${id}`);
  for (const id of scripted) if (!catalogued.has(id)) problems.push(`scripted but not catalogued: ${id}`);
  for (const f of mod.films) {
    if (!Array.isArray(f.steps) || f.steps.length === 0) problems.push(`${f.id}: no steps`);
    for (const [i, s] of (f.steps ?? []).entries()) {
      if (typeof s.say !== 'string' || !s.say.trim()) problems.push(`${f.id} step ${i + 1}: nothing to say`);
      if (typeof s.do !== 'function') problems.push(`${f.id} step ${i + 1}: nothing to do`);
      if (s.cut && !mod.variants.includes(s.cut)) problems.push(`${f.id} step ${i + 1}: no cut called ${s.cut}`);
    }
  }
  return problems;
}

/** A WebVTT timestamp. */
export function vttStamp(s) {
  const ms = Math.max(0, Math.round(s * 1000));
  const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
  const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
  const sec = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
  return `${h}:${m}:${sec}.${String(ms % 1000).padStart(3, '0')}`;
}

/** The captions: one cue per line said, timed from the film's first frame. */
export function vtt(cues, from) {
  return `WEBVTT\n\n${cues.map((c, i) => `${i + 1}\n${vttStamp(c.start - from)} --> ${vttStamp(c.start - from + c.dur)}\n${c.text}\n`).join('\n')}`;
}

/** Seconds of audio in a WAV, from ffprobe. */
const seconds = (path) =>
  Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path], { encoding: 'utf8' }).trim());

/**
 * Drawn on the page that is filmed: the touch, the pointer, the browser's
 * confirmations, and nothing that only a development build shows. Runs in the
 * page, so it takes only what can be passed to it.
 */
function overlay({ showPointer, permission, hide, buildStamp }) {
  // The push nudge and the notifications screen read the browser's permission:
  // "denied" keeps the nudge out of every film but the one about notifications.
  try {
    Object.defineProperty(window.Notification, 'permission', { get: () => permission, configurable: true });
  } catch {
    // No Notification here: nothing reads it either.
  }
  const ripple = (x, y) => {
    const r = document.createElement('div');
    r.className = '__film-ripple';
    r.style.left = `${x}px`;
    r.style.top = `${y}px`;
    document.body.appendChild(r);
    setTimeout(() => r.remove(), 700);
  };
  window.__filmRipple = ripple;
  /*
   * THE BROWSER'S CONFIRMATIONS, DRAWN. `window.confirm` is a dialog the
   * browser paints outside the page, so the video never shows it. Here it is a
   * card in the page that says what the app asked, answered OK — which a film's
   * script has already decided it wants.
   */
  const ask = (message, buttons) => {
    const back = document.createElement('div');
    back.className = '__film-dialog';
    const box = document.createElement('div');
    const text = document.createElement('div');
    text.textContent = message;
    const row = document.createElement('div');
    row.className = '__film-dialog-row';
    let ok = null;
    for (const label of buttons) {
      const b = document.createElement('div');
      b.textContent = label;
      b.className = label === 'OK' ? '__film-dialog-ok' : '__film-dialog-cancel';
      if (label === 'OK') ok = b;
      row.appendChild(b);
    }
    box.append(text, row);
    back.appendChild(box);
    document.body.appendChild(back);
    setTimeout(() => {
      const r = ok.getBoundingClientRect();
      ripple(r.left + r.width / 2, r.top + r.height / 2);
    }, 1700);
    setTimeout(() => back.remove(), 2300);
  };
  window.confirm = (message) => {
    ask(String(message ?? ''), ['Cancel', 'OK']);
    return true;
  };
  window.alert = (message) => ask(String(message ?? ''), ['OK']);

  const install = () => {
    if (document.getElementById('__film-style')) return;
    // The brand's raspberry for the touch and pointer, its gold for an outline.
    const style = document.createElement('style');
    style.id = '__film-style';
    style.textContent = `
      #__film-dot { position: fixed; left: -100px; top: -100px; width: 22px; height: 22px; margin: -11px 0 0 -11px;
        border-radius: 50%; background: rgba(131,17,79,.22); border: 2px solid rgba(131,17,79,.9);
        pointer-events: none; z-index: 2147483647; }
      .__film-ripple { position: fixed; width: 46px; height: 46px; margin: -23px 0 0 -23px; border-radius: 50%;
        background: rgba(131,17,79,.32); pointer-events: none; z-index: 2147483647; animation: __film-r .65s ease-out forwards; }
      @keyframes __film-r { from { transform: scale(.4); opacity: 1 } to { transform: scale(1.7); opacity: 0 } }
      .__film-box { position: fixed; border: 3px solid rgba(198,161,91,.95); border-radius: 12px;
        box-shadow: 0 0 0 5px rgba(198,161,91,.22); pointer-events: none; z-index: 2147483646; transition: opacity .35s; }
      .__film-dialog { position: fixed; inset: 0; background: rgba(58,47,40,.38); display: flex; align-items: center;
        justify-content: center; z-index: 2147483645; pointer-events: none; font: 15px/1.45 system-ui, sans-serif; }
      .__film-dialog > div { background: #FFFFFF; color: #3A2F28; border-radius: 14px; padding: 20px 22px 14px;
        width: min(86vw, 400px); box-shadow: 0 12px 40px rgba(0,0,0,.25); white-space: pre-wrap; }
      .__film-dialog-row { display: flex; justify-content: flex-end; gap: 22px; margin-top: 16px; }
      .__film-dialog-ok, .__film-dialog-cancel { font-weight: 600; padding: 6px 4px; }
      .__film-dialog-ok { color: #83114F; } .__film-dialog-cancel { color: #6A5748; }
      ${hide.map((sel) => `${sel} { display: none !important; }`).join('\n')}`;
    document.head.appendChild(style);
    if (showPointer) {
      const dot = document.createElement('div');
      dot.id = '__film-dot';
      document.body.appendChild(dot);
      window.addEventListener('mousemove', (e) => { dot.style.left = `${e.clientX}px`; dot.style.top = `${e.clientY}px`; }, true);
    }
    window.addEventListener('pointerdown', (e) => ripple(e.clientX, e.clientY), true);
    // The build stamp names whatever commit happened to be checked out.
    if (buildStamp) {
      const stamp = new RegExp(buildStamp);
      const conceal = () => {
        for (const el of document.querySelectorAll('div')) {
          if (el.childElementCount === 0 && stamp.test(el.textContent ?? '')) el.style.visibility = 'hidden';
        }
      };
      new MutationObserver(conceal).observe(document.body, { childList: true, subtree: true });
      conceal();
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();
}

/** What a step's `do` is given: locators by what a person sees, and actions a viewer can follow. */
function helpers(page, variant, world) {
  const phone = variant === 'phone';
  const visible = (loc) => loc.filter({ visible: true }).first();
  const wait = (ms) => page.waitForTimeout(ms);
  async function center(loc) {
    await loc.waitFor({ timeout: 20000 });
    await loc.evaluate((e) => e.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' }));
    await wait(450);
    const b = await loc.boundingBox();
    if (!b) throw new Error('element has no box');
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  }
  async function press(loc) {
    const { x, y } = await center(loc);
    if (phone) {
      await page.touchscreen.tap(x, y);
    } else {
      await page.mouse.move(x, y, { steps: 22 });
      await wait(160);
      await page.mouse.click(x, y);
    }
    await wait(550);
  }
  async function outline(loc) {
    const { x, y } = await center(loc);
    if (!phone) await page.mouse.move(x, y, { steps: 22 });
    await loc.evaluate((e) => {
      const r = e.getBoundingClientRect();
      const box = document.createElement('div');
      box.className = '__film-box';
      Object.assign(box.style, { left: `${r.left - 6}px`, top: `${r.top - 6}px`, width: `${r.width + 12}px`, height: `${r.height + 12}px` });
      document.body.appendChild(box);
      setTimeout(() => { box.style.opacity = '0'; }, 1900);
      setTimeout(() => box.remove(), 2300);
    });
    await wait(900);
  }
  const typeText = (text) => page.keyboard.type(text, { delay: 45 });
  return {
    page,
    phone,
    world,
    wait,
    // Locators, by what a person sees: a control's name, a field's label, words on screen.
    btn: (name) => visible(page.getByRole('button', { name, exact: typeof name === 'string' })),
    tab: (name) => visible(page.getByRole('tab', { name, exact: true })),
    switch: (name) => visible(page.getByRole('switch', { name, exact: true })),
    link: (name) => visible(page.getByRole('link', { name, exact: typeof name === 'string' })),
    radio: (name) => visible(page.getByRole('radio', { name, exact: true })),
    dialog: () => visible(page.getByRole('dialog')),
    label: (name) => visible(page.getByLabel(name, { exact: true })),
    placeholder: (text) => visible(page.getByPlaceholder(text, { exact: true })),
    text: (text, exact = typeof text === 'string') => visible(page.getByText(text, { exact })),
    id: (testId) => visible(page.getByTestId(testId)),
    // Actions.
    waitFor: (loc, timeout = 20000) => loc.waitFor({ timeout }),
    waitGone: (loc, timeout = 20000) => loc.waitFor({ state: 'hidden', timeout }),
    tap: async (loc, { times = 1 } = {}) => {
      for (let i = 0; i < times; i++) await press(loc);
    },
    tapIfShown: async (loc) => {
      if (await loc.isVisible().catch(() => false)) await press(loc);
    },
    /** The touch or the click drawn on a control without pressing it: the Google button, whose popup is not the app. */
    fakeTap: async (loc) => {
      const { x, y } = await center(loc);
      if (!phone) await page.mouse.move(x, y, { steps: 22 });
      await page.evaluate(([px, py]) => window.__filmRipple(px, py), [x, y]);
      await wait(550);
    },
    highlight: outline,
    type: async (loc, text) => {
      await press(loc);
      await typeText(text);
    },
    typeFocused: typeText,
    /** What a field holds, replaced: selected whole, then typed over. */
    replace: async (loc, text) => {
      await press(loc);
      await page.keyboard.press('Control+A');
      if (text) await typeText(text);
      else await page.keyboard.press('Backspace');
    },
    press: (key) => page.keyboard.press(key),
    fill: async (loc, value) => {
      await center(loc);
      await loc.fill(value);
      await wait(600);
    },
    scroll: async (dy) => {
      const vp = page.viewportSize();
      if (!phone) await page.mouse.move(vp.width / 2, vp.height / 2, { steps: 10 });
      for (let i = 0; i < 10; i++) {
        await page.mouse.wheel(0, dy / 10);
        await wait(45);
      }
      await wait(350);
    },
    scrollTo: async (loc) => {
      await center(loc);
    },
  };
}

async function film(mod, ctx, f, variant) {
  const { browsers, web, wavDir, outDir } = ctx;
  const durations = f.steps.map((step, i) => {
    const wav = join(wavDir, `${lineId(f.id, i)}.wav`);
    const said = join(wavDir, `${lineId(f.id, i)}.txt`);
    if (!existsSync(wav) || !existsSync(said)) throw new Error(`no narration for ${lineId(f.id, i)} — render it first (sabeel-ci films tts)`);
    // THE WORDS, NOT THE ID. A line reworded after it was rendered keeps its id,
    // and with it a WAV of the old words under captions of the new ones.
    if (readFileSync(said, 'utf8') !== step.say) {
      throw new Error(`the narration for ${lineId(f.id, i)} is of other words — render it again (sabeel-ci films tts)`);
    }
    return seconds(wav);
  });
  const world = await mod.world();
  if (f.before) await f.before(world);
  const dir = join(outDir, '.raw');
  mkdirSync(dir, { recursive: true });
  const phone = variant === 'phone';
  /*
   * THE PHONE AT TWICE ITS PIXELS, from a browser launched at that scale. A
   * context's own `deviceScaleFactor` sharpens screenshots, not the video:
   * Playwright films at CSS pixels, so the film was a 390-pixel page in the
   * corner of a 780-pixel frame. Launched with the scale forced, the page still
   * lays out at 390 and the screencast comes at 780.
   */
  const context = await browsers[variant].newContext({
    ...(phone
      ? { viewport: { width: 390, height: 844 }, hasTouch: true, recordVideo: { dir, size: { width: 780, height: 1688 } } }
      : { viewport: { width: 1440, height: 900 }, recordVideo: { dir, size: { width: 1440, height: 900 } } }),
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  await context.addInitScript(overlay, {
    showPointer: !phone,
    permission: f.permission ?? 'denied',
    hide: mod.hide ?? [],
    buildStamp: mod.buildStamp ? mod.buildStamp.source : null,
  });
  try {
    if (f.as) await mod.signIn(context, f.as, web);
    const page = await context.newPage();
    const born = Date.now();
    const start = typeof f.start === 'function' ? f.start(world) : (f.start ?? '');
    await page.goto(new URL(start, web).href, { waitUntil: 'domcontentloaded' });
    await mod.ready(page, f).waitFor({ timeout: 40000 });
    await page.waitForTimeout(1500);
    const t = { ...helpers(page, variant, world), ...(mod.helpers ? mod.helpers(page, variant, world) : {}) };
    const cues = [];
    for (const [i, step] of f.steps.entries()) {
      if (step.cut && step.cut !== variant) continue;
      const at = Date.now();
      cues.push({ start: (at - born) / 1000, dur: durations[i], text: step.say, wav: join(wavDir, `${lineId(f.id, i)}.wav`) });
      try {
        await step.do(t);
      } catch (e) {
        // What the page showed when the step failed, beside the films.
        await page.screenshot({ path: join(outDir, `.failed-${f.id}-${variant}.png`) }).catch(() => {});
        throw new Error(`step ${i + 1} ("${step.say.slice(0, 48)}…"): ${e instanceof Error ? e.message.split('\n')[0] : e}`);
      }
      const left = durations[i] * 1000 + GAP_MS - (Date.now() - at);
      if (left > 0) await page.waitForTimeout(left);
    }
    await page.waitForTimeout(TAIL_MS);
    const video = page.video();
    await page.close();
    await context.close();
    return { raw: await video.path(), cues, end: (Date.now() - born) / 1000 };
  } catch (e) {
    await context.close().catch(() => {});
    throw e;
  }
}

/**
 * Narration laid over the film from its first line, as MP4, with captions.
 *
 * SMALL, BECAUSE PEOPLE WATCH THESE ON PHONES. A screen recording is flat colour
 * that barely moves, which x264 compresses hard when told what it is (`-tune
 * animation`) and given time (`-preset slower`); 24 frames a second is plenty
 * for a pointer and a scroll; and speech needs one channel at 64 kbps. H.264
 * High at level 4.1 is what every phone and browser plays.
 */
function mux({ raw, cues, end }, base) {
  const from = Math.max(0, cues[0].start - 0.4);
  const length = Math.min(end, cues[cues.length - 1].start + cues[cues.length - 1].dur + TAIL_MS / 1000 + 0.3) - from;
  const inputs = ['-ss', from.toFixed(3), '-i', raw];
  for (const c of cues) inputs.push('-i', c.wav);
  const delays = cues.map((c, i) => {
    const ms = Math.round((c.start - from) * 1000);
    return `[${i + 1}:a]aresample=48000,adelay=${ms}|${ms}[a${i}]`;
  });
  // Back to 48 kHz after loudnorm, which works — and would otherwise write — at
  // 192 kHz resampled to 96: past what some phones' hardware decoders take.
  const mix = `${cues.map((_, i) => `[a${i}]`).join('')}amix=inputs=${cues.length}:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[aout]`;
  execFileSync('ffmpeg', [
    '-y', '-v', 'error', ...inputs,
    '-filter_complex', [...delays, mix].join(';'),
    '-map', '0:v', '-map', '[aout]', '-t', length.toFixed(3),
    '-c:v', 'libx264', '-preset', 'slower', '-tune', 'animation', '-crf', '28',
    '-profile:v', 'high', '-level', '4.1', '-pix_fmt', 'yuv420p', '-r', '24', '-g', '240',
    '-c:a', 'aac', '-b:a', '64k', '-ac', '1', '-ar', '48000', '-movflags', '+faststart',
    `${base}.mp4`,
  ]);
  writeFileSync(`${base}.vtt`, vtt(cues, from));
  return length;
}

/**
 * Record every film (or `only` some, or one `variant`) into `outDir`, against
 * the stack the films module brings up. Returns how many films failed.
 */
export async function recordFilms(mod, { wavDir, outDir, only = new Set(), variant }) {
  const require = createRequire(join(process.cwd(), 'package.json'));
  const { chromium } = require('playwright');
  mkdirSync(outDir, { recursive: true });
  const stack = await mod.stack();
  /*
   * THE BROWSER ITSELF, headless (`channel: 'chromium'`), not Playwright's
   * headless shell, which films a different browser from the one people use.
   */
  const browsers = {
    phone: await chromium.launch({ channel: 'chromium', args: ['--force-device-scale-factor=2'] }),
    computer: await chromium.launch({ channel: 'chromium' }),
  };
  let failures = 0;
  try {
    for (const f of mod.films) {
      if (only.size && !only.has(f.id)) continue;
      for (const v of variant ? [variant] : mod.variants) {
        const base = join(outDir, mod.fileName(f.id, v, 'video').replace(/\.mp4$/, ''));
        process.stdout.write(`${f.id} (${v}) … `);
        try {
          const shot = await film(mod, { browsers, web: stack.web, wavDir, outDir }, f, v);
          const length = mux(shot, base);
          rmSync(shot.raw, { force: true });
          console.log(`${length.toFixed(1)} s`);
        } catch (e) {
          failures += 1;
          console.log(`FAILED: ${e instanceof Error ? e.message.split('\n')[0] : e}`);
        }
      }
    }
  } finally {
    await Promise.all(Object.values(browsers).map((b) => b.close()));
    rmSync(join(outDir, '.raw'), { recursive: true, force: true });
    await stack.stop();
  }
  return failures;
}
