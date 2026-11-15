'use strict';

// Minimal in-memory imitation of the Azure DevOps REST endpoints simplan uses.
// Users are identified by their bearer access token.

const http = require('http');

const ORG = 'contoso';
const PROJECT_ID = '11111111-2222-3333-4444-555555555555';
const REPO_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const USERS = {
  'tok-alice': { id: 'a1a1a1a1-0000-0000-0000-000000000001', name: 'Alice Admin', admin: true, member: true },
  'tok-bob':   { id: 'b2b2b2b2-0000-0000-0000-000000000002', name: 'Bob Member', admin: false, member: true },
  'tok-eve':   { id: 'e5e5e5e5-0000-0000-0000-000000000005', name: 'Eve Outsider', admin: false, member: false },
};

function startFakeAdo() {
  const state = {
    file: null,           // .simplan.yml content on main, or null
    pushes: [],
    prs: [],
    calls: 0,
  };

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

    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const p = url.pathname;
      const orgPrefix = `/${ORG}`;
      if (!p.startsWith(orgPrefix + '/')) return send(404, { message: 'org not found' });
      const rest = p.slice(orgPrefix.length);

      if (rest === '/_apis/connectionData') {
        return send(200, { authenticatedUser: { id: user.id, providerDisplayName: user.name } });
      }
      if (rest === `/_apis/projects/${PROJECT_ID}`) {
        return user.member ? send(200, { id: PROJECT_ID, name: 'Shop' }) : send(404, { message: 'TF200016: project not found' });
      }
      if (/^\/_apis\/permissions\/[^/]+\/2$/.test(rest)) {
        return send(200, { value: [user.admin] });
      }
      const gitPrefix = `/${PROJECT_ID}/_apis/git/repositories`;
      if (!user.member && rest.startsWith(`/${PROJECT_ID}/`)) return send(404, { message: 'not found' });
      if (rest === gitPrefix) {
        return send(200, { value: [
          { id: 'other', name: 'infra', defaultBranch: 'refs/heads/main' },
          { id: REPO_ID, name: 'Shop', defaultBranch: 'refs/heads/main', webUrl: 'https://ado.test/contoso/Shop/_git/Shop' },
        ] });
      }
      if (rest === `${gitPrefix}/${REPO_ID}/items`) {
        if (url.searchParams.get('path') !== '/.simplan.yml' || state.file == null) return send(404, { message: 'not found' });
        return send(200, { path: '/.simplan.yml', content: state.file });
      }
      if (rest === `${gitPrefix}/${REPO_ID}/refs`) {
        return send(200, { value: [{ name: 'refs/heads/main', objectId: 'c0ffee'.padEnd(40, '0') }] });
      }
      if (rest === `${gitPrefix}/${REPO_ID}/pushes` && req.method === 'POST') {
        if (!user.admin) return send(403, { message: 'TF401027: You need the Git \'GenericContribute\' permission' });
        state.pushes.push(JSON.parse(body));
        return send(201, { pushId: state.pushes.length });
      }
      if (rest === `${gitPrefix}/${REPO_ID}/pullrequests` && req.method === 'POST') {
        const pr = { pullRequestId: 100 + state.prs.length, ...JSON.parse(body) };
        state.prs.push(pr);
        return send(201, pr);
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

module.exports = { startFakeAdo, ORG, PROJECT_ID, REPO_ID, USERS };
