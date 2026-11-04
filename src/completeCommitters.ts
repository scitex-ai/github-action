// Read-only attribution must finish before setupClaCheck can touch signatures.
// Transport callbacks keep the collector testable without GitHub credentials.
export const COMMIT_FIELDS = `oid author { email name user { id databaseId login } }
  committer { name user { id databaseId login } }`
export const PULL_QUERY = `query($owner:String!,$name:String!,$number:Int!,$cursor:String) {
  repository(owner:$owner,name:$name) { id nameWithOwner pullRequest(number:$number) {
    state baseRefOid headRefOid baseRefName headRefName
    baseRepository { id nameWithOwner } headRepository { id nameWithOwner }
    commits(first:100,after:$cursor) {
      totalCount pageInfo { endCursor hasNextPage } nodes { commit { ${COMMIT_FIELDS} } }
    }
  } }
}`

const OID = /^[0-9a-f]{40}$/
const own = (value: any, key: string) => Object.prototype.hasOwnProperty.call(value, key)
const refuse = (message: string): never => { throw new Error(message) }

export interface AttributionTransport {
  pull: (cursor: string | null) => Promise<any>
  compare: (base: string, head: string, page: number) => Promise<any>
  objects: (ids: string[]) => Promise<any[]>
}

export function objectQuery(ids: string[]): string {
  if (!ids.length || ids.length > 100 || new Set(ids).size !== ids.length ||
      ids.some(id => !OID.test(id))) refuse('Invalid commit-object batch')
  return `query($owner:String!,$name:String!) { repository(owner:$owner,name:$name) {
    ${ids.map((id, index) => `c${index}:object(oid:"${id}") {
      ... on Commit { ${COMMIT_FIELDS} }
    }`).join('\n')}
  } }`
}

// One shared budget covers initial, paginated, fallback and final reads.
export function boundedTransport(transport: AttributionTransport,
  now: () => number = Date.now): AttributionTransport {
  let calls = 0
  const deadline = now() + 30000
  async function read(operation: () => Promise<any>): Promise<any> {
    if (++calls > 48 || now() >= deadline) refuse('Attribution budget exhausted')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const value = await Promise.race([
        operation(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Attribution request timed out')),
            Math.min(4000, Math.max(1, deadline - now())))
        })
      ])
      if (now() >= deadline) refuse('Attribution deadline exhausted')
      return value
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
  return {
    pull: cursor => read(() => transport.pull(cursor)),
    compare: (base, head, page) => read(() => transport.compare(base, head, page)),
    objects: ids => read(() => transport.objects(ids))
  }
}

function actorProof(actor: any): any {
  if (actor === null) return null
  if (!actor || !own(actor, 'name') || !own(actor, 'user') ||
      !(actor.name === null || typeof actor.name === 'string')) {
    refuse('Incomplete commit actor')
  }
  let user: { id: string; databaseId: number; login: string } | null = null
  if (actor.user !== null) {
    const value = actor.user
    if (!value || typeof value.login !== 'string' || !value.login ||
        typeof value.id !== 'string' || !value.id ||
        !Number.isSafeInteger(value.databaseId) || value.databaseId <= 0) {
      refuse('Incomplete commit user')
    }
    user = { id: value.id, databaseId: value.databaseId, login: value.login }
  }
  return { name: actor.name, user }
}

function proof(commit: any): string {
  if (!commit || !OID.test(commit.oid) || !own(commit, 'author') ||
      !own(commit, 'committer')) refuse('Invalid commit attribution')
  return JSON.stringify({ oid: commit.oid,
    author: actorProof(commit.author), committer: actorProof(commit.committer) })
}

function snapshot(response: any, repository: string): string {
  const repo = response?.repository
  const pull = repo?.pullRequest
  const count = pull?.commits?.totalCount
  if (repo?.nameWithOwner !== repository ||
      pull?.baseRepository?.nameWithOwner !== repository ||
      typeof repo?.id !== 'string' || !repo.id || pull.baseRepository.id !== repo.id ||
      typeof pull?.headRepository?.id !== 'string' || !pull.headRepository.id ||
      typeof pull.headRepository.nameWithOwner !== 'string' || !pull.headRepository.nameWithOwner ||
      !OID.test(pull?.baseRefOid) || !OID.test(pull?.headRefOid) ||
      !['OPEN', 'CLOSED', 'MERGED'].includes(pull?.state) ||
      typeof pull?.baseRefName !== 'string' || !pull.baseRefName ||
      typeof pull?.headRefName !== 'string' || !pull.headRefName ||
      !Number.isSafeInteger(count) || count < 1 || count > 2000) {
    refuse('Invalid PR attribution snapshot')
  }
  return JSON.stringify([repository, repo.id, pull.state, pull.baseRefName,
    pull.headRefName, pull.headRepository.id, pull.headRepository.nameWithOwner,
    pull.baseRefOid, pull.headRefOid, count])
}

