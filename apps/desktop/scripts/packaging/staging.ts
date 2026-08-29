/**
 * Stage one packaged desktop release: the slim app directory that becomes
 * app.asar, the unpacked resources (renderer, bundled Node, the runtime
 * closure), the build manifest, and the license notices. Staging is pure
 * file assembly from verified inputs — every input is a build output or a
 * checksum-verified download, and a stale or missing input fails loud here
 * instead of shipping.
 *
 * The staged tree is what the packager consumes: `staging/app` becomes the
 * asar, and the remaining staging entries ride to the artifact's resources
 * directory as extraResources.
 * @module @deepseek-ai/dsh-desktop/scripts/packaging/staging
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createBuildManifest, type BuildManifest } from './build-manifest.ts'
import { stageRuntimeClosure, type ClosureStageResult } from './closure.ts'
import { installNodeTarget } from '../bundle-node.ts'

/** The staged release tree. */
export interface StagedRelease {
  /** The staging root (`out/staging`). */
  stagingDir: string
  /** The slim app directory that becomes app.asar. */
  appDir: string
  /** The unpacked resource entries, in extraResource order. */
  extraResources: string[]
  /** The staged runtime closure result. */
  runtime: ClosureStageResult
  /** The release identity. */
  manifest: BuildManifest
}

interface StagingInput {
  /** The desktop app package directory (apps/desktop). */
  appDir: string
  /** The runtime package directory (apps/desktop-runtime). */
  runtimeSourceDir: string
  /** The repository root (git work tree). */
  repoRoot: string
  /** The staging root (`apps/desktop/out/staging`). */
  stagingDir: string
  /** The packaged target, node naming (`darwin-arm64`, ...). */
  target: string
}

/**
 * Stage the renderer distribution, guarding the stale-output case.
 * @param source - the built renderer directory (dist/renderer).
 * @param destination - where it lands in staging.
 */
function stageRenderer(source: string, destination: string): void {
  if (!existsSync(join(source, 'index.html'))) {
    throw new Error(`staging: renderer distribution missing at ${source}; run the desktop build first`)
  }
  mkdirSync(destination, { recursive: true })
  cpSync(source, destination, { recursive: true, dereference: true })
}

/**
 * Stage the slim asar app directory: the built main bundle, the checked-in
 * CJS preload, and a minimal manifest. The preload stays a source file by
 * design (a sandboxed preload cannot use ESM), and both paths resolve the
 * same inside the asar.
 * @param appDir - the desktop app package directory.
 * @param destination - where the slim app directory lands in staging.
 */
function stageAppDir(appDir: string, destination: string): void {
  const mainEntry = join(appDir, 'dist', 'main', 'index.js')
  const preload = join(appDir, 'src', 'preload', 'index.cjs')
  if (!existsSync(mainEntry)) {
    throw new Error(`staging: main bundle missing at ${mainEntry}; run the desktop build first`)
  }
  if (!existsSync(preload)) {
    throw new Error(`staging: preload missing at ${preload}`)
  }
  mkdirSync(join(destination, 'main'), { recursive: true })
  mkdirSync(join(destination, 'preload'), { recursive: true })
  cpSync(mainEntry, join(destination, 'main', 'index.js'), { dereference: true })
  cpSync(preload, join(destination, 'preload', 'index.cjs'), { dereference: true })
  const sourceManifest = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')) as {
    name: string
    version: string
    description?: string
    license?: string
  }
  const manifest = {
    name: sourceManifest.name,
    version: sourceManifest.version,
    description: sourceManifest.description,
    main: 'main/index.js',
    license: sourceManifest.license,
    private: true,
  }
  writeFileSync(join(destination, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}

/**
 * Stage the license notices: the repository MIT license, the generated
 * third-party notices, the Electron license, and the pinned Node
 * distribution license.
 * @param input - the staging input.
 * @param destination - where the licenses land in staging.
 */
function stageLicenses(input: StagingInput, destination: string): void {
  mkdirSync(destination, { recursive: true })
  const copies: [string, string][] = [
    [join(input.repoRoot, 'LICENSE'), 'LICENSE'],
    [join(input.repoRoot, 'THIRD_PARTY_NOTICES.md'), 'THIRD_PARTY_NOTICES.md'],
    [join(input.appDir, 'node_modules', 'electron', 'LICENSE'), 'ELECTRON_LICENSE.txt'],
    [join(input.stagingDir, 'node', input.target, 'LICENSE'), 'NODE_LICENSE.txt'],
  ]
  for (const [source, name] of copies) {
    if (!existsSync(source)) {
      throw new Error(`staging: license source missing at ${source}`)
    }
    cpSync(source, join(destination, name), { dereference: true })
  }
}

/**
 * Stage the complete release tree under `stagingDir`.
 * @param input - app dir, runtime source, repo root, staging root, target.
 * @returns the staged release description.
 */
export async function stageRelease(input: StagingInput): Promise<StagedRelease> {
  rmSync(input.stagingDir, { recursive: true, force: true })
  const appDir = join(input.stagingDir, 'app')
  stageAppDir(input.appDir, appDir)
  stageRenderer(join(input.appDir, 'dist', 'renderer'), join(input.stagingDir, 'renderer'))
  const nodeManifest = JSON.parse(readFileSync(join(input.appDir, 'node-versions.json'), 'utf8')) as Parameters<typeof installNodeTarget>[0]
  await installNodeTarget(nodeManifest, input.target, join(input.stagingDir, 'node'))
  const runtime = stageRuntimeClosure(input.runtimeSourceDir, join(input.stagingDir, 'runtime'))
  const manifest = createBuildManifest({
    repoRoot: input.repoRoot,
    appDir: input.appDir,
    runtimeSourceDir: input.runtimeSourceDir,
    runtimeDir: join(input.stagingDir, 'runtime'),
    target: input.target,
  })
  writeFileSync(join(input.stagingDir, 'build-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  stageLicenses(input, join(input.stagingDir, 'licenses'))
  const extraResources = [
    join(input.stagingDir, 'renderer'),
    join(input.stagingDir, 'node'),
    join(input.stagingDir, 'runtime'),
    join(input.stagingDir, 'build-manifest.json'),
    join(input.stagingDir, 'licenses'),
  ]
  return {
    stagingDir: input.stagingDir,
    appDir,
    extraResources,
    runtime,
    manifest,
  }
}
