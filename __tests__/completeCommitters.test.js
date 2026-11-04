'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { completeAttribution, boundedTransport, objectQuery } = require('../lib/completeCommitters')
const copy = value => JSON.parse(JSON.stringify(value))
const oid = n => n.toString(16).padStart(40, '0')
const actor = n => ({ name: 'actor' + n, user: {
  id: 'USER' + n, login: 'actor' + n, databaseId: n
} })

function fixture(count = 665, cap = 250) {
  const commits = Array.from({ length: count }, (_, n) => ({
    oid: oid(n + 1), author: actor(n < 100 ? 1 : n + 1), committer: actor(1)
  }))
  const calls = []
  function pull(cursor) {
    const offset = cursor === null ? 0 : Number(cursor)
    const end = Math.min(offset + 100, cap, count)
    return { repository: { id: 'REPO', nameWithOwner: 'owner/repo', pullRequest: {
      state: 'OPEN', baseRefOid: oid(9000), headRefOid: oid(count),
      baseRefName: 'main', headRefName: 'feature', baseRepository: { id: 'REPO', nameWithOwner: 'owner/repo' },
      headRepository: { id: 'FORK', nameWithOwner: 'contributor/repo' },
      commits: { totalCount: count, nodes: copy(commits.slice(offset, end)).map(commit => ({ commit })),
        pageInfo: { hasNextPage: end < Math.min(cap, count), endCursor: String(end) } }
    } } }
  }
  const raw = {
    pull: async cursor => { calls.push(['pull', cursor]); return pull(cursor) },
    compare: async (base, head, page) => {
      calls.push(['compare', base, head, page])
      assert.equal(base, oid(9000)); assert.equal(head, oid(count))
      return { base_commit: { sha: base }, total_commits: count,
        commits: commits.slice((page - 1) * 100, page * 100).map(c => ({ sha: c.oid })) }
    },
    objects: async ids => { calls.push(['objects', ids]); return ids.map(id => copy(commits.find(c => c.oid === id))) }
  }
  return { commits, calls, raw, pull }
}

const collect = f => completeAttribution(boundedTransport(f.raw), 'owner/repo')

test('101 commits include the late contributor rather than the old first100 result', async () => {
  const f = fixture(101, 101)
  const result = await collect(f)
  assert.equal(result.length, 101)
  assert.equal(result[100].author.user.login, 'actor101')
  assert.equal(f.calls.filter(c => c[0] === 'compare').length, 0)
})

test('coherent capped250 fallback retrieves all665 and preserves originalfirst100 order', async () => {
  const f = fixture()
  const realPull = f.raw.pull
  f.raw.pull = async cursor => {
    const result = await realPull(cursor)
    if (cursor === null) result.repository.pullRequest.commits.nodes.reverse()
    return result
  }
  const result = await collect(f)
  assert.equal(result.length, 665)
  assert.equal(new Set(result.map(c => c.oid)).size, 665)
  assert.deepEqual(result.slice(0, 100).map(c => c.oid), f.commits.slice(0, 100).reverse().map(c => c.oid))
  assert.equal(result.find(c => c.oid === oid(665)).author.user.databaseId, 665)
  assert.equal(f.calls.filter(c => c[0] === 'compare').length, 7)
  assert.equal(f.calls.filter(c => c[0] === 'objects').length, 7)
})

test('explicit unlinked author still retains committer-user precedence', async () => {
  const f = fixture(1, 1)
  f.commits[0].author = { name: 'Unlinked human', user: null }
  const result = await collect(f)
  assert.equal(result[0].author.user, null)
  assert.equal(result[0].committer.user.databaseId, 1)
})

for (const [label, mutate] of [
  ['base', p => { p.baseRefOid = oid(9001) }],
  ['head', p => { p.headRefOid = oid(9002) }],
  ['state', p => { p.state = 'CLOSED' }],
  ['base branch', p => { p.baseRefName = 'other' }],
  ['head branch', p => { p.headRefName = 'other' }],
  ['head repository ID', p => { p.headRepository.id = 'OTHER' }],
  ['head repository name', p => { p.headRepository.nameWithOwner = 'other/repo' }],
  ['repository', p => { p.baseRepository.nameWithOwner = 'owner/other' }],
  ['count', p => { p.commits.totalCount++ }]
]) test('refuses changed ' + label + ' before returning contributors', async () => {
  const f = fixture(101, 101), real = f.raw.pull
  let calls = 0
  f.raw.pull = async cursor => { const r = await real(cursor); if (++calls > 1) mutate(r.repository.pullRequest); return r }
  await assert.rejects(collect(f), /snapshot|changed/)
})