function page(response: any, repository: string, expected: string): any {
  if (snapshot(response, repository) !== expected) refuse('PR attribution changed')
  const connection = response.repository.pullRequest.commits
  if (!Array.isArray(connection.nodes) || connection.nodes.length > 100 ||
      typeof connection.pageInfo?.hasNextPage !== 'boolean') {
    refuse('Incomplete PR attribution page')
  }
  return connection
}

async function immutableFallback(transport: AttributionTransport, pull: any,
  partial: any[]): Promise<any[]> {
  const count = pull.commits.totalCount
  if (partial.length < 100) refuse('Insufficient capped attribution prefix')
  const ids: string[] = []
  for (let index = 1; ids.length < count; index++) {
    const response = await transport.compare(pull.baseRefOid, pull.headRefOid, index)
    const commits = response?.commits
    if (response?.base_commit?.sha !== pull.baseRefOid ||
        response?.total_commits !== count || !Array.isArray(commits) ||
        commits.length !== Math.min(100, count - ids.length)) {
      refuse('Incomplete immutable comparison')
    }
    for (const commit of commits) {
      if (!OID.test(commit?.sha) || ids.includes(commit.sha)) {
        refuse('Invalid immutable commit identity')
      }
      ids.push(commit.sha)
    }
  }
  if (!ids.includes(pull.headRefOid)) refuse('Comparison omits PR head')
  const canonical = new Map<string, any>()
  for (let index = 0; index < ids.length; index += 100) {
    const batch = ids.slice(index, index + 100)
    const commits = await transport.objects(batch)
    if (!Array.isArray(commits) || commits.length !== batch.length) {
      refuse('Incomplete canonical attribution')
    }
    commits.forEach((commit, offset) => {
      proof(commit)
      if (commit.oid !== batch[offset]) refuse('Canonical identity changed')
      canonical.set(commit.oid, commit)
    })
  }
  for (const commit of partial) {
    if (proof(commit) !== proof(canonical.get(commit.oid))) {
      refuse('Original commit attribution changed')
    }
  }
  // Preserve the exact original first100 order that the old action covered.
  const first = partial.slice(0, 100)
  const prefix = new Set(first.map(commit => commit.oid))
  return [...first, ...ids.filter(id => !prefix.has(id)).map(id => canonical.get(id))]
}

export async function completeAttribution(transport: AttributionTransport,
  repository: string): Promise<any[]> {
  const first = await transport.pull(null)
  const binding = snapshot(first, repository)
  const pull = first.repository.pullRequest
  const count = pull.commits.totalCount
  const commits: any[] = []
  const seen = new Set<string>()
  const cursors = new Set<string>()
  let response = first
  while (true) {
    const connection = page(response, repository, binding)
    for (const row of connection.nodes) {
      const commit = row?.commit
      proof(commit)
      if (seen.has(commit.oid)) refuse('Duplicate PR commit')
      seen.add(commit.oid)
      commits.push(commit)
    }
    if (commits.length > count || !connection.nodes.length) {
      refuse('Invalid PR attribution count')
    }
    if (!connection.pageInfo.hasNextPage) break
    const cursor = connection.pageInfo.endCursor
    if (typeof cursor !== 'string' || !cursor || cursors.has(cursor) ||
        commits.length >= count) refuse('Invalid PR attribution cursor')
    cursors.add(cursor)
    response = await transport.pull(cursor)
  }
  const complete = commits.length === count ? commits :
    await immutableFallback(transport, pull, commits)
  if (complete.length !== count || !complete.some(c => c.oid === pull.headRefOid)) {
    refuse('Incomplete PR attribution')
  }
  const after = await transport.pull(null)
  const finalPage = page(after, repository, binding)
  const firstPage = first.repository.pullRequest.commits
  if (finalPage.pageInfo.hasNextPage !== firstPage.pageInfo.hasNextPage ||
      finalPage.pageInfo.endCursor !== firstPage.pageInfo.endCursor ||
      finalPage.nodes.length !== firstPage.nodes.length ||
      finalPage.nodes.some((row: any, index: number) =>
        proof(row?.commit) !== proof(firstPage.nodes[index]?.commit))) {
    refuse('First-page attribution changed')
  }
  return complete
}
