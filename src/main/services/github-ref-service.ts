import * as os from 'os';
import {
  GITHUB_SHA_RE, isGithubRepo,
  type GithubChecks, type GithubRefDetails, type GithubRefKind, type GithubRefResult, type GithubRefState,
} from '../../shared/github-ref';
import { ghExec } from './git-service';

/**
 * Pull request, issue and commit details for chat's GitHub tokens (#2351).
 * One `gh api graphql` call per reference, so lookups only ever go to
 * GitHub with the user's own gh sign-in. Answers are cached (failures for
 * less time) and concurrent lookups of the same reference share one call.
 */

/** Successful lookups are reused for this long. */
export const REF_CACHE_TTL_MS = 5 * 60_000;
/** Failed lookups (signed out, rate-limited, not found) wait this long before trying again. */
export const REF_FAILURE_TTL_MS = 2 * 60_000;
const REF_CACHE_MAX = 500;
/** At most this many gh processes at once; more are refused (not cached) rather than queued. */
export const REF_MAX_IN_FLIGHT = 4;

type Runner = (args: string[]) => Promise<string | null>;

const NUMBER_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issueOrPullRequest(number:$number){
__typename
... on Issue{title state updatedAt author{login}}
... on PullRequest{title state isDraft updatedAt author{login} commits(last:1){nodes{commit{statusCheckRollup{state}}}}}
}}}`;

const COMMIT_QUERY = `query($owner:String!,$name:String!,$expr:String!){repository(owner:$owner,name:$name){object(expression:$expr){
... on Commit{messageHeadline committedDate author{name user{login}} statusCheckRollup{state}}
}}}`;

interface Node {
  __typename?: string;
  title?: string;
  messageHeadline?: string;
  state?: string;
  isDraft?: boolean;
  updatedAt?: string;
  committedDate?: string;
  author?: { login?: string; name?: string; user?: { login?: string } | null } | null;
  statusCheckRollup?: { state?: string } | null;
  commits?: { nodes?: Array<{ commit?: { statusCheckRollup?: { state?: string } | null } }> };
}

function checksOf(rollup: { state?: string } | null | undefined): GithubChecks | undefined {
  switch (rollup?.state) {
    case 'SUCCESS': return 'passing';
    case 'FAILURE': case 'ERROR': return 'failing';
    case 'PENDING': case 'EXPECTED': return 'pending';
    default: return undefined;
  }
}

function stateOf(node: Node): GithubRefState {
  if (node.state === 'MERGED') return 'merged';
  if (node.state === 'CLOSED') return 'closed';
  return node.isDraft ? 'draft' : 'open';
}

/** Parse a GraphQL answer into details, or null when it doesn't hold the reference. */
export function parseRefResponse(raw: string, kind: GithubRefKind): GithubRefDetails | null {
  let node: Node | null | undefined;
  try {
    const json = JSON.parse(raw) as { data?: { repository?: { issueOrPullRequest?: Node | null; object?: Node | null } | null } };
    const repo = json.data?.repository;
    node = kind === 'commit' ? repo?.object : repo?.issueOrPullRequest;
  } catch {
    // telemetry-exempt: unexpected gh output; the token stays a plain link.
    return null;
  }
  if (!node) return null;
  if (kind === 'commit') {
    if (typeof node.messageHeadline !== 'string') return null;
    return {
      kind: 'commit',
      title: node.messageHeadline,
      author: node.author?.user?.login ?? node.author?.name ?? undefined,
      updatedAt: node.committedDate,
      checks: checksOf(node.statusCheckRollup),
    };
  }
  if (typeof node.title !== 'string') return null;
  const isPull = node.__typename === 'PullRequest';
  // A link to /pull/N that GitHub answers with an issue (or the reverse) is still shown: it's the same number.
  return {
    kind: isPull ? 'pull' : 'issue',
    title: node.title,
    state: stateOf(node),
    author: node.author?.login ?? undefined,
    updatedAt: node.updatedAt,
    checks: isPull ? checksOf(node.commits?.nodes?.[0]?.commit?.statusCheckRollup) : undefined,
  };
}

export function createGithubRefService(run: Runner = (args) => ghExec(os.homedir(), args), now: () => number = Date.now) {
  const cache = new Map<string, { at: number; result: GithubRefResult }>();
  const inFlight = new Map<string, Promise<GithubRefResult>>();

  async function lookup(repo: string, kind: GithubRefKind, id: string): Promise<GithubRefResult> {
    const [owner, name] = repo.split('/');
    // -f sends strings and -F typed values; every value is validated before it gets here.
    // --hostname: always github.com, never a GitHub Enterprise host gh might default to.
    const args = kind === 'commit'
      ? ['api', '--hostname', 'github.com', 'graphql', '-f', `query=${COMMIT_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-f', `expr=${id}`]
      : ['api', '--hostname', 'github.com', 'graphql', '-f', `query=${NUMBER_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${id}`];
    const raw = await run(args);
    if (raw === null) return { ok: false, reason: 'unavailable' };
    const details = parseRefResponse(raw, kind);
    return details ? { ok: true, details } : { ok: false, reason: 'not_found' };
  }

  return {
    /** Details of one reference; `id` is the number, or the sha for a commit. */
    get(repo: string, kind: GithubRefKind, id: string): Promise<GithubRefResult> {
      if (!isGithubRepo(repo)) return Promise.resolve({ ok: false, reason: 'not_found' });
      const valid = kind === 'commit' ? GITHUB_SHA_RE.test(id) : /^\d{1,9}$/.test(id) && Number(id) > 0;
      if (!valid || !['pull', 'issue', 'commit', 'ref'].includes(kind)) return Promise.resolve({ ok: false, reason: 'not_found' });
      // Issues and pull requests share numbers, so #5, /issues/5 and /pull/5 are one lookup.
      const key = `${repo.toLowerCase()}|${kind === 'commit' ? `c:${id.toLowerCase()}` : `n:${Number(id)}`}`;
      const hit = cache.get(key);
      if (hit && now() - hit.at < (hit.result.ok ? REF_CACHE_TTL_MS : REF_FAILURE_TTL_MS)) return Promise.resolve(hit.result);
      const pending = inFlight.get(key);
      if (pending) return pending;
      if (inFlight.size >= REF_MAX_IN_FLIGHT) return Promise.resolve({ ok: false, reason: 'unavailable' });
      const p = lookup(repo, kind, id).then((result) => {
        if (cache.size >= REF_CACHE_MAX) cache.delete(cache.keys().next().value!);
        cache.delete(key);
        cache.set(key, { at: now(), result });
        return result;
      }).finally(() => inFlight.delete(key));
      inFlight.set(key, p);
      return p;
    },
  };
}

let shared: ReturnType<typeof createGithubRefService> | null = null;

export function getGithubRef(repo: string, kind: GithubRefKind, id: string): Promise<GithubRefResult> {
  shared ??= createGithubRefService();
  return shared.get(repo, kind, id);
}