for (const [label, mutate] of [
  ['duplicate', r => { r.commits[1].sha = r.commits[0].sha }],
  ['null commit', r => { r.commits[0] = null }],
  ['short page', r => { r.commits.pop() }],
  ['wrong base', r => { r.base_commit.sha = oid(9001) }],
  ['wrong count', r => { r.total_commits++ }],
  ['missing head', r => { for (const c of r.commits) if (c.sha === oid(665)) c.sha = oid(8000) }]
]) test('refuses immutable comparison ' + label, async () => {
  const f = fixture(), real = f.raw.compare
  f.raw.compare = async (...args) => { const r = await real(...args); mutate(r); return r }
  await assert.rejects(collect(f), /comparison|identity|head/)
})

for (const [label, mutate] of [
  ['null object', r => { r[0] = null }],
  ['short object batch', r => { r.pop() }],
  ['wrong object OID', r => { r[0].oid = oid(8000) }],
  ['changed original late actor', r => { if (r.some(c => c.oid === oid(250))) r.find(c => c.oid === oid(250)).author = actor(900) }],
  ['omitted user', r => { delete r[0].author.user }],
  ['null user ID', r => { r[0].author.user.databaseId = null }]
]) test('refuses canonical ' + label, async () => {
  const f = fixture(), real = f.raw.objects
  f.raw.objects = async ids => { const r = await real(ids); mutate(r); return r }
  await assert.rejects(collect(f), /attribution|identity|actor|user/)
})

test('refuses changed final original actor metadata', async () => {
  const f = fixture(101, 101), real = f.raw.pull
  let nulls = 0
  f.raw.pull = async cursor => {
    const r = await real(cursor)
    if (cursor === null && ++nulls > 1) r.repository.pullRequest.commits.nodes[0].commit.author = actor(900)
    return r
  }
  await assert.rejects(collect(f), /attribution changed/)
})

test('refuses stalled cursor and premature tiny terminal prefix', async () => {
  const f = fixture(665, 50)
  await assert.rejects(collect(f), /Insufficient/)
  const g = fixture(665, 665), real = g.raw.pull
  g.raw.pull = async cursor => { const r = await real(cursor); r.repository.pullRequest.commits.pageInfo.endCursor = '100'; return r }
  await assert.rejects(collect(g), /cursor/)
})

for (const method of ['pull', 'compare', 'objects']) test('API failure ' + method + ' returns no partial contributors', async () => {
  const f = fixture()
  f.raw[method] = async () => { throw new Error('owned API failure') }
  await assert.rejects(collect(f), /owned API failure/)
})

test('2000 fully paginated commits accepted;2001 rejected before pagination', async () => {
  const f = fixture(2000, 2000)
  assert.equal((await collect(f)).length, 2000)
  assert.equal(f.calls.length, 21)
  const g = fixture(2001, 2001)
  await assert.rejects(collect(g), /snapshot/)
  assert.equal(g.calls.length, 1)
})

test('one shared48 request limit refuses pathological GraphQL+fallback workload', async () => {
  const f = fixture(2000, 1900)
  await assert.rejects(collect(f), /budget/)
  assert.equal(f.calls.length, 48)
})

test('shared30s deadline checked before and after API response', async () => {
  let now = 0
  const f = fixture(1, 1)
  const t = boundedTransport(f.raw, () => now)
  now = 30000
  await assert.rejects(completeAttribution(t, 'owner/repo'), /budget/)
  assert.equal(f.calls.length, 0)
  const g = fixture(1, 1), real = g.raw.pull
  now = 0
  g.raw.pull = async c => { const r = await real(c); now = 30000; return r }
  await assert.rejects(completeAttribution(boundedTransport(g.raw, () => now), 'owner/repo'), /deadline/)
})

