import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export function requirePassingCI(sha, runs) {
  const latest = (runs || []).filter(r => r.head_sha === sha && r.name === 'DLT CI' && r.event === 'push')
    .sort((a,b) => b.run_number - a.run_number || b.run_attempt - a.run_attempt)[0];
  if (!latest || latest.status !== 'completed' || latest.conclusion !== 'success')
    throw new Error(`Release blocked: DLT CI is ${latest ? `${latest.status}/${latest.conclusion || 'pending'}` : 'not available'} for this commit. ${latest?.html_url || ''}`);
  return latest;
}

async function main() {
  const sha = process.argv[2];
  if (!/^[a-f0-9]{40}$/.test(sha || '')) throw new Error('Supply the full release commit SHA.');
  const response = await fetch(`https://api.github.com/repos/T-R-I-T-E-J/dlt_bus_service/actions/runs?head_sha=${sha}&per_page=100`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'DLT-release-check' },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`Unable to verify CI (HTTP ${response.status}); release was not approved.`);
  const { workflow_runs: runs } = await response.json();
  const latest = requirePassingCI(sha, runs);
  console.log(`CI passed for ${sha.slice(0,7)}: ${latest.html_url}`);

}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
