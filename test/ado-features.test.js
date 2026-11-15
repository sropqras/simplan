'use strict';

// Integration: milestones 3-6 (board, live updates, realtime, chat + AI, proposals, code links).
// Real server + Postgres + fake ADO + fake Foundry. Needs TEST_DATABASE_URL (a throwaway DB).

const test = require('node:test');
const assert = require('node:assert/strict');
const { io } = require('socket.io-client');
const { startStack, appTokenFor } = require('./helpers/stack');
const { ORG, PROJECT_ID, REPO_ID, USERS } = require('./helpers/fakeAdo');
const { hookPassword } = require('../src/ado/board');

const DB = process.env.TEST_DATABASE_URL;
process.env.ADO_HOOK_SECRET = 'hook-secret'; // same as the server's, so the test can compute hookPassword()
const P = `/ado/api/projects/${PROJECT_ID}`;

function connect(base, tok, { appToken } = {}) {
  return io(`${base}/ado`, {
    auth: { appToken: appToken || appTokenFor(tok), accessToken: tok, org: ORG },
    transports: ['websocket'],
    reconnection: false,
  });
}

function waitFor(socket, event, pred = () => true, ms = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(event, h); reject(new Error(`timeout waiting for ${event}`)); }, ms);
    function h(payload) {
      if (!pred(payload)) return;
      clearTimeout(timer);
      socket.off(event, h);
      resolve(payload);
    }
    socket.on(event, h);
  });
}

