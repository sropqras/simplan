// Work item form group "simplan": linked branches/PRs, originating chat, create branch, AI summary.
// The form host calls the registered object's onLoaded/onSaved/onRefreshed/onUnloaded.

import * as SDK from 'azure-devops-extension-sdk';
import { initPage, api, h, mount, showFatal, timeAgo } from '../common/backend';

const root = document.getElementById('root');
let ctx;
let workItemId = 0;
let data = null;
let summary = null;
let banner = null;
let busy = false;

const PR_STATUS = { active: 'Active', completed: 'Completed', abandoned: 'Abandoned', notSet: '—', unknown: 'unknown' };

function resize() {
  try { SDK.resize(undefined, Math.min(Math.max(document.body.scrollHeight + 8, 120), 900)); } catch { /* not in a frame */ }
}

function render() {
  if (!workItemId) {
    mount(root, h('div', { class: 'muted' }, 'Save the work item to use simplan.'));
    return resize();
  }
  if (!data) {
    mount(root, h('div', { class: 'muted' }, 'Loading…'), banner ? h('div', { class: `banner ${banner.kind}` }, banner.text) : null);
    return resize();
  }
  mount(root,
    banner ? h('div', { class: `banner ${banner.kind}` }, banner.text) : null,
    h('div', { class: 'row' },
      h('button', { disabled: busy, onclick: createBranch, title: 'Create a branch from the default branch and link it' }, 'Create branch'),
      data.aiAvailable ? h('button', { disabled: busy, onclick: summarize }, 'AI summary') : null),
    summary ? h('div', { class: 'card small pre' }, summary) : null,
    h('h2', {}, 'Code'),
    data.branches.length || data.pullRequests.length ? null : h('div', { class: 'muted small' }, 'No branches or pull requests linked.'),
    data.branches.map((b) => h('div', { class: 'small' }, '⎇ ',
      b.url ? h('a', { href: b.url, target: '_blank', rel: 'noopener' }, b.name) : b.name,
      b.repo ? h('span', { class: 'muted' }, ` · ${b.repo}`) : null)),
    data.pullRequests.map((p) => h('div', { class: 'small' }, `PR !${p.id} `,
      p.url ? h('a', { href: p.url, target: '_blank', rel: 'noopener' }, p.title || '(no access)') : (p.title || ''),
      h('span', { class: `badge pr-${p.status}` }, `${p.isDraft ? 'Draft · ' : ''}${PR_STATUS[p.status] || p.status}`))),
    data.commits ? h('div', { class: 'muted small' }, `${data.commits} linked commit(s)`) : null,
    data.origin ? [
      h('h2', {}, 'From project chat'),
      h('div', { class: 'small muted' }, `Approved ${data.origin.approvedAt ? timeAgo(data.origin.approvedAt) : ''}`),
      data.origin.messages.map((m) => h('div', { class: 'small quote' }, h('strong', {}, `${m.authorName}: `), m.body)),
    ] : null);
  resize();
}

async function load() {
  if (!workItemId) return render();
  try {
    data = await api(ctx, 'GET', `/projects/${ctx.project.id}/workitems/${workItemId}/code`);
    banner = null;
  } catch (err) {
    banner = { kind: 'error', text: err.message };
  }
  render();
}

async function createBranch() {
  busy = true; render();
  try {
    const b = await api(ctx, 'POST', `/projects/${ctx.project.id}/workitems/${workItemId}/branch`, {});
    banner = { kind: 'ok', text: `Created branch ${b.name}. Refresh the form to see the link in Development.` };
    await load();
  } catch (err) {
    banner = { kind: 'error', text: err.message };
  }
  busy = false; render();
}

async function summarize() {
  busy = true; summary = 'Thinking…'; render();
  try {
    summary = (await api(ctx, 'POST', `/projects/${ctx.project.id}/workitems/${workItemId}/summary`, {})).summary;
  } catch (err) {
    summary = null;
    banner = { kind: 'error', text: err.message };
  }
  busy = false; render();
}

(async () => {
  try {
    // Register before init completes so the form can call us.
    SDK.register(SDK.getContributionId(), {
      onLoaded: (args) => { workItemId = (args && args.id) || 0; data = null; summary = null; load(); },
      onSaved: (args) => { if (args && args.id && args.id !== workItemId) { workItemId = args.id; load(); } },
      onRefreshed: () => load(),
      onReset: () => {},
      onUnloaded: () => { workItemId = 0; data = null; },
    });
    ctx = await initPage();
    if (!ctx.project) throw new Error('No project context.');
    render();
    await ctx.SDK.notifyLoadSucceeded();
  } catch (err) {
    showFatal(root, err);
    if (ctx) await ctx.SDK.notifyLoadSucceeded();
  }
})();