test('a hung read refuses after the actual4000ms request cap', async () => {
  const f = fixture(1, 1)
  f.raw.pull = () => new Promise(() => {})
  const started = Date.now()
  await assert.rejects(collect(f), /request timed out/)
  assert(Date.now() - started >= 3900)
})

test('object query refuses duplicate/invalid/oversized identifiers', () => {
  for (const ids of [[], [oid(1), oid(1)], ['not-oid'], Array.from({length:101}, (_,n) => oid(n+1))]) {
    assert.throws(() => objectQuery(ids), /Invalid/)
  }
})

// Exercise the real getCommitters integration with credential-free transport
// callbacks. No action main/signature/comment modules are imported or called.
async function actionContributors(f) {
  const githubPath = require.resolve('@actions/github')
  const octokitPath = require.resolve('../lib/octokit')
  const actionPath = require.resolve('../lib/graphql')
  const oldGithub = require.cache[githubPath], oldOctokit = require.cache[octokitPath]
  require.cache[githubPath] = { exports: { context: {
    repo: { owner: 'owner', repo: 'repo' }, issue: { number: 1148 }
  } } }
  require.cache[octokitPath] = { exports: { octokit: {
    graphql: async (query, args) => {
      assert.equal(args.request.timeout, 4000)
      if (query.includes('pullRequest(')) return f.raw.pull(args.cursor)
      const ids = [...query.matchAll(/object\(oid:"([0-9a-f]+)"\)/g)].map(m => m[1])
      const commits = await f.raw.objects(ids)
      return { repository: Object.fromEntries(commits.map((c, i) => ['c' + i, c])) }
    },
    request: async (route, args) => {
      assert.equal(route, 'GET /repos/{owner}/{repo}/compare/{basehead}')
      assert.equal(args.request.timeout, 4000); assert.equal(args.per_page, 100)
      const [base, head] = args.basehead.split('...')
      return { data: await f.raw.compare(base, head, args.page) }
    }
  } } }
  delete require.cache[actionPath]
  try { return await require(actionPath).default() } finally {
    delete require.cache[actionPath]
    if (oldGithub) require.cache[githubPath] = oldGithub; else delete require.cache[githubPath]
    if (oldOctokit) require.cache[octokitPath] = oldOctokit; else delete require.cache[octokitPath]
  }
}

test('actual action returns late665 actor with same precedence/bot/name-dedup policy', async () => {
  const f = fixture()
  f.commits[0].author = actor(41898282)
  f.commits[1].author = { name: 'Unlinked author', user: null }
  f.commits[1].committer = actor(70)
  f.commits[2].author = { name: 'Raw human', user: null }
  f.commits[2].committer = { name: 'Raw committer', user: null }
  const users = await actionContributors(f)
  assert(users.some(u => u.id === 665 && u.name === 'actor665' && u.pullRequestNo === 1148))
  assert(users.some(u => u.id === 70 && u.name === 'actor70'))
  assert(users.some(u => u.id === '' && u.name === 'Raw human'))
  assert(!users.some(u => u.id === 41898282))
  assert.equal(users.filter(u => u.name === 'actor1').length, 1)
})

test('actual action refuses conflicting numeric-ID/login mapping rather than omitting contributor', async () => {
  for (const conflict of ['name', 'id', 'raw']) {
    const f = fixture(101, 101)
    if (conflict === 'name') f.commits[100].author.user.login = 'actor1'
    if (conflict === 'id') f.commits[100].author.user.databaseId = 1
    if (conflict === 'raw') f.commits[100].author = { name: 'actor1', user: null },
      f.commits[100].committer = { name: 'raw', user: null }
    await assert.rejects(actionContributors(f), /Ambiguous contributor/)
  }
})

test('actual action returns no contributors when final snapshot changes', async () => {
  const f = fixture(1, 1), real = f.raw.pull
  let calls = 0
  f.raw.pull = async cursor => {
    const r = await real(cursor)
    if (++calls > 1) r.repository.pullRequest.headRefOid = oid(8000)
    return r
  }
  await assert.rejects(actionContributors(f), /attribution changed/)
})