function emitAck(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

test('Azure DevOps milestones 3-6 (integration)', { skip: !DB && 'set TEST_DATABASE_URL to run' }, async (t) => {
  const s = await startStack(DB, { env: { ADO_HOOK_SECRET: 'hook-secret' } });
  const { ado, ai, call } = s;
  const sockets = [];
  t.after(async () => { sockets.forEach((x) => x.close()); await s.stop(); });

  // Seed the board.
  const a = ado.state.addItem({ 'System.Title': 'Checkout fails on retry', 'System.State': 'To Do', 'System.Tags': 'payments; urgent' });
  const b = ado.state.addItem({ 'System.Title': 'Cart badge', 'System.State': 'Doing' });
  ado.state.addItem({ 'System.Title': 'A bug', 'System.WorkItemType': 'Bug', 'System.State': 'New' });
  const foreign = ado.state.addItem({ 'System.Title': 'Other project item' }, { project: 'Other' });

  // ---------------- realtime ----------------
  let bobSock;
  await t.test('socket: bad token rejected; outsider cannot join; member joins with presence', async () => {
    const bad = connect(s.base, 'tok-bob', { appToken: appTokenFor('tok-bob', { secret: 'nope' }) });
    sockets.push(bad);
    const err = await new Promise((resolve) => bad.on('connect_error', resolve));
    assert.match(err.message, /signature/);

    const eve = connect(s.base, 'tok-eve');
    sockets.push(eve);
    await new Promise((r) => eve.on('connect', r));
    const ackEve = await emitAck(eve, 'join', { projectId: PROJECT_ID });
    assert.equal(ackEve.ok, false);
    assert.match(ackEve.error, /not found/);

    bobSock = connect(s.base, 'tok-bob');
    sockets.push(bobSock);
    await new Promise((r) => bobSock.on('connect', r));
    const ack = await emitAck(bobSock, 'join', { projectId: PROJECT_ID, view: 'board' });
    assert.equal(ack.ok, true);
    assert.deepEqual(ack.presence.map((u) => u.displayName), ['Bob Member']);
  });

  await t.test('socket: second viewer updates presence for everyone', async () => {
    const alice = connect(s.base, 'tok-alice');
    sockets.push(alice);
    await new Promise((r) => alice.on('connect', r));
    const seen = waitFor(bobSock, 'presence', (list) => list.length === 2);
    await emitAck(alice, 'join', { projectId: PROJECT_ID, view: 'chat' });
    const list = await seen;
    assert.deepEqual(list.map((u) => u.displayName).sort(), ['Alice Admin', 'Bob Member']);
    const closed = waitFor(bobSock, 'presence', (l) => l.length === 1);
    alice.close();
    await closed;
  });

  // ---------------- board (M3) ----------------
  await t.test('board: columns from states (Removed hidden), items, members, live off', async () => {
    const r = await call('GET', `${P}/board`, { as: 'tok-bob' });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.columns.map((c) => c.name), ['To Do', 'Doing', 'Done']);
    assert.equal(r.json.columns[1].color, '#007acc');
    assert.deepEqual(r.json.items.map((i) => i.id).sort(), [a.id, b.id].sort()); // Bug + other project excluded
    const ia = r.json.items.find((i) => i.id === a.id);
    assert.deepEqual(ia.tags, ['payments', 'urgent']);
    assert.equal(ia.state, 'To Do');
    assert.deepEqual(r.json.members.map((m) => m.uniqueName), ['alice@contoso.test', 'bob@contoso.test']);
    assert.equal(r.json.live.enabled, false);
    const q = ado.state.wiql.at(-1);
    assert.match(q, /\[System\.WorkItemType\] = 'Task'/);
    assert.match(q, /\[System\.State\] IN \('To Do', 'Doing', 'Done'\)/);
  });

  await t.test('board: configured columns/area applied, unknown state warned, bad type is 400', async () => {
    await call('PUT', `${P}/config`, { as: 'tok-alice', body: { overrides: {
      'board.columns': ['Doing', 'To Do', 'Waiting'], 'board.areaPath': "Shop\\O'Brien",
    } } });
    let r = await call('GET', `${P}/board`, { as: 'tok-bob' });
    assert.deepEqual(r.json.columns.map((c) => c.name), ['Doing', 'To Do']);
    assert.ok(r.json.warnings.some((w) => /Waiting/.test(w)));
    assert.match(ado.state.wiql.at(-1), /\[System\.AreaPath\] UNDER 'Shop\\O''Brien'/);
    await call('PUT', `${P}/config`, { as: 'tok-alice', body: { overrides: { 'board.workItemType': 'Nope' } } });
    r = await call('GET', `${P}/board`, { as: 'tok-bob' });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /Nope/);
    await call('PUT', `${P}/config`, { as: 'tok-alice', body: { overrides: {
      'board.workItemType': null, 'board.columns': null, 'board.areaPath': null,
    } } });
  });

  await t.test('board: outsider 404; foreign-project item 404; invalid id 400', async () => {
    assert.equal((await call('GET', `${P}/board`, { as: 'tok-eve' })).status, 404);
    assert.equal((await call('GET', `${P}/workitems/${foreign.id}`, { as: 'tok-bob' })).status, 404);
    assert.equal((await call('PATCH', `${P}/workitems/${foreign.id}`, { as: 'tok-bob', body: { state: 'Done' } })).status, 404);
    assert.equal((await call('GET', `${P}/workitems/abc`, { as: 'tok-bob' })).status, 400);
    assert.equal((await call('GET', `${P}/workitems/${a.id}`, { as: 'tok-bob' })).json.title, 'Checkout fails on retry');
  });

  await t.test('board: move a card -> ADO updated + broadcast to the room', async () => {
    const got = waitFor(bobSock, 'workitem:updated', (p) => p.item.id === a.id);
    const r = await call('PATCH', `${P}/workitems/${a.id}`, { as: 'tok-bob', body: { state: 'Doing', rev: 1, assignedTo: 'alice@contoso.test' } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.state, 'Doing');
    assert.equal(r.json.assignedTo.displayName, 'Alice Admin');
    assert.equal(r.json.rev, 2);
    const ev = await got;
    assert.equal(ev.by, 'Bob Member');
    assert.equal(ado.state.items.get(a.id).fields['System.State'], 'Doing');
  });

  await t.test('board: stale rev -> 409; invalid state -> 400; empty patch -> 400', async () => {
    let r = await call('PATCH', `${P}/workitems/${a.id}`, { as: 'tok-bob', body: { state: 'Done', rev: 1 } });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /changed by someone else/);
    r = await call('PATCH', `${P}/workitems/${a.id}`, { as: 'tok-bob', body: { state: 'Flying' } });
    assert.equal(r.status, 400);
    r = await call('PATCH', `${P}/workitems/${a.id}`, { as: 'tok-bob', body: { rev: 2 } });
    assert.equal(r.status, 400);
  });

  await t.test('board: quick-add creates a work item with configured tags', async () => {
    await call('PUT', `${P}/config`, { as: 'tok-alice', body: { overrides: { 'tickets.defaultTags': ['simplan'] } } });
    const got = waitFor(bobSock, 'workitem:created');
    const r = await call('POST', `${P}/workitems`, { as: 'tok-bob', body: { title: 'Write release notes' } });
    assert.equal(r.status, 201, r.text);
    assert.deepEqual(r.json.tags, ['simplan']);
    assert.equal((await got).item.title, 'Write release notes');
    assert.equal((await call('POST', `${P}/workitems`, { as: 'tok-bob', body: { title: ' ' } })).status, 400);
  });

  // ---------------- live updates via service hooks ----------------
  await t.test('live: member cannot enable; admin creates 4 subscriptions', async () => {
    assert.equal((await call('POST', `${P}/live`, { as: 'tok-bob' })).status, 403);
    const r = await call('POST', `${P}/live`, { as: 'tok-alice' });
    assert.equal(r.status, 201, r.text);
    const subs = [...ado.state.subscriptions.values()];
    assert.deepEqual(subs.map((x) => x.eventType).sort(), ['workitem.created', 'workitem.deleted', 'workitem.restored', 'workitem.updated']);
    assert.match(subs[0].consumerInputs.url, new RegExp(`/ado/hooks/workitems\\?org=${ORG}&project=${PROJECT_ID}$`));
    assert.equal(subs[0].consumerInputs.basicAuthPassword, hookPassword(ORG, PROJECT_ID));
    assert.equal((await call('GET', `${P}/board`, { as: 'tok-bob' })).json.live.enabled, true);
    // Re-enabling replaces, not duplicates.
    await call('POST', `${P}/live`, { as: 'tok-alice' });
    assert.equal(ado.state.subscriptions.size, 4);
  });

  await t.test('live: webhook needs the right password; valid call pings the room', async () => {
    const url = `/ado/hooks/workitems?org=${ORG}&project=${PROJECT_ID}`;
    const auth = (pw) => ({ authorization: `Basic ${Buffer.from(`simplan:${pw}`).toString('base64')}` });
    const payload = { eventType: 'workitem.updated', resource: { workItemId: b.id } };
    assert.equal((await call('POST', url, { headers: auth('wrong'), body: payload })).status, 401);
    assert.equal((await call('POST', url, { body: payload })).status, 401);
    assert.equal((await call('POST', `/ado/hooks/workitems?org=evil.com&project=${PROJECT_ID}`, { headers: auth('x'), body: payload })).status, 400);
    const got = waitFor(bobSock, 'workitem:changed', (p) => p.id === b.id);
    const r = await call('POST', url, { headers: auth(hookPassword(ORG, PROJECT_ID)), body: payload });
    assert.equal(r.status, 200);
    assert.deepEqual(await got, { id: b.id, eventType: 'workitem.updated' });
    const ignored = await call('POST', url, { headers: auth(hookPassword(ORG, PROJECT_ID)), body: { eventType: 'git.push', resource: {} } });
    assert.equal(ignored.status, 202);
  });

  await t.test('live: admin disables -> subscriptions deleted', async () => {
    const r = await call('DELETE', `${P}/live`, { as: 'tok-alice' });
    assert.equal(r.status, 200);
    assert.equal(ado.state.subscriptions.size, 0);
  });

  // ---------------- chat + AI (M4) ----------------
  let msgIds = [];
  await t.test('chat: post -> stored + broadcast; history; validation', async () => {
    const got = waitFor(bobSock, 'chat:message', (m) => m.body.startsWith('Checkout'));
    let r = await call('POST', `${P}/messages`, { as: 'tok-bob', body: { body: 'Checkout payments fail when the card is retried.' } });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.aiRequested, false);
    assert.equal((await got).authorName, 'Bob Member');
    msgIds.push(r.json.id);
    r = await call('POST', `${P}/messages`, { as: 'tok-alice', body: { body: 'We also need retry logging for support.' } });
    msgIds.push(r.json.id);
    r = await call('GET', `${P}/messages`, { as: 'tok-bob' });
    assert.deepEqual(r.json.map((m) => m.id), msgIds);
    assert.equal((await call('POST', `${P}/messages`, { as: 'tok-bob', body: { body: 'x'.repeat(4001) } })).status, 400);
    assert.equal((await call('POST', `${P}/messages`, { as: 'tok-bob', body: { body: '  ' } })).status, 400);
    assert.equal((await call('GET', `${P}/messages`, { as: 'tok-eve' })).status, 404);
    assert.equal((await call('GET', `${P}/messages?before=yesterday`, { as: 'tok-bob' })).status, 400);
  });

  await t.test('chat: @ai -> Foundry with repo tool -> AI reply broadcast; disallowed files never read', async () => {
    ai.state.replies.push(
      { content: null, tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } },
        { id: 'c2', type: 'function', function: { name: 'read_file', arguments: '{"path":".env"}' } },
        { id: 'c3', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/checkout.js"}' } },
      ] },
      (req) => ({ content: `Looked at ${req.messages.filter((m) => m.role === 'tool').length} files. Retry is a TODO in src/checkout.js.` }),
    );
    const got = waitFor(bobSock, 'chat:message', (m) => m.kind === 'ai');
    const r = await call('POST', `${P}/messages`, { as: 'tok-bob', body: { body: '@ai where does checkout retry? see #' + a.id } });
    assert.equal(r.json.aiRequested, true);
    const reply = await got;
    assert.match(reply.body, /Looked at 3 files/);
    assert.equal(reply.authorName, 'simplan AI');

    const first = ai.state.requests.at(-2);
    assert.equal(first.model, 'fake-gpt');
    assert.equal(first.tools[0].function.name, 'read_file');
    const sys = first.messages[0].content;
    assert.match(sys, /README\.md/);
    assert.doesNotMatch(sys, /src\/checkout\.js/); // default contextPaths: README.md, docs/**
    assert.doesNotMatch(sys, /\.env/);
    assert.match(sys, new RegExp(`#${a.id} \\[Task\\] Checkout fails on retry`));
    const toolMsgs = ai.state.requests.at(-1).messages.filter((m) => m.role === 'tool');
    assert.match(toolMsgs[0].content, /An online shop/);
    assert.match(toolMsgs[1].content, /Not allowed/);
    assert.match(toolMsgs[2].content, /Not allowed/);
    assert.ok(ado.state.log.includes('READ README.md'));
    assert.ok(!ado.state.log.includes('READ .env'));
    assert.ok(!ado.state.log.includes('READ src/checkout.js'));
  });

  await t.test('chat: AI failure becomes a system message', async () => {
    ai.state.replies.push({ status: 500, error: 'model exploded' });
    const got = waitFor(bobSock, 'chat:message', (m) => m.kind === 'system');
    await call('POST', `${P}/messages`, { as: 'tok-bob', body: { body: '@ai hello' } });
    assert.match((await got).body, /AI reply failed: model exploded/);
  });

  // ---------------- proposals (M5) ----------------
  let proposals;
  await t.test('proposals: chat -> AI -> sanitized proposals stored + broadcast', async () => {
    await call('PUT', `${P}/config`, { as: 'tok-alice', body: { overrides: { 'ai.contextPaths': ['README.md', 'src/**'] } } });
    ai.state.replies.push({ content: JSON.stringify({ proposals: [
      { title: 'Retry failed card payments', description: 'Payments fail on retry.\n\nAdd a safe retry.', type: 'task',
        acceptanceCriteria: ['Retries up to 3 times', 'No double charge'], suggestedFiles: ['src/checkout.js', 'src/nope.js', '.env'], tags: ['payments'] },
      { title: 'Log payment retries', description: 'Support needs logs.', type: 'Epic',
        acceptanceCriteria: [], suggestedFiles: [], tags: [] },
      { title: '', description: 'empty title dropped', type: 'Task', acceptanceCriteria: [], suggestedFiles: [], tags: [] },
    ] }) });
    const got = waitFor(bobSock, 'proposal:created');
    const r = await call('POST', `${P}/proposals`, { as: 'tok-bob', body: { messageIds: msgIds } });
    assert.equal(r.status, 201, r.text);
    proposals = r.json.proposals;
    assert.equal(proposals.length, 2);
    assert.equal(proposals[0].type, 'Task');            // case-normalised to a real type
    assert.equal(proposals[1].type, 'Task');            // unknown type -> ai.defaultType
    assert.deepEqual(proposals[0].suggestedFiles, ['src/checkout.js']);
    assert.equal(proposals[0].status, 'proposed');
    assert.deepEqual(proposals[0].sourceMessageIds, msgIds);
    await got;
    const req = ai.state.requests.at(-1);
    assert.equal(req.response_format.type, 'json_schema');
    assert.match(req.messages[1].content, /\[Bob Member\] Checkout payments fail/);
    assert.match(req.messages[0].content, /Allowed work item types: Task, Bug, User Story/);
    // board shows the pending lane
    const board = await call('GET', `${P}/board`, { as: 'tok-bob' });
    assert.deepEqual(board.json.proposals.map((p) => p.title), ['Retry failed card payments', 'Log payment retries']);
    assert.equal((await call('POST', `${P}/proposals`, { as: 'tok-bob', body: { messageIds: ['nope'] } })).status, 400);
  });

  await t.test('proposals: json_schema unsupported -> falls back to json_object', async () => {
    ai.state.replies.push({ status: 400, error: "Invalid parameter: 'response_format' of type 'json_schema' is not supported" },
      { content: '```json\n{"proposals":[]}\n```' });
    const r = await call('POST', `${P}/proposals`, { as: 'tok-bob', body: { last: 5 } });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.proposals.length, 0);
    assert.equal(ai.state.requests.at(-1).response_format.type, 'json_object');
  });

  let createdId;
  await t.test('proposals: member cannot approve (ai.approvers=admins); admin approves + branch', async () => {
    const r403 = await call('POST', `${P}/proposals/${proposals[0].id}/approve`, { as: 'tok-bob' });
    assert.equal(r403.status, 403);
    const updated = waitFor(bobSock, 'proposal:updated', (p) => p.id === proposals[0].id);
    const r = await call('POST', `${P}/proposals/${proposals[0].id}/approve`, { as: 'tok-alice', body: { createBranch: true, edits: { title: 'Retry failed card payments safely' } } });
    assert.equal(r.status, 200, r.text);
    createdId = r.json.item.id;
    assert.equal(r.json.item.title, 'Retry failed card payments safely');
    assert.equal(r.json.branch.name, `feature/${createdId}-retry-failed-card-payments-safely`);
    assert.equal((await updated).status, 'approved');
    const wi = ado.state.items.get(createdId);
    const desc = wi.fields['System.Description'];
    assert.match(desc, /<li>No double charge<\/li>/);
    assert.match(desc, /href="https:\/\/ado\.test\/contoso\/Shop\/_git\/Shop\?path=\/src\/checkout\.js"/);
    assert.match(desc, /from project chat \(2 messages\)/);
    assert.equal(wi.fields['System.Tags'], 'simplan; payments');
    assert.ok(wi.relations.some((x) => x.rel === 'ArtifactLink' && x.url === `vstfs:///Git/Ref/${PROJECT_ID}%2F${REPO_ID}%2FGBfeature%2F${createdId}-retry-failed-card-payments-safely`));
    const again = await call('POST', `${P}/proposals/${proposals[0].id}/approve`, { as: 'tok-alice' });
    assert.equal(again.status, 409);
  });

  await t.test('proposals: concurrent approvals create exactly one work item', async () => {
    const before = ado.state.items.size;
    const rs = await Promise.all([1, 2, 3].map(() => call('POST', `${P}/proposals/${proposals[1].id}/approve`, { as: 'tok-alice' })));
    assert.deepEqual(rs.map((x) => x.status).sort(), [200, 409, 409]);
    assert.equal(ado.state.items.size, before + 1);
  });

  await t.test('proposals: reject, list by status, approvers=members, auto-approve', async () => {
    ai.state.replies.push({ content: JSON.stringify({ proposals: [
      { title: 'Rejected idea', description: 'x', type: 'Task', acceptanceCriteria: [], suggestedFiles: [], tags: [] },
    ] }) });
    let r = await call('POST', `${P}/proposals`, { as: 'tok-bob', body: { last: 3 } });
    const pid = r.json.proposals[0].id;
    assert.equal((await call('POST', `${P}/proposals/${pid}/reject`, { as: 'tok-bob' })).status, 403);
    await call('PUT', `${P}/config`, { as: 'tok-alice', body: { overrides: { 'ai.approvers': 'members' } } });
    assert.equal((await call('POST', `${P}/proposals/${pid}/reject`, { as: 'tok-bob' })).json.status, 'rejected');
    assert.equal((await call('POST', `${P}/proposals/${pid}/reject`, { as: 'tok-bob' })).status, 409);
    r = await call('GET', `${P}/proposals?status=all`, { as: 'tok-bob' });
    assert.deepEqual(r.json.map((p) => p.status).sort(), ['approved', 'approved', 'rejected']);
    assert.equal((await call('GET', `${P}/proposals?status=weird`, { as: 'tok-bob' })).status, 400);

    await call('PUT', `${P}/config`, { as: 'tok-alice', body: { overrides: { 'ai.requireApproval': false } } });
    ai.state.replies.push({ content: JSON.stringify({ proposals: [
      { title: 'Auto ticket', description: 'y', type: 'Bug', acceptanceCriteria: [], suggestedFiles: [], tags: [] },
    ] }) });
    r = await call('POST', `${P}/proposals`, { as: 'tok-bob', body: { last: 3 } });
    assert.equal(r.json.autoApproved, true);
    assert.equal(r.json.proposals[0].status, 'approved');
    assert.equal(ado.state.items.get(r.json.proposals[0].workItemId).fields['System.WorkItemType'], 'Bug');
    await call('PUT', `${P}/config`, { as: 'tok-alice', body: { overrides: { 'ai.requireApproval': null, 'ai.approvers': null } } });
  });

  // ---------------- code links (M6) ----------------
  await t.test('code: branch, PR status and originating chat for a work item', async () => {
    ado.state.items.get(createdId).relations.push({
      rel: 'ArtifactLink', url: `vstfs:///Git/PullRequestId/${PROJECT_ID}%2F${REPO_ID}%2F7`, attributes: { name: 'Pull Request' },
    });
    const r = await call('GET', `${P}/workitems/${createdId}/code`, { as: 'tok-bob' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.branches[0].name, `feature/${createdId}-retry-failed-card-payments-safely`);
    assert.equal(r.json.branches[0].repo, 'Shop');
    assert.deepEqual(r.json.pullRequests[0], {
      id: 7, title: 'Fix checkout retries', status: 'active', isDraft: false, sourceBranch: 'feature/1-checkout',
      repo: 'Shop', url: 'https://ado.test/contoso/Shop/_git/Shop/pullrequest/7',
    });
    assert.deepEqual(r.json.origin.messages.map((m) => m.authorName), ['Bob Member', 'Alice Admin']);
    assert.equal(r.json.aiAvailable, true);
  });

  await t.test('code: create branch (pattern / custom), duplicates 409, bad names 400', async () => {
    let r = await call('POST', `${P}/workitems/${b.id}/branch`, { as: 'tok-bob' });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.name, `feature/${b.id}-cart-badge`);
    assert.equal(r.json.url, `https://ado.test/contoso/Shop/_git/Shop?version=GB${encodeURIComponent(`feature/${b.id}-cart-badge`)}`);
    r = await call('POST', `${P}/workitems/${b.id}/branch`, { as: 'tok-bob' });
    assert.equal(r.status, 409);
    for (const name of ['../x', 'a..b', '/lead', 'trail/', 'sp ace', 'x.lock', 'a/.hidden']) {
      assert.equal((await call('POST', `${P}/workitems/${b.id}/branch`, { as: 'tok-bob', body: { name } })).status, 400, name);
    }
    r = await call('POST', `${P}/workitems/${b.id}/branch`, { as: 'tok-bob', body: { name: 'users/bob/cart' } });
    assert.equal(r.status, 201);
    assert.equal((await call('POST', `${P}/workitems/${foreign.id}/branch`, { as: 'tok-bob' })).status, 404);
  });

  await t.test('code: AI summary uses item, PRs and chat origin', async () => {
    ai.state.replies.push({ content: '- Goal: safe retries\n- Status: PR !7 open' });
    const r = await call('POST', `${P}/workitems/${createdId}/summary`, { as: 'tok-bob' });
    assert.equal(r.status, 200, r.text);
    assert.match(r.json.summary, /safe retries/);
    const sent = ai.state.requests.at(-1).messages[1].content;
    assert.match(sent, /Retry failed card payments safely/);
    assert.match(sent, /!7 Fix checkout retries \(active\)/);
    assert.match(sent, /Bob Member: Checkout payments fail/);
    assert.match(sent, /No double charge/); // description HTML stripped to text
  });
});
