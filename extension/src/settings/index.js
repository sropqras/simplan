// Project settings page: edit simplan's tool configs.
// Each key shows its effective value and where it comes from:
//   default  -> built-in default
//   repo     -> .simplan.yml in the project's repo
//   tool     -> override saved here (wins over the repo file)

import { initPage, api, h, mount, showFatal } from '../common/backend';

const root = document.getElementById('root');
let ctx;
let view;           // last GET/PUT response
const edits = {};   // key -> new override value (null = remove override)

const LABELS = {
  'repo': 'Repository',
  'board.workItemType': 'Board: work item type',
  'board.columns': 'Board: columns (states)',
  'board.swimlanes': 'Board: swimlanes',
  'board.areaPath': 'Board: area path',
  'ai.deployment': 'AI: Foundry deployment',
  'ai.systemPrompt': 'AI: extra instructions',
  'ai.defaultType': 'AI: default ticket type',
  'ai.contextPaths': 'AI: repo paths it may read',
  'ai.requireApproval': 'AI: tickets need approval',
  'tickets.branchPattern': 'Tickets: branch name pattern',
  'tickets.defaultTags': 'Tickets: default tags',
};

// ---- value <-> input conversion ----
function toInput(type, v) {
  if (v === null || v === undefined) return '';
  if (type === 'stringArray') return v.join('\n');
  return String(v);
}
// Empty input means "no override" (fall back to repo/default).
function fromInput(type, s) {
  if (type === 'stringArray') {
    const items = s.split('\n').map((x) => x.trim()).filter(Boolean);
    return items.length ? items : null;
  }
  if (type === 'boolean') return s === '' ? null : s === 'true';
  const t = s.trim();
  return t === '' ? null : t;
}
function same(a, b) { return JSON.stringify(a ?? null) === JSON.stringify(b ?? null); }

function control(key, spec, value, disabled) {
  const onchange = (ev) => {
    const next = fromInput(spec.type, ev.target.value);
    const current = view.overrides[key] ?? null;
    if (same(next, current)) delete edits[key];
    else edits[key] = next;
    render();
  };
  const val = key in edits ? edits[key] : view.overrides[key];
  const shown = toInput(spec.type, val ?? null);
  const placeholder = toInput(spec.type, value) || '(not set)';

  if (spec.type === 'enum' || spec.type === 'boolean') {
    const options = spec.type === 'boolean' ? ['true', 'false'] : spec.values;
    return h('select', { disabled, onchange },
      h('option', { value: '' }, `— use ${view.sources[key] === 'tool' ? 'repo/default' : view.sources[key]}: ${toInput(spec.type, inherited(key))} —`),
      options.map((o) => h('option', { value: o, selected: shown === o }, o)));
  }
  if (spec.type === 'stringArray' || key === 'ai.systemPrompt') {
    return h('textarea', { rows: spec.type === 'stringArray' ? 3 : 5, disabled, placeholder, value: shown, onchange });
  }
  if (key === 'repo') {
    return h('select', { disabled, onchange },
      h('option', { value: '' }, '— automatic —'),
      view.repos.map((r) => h('option', { value: r, selected: shown === r }, r)));
  }
  return h('input', { type: 'text', disabled, placeholder, value: shown, onchange });
}

// Value the key would have without a tool override.
function inherited(key) {
  return key in view.repoValues ? view.repoValues[key] : view.schema[key].default;
}

