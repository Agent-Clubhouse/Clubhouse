import { test, expect } from '@playwright/test';
import { chatDom, openRichChat, TURN_TIMEOUT, type RichChat } from './harness';

/**
 * Links and PR tokens (#2480 area 4, #2488). GitHub references in an agent's
 * reply become tokens; a token's hover card is looked up in main only once
 * it's hovered or focused, and never for a plain link. Main's lookups answer
 * from the harness's stubs (CLUBHOUSE_TEST_GITHUB_REFS), which also record
 * each one, so nothing reaches gh or the network.
 *
 * One launch for the file: the tests run in order and share main's and the
 * renderer's lookup caches, which is what the "looked up once" checks need.
 */

const REPO_URL = 'https://github.com/acme/widgets';
const PR = `${REPO_URL}/pull/34`;
// Bare #12 could be an issue or a pull request, so its token links to /issues/12 until GitHub answers.
const BARE = `${REPO_URL}/issues/12`;
const UNKNOWN = `${REPO_URL}/issues/99`;
const COMMIT = `${REPO_URL}/commit/abc1234def`;
const PLAIN = 'https://example.com/docs/links';

/** What `gh api graphql` prints for each reference the reply names, except #99. */
const GITHUB_REFS = {
  'acme/widgets#34': { data: { repository: { issueOrPullRequest: {
    __typename: 'PullRequest', title: 'Add link tokens', state: 'MERGED', isDraft: false, updatedAt: '2026-10-18T10:00:00Z',
    author: { login: 'octo' }, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
  } } } },
  'acme/widgets#12': { data: { repository: { issueOrPullRequest: {
    __typename: 'PullRequest', title: 'Wrap long links', state: 'OPEN', isDraft: true, updatedAt: '2026-10-17T09:00:00Z',
    author: { login: 'hubot' },
  } } } },
  'acme/widgets@abc1234def': { data: { repository: { object: {
    messageHeadline: 'Tokenize links', committedDate: '2026-10-16T08:00:00Z',
    author: { name: 'Octo', user: { login: 'octo' } }, statusCheckRollup: { state: 'FAILURE' },
  } } } },
};

const REPLY = `The fix is ${PR}, which follows #12. It builds on ${COMMIT}, and acme/widgets#99 is unrelated. Background: ${PLAIN}.`;

test.describe.configure({ mode: 'serial' });

let session: RichChat;
let dom: ReturnType<typeof chatDom>;

const lookedUp = async () => (await session.githubRefRequests()).map((r) => r.ref);

test.beforeAll(async () => {
  session = await openRichChat({
    cli: 'claude',
    gitRemote: `${REPO_URL}.git`,
    githubRefs: GITHUB_REFS,
    script: { description: 'a reply naming a pull request, issues, a commit and a plain link', turns: [{ steps: [{ type: 'text', text: REPLY }] }] },
  });
  dom = chatDom(session.window);
  await session.send('What fixed the link bug?');
  await expect(dom.turnFooters).toHaveCount(1, { timeout: TURN_TIMEOUT });
  // Bare #12 is a token only once the project's GitHub remote has resolved.
  await expect(dom.githubToken(BARE)).toBeVisible({ timeout: TURN_TIMEOUT });
});

test.afterAll(async () => {
  await session?.close();
});

test('claude: references render as tokens without looking anything up', async () => {
  // A URL in the project's own repo reads as its number.
  await expect(dom.githubToken(PR)).toHaveText('#34');
  await expect(dom.githubToken(PR)).toHaveAttribute('data-gh-kind', 'pull');
  await expect(dom.githubToken(BARE)).toHaveText('#12');
  await expect(dom.githubToken(BARE)).toHaveAttribute('data-gh-kind', 'issue');
  await expect(dom.githubToken(UNKNOWN)).toHaveText('acme/widgets#99');
  await expect(dom.githubToken(COMMIT)).toHaveAttribute('data-gh-kind', 'commit');
  await expect(dom.plainLink(PLAIN)).toBeVisible();
  await expect(session.window.locator(`a[data-gh-token][href="${PLAIN}"]`)).toHaveCount(0);

  // Nothing is known yet, and nothing was asked.
  await expect(dom.githubToken(PR)).not.toHaveAttribute('data-gh-state');
  expect(await lookedUp()).toEqual([]);
});

