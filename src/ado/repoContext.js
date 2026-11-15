'use strict';

// Builds AI context from the project's configured repo, restricted to the
// `ai.contextPaths` allow-list. Nothing outside the allow-list is ever read or sent.

const LIMITS = {
  maxListedPaths: 300,
  maxFileChars: 12000,
  maxTotalChars: 60000,
  maxReads: 8,
};

const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|bmp|pdf|zip|gz|tgz|7z|rar|jar|dll|exe|so|dylib|bin|woff2?|ttf|eot|mp[34]|mov|avi|wasm|lock)$/i;
const DENY = /(^|\/)(\.env(\..*)?|.*\.pem|.*\.key|id_rsa.*|.*secret.*|node_modules\/.*|\.git\/.*)$/i;

// Minimal glob: `**` any path (incl. /), `*` within a segment, `?` one char. Leading / optional.
function globToRegex(glob) {
  let g = String(glob).trim().replace(/^\/+/, '');
  if (g.endsWith('/')) g += '**';
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

function makeMatcher(globs) {
  const res = (globs || []).map(globToRegex);
  return (path) => {
    const p = String(path).replace(/^\/+/, '');
    if (!p || p.includes('..') || BINARY_EXT.test(p) || DENY.test(p)) return false;
    return res.some((re) => re.test(p));
  };
}

// Returns { paths, allowed(path), readFile(path) -> string, stats } for one repo/branch.
async function createRepoContext(ado, repo, globs, limits = LIMITS) {
  const allowed = makeMatcher(globs);
  let all = [];
  if (repo && repo.defaultBranch) {
    all = (await ado.client.listTree(ado.project.id, repo.id, repo.defaultBranch)).map((p) => p.replace(/^\/+/, ''));
  }
  const paths = all.filter(allowed).sort();
  const stats = { reads: 0, chars: 0, filesRead: [] };

  async function readFile(path) {
    const p = String(path || '').replace(/^\/+/, '');
    if (!allowed(p) || !paths.includes(p)) return `Not allowed or not found: ${p}`;
    if (stats.reads >= limits.maxReads) return 'File read limit reached.';
    if (stats.chars >= limits.maxTotalChars) return 'Context size limit reached.';
    stats.reads++;
    const text = await ado.client.getFileText(ado.project.id, repo.id, `/${p}`, repo.defaultBranch);
    if (text == null) return `Not found: ${p}`;
    const room = Math.min(limits.maxFileChars, limits.maxTotalChars - stats.chars);
    const out = String(text).slice(0, room);
    stats.chars += out.length;
    stats.filesRead.push(p);
    return out.length < String(text).length ? `${out}\n…[truncated]` : out;
  }

  const listing = paths.slice(0, limits.maxListedPaths);
  return {
    repo,
    paths,
    listing,
    listingTruncated: paths.length > listing.length,
    allowed,
    readFile,
    stats,
    // Tool definition for foundry.structured()
    tool: {
      name: 'read_file',
      description: 'Read a file from the project repository (only paths from the provided list).',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Repository path from the list' } },
        required: ['path'],
        additionalProperties: false,
      },
      handler: async (args) => readFile(args.path),
    },
  };
}

module.exports = { createRepoContext, makeMatcher, globToRegex, LIMITS };
