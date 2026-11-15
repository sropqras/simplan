'use strict';

// Minimal in-memory imitation of the Azure DevOps REST endpoints simplan uses.
// Users are identified by their bearer access token.

const http = require('http');

const ORG = 'contoso';
const PROJECT_ID = '11111111-2222-3333-4444-555555555555';
const REPO_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const TEAM_ID = '99999999-8888-7777-6666-555555555555';

const USERS = {
  'tok-alice': { id: 'a1a1a1a1-0000-0000-0000-000000000001', name: 'Alice Admin', unique: 'alice@contoso.test', admin: true, member: true },
  'tok-bob':   { id: 'b2b2b2b2-0000-0000-0000-000000000002', name: 'Bob Member', unique: 'bob@contoso.test', admin: false, member: true },
  'tok-eve':   { id: 'e5e5e5e5-0000-0000-0000-000000000005', name: 'Eve Outsider', unique: 'eve@other.test', admin: false, member: false },
};

const TYPES = {
  Task: [
    { name: 'To Do', color: 'b2b2b2', category: 'Proposed' },
    { name: 'Doing', color: '007acc', category: 'InProgress' },
    { name: 'Done', color: '339933', category: 'Completed' },
    { name: 'Removed', color: 'ffffff', category: 'Removed' },
  ],
  Bug: [
    { name: 'New', color: 'b2b2b2', category: 'Proposed' },
    { name: 'Active', color: '007acc', category: 'InProgress' },
    { name: 'Closed', color: '339933', category: 'Completed' },
  ],
  'User Story': [
    { name: 'New', category: 'Proposed' },
    { name: 'Active', category: 'InProgress' },
    { name: 'Closed', category: 'Completed' },
  ],
};

function identity(u) {
  return { id: u.id, displayName: u.name, uniqueName: u.unique, _links: { avatar: { href: `https://ado.test/avatar/${u.id}` } } };
}