test('claude: hovering or focusing a token asks GitHub once and shows its card', async () => {
  const token = dom.githubToken(PR);
  await token.hover();
  await expect(dom.githubCardTitle).toHaveText('Add link tokens', { timeout: TURN_TIMEOUT });
  await expect(dom.githubCardState).toHaveText('Merged');
  await expect(dom.githubCard).toContainText('octo');
  await expect(dom.githubCard).toContainText('Checks passing');
  await expect(token).toHaveAttribute('data-gh-state', 'merged');
  const [request] = await session.githubRefRequests();
  expect(request.ref).toBe('acme/widgets#34');
  // Only ever github.com, never a GitHub Enterprise host gh might default to.
  expect(request.args).toEqual(expect.arrayContaining(['--hostname', 'github.com']));

  await dom.composer.hover();
  await expect(dom.githubCard).toHaveCount(0);

  // Keyboard focus opens the card too, and the answer turns bare #12 into the pull request it is.
  await dom.githubToken(BARE).focus();
  await expect(dom.githubCardTitle).toHaveText('Wrap long links', { timeout: TURN_TIMEOUT });
  await expect(dom.githubCardState).toHaveText('Draft');
  await expect(dom.githubToken(BARE)).toHaveAttribute('data-gh-kind', 'pull');
  await expect(dom.githubToken(BARE)).toHaveAttribute('data-gh-state', 'draft');
  await session.window.getByRole('textbox', { name: 'Message' }).focus();
  await expect(dom.githubCard).toHaveCount(0);

  // A second hover shows the card again without asking GitHub again.
  await token.hover();
  await expect(dom.githubCardTitle).toHaveText('Add link tokens');
  await dom.composer.hover();
  await expect(dom.githubCard).toHaveCount(0);

  expect(await lookedUp()).toEqual(['acme/widgets#34', 'acme/widgets#12']);
});

test('claude: a plain link is never looked up, and a reference GitHub cannot answer shows no card', async () => {
  await dom.plainLink(PLAIN).hover();

  // #99 has no stub, so the lookup fails like a signed-out gh: the token stays a plain link.
  await dom.githubToken(UNKNOWN).hover();
  await expect.poll(lookedUp, { timeout: TURN_TIMEOUT }).toContain('acme/widgets#99');
  await expect(dom.githubCard).toHaveCount(0);
  await expect(dom.githubToken(UNKNOWN)).not.toHaveAttribute('data-gh-state');

  await dom.githubToken(COMMIT).hover();
  await expect(dom.githubCardTitle).toHaveText('Tokenize links', { timeout: TURN_TIMEOUT });
  await expect(dom.githubCard).toContainText('Checks failing');
  await dom.composer.hover();
  await expect(dom.githubCard).toHaveCount(0);

  // The plain link's hover asked GitHub nothing, and nothing was asked twice.
  expect(await lookedUp()).toEqual(['acme/widgets#34', 'acme/widgets#12', 'acme/widgets#99', 'acme/widgets@abc1234def']);
});

test('claude: clicking a token or a link opens it in the browser without another lookup', async () => {
  // Stand in for the browser: record what main would open.
  await session.electronApp.evaluate(({ shell }) => {
    const opened: string[] = [];
    (globalThis as { __openedUrls?: string[] }).__openedUrls = opened;
    shell.openExternal = async (url: string) => { opened.push(url); };
  });
  const opened = () => session.electronApp.evaluate(() => (globalThis as { __openedUrls?: string[] }).__openedUrls ?? []);

  await dom.githubToken(PR).click();
  await expect.poll(opened, { timeout: TURN_TIMEOUT }).toEqual([PR]);
  await dom.plainLink(PLAIN).click();
  await expect.poll(opened, { timeout: TURN_TIMEOUT }).toEqual([PR, PLAIN]);

  expect(await lookedUp()).toEqual(['acme/widgets#34', 'acme/widgets#12', 'acme/widgets#99', 'acme/widgets@abc1234def']);
  await session.expectScriptComplete();
});
