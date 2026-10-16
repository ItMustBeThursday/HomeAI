import test from 'node:test';
import assert from 'node:assert/strict';
import { mediaIntent } from './media-intent.mjs';

const config = {
  routes: { video: { chain: ['v'] }, music: { chain: ['m'] }, image: { chain: ['i'] } },
  connectors: { v: { kind: 'comfyui' }, m: { kind: 'comfyui' }, i: { kind: 'comfyui' } },
};

test('descriptive requests with several adjectives route to media', () => {
  assert.equal(mediaIntent('Make a 15 second upbeat acoustic guitar song, instrumental', config)?.route, 'music');
  assert.equal(mediaIntent('generate a cute cat video', config)?.route, 'video');
  assert.equal(mediaIntent('Generate an image of a cat', config)?.route, 'image');
});

test('requests about prompts, plans or lists stay text chat', () => {
  for (const t of ['make a prompt for a song', 'create a plan for the video', 'write a list of song ideas']) {
    assert.equal(mediaIntent(t, config), null, t);
  }
});
