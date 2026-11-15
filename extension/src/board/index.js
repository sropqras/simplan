// simplan Board hub. Milestone 1: proves the extension <-> backend auth bridge
// end to end (whoami + effective config). The live board arrives in milestone 3.

import { initPage, api, h, mount, showFatal } from '../common/backend';

const root = document.getElementById('root');

(async () => {
  let ctx;
  try {
    ctx = await initPage();
    if (!ctx.project) throw new Error('Open this hub from a project.');
    const [me, cfg] = await Promise.all([
      api(ctx, 'GET', '/whoami'),
      api(ctx, 'GET', `/projects/${ctx.project.id}/config`),
    ]);
    mount(root,
      h('h1', {}, `simplan · ${ctx.project.name}`),
      h('div', { class: 'banner ok' },
        'Connected to the simplan backend as ', h('strong', {}, me.displayName), ` (${me.org}).`),
      h('div', { class: 'card' },
        h('div', {}, 'Board work item type: ', h('strong', {}, cfg.values['board.workItemType']),
          ' ', h('span', { class: `badge ${cfg.sources['board.workItemType']}` }, cfg.sources['board.workItemType'])),
        h('div', {}, 'Swimlanes: ', h('strong', {}, cfg.values['board.swimlanes'])),
        h('div', {}, 'Repository: ', h('strong', {}, cfg.repo ? cfg.repo.name : 'none'),
          cfg.repoFile.exists ? ' (has .simplan.yml)' : ' (no .simplan.yml yet)')),
      h('p', { class: 'muted' }, 'The live board, chat and AI ticket creation are coming in the next milestones. ',
        'Change settings under Project settings → simplan.'));
    await ctx.SDK.notifyLoadSucceeded();
  } catch (err) {
    showFatal(root, err);
    if (ctx) await ctx.SDK.notifyLoadSucceeded();
  }
})();
