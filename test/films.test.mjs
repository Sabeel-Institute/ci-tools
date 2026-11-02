import { describe, expect, it } from 'vitest';
import { checkFilms, lineId, linesOf, vtt, vttStamp } from '../lib/films/record.mjs';
import { validate } from '../lib/config.mjs';
import { readFileSync } from 'node:fs';

const step = (say) => ({ say, do: async () => {} });
const mod = (films, catalogue = films.map((f) => ({ id: f.id }))) => ({
  catalogue,
  variants: ['phone', 'computer'],
  fileName: (id, v, kind) => `${id}-${v}.${kind === 'video' ? 'mp4' : 'vtt'}`,
  films,
  stack: async () => ({}),
  world: async () => ({}),
  signIn: async () => {},
  ready: () => null,
});

describe('the help films', () => {
  it('name each line by its film and its step, counted from 01', () => {
    expect(lineId('clocking', 0)).toBe('clocking-01');
    expect(linesOf([{ id: 'a', steps: [step('One.'), step('Two.')] }])).toEqual([
      { id: 'a-01', text: 'One.' },
      { id: 'a-02', text: 'Two.' },
    ]);
  });

  it('film exactly what the catalogue lists', () => {
    expect(checkFilms(mod([{ id: 'a', steps: [step('Hi.')] }]))).toEqual([]);
    expect(checkFilms(mod([{ id: 'a', steps: [step('Hi.')] }], [{ id: 'a' }, { id: 'b' }]))).toEqual([
      'catalogued but not scripted: b',
    ]);
    expect(checkFilms(mod([{ id: 'a', steps: [step('Hi.')] }, { id: 'x', steps: [step('Hi.')] }], [{ id: 'a' }]))).toEqual([
      'scripted but not catalogued: x',
    ]);
  });

  it('refuse a step with nothing to say, nothing to do, or a cut there is not', () => {
    const bad = mod([{ id: 'a', steps: [{ say: ' ', do: async () => {} }, { say: 'Hi.' }, { say: 'Hi.', do: async () => {}, cut: 'tablet' }] }]);
    expect(checkFilms(bad)).toEqual(['a step 1: nothing to say', 'a step 2: nothing to do', 'a step 3: no cut called tablet']);
  });

  it('refuse a module missing a part', () => {
    const { stack: _stack, ...rest } = mod([{ id: 'a', steps: [step('Hi.')] }]);
    expect(checkFilms(rest)).toEqual(['the films module exports no stack']);
  });

  it('time the captions from the film’s first frame', () => {
    expect(vttStamp(3725.5)).toBe('01:02:05.500');
    expect(vtt([{ start: 2, dur: 1.25, text: 'Hello.' }], 1.5)).toBe('WEBVTT\n\n1\n00:00:00.500 --> 00:00:01.750\nHello.\n');
  });

  it('are configured with both a module and a site, or not at all', () => {
    const base = JSON.parse(readFileSync(new URL('./fixtures/minimal.json', import.meta.url), 'utf8'));
    expect(() => validate({ ...base, films: { module: 'scripts/films/films.mjs', site: 'some-help' } })).not.toThrow();
    expect(() => validate({ ...base, films: { module: 'scripts/films/films.mjs' } })).toThrow(/both module and site/);
    expect(() => validate({ ...base, films: { module: '../outside.mjs', site: 'some-help' } })).toThrow(/films.module/);
  });
});
