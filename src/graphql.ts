import { octokit } from './octokit'
import { context } from '@actions/github'
import { CommittersDetails } from './interfaces'
import { boundedTransport, completeAttribution, objectQuery, PULL_QUERY } from './completeCommitters'



export default async function getCommitters(): Promise<CommittersDetails[]> {
    try {
        let committers: CommittersDetails[] = []
        let filteredCommitters: CommittersDetails[] = []
        const repository = context.repo.owner + '/' + context.repo.repo
        const transport = boundedTransport({
            pull: cursor => octokit.graphql(PULL_QUERY, {
                owner: context.repo.owner, name: context.repo.repo,
                number: context.issue.number, cursor, request: { timeout: 4000 }
            }),
            compare: async (base, head, page) => (await octokit.request(
                'GET /repos/{owner}/{repo}/compare/{basehead}', {
                    owner: context.repo.owner, repo: context.repo.repo,
                    basehead: base + '...' + head, per_page: 100, page,
                    request: { timeout: 4000 }
                })).data,
            objects: async ids => {
                const data: any = await octokit.graphql(objectQuery(ids), {
                    owner: context.repo.owner, name: context.repo.repo,
                    request: { timeout: 4000 }
                })
                return ids.map((_, index) => data.repository?.['c' + index])
            }
        })
        const commits = await completeAttribution(transport, repository)
        const names = new Map<string, number | string>()
        const ids = new Map<number, string>()
        commits.forEach(commit => {
            const committer = extractUserFromCommit(commit)
            let user = {
                name: committer.login || committer.name,
                id: committer.databaseId || '',
                pullRequestNo: context.issue.number
            }
            if (typeof user.name !== 'string' || !user.name ||
                (names.has(user.name) && names.get(user.name) !== user.id) ||
                (user.id && ids.has(user.id) && ids.get(user.id) !== user.name)) {
                throw new Error('Ambiguous contributor identity; refusing incomplete CLA coverage')
            }
            names.set(user.name, user.id)
            if (user.id) ids.set(user.id, user.name)
            if (committers.length === 0 || committers.map((c) => {
                return c.name
            }).indexOf(user.name) < 0) {
                committers.push(user)
            }
        })
        filteredCommitters = committers.filter((committer) => {
            return committer.id !== 41898282
        })
        return filteredCommitters

    } catch (e) {
        throw new Error(`graphql call to get the committers details failed: ${e}`)
    }

}
const extractUserFromCommit = (commit) => commit.author.user || commit.committer.user || commit.author || commit.committer