function startFakeAdo() {
  const state = {
    file: null,                 // .simplan.yml content on main, or null
    files: {                    // other repo files (path without leading slash -> content)
      'README.md': '# Shop\nAn online shop. Checkout lives in src/checkout.js.',
      'src/checkout.js': 'function checkout() { /* TODO: retry payments */ }',
      'src/cart.js': 'module.exports = {};',
      '.env': 'SECRET=1',
      'docs/setup.md': 'Run npm start.',
    },
    pushes: [],
    prs: [],
    refs: { main: 'c0ffee'.padEnd(40, '0') },
    items: new Map(),           // id -> work item
    nextId: 100,
    wiql: [],                   // queries received
    subscriptions: new Map(),
    nextSub: 1,
    pullRequests: { 7: { pullRequestId: 7, title: 'Fix checkout retries', status: 'active', isDraft: false, sourceRefName: 'refs/heads/feature/1-checkout' } },
    calls: 0,
    log: [],
  };

  function addItem(fields, { project = 'Shop', relations = [] } = {}) {
    const id = state.nextId++;
    const item = {
      id, rev: 1, relations,
      fields: {
        'System.TeamProject': project,
        'System.State': TYPES[fields['System.WorkItemType'] || 'Task'][0].name,
        'System.WorkItemType': 'Task',
        'System.ChangedDate': new Date().toISOString(),
        ...fields,
      },
    };
    state.items.set(id, item);
    return item;
  }
  state.addItem = addItem;

  const server = http.createServer((req, res) => {
    state.calls++;
    const url = new URL(req.url, 'http://x');
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    const user = USERS[token];
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (!user) { res.writeHead(302, { location: '/_signin' }); return res.end(); }

    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      const p = url.pathname;
      state.log.push(`${req.method} ${p}`);
      if (!p.startsWith(`/${ORG}/`)) return send(404, { message: 'org not found' });
      const rest = p.slice(ORG.length + 1);
      const pp = `/${PROJECT_ID}`;
      const member = user.member;

      // ---- identity / project / permissions ----
      if (rest === '/_apis/connectionData') {
        return send(200, { authenticatedUser: { id: user.id, providerDisplayName: user.name } });
      }
      if (rest === `/_apis/projects/${PROJECT_ID}`) {
        return member ? send(200, { id: PROJECT_ID, name: 'Shop', defaultTeam: { id: TEAM_ID, name: 'Shop Team' } })
          : send(404, { message: 'TF200016: project not found' });
      }
      if (/^\/_apis\/permissions\/[^/]+\/2$/.test(rest)) return send(200, { value: [user.admin] });
      if (rest === `/_apis/projects/${PROJECT_ID}/teams/${TEAM_ID}/members`) {
        if (!member) return send(404, { message: 'not found' });
        return send(200, { value: [USERS['tok-bob'], USERS['tok-alice']].map((u) => ({ identity: identity(u) })) });
      }

      // ---- service hooks ----
      if (rest === '/_apis/hooks/subscriptions') {
        if (req.method === 'GET') return send(200, { value: [...state.subscriptions.values()] });
        if (req.method === 'POST') {
          if (!user.admin) return send(403, { message: 'no hooks permission' });
          const sub = { id: `sub-${state.nextSub++}`, ...body };
          state.subscriptions.set(sub.id, sub);
          return send(200, sub);
        }
      }
      const subM = /^\/_apis\/hooks\/subscriptions\/([^/]+)$/.exec(rest);
      if (subM && req.method === 'DELETE') {
        return state.subscriptions.delete(subM[1]) ? send(204, {}) : send(404, { message: 'no sub' });
      }

      if (rest.startsWith(`${pp}/`) && !member) return send(404, { message: 'not found' });

      // ---- work items ----
      if (rest === `${pp}/_apis/wit/workitemtypes`) {
        return send(200, { value: Object.keys(TYPES).map((name) => ({ name })) });
      }
      const statesM = /^\/[^/]+\/_apis\/wit\/workitemtypes\/([^/]+)\/states$/.exec(rest);
      if (statesM) {
        const t = TYPES[decodeURIComponent(statesM[1])];
        return t ? send(200, { value: t }) : send(404, { message: 'TF51535: type not found' });
      }
      if (rest === `${pp}/_apis/wit/wiql` && req.method === 'POST') {
        state.wiql.push(body.query);
        const typeM = /\[System\.WorkItemType\] = '((?:[^']|'')*)'/.exec(body.query);
        const type = typeM ? typeM[1].replace(/''/g, "'") : null;
        const ids = [...state.items.values()]
          .filter((i) => i.fields['System.TeamProject'] === 'Shop' && (!type || i.fields['System.WorkItemType'] === type))
          .map((i) => ({ id: i.id }));
        return send(200, { workItems: ids });
      }
      if (rest === `${pp}/_apis/wit/workitemsbatch` && req.method === 'POST') {
        return send(200, { value: body.ids.map((id) => state.items.get(id) || null) });
      }
      const createM = /^\/[^/]+\/_apis\/wit\/workitems\/\$(.+)$/.exec(rest);
      if (createM && req.method === 'POST') {
        if (!/json-patch/.test(req.headers['content-type'])) return send(415, { message: 'need json-patch' });
        const type = decodeURIComponent(createM[1]);
        if (!TYPES[type]) return send(400, { message: `TF401326: Work item type ${type} does not exist` });
        const fields = { 'System.WorkItemType': type };
        for (const op of body) if (op.path.startsWith('/fields/')) fields[op.path.slice(8)] = op.value;
        const item = addItem(fields);
        item.createdBy = user.id;
        return send(200, item);
      }
      const wiM = /^\/[^/]+\/_apis\/wit\/workitems\/(\d+)$/.exec(rest);
      if (wiM) {
        const item = state.items.get(Number(wiM[1]));
        if (!item) return send(404, { message: 'TF401232: Work item does not exist' });
        if (req.method === 'GET') {
          const out = { ...item };
          if (url.searchParams.get('$expand') !== 'relations') delete out.relations;
          return send(200, out);
        }
        if (req.method === 'PATCH') {
          if (!/json-patch/.test(req.headers['content-type'])) return send(415, { message: 'need json-patch' });
          for (const op of body) {
            if (op.op === 'test' && op.path === '/rev' && op.value !== item.rev) {
              return send(412, { message: 'TF26071: This work item has been changed by someone else' });
            }
          }
          for (const op of body) {
            if (op.op === 'add' && op.path.startsWith('/fields/')) {
              const f = op.path.slice(8);
              if (f === 'System.State') {
                const allowed = TYPES[item.fields['System.WorkItemType']].map((s) => s.name);
                if (!allowed.includes(op.value)) return send(400, { message: `TF401320: invalid state ${op.value}` });
              }
              if (f === 'System.AssignedTo') {
                const u = Object.values(USERS).find((x) => x.unique === op.value);
                item.fields[f] = u ? identity(u) : undefined;
                if (!u) delete item.fields[f];
              } else item.fields[f] = op.value;
            }
            if (op.op === 'add' && op.path === '/relations/-') item.relations.push(op.value);
          }
          item.rev++;
          item.fields['System.ChangedDate'] = new Date().toISOString();
          return send(200, item);
        }
      }

      // ---- git ----
      const gitPrefix = `${pp}/_apis/git/repositories`;
      if (rest === gitPrefix) {
        return send(200, { value: [
          { id: 'other', name: 'infra', defaultBranch: 'refs/heads/main' },
          { id: REPO_ID, name: 'Shop', defaultBranch: 'refs/heads/main', webUrl: 'https://ado.test/contoso/Shop/_git/Shop' },
        ] });
      }
      if (rest === `${gitPrefix}/${REPO_ID}/items`) {
        if (url.searchParams.get('recursionLevel') === 'Full') {
          const paths = Object.keys(state.files).concat(state.file != null ? ['.simplan.yml'] : []);
          return send(200, { value: [{ path: '/', isFolder: true }, ...paths.map((x) => ({ path: `/${x}`, isFolder: false }))] });
        }
        const path = (url.searchParams.get('path') || '').replace(/^\//, '');
        if (path === '.simplan.yml') return state.file == null ? send(404, { message: 'not found' }) : send(200, { content: state.file });
        if (path in state.files) { state.log.push(`READ ${path}`); return send(200, { path: `/${path}`, content: state.files[path] }); }
        return send(404, { message: 'not found' });
      }
      if (rest === `${gitPrefix}/${REPO_ID}/refs`) {
        if (req.method === 'GET') {
          const name = (url.searchParams.get('filter') || '').replace(/^heads\//, '');
          return send(200, { value: state.refs[name] ? [{ name: `refs/heads/${name}`, objectId: state.refs[name] }] : [] });
        }
        if (req.method === 'POST') {
          if (!member) return send(403, { message: 'no' });
          const u = body[0];
          const name = u.name.replace(/^refs\/heads\//, '');
          if (state.refs[name]) return send(200, { value: [{ name: u.name, success: false, updateStatus: 'failedToCreateRefAlreadyExists' }] });
          state.refs[name] = u.newObjectId;
          return send(200, { value: [{ name: u.name, success: true, updateStatus: 'succeeded' }] });
        }
      }
      if (rest === `${gitPrefix}/${REPO_ID}/pushes` && req.method === 'POST') {
        if (!user.admin) return send(403, { message: 'TF401027: You need the Git \'GenericContribute\' permission' });
        state.pushes.push(body);
        return send(201, { pushId: state.pushes.length });
      }
      if (rest === `${gitPrefix}/${REPO_ID}/pullrequests` && req.method === 'POST') {
        const pr = { pullRequestId: 100 + state.prs.length, ...body };
        state.prs.push(pr);
        return send(201, pr);
      }
      const prM = /^\/[^/]+\/_apis\/git\/pullrequests\/(\d+)$/.exec(rest);
      if (prM) {
        const pr = state.pullRequests[prM[1]];
        return pr ? send(200, pr) : send(404, { message: 'no pr' });
      }
      return send(404, { message: `fake ADO: no route ${req.method} ${rest}` });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, state, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() });
    });
  });
}

module.exports = { startFakeAdo, ORG, PROJECT_ID, REPO_ID, TEAM_ID, USERS, TYPES };
