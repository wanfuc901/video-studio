import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

const root = resolve(import.meta.dirname, '..', 'dist');
const read = (name) => readFileSync(resolve(root, name), 'utf8');

test('studio shell loads redesigned assets after legacy theme', () => {
  const html = read('index.html');
  assert.match(html, /href="\.\/styles\.css"/);
  assert.match(html, /href="\.\/studio-redesign\.css"/);
  assert.match(html, /src="\.\/studio-redesign\.js"/);
  assert.ok(html.indexOf('styles.css') < html.indexOf('studio-redesign.css'));
});

test('studio theme does not conceal inspector on tablet and mobile', () => {
  const css = read('studio-redesign.css');
  assert.match(css, /@media\(max-width:1080px\)/);
  assert.match(css, /@media\(max-width:700px\)/);
  assert.match(css, /\.inspector-panel\{display:block/);
  assert.match(css, /prefers-reduced-motion:reduce/);
});

test('studio navigation dispatches only to existing editor actions', () => {
  const names = {
    '.media-panel': 'media', '#add-text': 'text', '#align-lyrics-button': 'align',
    '#ai-lyrics-button': 'transcribe', '#timeline-scroll': 'timeline',
    '#shortcuts-button': 'help',
  };
  const clicked = [];
  const scrolled = [];
  const targets = Object.fromEntries(Object.entries(names).map(([selector, kind]) =>
    [selector, {
      click: () => clicked.push(kind),
      scrollIntoView: () => scrolled.push(kind),
    }]
  ));
  const navButtons = [];
  const nav = {
    className: '', children: navButtons,
    setAttribute: () => {},
    appendChild: (button) => navButtons.push(button),
    addEventListener: (_event, callback) => { nav.dispatch = callback; },
  };
  const topbar = {
    querySelector: () => null,
    insertBefore: (node) => assert.equal(node, nav),
  };
  const doc = {
    readyState: 'complete',
    querySelector: (selector) => selector === '.topbar' ? topbar :
      selector === '.top-actions' ? {} : targets[selector] ?? null,
    createElement: (tag) => tag === 'nav' ? nav : {
      type: '', textContent: '', dataset: {}, className: '',
    },
  };
  runInNewContext(read('studio-redesign.js'), { document: doc });
  assert.equal(navButtons.length, 6);
  for (const button of navButtons) {
    nav.dispatch({target: {closest: () => button}});
  }
  assert.deepEqual(clicked, ['text', 'align', 'transcribe', 'help']);
  assert.deepEqual(scrolled, ['media', 'timeline']);
  // Confirm the targets are provided by original modules, not mock-only DOM.
  const karaoke = read('karaoke-ui.js');
  const lyrics = read('ai-lyrics-ui.js');
  const index = read('index.html');
  assert.match(karaoke, /id="add-text"/);
  assert.match(lyrics, /id="align-lyrics-button"/);
  assert.match(lyrics, /id="ai-lyrics-button"/);
  assert.match(index, /id="timeline-scroll"/);
  assert.match(index, /id="shortcuts-button"/);
});
