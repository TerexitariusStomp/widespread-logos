/**
 * LP-0023 self-registration driver: invokes each program's `register_self`
 * hook through `wsp-lez call`, which emits the chained call that satisfies
 * the registry's caller_program_id deployer check.
 *
 * Usage:
 *   bun scripts/register-programs.ts <vault.blob> [--unauthorized-demo]
 */
import { deployerEntryPda, instructionDataHex, r0Str, r0U64, r0U8Array32 } from '../sdk/registry/src/index.ts'
import { execSync } from 'node:child_process'

const WSP_LEZ = new URL('../target/release/wsp-lez', import.meta.url).pathname

const PROGRAMS = {
  registry: 'be6cd0c3c15e6d6236cadf3af0eb63332473f223c0713256f7a5b83e0fac2cf5',
  testimonial: '9aa87b6ba0a722bb79fec3e2dc0ee58fd303c1127d13699fff27e6d7627fb9f4',
  pointer: 'a97a787dee00aaf8541e473f96474ef5f5342ca6f4d9883d8554b8b1ced0a5bd',
} as const

const REGISTRY = PROGRAMS.registry
const REGISTER_SELF_IX = 1 // submit/publish=0, register_self=1 in all three
const COMMIT = 'e3e0a00' // repo state at build time; informational

const hexToBytes = (h: string) =>
  new Uint8Array(h.match(/../g)!.map((b) => parseInt(b, 16)))

const FIELDS = (name: string, idlCid: string, sourceCid: string) => [
  r0Str(name),
  r0Str('0.1.0'),
  r0Str(`Widespread ${name} — LP-0023 registered program`),
  r0Str('widespread,lp0023,spel'),
  r0Str(idlCid),
  r0Str(sourceCid),
  r0Str('https://github.com/logos-co/widespread-logos'),
  r0Str(COMMIT),
  r0Str('cargo risczero build --manifest-path methods/guest/Cargo.toml (r0.1.88.0)'),
  r0U64(BigInt(Math.floor(Date.now() / 1000))),
]

const CIDS: Record<string, [string, string]> = {
  // [idlCid, sourceCid] — Logos Storage CIDs from the artifact upload
  registry: [
    'zDvZRwzkwZh6vSRAky3MYSwEkGZtryKHN4hg1yHokMQHitn9fE1q',
    'zDvZRwzkyMpS6zBubWqyw6UqPSamYJV9pF95cEoLaAfVzxcoY7Db',
  ],
  testimonial: [
    'zDvZRwzm8JNFm3m51yjkGkeo7KNLHCs8AcqmYBQcsv1T5MJiPLQS',
    'zDvZRwzm7s7bNa8JnaLoHjWpwonsqtga5BKiGzbuKS23WSVcbG91',
  ],
  pointer: [
    'zDvZRwzmDaZ4fKgc4155XjB6pNkLF82AbQ1F4ZSXZpLFZekhi57U',
    'zDvZRwzkyY6uG2RAEMMwEx2bQNetzDmTD6ZzpPdQCpGcNN6qCU2G',
  ],
}

function call(vault: string, program: string, dataHex: string, accounts: string[]) {
  const acctArgs = accounts.flatMap((a) => ['--account', a])
  const out = execSync(
    `${WSP_LEZ} --vault ${vault} call ${program} --data ${dataHex} ${acctArgs.join(' ')}`,
    { encoding: 'utf8', timeout: 300_000 },
  )
  return out.trim()
}

async function main() {
  const vault = process.argv[2]
  if (!vault) {
    console.error('usage: bun scripts/register-programs.ts <vault.blob> [--unauthorized-demo]')
    process.exit(1)
  }
  const demo = process.argv.includes('--unauthorized-demo')
  const registryBytes = hexToBytes(REGISTRY)

  for (const [name, pid] of Object.entries(PROGRAMS)) {
    const entry = await deployerEntryPda(REGISTRY, pid)
    const [idlCid, sourceCid] = CIDS[name]
    // register_self args: for the registry itself the first arg is `program`
    // (self bytes); for other programs it is `registry_program_id`. Same
    // 32 bytes either way — registry's own id for itself, registry id for
    // the others. Both equal `registryBytes` ONLY for the registry; for
    // testimonial/pointer the arg is the REGISTRY pid (also registryBytes).
    const firstArg = name === 'registry' ? r0U8Array32(registryBytes) : r0U8Array32(registryBytes)
    const dataHex = instructionDataHex(REGISTER_SELF_IX, [
      firstArg,
      ...FIELDS(`widespread-${name}`, idlCid, sourceCid),
    ])
    console.log(`\n=== ${name}: register_self → entry ${entry}`)
    const out = call(vault, pid, dataHex, [entry])
    console.log(out)
  }

  if (demo) {
    // Unauthorized-deployer demo: a DIRECT register_deployer call to the
    // registry naming the OLD (v1) testimonial program — a real deployed
    // program with no self-registration entry in this registry, so the
    // only thing that can reject the call is the caller_program_id check
    // (all-zeros for a top-level tx ≠ the named program).
    const OLD_TESTIMONIAL =
      '553629798bae79046eb13ec4dc23155f0a6bc667d18016ba95b64bfd42e4b0b1'
    const victimEntry = await deployerEntryPda(REGISTRY, OLD_TESTIMONIAL)
    const dataHex = instructionDataHex(0 /* register_deployer */, [
      r0U8Array32(hexToBytes(OLD_TESTIMONIAL)),
      ...FIELDS('evil-testimonial', 'zDvFakeCid', 'zDvFakeCid'),
    ])
    console.log(`\n=== UNAUTHORIZED: direct register_deployer naming testimonial`)
    try {
      const out = call(vault, REGISTRY, dataHex, [victimEntry])
      console.log('tx submitted (unexpected):', out)
    } catch (e) {
      console.log('rejected as expected:', String(e).slice(0, 400))
    }
  }
}

await main()
