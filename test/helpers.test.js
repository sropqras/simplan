'use strict';

// Unit tests for pure helpers used by milestones 3-6.

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeMatcher, globToRegex } = require('../src/ado/repoContext');
const code = require('../src/ado/code');
const { sanitizeProposals, descriptionHtml } = require('../src/ado/proposals');
const { buildBoardWiql, resolveColumns, normalizeItem, wiqlString } = require('../src/ado/board');
const { mentionsAi } = require('../src/ado/chat');

test('globs: **, *, ?, folders, leading slash', () => {
  const m = makeMatcher(['README.md', 'docs/**', 'src/*.js', 'lib/', '/conf/?.yml']);
  assert.ok(m('README.md'));
  assert.ok(m('/README.md'));
  assert.ok(m('docs/a/b/c.md'));
  assert.ok(m('src/x.js'));
  assert.ok(!m('src/deep/x.js'));
  assert.ok(m('lib/any/thing.ts'));
  assert.ok(m('conf/a.yml'));
  assert.ok(!m('conf/ab.yml'));
  assert.ok(!m('other.md'));
  assert.ok(globToRegex('**/*.md').test('a/b/c.md'));
  assert.ok(globToRegex('**/*.md').test('c.md'));
});

test('globs: secrets, binaries and traversal are never allowed', () => {
  const m = makeMatcher(['**']);
  for (const p of ['.env', 'config/.env.production', 'certs/server.pem', 'keys/app.key', 'id_rsa', 'config/secrets.json',
    'node_modules/x/index.js', '.git/config', 'img/logo.png', 'a/../b.md', 'package-lock.lock']) {
    assert.equal(m(p), false, p);
  }
  assert.ok(m('src/index.js'));
});

test('branch names: pattern, slug and git ref rules', () => {
  assert.equal(code.slugify('Fix: Café checkout — retries!!'), 'fix-cafe-checkout-retries');
  assert.equal(code.slugify('???'), 'work');
  assert.equal(code.branchFromPattern('feature/{id}-{slug}', { id: 42, title: 'Add login', type: 'User Story' }), 'feature/42-add-login');
  assert.equal(code.branchFromPattern('{type}/{id}', { id: 7, title: 'x', type: 'User Story' }), 'user-story/7');
  for (const ok of ['feature/1-a', 'users/bob/x', 'a.b_c-d']) assert.ok(code.isValidBranchName(ok), ok);
  for (const bad of ['', '/a', 'a/', 'a..b', 'a//b', 'a b', 'x.lock', 'a/.b', '.a', '-a', 'a~1', 'a'.repeat(201)]) {
    assert.equal(code.isValidBranchName(bad), false, bad);
  }
});

test('artifact links: branch / PR / commit parsing round-trips', () => {
  const pid = '11111111-2222-3333-4444-555555555555';
  const rid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const url = code.branchArtifactUrl(pid, rid, 'feature/1-x');
  assert.equal(url, `vstfs:///Git/Ref/${pid}%2F${rid}%2FGBfeature%2F1-x`);
  const links = code.parseArtifactLinks([
    { rel: 'ArtifactLink', url },
    { rel: 'ArtifactLink', url: `vstfs:///Git/PullRequestId/${pid}%2F${rid}%2F12` },
    { rel: 'ArtifactLink', url: `vstfs:///Git/Commit/${pid}%2F${rid}%2Fabc123` },
    { rel: 'ArtifactLink', url: 'vstfs:///Build/Build/5' },
    { rel: 'System.LinkTypes.Related', url: 'https://x' },
  ]);
  assert.deepEqual(links.branches, [{ projectId: pid, repoId: rid, name: 'feature/1-x' }]);
  assert.deepEqual(links.pullRequests, [{ projectId: pid, repoId: rid, id: 12 }]);
  assert.equal(links.commits.length, 1);
});

test('stripHtml turns ADO HTML into readable text', () => {
  assert.equal(code.stripHtml('<p>a &amp; b</p><ul><li>x</li><li>y</li></ul>'), 'a & b\nx\ny');
});

test('sanitizeProposals: caps, types, files, tags', () => {
  const raw = { proposals: [
    { title: '  T1  ', description: 'd', type: 'bug', acceptanceCriteria: ['a', 3, ''], suggestedFiles: ['/src/a.js', 'nope.js'], tags: ['x;y'] },
    { title: '', description: 'dropped' },
    ...Array.from({ length: 15 }, (_, i) => ({ title: `n${i}`, type: 'Task' })),
  ] };
  const out = sanitizeProposals(raw, { types: ['Task', 'Bug'], defaultType: 'Task', repoPaths: ['src/a.js'] });
  assert.equal(out.length, 9); // first 10 kept, empty title dropped
  assert.deepEqual(out[0], {
    title: 'T1', description: 'd', type: 'Bug', acceptanceCriteria: ['a'], suggestedFiles: ['src/a.js'], tags: ['xy'],
  });
  assert.deepEqual(sanitizeProposals(null, { types: [], defaultType: 'Task', repoPaths: [] }), []);
});

test('descriptionHtml escapes model output', () => {
  const html = descriptionHtml({
    title: 't', description: '<script>alert(1)</script>\nline2', acceptanceCriteria: ['<b>x</b>'], suggestedFiles: ['a"b.js'],
  }, { webUrl: 'https://r' }, 1);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<li>&lt;b&gt;x&lt;\/b&gt;<\/li>/);
  assert.match(html, /href="https:\/\/r\?path=\/a%22b\.js"/);
  assert.match(html, /\(1 message\)/);
});

test('board WIQL quoting and column resolution', () => {
  assert.equal(wiqlString("O'Brien"), "'O''Brien'");
  const q = buildBoardWiql("Bug'); DROP", ['New'], null);
  assert.match(q, /\[System\.WorkItemType\] = 'Bug''\); DROP'/);
  const states = [{ name: 'New', color: 'aaa' }, { name: 'Gone', category: 'Removed' }];
  assert.deepEqual(resolveColumns(states, null).columns.map((c) => c.name), ['New']);
  const r = resolveColumns(states, ['new', 'Missing']);
  assert.deepEqual(r.columns.map((c) => c.name), ['New']);
  assert.equal(r.warnings.length, 1);
});

test('normalizeItem handles missing fields and string identities', () => {
  const n = normalizeItem({ id: 5, rev: 3, fields: { 'System.Title': 'x', 'System.AssignedTo': 'Someone <s@x>' } });
  assert.equal(n.assignedTo.displayName, 'Someone <s@x>');
  assert.deepEqual(n.tags, []);
  assert.equal(n.rev, 3);
});

test('@ai mention detection', () => {
  assert.ok(mentionsAi('@ai help'));
  assert.ok(mentionsAi('hey (@AI) what'));
  assert.ok(!mentionsAi('email me@ai.com'));
  assert.ok(!mentionsAi('@aidan hi'));
});
