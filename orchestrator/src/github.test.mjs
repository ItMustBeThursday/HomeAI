import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createGithub, parseCredential } from './github.mjs';

function fakeGit(password) {
  const calls = [];
  const spawnImpl = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {};
    let input = '';
    child.stdin.on('data', (d) => (input += d));
    child.stdin.on('finish', () => {
      calls.push({ cmd, args, input, env: opts.env });
      child.stdout.end(password ? `protocol=https\nhost=github.com\nusername=u\npassword=${password}\n` : '');
      setImmediate(() => child.emit('close', password ? 0 : 1));
    });
    return child;
  };
  return { spawnImpl, calls };
}

function fakeFetch(routes, seen) {
  return async (url, init) => {
    seen.push({ url, init });
    const path = url.replace('https://api.github.com', '');
    const hit = Object.entries(routes).find(([k]) => path.startsWith(k));
    if (!hit) return { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) };
    return { ok: true, status: 200, json: async () => hit[1] };
  };
}

test('parseCredential reads the password line only', () => {
  assert.equal(parseCredential('username=u\npassword=abc123\n'), 'abc123');
  assert.equal(parseCredential('username=u\n'), null);
});

test('repo name is validated', () => {
  assert.throws(() => createGithub({ repo: 'nope' }), /owner\/name/);
});

test('summary combines repo info, commits and workflow runs; sends the stored login without prompting', async () => {
  const git = fakeGit('tok-123');
  const seen = [];
  const gh = createGithub({
    repo: 'o/r', spawnImpl: git.spawnImpl,
    fetchImpl: fakeFetch({
      '/repos/o/r/commits': [{ sha: 'abcdef1234567', commit: { message: 'Fix things\n\nbody', author: { name: 'A', date: 'd' } } }],
      '/repos/o/r/actions/runs': { workflow_runs: [{ id: 1, name: 'CI', status: 'completed', conclusion: 'success', head_branch: 'main', html_url: 'u', created_at: 'c' }] },
      '/repos/o/r': { html_url: 'https://github.com/o/r', private: false, default_branch: 'main', open_issues_count: 2, pushed_at: 'p' },
    }, seen),
  });
  const s = await gh.summary();
  assert.equal(s.defaultBranch, 'main');
  assert.equal(s.commits[0].sha, 'abcdef1');
  assert.equal(s.commits[0].message, 'Fix things');
  assert.equal(s.runs[0].conclusion, 'success');
  assert.equal(seen[0].init.headers.authorization, 'Bearer tok-123');
  assert.equal(git.calls.length, 1); // token fetched once, then cached
  assert.equal(git.calls[0].env.GIT_TERMINAL_PROMPT, '0');
  assert.ok(!JSON.stringify(s).includes('tok-123'));
});

test('public reads work without a login; writes need one', async () => {
  const git = fakeGit(null);
  const seen = [];
  const gh = createGithub({ repo: 'o/r', spawnImpl: git.spawnImpl, fetchImpl: fakeFetch({ '/repos/o/r/issues': [{ number: 1, title: 'T', state: 'open', html_url: 'u', user: { login: 'x' }, updated_at: 'd', labels: [{ name: 'bug' }], pull_request: {} }] }, seen) });
  const issues = await gh.issues('open');
  assert.equal(issues[0].pullRequest, true);
  assert.deepEqual(issues[0].labels, ['bug']);
  assert.equal(seen[0].init.headers.authorization, undefined);
  await assert.rejects(gh.createIssue({ title: 'x' }), /No GitHub login/);
  await assert.rejects(gh.issues('weird'), /state/);
});

test('create issue and comment post JSON with the token and validate input', async () => {
  const git = fakeGit('tok');
  const seen = [];
  const gh = createGithub({ repo: 'o/r', spawnImpl: git.spawnImpl, fetchImpl: fakeFetch({ '/repos/o/r/issues/7/comments': { id: 9, html_url: 'cu' }, '/repos/o/r/issues': { number: 7, title: 'New', state: 'open', html_url: 'iu', user: { login: 'me' }, updated_at: 'd', labels: [] } }, seen) });
  const i = await gh.createIssue({ title: ' New ', body: 'b' });
  assert.equal(i.number, 7);
  const post = seen.find((s) => s.init.method === 'POST');
  assert.deepEqual(JSON.parse(post.init.body), { title: 'New', body: 'b' });
  assert.equal(post.init.headers.authorization, 'Bearer tok');
  assert.deepEqual(await gh.comment(7, 'thanks'), { id: 9, url: 'cu' });
  await assert.rejects(gh.createIssue({ title: '' }), /title/);
  await assert.rejects(gh.comment(0, 'x'), /number/);
  await assert.rejects(gh.comment(1, ' '), /body/);
});

test('API errors surface the GitHub message', async () => {
  const gh = createGithub({ repo: 'o/r', spawnImpl: fakeGit(null).spawnImpl, fetchImpl: fakeFetch({}, []) });
  await assert.rejects(gh.runs(), /GitHub 404: Not Found/);
});
