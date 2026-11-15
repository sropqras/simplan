'use strict';

// Per-project simplan configuration in ADO mode.
//
// Effective value of each key = DEFAULTS  <-  repo `.simplan.yml`  <-  tool overrides (DB).
// Every key reports where its value came from ('default' | 'repo' | 'tool') so the
// settings page can show it and offer "reset to repo value".

const YAML = require('yaml');

const CONFIG_PATH = '/.simplan.yml';

// Schema: flat dotted keys. type + optional constraints. Kept hand-written and small.
const SCHEMA = {
  'repo':                 { type: 'string', default: null, maxLength: 256,
                            help: 'Repository name to use when the project has several. Default: repo named like the project, else the only/first repo.' },
  'board.workItemType':   { type: 'string', default: 'Task', maxLength: 128 },
  'board.columns':        { type: 'stringArray', default: null, maxItems: 20, maxLength: 128,
                            help: 'Ordered list of states shown as columns. Default: all states of the work item type.' },
  'board.swimlanes':      { type: 'enum', values: ['none', 'assignee'], default: 'none' },
  'board.areaPath':       { type: 'string', default: null, maxLength: 512 },
  'ai.deployment':        { type: 'string', default: null, maxLength: 128,
                            help: 'Foundry model deployment name. Default: FOUNDRY_DEPLOYMENT on the server.' },
  'ai.systemPrompt':      { type: 'string', default: null, maxLength: 4000 },
  'ai.defaultType':       { type: 'string', default: 'Task', maxLength: 128 },
  'ai.contextPaths':      { type: 'stringArray', default: ['README.md', 'docs/**'], maxItems: 50, maxLength: 256,
                            help: 'Glob allow-list of repo paths the AI may read. Nothing outside it is ever sent.' },
  'ai.requireApproval':   { type: 'boolean', default: true },
  'tickets.branchPattern':{ type: 'string', default: 'feature/{id}-{slug}', maxLength: 128 },
  'tickets.defaultTags':  { type: 'stringArray', default: [], maxItems: 20, maxLength: 64 },
};

const KEYS = Object.keys(SCHEMA);

class ConfigError extends Error {
  constructor(message, errors) {
    super(message);
    this.status = 400;
    this.expose = true;
    this.errors = errors;
  }
}

// Nested object (as written in YAML) -> flat { 'a.b': v }. Unknown keys are reported.
function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v) && !SCHEMA[key]) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}

function unflatten(flat) {
  const out = {};
  for (const [key, v] of Object.entries(flat)) {
    const parts = key.split('.');
    let cur = out;
    parts.slice(0, -1).forEach((p) => { cur = cur[p] = cur[p] || {}; });
    cur[parts[parts.length - 1]] = v;
  }
  return out;
}

function checkValue(key, v) {
  const s = SCHEMA[key];
  if (v === null) return null; // null = "unset / use lower layer"
  switch (s.type) {
    case 'string':
      if (typeof v !== 'string') return `${key} must be a string`;
      if (s.maxLength && v.length > s.maxLength) return `${key} is longer than ${s.maxLength} characters`;
      return null;
    case 'boolean':
      return typeof v === 'boolean' ? null : `${key} must be true or false`;
    case 'enum':
      return s.values.includes(v) ? null : `${key} must be one of: ${s.values.join(', ')}`;
    case 'stringArray':
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) return `${key} must be a list of strings`;
      if (v.length > s.maxItems) return `${key} has more than ${s.maxItems} items`;
      if (v.some((x) => x.length > s.maxLength)) return `${key} has an item longer than ${s.maxLength} characters`;
      return null;
    default:
      return `${key} has an unknown type`;
  }
}

// Validates a flat object. Returns the cleaned object or throws ConfigError with all problems.
function validateFlat(flat, where) {
  const errors = [];
  const clean = {};
  for (const [key, v] of Object.entries(flat)) {
    if (!SCHEMA[key]) { errors.push(`Unknown key: ${key}`); continue; }
    const e = checkValue(key, v);
    if (e) errors.push(e);
    else clean[key] = v;
  }
  if (errors.length) throw new ConfigError(`Invalid ${where}: ${errors.join('; ')}`, errors);
  return clean;
}

// Parses `.simplan.yml` text. Returns { values, errors }: a broken repo file must not
// break the tool, so problems are reported rather than thrown.
function parseRepoConfig(text) {
  if (text == null || !String(text).trim()) return { values: {}, errors: [] };
  let doc;
  try {
    doc = YAML.parse(String(text), { maxAliasCount: 50 });
  } catch (err) {
    return { values: {}, errors: [`.simplan.yml is not valid YAML: ${err.message.split('\n')[0]}`] };
  }
  if (doc === null || doc === undefined) return { values: {}, errors: [] };
  if (typeof doc !== 'object' || Array.isArray(doc)) {
    return { values: {}, errors: ['.simplan.yml must be a mapping of keys'] };
  }
  try {
    return { values: validateFlat(flatten(doc), '.simplan.yml'), errors: [] };
  } catch (err) {
    // Keep the valid keys, report the bad ones.
    const flat = flatten(doc);
    const values = {};
    for (const [k, v] of Object.entries(flat)) {
      if (SCHEMA[k] && !checkValue(k, v) && v !== null) values[k] = v;
    }
    return { values, errors: err.errors || [err.message] };
  }
}

// Tool overrides come from the settings page as a flat object. null means "remove override".
function validateOverrides(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ConfigError('overrides must be an object', ['overrides must be an object']);
  }
  return validateFlat(input, 'settings');
}

function mergeConfig(repoValues = {}, overrides = {}) {
  const values = {};
  const sources = {};
  for (const key of KEYS) {
    if (overrides[key] !== undefined && overrides[key] !== null) {
      values[key] = overrides[key]; sources[key] = 'tool';
    } else if (repoValues[key] !== undefined && repoValues[key] !== null) {
      values[key] = repoValues[key]; sources[key] = 'repo';
    } else {
      values[key] = SCHEMA[key].default; sources[key] = 'default';
    }
  }
  return { values, sources };
}

// Effective config -> YAML for "commit to repo". Defaults are left out to keep the file short.
function toYaml(values, sources) {
  const keep = {};
  for (const key of KEYS) if (sources[key] !== 'default') keep[key] = values[key];
  const header = '# simplan configuration. Settings saved in the simplan settings page override these.\n';
  const body = Object.keys(keep).length ? YAML.stringify(unflatten(keep)) : '{}\n';
  return header + body;
}

// Which repo holds the config: explicit override, else repo named like the project,
// else the only repo, else the first one alphabetically.
function pickRepo(repos, projectName, wantedName) {
  const usable = repos.filter((r) => !r.isDisabled);
  if (!usable.length) return null;
  const byName = (n) => usable.find((r) => r.name.toLowerCase() === String(n).toLowerCase());
  if (wantedName) return byName(wantedName) || null;
  return byName(projectName) || (usable.length === 1 ? usable[0] : [...usable].sort((a, b) => a.name.localeCompare(b.name))[0]);
}

function branchName(ref) {
  return ref ? ref.replace(/^refs\/heads\//, '') : null;
}

module.exports = {
  SCHEMA, KEYS, CONFIG_PATH, ConfigError,
  parseRepoConfig, validateOverrides, mergeConfig, toYaml, pickRepo, branchName, flatten, unflatten,
};
