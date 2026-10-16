// GitHub REST access for the project repo. The token is fetched from Git Credential Manager (the same login `git push`
// uses) when needed, kept only in memory, and never returned by any endpoint. Public data also works without a token.
import { spawn } from 'node:child_process';

const API = 'https://api.github.com';

export function parseCredential(output) {
  const m = /^password=(.*)$/m.exec(output);
  return m ? m[1].trim() : null;
}

export function createGithub({ repo, gitBin = 'git', spawnImpl = spawn, fetchImpl = fetch, now = Date.now, tokenTtlMs = 600_000 } = {}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw new Error('repo must look like owner/name');
  let cached = null;

  function fillToken() {
    return new Promise((resolve) => {
      let out = '';
      let child;
      try {
        child = spawnImpl(gitBin, ['credential', 'fill'], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
      } catch {
        return resolve(null);
      }
      const timer = setTimeout(() => {
        child.kill();
        resolve(null);
      }, 10_000);
      child.stdout.setEncoding('utf8').on('data', (d) => (out += d));
      child.on('error', () => {
        clearTimeout(timer);
        resolve(null);
      });
      child.on('close', () => {
        clearTimeout(timer);
        resolve(parseCredential(out));
      });
      child.stdin.on('error', () => {});
      child.stdin.end('protocol=https\nhost=github.com\n\n');
    });
  }

  // Caches the promise, so parallel calls share one credential lookup.
  function token() {
    if (!cached || now() - cached.at >= tokenTtlMs) cached = { value: fillToken(), at: now() };
    return cached.value;
  }

  async function call(path, { method = 'GET', body, auth = false } = {}) {
    const headers = { accept: 'application/vnd.github+json', 'user-agent': 'homeai-orchestrator', 'x-github-api-version': '2022-11-28' };
    if (auth) {
      const t = await token();
      if (!t) throw new Error('No GitHub login found in Git Credential Manager; sign in with git first');
      headers.authorization = `Bearer ${t}`;
    } else {
      const t = await token().catch(() => null);
      if (t) headers.authorization = `Bearer ${t}`;
    }
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetchImpl(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`GitHub ${res.status}: ${data?.message ?? 'request failed'}`);
    return data;
  }

  const slim = {
    issue: (i) => ({ number: i.number, title: i.title, state: i.state, url: i.html_url, user: i.user?.login, updated: i.updated_at, labels: (i.labels ?? []).map((l) => l.name) }),
    run: (r) => ({ id: r.id, name: r.name, status: r.status, conclusion: r.conclusion, branch: r.head_branch, url: r.html_url, created: r.created_at }),
  };

  return {
    repo,
    async summary() {
      const [info, commits, runs] = await Promise.all([
        call(`/repos/${repo}`),
        call(`/repos/${repo}/commits?per_page=5`),
        call(`/repos/${repo}/actions/runs?per_page=5`).catch(() => ({ workflow_runs: [] })),
      ]);
      return {
        repo, url: info.html_url, private: info.private, defaultBranch: info.default_branch, openIssues: info.open_issues_count, pushed: info.pushed_at,
        commits: commits.map((c) => ({ sha: c.sha.slice(0, 7), message: c.commit.message.split('\n')[0], author: c.commit.author?.name, date: c.commit.author?.date })),
        runs: runs.workflow_runs.map(slim.run),
      };
    },
    // GitHub lists pull requests as issues too; the `pull_request` key tells them apart.
    async issues(state = 'open') {
      if (!['open', 'closed', 'all'].includes(state)) throw new Error('state must be open, closed or all');
      const rows = await call(`/repos/${repo}/issues?state=${state}&per_page=30`);
      return rows.map((i) => ({ ...slim.issue(i), pullRequest: !!i.pull_request }));
    },
    async createIssue({ title, body = '' }) {
      if (typeof title !== 'string' || !title.trim()) throw new Error('title must be a non-empty string');
      if (typeof body !== 'string') throw new Error('body must be a string');
      return slim.issue(await call(`/repos/${repo}/issues`, { method: 'POST', body: { title: title.trim(), body }, auth: true }));
    },
    async comment(number, body) {
      if (!Number.isInteger(number) || number < 1) throw new Error('number must be a positive integer');
      if (typeof body !== 'string' || !body.trim()) throw new Error('body must be a non-empty string');
      const r = await call(`/repos/${repo}/issues/${number}/comments`, { method: 'POST', body: { body }, auth: true });
      return { id: r.id, url: r.html_url };
    },
    async runs() {
      return (await call(`/repos/${repo}/actions/runs?per_page=10`)).workflow_runs.map(slim.run);
    },
  };
}
