'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cfg = require('../src/ado/config');

test('defaults when there is no repo file and no overrides', () => {
  const { values, sources } = cfg.mergeConfig({}, {});
  assert.equal(values['board.workItemType'], 'Task');
  assert.equal(values['ai.requireApproval'], true);
  assert.ok(Object.values(sources).every((s) => s === 'default'));
});

test('repo file overrides defaults; tool overrides beat repo', () => {
  const { values: repo } = cfg.parseRepoConfig(`
board:
  workItemType: Bug
  swimlanes: assignee
ai:
  requireApproval: false
`);
  const { values, sources } = cfg.mergeConfig(repo, { 'board.workItemType': 'User Story' });
  assert.equal(values['board.workItemType'], 'User Story');
  assert.equal(sources['board.workItemType'], 'tool');
  assert.equal(values['board.swimlanes'], 'assignee');
  assert.equal(sources['board.swimlanes'], 'repo');
  assert.equal(values['ai.requireApproval'], false);
  assert.equal(sources['ai.requireApproval'], 'repo');
  assert.equal(sources['tickets.branchPattern'], 'default');
});

test('dotted keys in YAML are accepted too', () => {
  const { values, errors } = cfg.parseRepoConfig('board.workItemType: Epic\n');
  assert.deepEqual(errors, []);
  assert.equal(values['board.workItemType'], 'Epic');
});

test('broken YAML is reported, not thrown', () => {
  const { values, errors } = cfg.parseRepoConfig('board: [unclosed');
  assert.deepEqual(values, {});
  assert.match(errors[0], /not valid YAML/);
});

test('unknown and invalid keys are reported; valid keys still apply', () => {
  const { values, errors } = cfg.parseRepoConfig(`
board:
  workItemType: Bug
  swimlanes: diagonal
colour: red
`);
  assert.equal(values['board.workItemType'], 'Bug');
  assert.equal(values['board.swimlanes'], undefined);
  assert.ok(errors.some((e) => /Unknown key: colour/.test(e)));
  assert.ok(errors.some((e) => /board.swimlanes must be one of/.test(e)));
});

test('non-mapping YAML is rejected', () => {
  assert.match(cfg.parseRepoConfig('- a\n- b\n').errors[0], /mapping/);
  assert.deepEqual(cfg.parseRepoConfig('').values, {});
  assert.deepEqual(cfg.parseRepoConfig('# only a comment\n').values, {});
});

test('validateOverrides: type checks, nulls allowed for removal', () => {
  assert.deepEqual(cfg.validateOverrides({ 'ai.requireApproval': null }), { 'ai.requireApproval': null });
  assert.throws(() => cfg.validateOverrides({ 'ai.requireApproval': 'yes' }), /true or false/);
  assert.throws(() => cfg.validateOverrides({ 'board.columns': ['a', 1] }), /list of strings/);
  assert.throws(() => cfg.validateOverrides({ nope: 1 }), /Unknown key/);
  assert.throws(() => cfg.validateOverrides([]), /object/);
  assert.throws(() => cfg.validateOverrides({ 'ai.systemPrompt': 'x'.repeat(5000) }), /longer than/);
});

test('toYaml round-trips non-default values only', () => {
  const merged = cfg.mergeConfig({ 'board.workItemType': 'Bug' }, { 'ai.contextPaths': ['src/**'] });
  const text = cfg.toYaml(merged.values, merged.sources);
  assert.match(text, /^# simplan configuration/);
  assert.doesNotMatch(text, /branchPattern/); // default left out
  const back = cfg.parseRepoConfig(text);
  assert.deepEqual(back.errors, []);
  assert.equal(back.values['board.workItemType'], 'Bug');
  assert.deepEqual(back.values['ai.contextPaths'], ['src/**']);
});

test('pickRepo: explicit name, project-named, only, first alphabetical', () => {
  const repos = [{ name: 'zeta' }, { name: 'Shop' }, { name: 'alpha' }, { name: 'off', isDisabled: true }];
  assert.equal(cfg.pickRepo(repos, 'shop').name, 'Shop');
  assert.equal(cfg.pickRepo(repos, 'other').name, 'alpha');
  assert.equal(cfg.pickRepo(repos, 'other', 'ZETA').name, 'zeta');
  assert.equal(cfg.pickRepo(repos, 'other', 'off'), null);
  assert.equal(cfg.pickRepo([{ name: 'only' }], 'x').name, 'only');
  assert.equal(cfg.pickRepo([], 'x'), null);
});
