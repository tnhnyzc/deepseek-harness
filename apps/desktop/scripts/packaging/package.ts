/**
 * Build one packaged desktop release for this host's platform and
 * architecture: clean, build, stage (renderer, checksum-verified Node, the
 * lockfile-pinned runtime closure, manifest, licenses), assemble with
 * @electron/packager (asar + integrity entries + extraResources), flip the
 * release fuses, sign (Developer ID with credentials; ad-hoc on macOS
 * otherwise; unsigned elsewhere without credentials), notarize when
 * credentials are present, and verify the artifact against its layout
 * contract.
 *
 * Cross-host packaging is out of scope by design: the runtime closure
 * stages this host's platform prebuilds, so each CI runner packages its own
 * platform and the artifact matrix is filled by the runners, not by one
 * machine reaching across platforms.
 *
 * Usage (from the repository root):
 *   pnpm --filter @deepseek-ai/dsh-desktop run package
 *   pnpm --filter @deepseek-ai/dsh-desktop run package -- --skip-build
 * @module @deepseek-ai/dsh-desktop/scripts/packaging/package
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { packager } from '@electron/packager'
import type { SignOptionsForDirectory } from '@electron/windows-sign'
import { APP_PRODUCT_NAME, DESKTOP_FUSE_INDICES, electronBinaryPath, flipDesktopFuses } from './fuses.ts'
import { layoutVerdict, verifyArtifactLayout } from './verify-layout.ts'
import { stageRelease } from './staging.ts'
import { runRuntimeSmoke } from './smoke-runtime.ts'

const appDir = resolve(import.meta.dirname, '..', '..')
const repoRoot = resolve(import.meta.dirname, '..', '..', '..', '..')
const outDir = join(appDir, 'out')

interface PackageOptions {
  target: string
  skipBuild: boolean
  skipSmoke: boolean
}

function parseArgs(argv: string[]): PackageOptions {
  const options: PackageOptions = {
    target: `${process.platform}-${process.arch}`,
    skipBuild: false,
    skipSmoke: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === undefined) continue
    if (arg === '--') {
      // pnpm's option separator; carries no meaning here.
      continue
    }
    if (arg === '--skip-build') {
      options.skipBuild = true
    } else if (arg === '--skip-smoke') {
      options.skipSmoke = true
    } else if (arg === '--target') {
      i += 1
      options.target = argv[i] ?? ''
    } else {
      throw new Error(`package: unknown argument ${JSON.stringify(arg)}`)
    }
  }
  if (options.target !== `${process.platform}-${process.arch}`) {
    throw new Error(
      `package: cross-host packaging is not supported (host ${process.platform}-${process.arch}, asked for ${options.target}); `
      + 'each CI runner packages its own platform',
    )
  }
  return options
}

/** Run the desktop build (runtime + main + renderer) unless skipped. */
async function buildDesktop(): Promise<void> {
  console.log('package: building the desktop runtime, main, and renderer')
  const result = spawnSync('pnpm', ['--filter', '@deepseek-ai/dsh-desktop', 'run', 'build'], {
    stdio: 'inherit',
    cwd: repoRoot,
  })
  if (result.status !== 0) throw new Error(`package: the desktop build failed (exit ${String(result.status)})`)
}

/**
 * Sign the packaged macOS bundle. With a `CSC_NAME` identity present in the
 * keychain: Developer ID + hardened runtime + the V8-entailed JIT entitlement
 * (the only entitlement the packaged app needs). Without credentials: ad-hoc,
 * which keeps the fuse-flipped binary launchable — a present-but-invalidated
 * signature refuses to exec on Apple Silicon. Returns what was actually done.
 */
async function signMacApp(artifact: string): Promise<string> {
  const identity = process.env.CSC_NAME
  if (identity === undefined || identity.length === 0) {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', artifact], { stdio: 'pipe' })
    return 'ad-hoc (no CSC_NAME in environment)'
  }
  const { sign } = await import('@electron/osx-sign')
  // hardenedRuntime defaults to true and the built-in Electron entitlements
  // already carry com.apple.security.cs.allow-jit (the only entitlement this
  // app needs), so the identity alone fully specifies the signing.
  await sign({ app: artifact, identity })
  return `Developer ID (${identity})`
}

/**
 * Notarize when Apple credentials are present; report when they are not.
 * @param artifact - the signed `.app` bundle.
 * @returns what was done.
 */
async function notarizeMacApp(artifact: string): Promise<string> {
  const appleId = process.env.APPLE_ID
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD
  const teamId = process.env.APPLE_TEAM_ID
  if (appleId === undefined || appleIdPassword === undefined || teamId === undefined) {
    return 'not run (APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID not set)'
  }
  const { notarize } = await import('@electron/notarize')
  await notarize({ appPath: artifact, appleId, appleIdPassword, teamId })
  return 'notarized'
}