function render() {
  const dirty = Object.keys(edits).length > 0;
  const canEdit = view.canEdit;

  const repoInfo = view.repo
    ? h('div', { class: 'card' },
        h('div', {}, 'Repository: ', h('strong', {}, view.repo.name), ' · branch ', h('span', { class: 'mono' }, view.repo.defaultBranch || '—')),
        h('div', { class: 'muted' }, view.repoFile.exists
          ? ['Reading ', h('span', { class: 'mono' }, view.repoFile.path), ' from the default branch.']
          : ['No ', h('span', { class: 'mono' }, view.repoFile.path), ' in the repo yet. Use "Commit to repo" to create one.']))
    : h('div', { class: 'banner warn' }, 'No usable Git repository found in this project. Settings saved here still apply.');

  const errors = view.repoFile.errors.length
    ? h('div', { class: 'banner warn' }, h('strong', {}, 'Problems in the repo config (ignored keys): '),
        h('ul', {}, view.repoFile.errors.map((e) => h('li', {}, e))))
    : null;

  const fields = Object.entries(view.schema).map(([key, spec]) => {
    const src = view.sources[key];
    const isOverride = src === 'tool' && !(key in edits && edits[key] === null);
    return h('div', { class: `field${key in edits ? ' dirty' : ''}` },
      h('label', {}, LABELS[key] || key, h('div', { class: 'mono muted' }, key)),
      control(key, spec, inherited(key), !canEdit),
      h('div', { class: 'source' },
        h('span', { class: `badge ${src}` }, src),
        isOverride && canEdit
          ? h('div', {}, h('button', { class: 'link', title: 'Remove the override and use the repo/default value',
              onclick: () => { edits[key] = null; render(); } }, 'reset'))
          : null),
      spec.help ? h('div', { class: 'help' }, spec.help) : null);
  });

  mount(root,
    h('h1', {}, 'simplan settings'),
    h('div', { class: 'muted' },
      'Values come from the built-in defaults, then ', h('span', { class: 'mono' }, '.simplan.yml'),
      ' in the project repo, then overrides saved on this page (highest priority).'),
    !canEdit ? h('div', { class: 'banner warn' }, 'Read-only: only project administrators can change these settings.') : null,
    h('h2', {}, 'Source'), repoInfo, errors,
    h('h2', {}, 'Settings'), fields,
    canEdit ? h('div', { class: 'actions row' },
      h('button', { class: 'primary', disabled: !dirty, onclick: save }, 'Save'),
      h('button', { disabled: !dirty, onclick: () => { for (const k of Object.keys(edits)) delete edits[k]; render(); } }, 'Discard'),
      h('span', { style: 'flex:1' }),
      h('button', { disabled: dirty || !view.repo, title: dirty ? 'Save first' : 'Open a pull request writing these settings to .simplan.yml',
        onclick: commitToRepo }, 'Commit to repo…')) : null,
    h('div', { id: 'status' }));
}

function status(kind, ...content) {
  document.getElementById('status').replaceChildren(h('div', { class: `banner ${kind}` }, ...content));
}

async function save() {
  try {
    view = await api(ctx, 'PUT', `/projects/${ctx.project.id}/config`, { overrides: { ...edits } });
    for (const k of Object.keys(edits)) delete edits[k];
    render();
    status('ok', 'Saved.');
  } catch (err) {
    status('error', err.message, err.details.length ? h('ul', {}, err.details.map((d) => h('li', {}, d))) : null);
  }
}

async function commitToRepo() {
  if (!confirm(`Open a pull request in "${view.repo.name}" that writes the current settings to .simplan.yml?`)) return;
  try {
    const pr = await api(ctx, 'POST', `/projects/${ctx.project.id}/config/commit`);
    status('ok', `Pull request #${pr.pullRequestId} created on branch `, h('span', { class: 'mono' }, pr.branch), '. ',
      pr.url ? h('a', { href: pr.url, target: '_blank', rel: 'noopener' }, 'Open it') : null);
  } catch (err) {
    status('error', err.message);
  }
}

(async () => {
  try {
    ctx = await initPage();
    if (!ctx.project) throw new Error('Open this page from a project.');
    view = await api(ctx, 'GET', `/projects/${ctx.project.id}/config`);
    render();
    await ctx.SDK.notifyLoadSucceeded();
  } catch (err) {
    showFatal(root, err);
    if (ctx) await ctx.SDK.notifyLoadSucceeded(); // show our error instead of ADO's spinner
  }
})();