/** Sign the Windows bundle when credentials are present; report when not. */
async function signWindowsApp(artifact: string): Promise<string> {
  const certificateFile = process.env.CSC_CERTIFICATE_FILE
  const certificatePassword = process.env.CSC_KEY_PASSWORD
  if (certificateFile === undefined || certificatePassword === undefined) {
    return 'not run (CSC_CERTIFICATE_FILE / CSC_KEY_PASSWORD not set)'
  }
  const { sign } = await import('@electron/windows-sign')
  // The `hashes` field is a cross-package const enum a string literal cannot
  // satisfy under this project's resolution; the value is a valid member.
  const options: SignOptionsForDirectory = {
    appDirectory: artifact,
    certificateFile,
    certificatePassword,
    hashes: ['sha256'] as unknown as NonNullable<SignOptionsForDirectory['hashes']>,
  }
  await sign(options)
  return 'signed (CSC_CERTIFICATE_FILE)'
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const [platform, arch] = options.target.split('-') as [NodeJS.Platform, string]

  console.log(`package: clean ${outDir}`)
  rmSync(outDir, { recursive: true, force: true })

  if (options.skipBuild) {
    console.log('package: skipping build (--skip-build)')
  } else {
    await buildDesktop()
  }

  console.log('package: staging the release tree')
  const staged = await stageRelease({
    appDir,
    runtimeSourceDir: join(appDir, '..', 'desktop-runtime'),
    repoRoot,
    stagingDir: join(outDir, 'staging'),
    target: options.target,
  })
  console.log(`package: staged ${String(staged.runtime.packageCount)} closure packages; fingerprint ${staged.manifest.closureFingerprint.slice(0, 16)}…`)

  console.log('package: assembling with @electron/packager')
  const electronVersion = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')) as {
    devDependencies?: Record<string, string>
  }
  await packager({
    dir: staged.appDir,
    out: outDir,
    // The target is validated to be this host's platform/arch, so the
    // narrow casts are sound.
    arch: arch as 'arm64' | 'x64',
    platform: platform as 'darwin' | 'win32' | 'linux',
    name: APP_PRODUCT_NAME,
    executableName: APP_PRODUCT_NAME,
    electronVersion: electronVersion.devDependencies?.electron ?? '',
    asar: true,
    extraResource: staged.extraResources,
    overwrite: true,
  })
  const artifactBasename = `${APP_PRODUCT_NAME}-${platform}-${arch}`
  const artifact = platform === 'darwin' ? join(outDir, artifactBasename, `${APP_PRODUCT_NAME}.app`) : join(outDir, artifactBasename)
  if (!existsSync(artifact)) {
    throw new Error(`package: expected artifact missing at ${artifact}`)
  }

  console.log('package: flipping the release fuses (before any signature)')
  const slices = await flipDesktopFuses(electronBinaryPath(artifact, platform))
  console.log(`package: set ${String(DESKTOP_FUSE_INDICES.length)} fuses across ${String(slices)} binary slice(s)`)

  let signed = 'not applicable (linux)'
  let notarized = 'not applicable'
  if (platform === 'darwin') {
    signed = await signMacApp(artifact)
    console.log(`package: signed ${signed}`)
    notarized = await notarizeMacApp(artifact)
    console.log(`package: notarization ${notarized}`)
  } else if (platform === 'win32') {
    signed = await signWindowsApp(artifact)
    console.log(`package: ${signed}`)
  }

  console.log('package: verifying the artifact layout')
  const report = await verifyArtifactLayout(artifact, platform, arch, options.target)
  console.log(`package: ${layoutVerdict(report)}`)
  if (!report.checks.every(c => c.ok)) {
    throw new Error(layoutVerdict(report))
  }

  // The clean-copy boot smoke: the strongest signal that the packaged
  // runtime actually boots under the packaged Node. Skipped with
  // --skip-smoke (e.g. a headless runner without the runtime's host deps).
  let smoke = 'skipped (--skip-smoke)'
  if (!options.skipSmoke) {
    console.log('package: running the clean-copy boot smoke')
    const result = await runRuntimeSmoke(artifact, platform)
    console.log(`package: smoke ${result.ok ? 'PASS' : 'FAIL'} — ${result.detail}`)
    if (!result.ok) throw new Error(`package: boot smoke failed: ${result.detail}`)
    smoke = `PASS (${result.detail})`
  }

  const summary = {
    artifact,
    manifest: staged.manifest,
    closurePackages: staged.runtime.packageCount,
    signed,
    notarized,
    smoke,
  }
  writeFileSync(join(outDir, 'package-report.json'), `${JSON.stringify(summary, null, 2)}\n`)
  console.log(`package: done -> ${artifact}`)
}

void main()
