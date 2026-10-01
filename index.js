/**
 * dsh-dario-sidecar — harness-owned lifecycle for `dario proxy`.
 *
 * Starts the Dario subscription proxy when the harness starts and tears it
 * down when the plugin unmounts (effect-scoped): spawn through the
 * `subprocess` seam, readiness-gate on `GET /v1/models` answering 2xx, and
 * SIGTERM → grace → SIGKILL on disposal. A listener that is already healthy
 * on the configured port is ADOPTED, not spawned — adoption never owns the
 * process, so teardown kills only what this plugin started.
 *
 * The default `args` is `['proxy']`, which serves every subscription plan
 * dario has credentials for (Claude and/or ChatGPT). A deployment that wants
 * a single-plan posture overrides `args` in its insert row, e.g.
 * `['proxy', '--no-claude-auth']` to never load the Claude OAuth path.
 *
 * Namespace plugin (named exports, no default export), shaped after
 * @deepseek-ai/dsh-lsp-stdio: `apply` resolves the executable before
 * publishing anything, observes its own disposal during async setup, and
 * registers exactly one teardown effect.
 * @module dsh-dario-sidecar
 */

import os from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import z from '@deepseek-ai/schemastery'

/** Cordis plugin name for loader diagnostics. */
export const name = 'dsh-dario-sidecar'

/** Services required by this plugin. */
export const inject = ['subprocess']

const DEFAULT_READY_TIMEOUT_MS = 120_000
const DEFAULT_POLL_INTERVAL_MS = 500
const DEFAULT_KILL_GRACE_MS = 5_000
const DEFAULT_STDIO_TAIL_BYTES = 65_536
/** Hard bound on the awaited whole-tree exit after terminate(). */
const TEARDOWN_WAIT_MS = 15_000

/** Plugin configuration, filled from the insert row's `config`. */
export const Config = z.object({
  /** Executable to spawn (absolute, or resolved on PATH at load). Default `dario`. */
  command: z.string().default('dario'),
  /**
   * Arguments passed to the executable (no shell). Default `['proxy']` —
   * every plan dario holds credentials for. Override per deployment, e.g.
   * `['proxy', '--no-claude-auth']` for a ChatGPT-only posture that never
   * loads the Claude OAuth path.
   */
  args: z.array(String).default(['proxy']),
  /** Host the readiness probe polls. Default `127.0.0.1`. */
  host: z.string().default('127.0.0.1'),
  /** Port the readiness probe polls; passed to the child as DARIO_PORT. Default 3456. */
  port: z.number().default(3456),
  /** Budget for the readiness gate before the spawn is torn down and load fails. */
  readyTimeoutMs: z.number().default(DEFAULT_READY_TIMEOUT_MS),
  /** Interval between readiness polls. */
  pollIntervalMs: z.number().default(DEFAULT_POLL_INTERVAL_MS),
  /** SIGTERM → SIGKILL escalation grace owned by the subprocess seam. */
  killGraceMs: z.number().default(DEFAULT_KILL_GRACE_MS),
  /** Extra env vars merged onto the scrubbed ambient env (PATH/HOME survive). */
  env: z.dict(String).default({}),
})

/** One `GET /v1/models` readiness probe; any 2xx means serving. */
async function probeReady(url, signal) {
  try {
    const response = await fetch(url, { signal, redirect: 'error' })
    return response.ok
  } catch {
    return false
  }
}

/** Collected stderr/stdout tail of a dead child, for the load-failure diagnostic. */
function tailOf(handle) {
  const read = async (stream) => {
    try {
      const read = await stream.readFrom(0)
      return read.text.trim()
    } catch {
      return ''
    }
  }
  return Promise.all([read(handle.collected.stderr), read(handle.collected.stdout)])
}

/**
 * Adopt or spawn the proxy, gate on readiness, and own the spawned process
 * for the plugin's lifetime.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context carrying `subprocess`.
 * @param {ReturnType<typeof Config>} config - resolved plugin configuration.
 */
export async function apply(ctx, config) {
  const url = `http://${config.host}:${config.port}/v1/models`
  const childEnv = {
    ...config.env,
    DARIO_HOST: config.host,
    DARIO_PORT: String(config.port),
  }

  const setupAbort = new AbortController()
  const stopSetupCancellation = ctx.on('internal/plugin', (fiber) => {
    // An async plugin callback must observe its own disposal before Cordis
    // can run effect cleanup, because unload otherwise waits for it.
    if (fiber === ctx.fiber && fiber.uid === null) {
      setupAbort.abort(new Error('dsh-dario-sidecar setup disposed'))
    }
  })

  let handle
  try {
    if (await probeReady(url, setupAbort.signal)) {
      ctx.logger.info('dsh-dario-sidecar: adopted an already-healthy dario on %s:%s (not owned; teardown will not kill it)', config.host, config.port)
      return
    }
    setupAbort.signal.throwIfAborted()

    const executable = await ctx.subprocess.resolveExecutable(config.command, childEnv, setupAbort.signal)
    setupAbort.signal.throwIfAborted()

    handle = ctx.subprocess.spawn({
      argv: [executable, ...config.args],
      cwd: os.homedir(),
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: DEFAULT_STDIO_TAIL_BYTES },
        stderr: { maxBytes: DEFAULT_STDIO_TAIL_BYTES },
      },
      graceMs: config.killGraceMs,
      signal: setupAbort.signal,
      env: childEnv,
    })

    const deadline = Date.now() + config.readyTimeoutMs
    while (!(await probeReady(url, setupAbort.signal))) {
      setupAbort.signal.throwIfAborted()
      if (Date.now() >= deadline) {
        const [stderrTail, stdoutTail] = await tailOf(handle)
        handle.terminate()
        await handle.waitForExit()
        throw new Error(`dsh-dario-sidecar: dario proxy not ready on ${url} within ${config.readyTimeoutMs}ms`
          + `${stderrTail ? `; stderr tail: ${stderrTail}` : ''}${stdoutTail ? `; stdout tail: ${stdoutTail}` : ''}`)
      }
      // Observe an early exit between polls so the failure carries the tail.
      const settled = await Promise.race([handle.done.then(() => true, () => true), delay(config.pollIntervalMs, undefined, { signal: setupAbort.signal }).then(() => false)])
      if (settled) {
        const [stderrTail, stdoutTail] = await tailOf(handle)
        throw new Error(`dsh-dario-sidecar: dario proxy exited before readiness on ${url}`
          + `${stderrTail ? `; stderr tail: ${stderrTail}` : ''}${stdoutTail ? `; stdout tail: ${stdoutTail}` : ''}`)
      }
    }
    setupAbort.signal.throwIfAborted()
    ctx.logger.info('dsh-dario-sidecar: dario proxy ready on %s (pid %s)', url, handle.pid)

    // Surface a later death without letting the outcome promise reject unhandled.
    handle.done.then((outcome) => {
      ctx.logger.warn('dsh-dario-sidecar: dario proxy exited while mounted (exitCode %s, signal %s)', outcome.exitCode, outcome.signal)
    }, (error) => {
      ctx.logger.error('dsh-dario-sidecar: dario proxy process failed while mounted', error)
    })
  } catch (error) {
    // Setup aborts mean this plugin is being disposed mid-load; the spawn (if
    // any) is terminated by the spec signal, so rethrow for Cordis to observe.
    if (handle !== undefined) {
      handle.terminate()
      await handle.waitForExit().catch(() => {})
    }
    stopSetupCancellation()
    throw error
  }

  ctx.effect(() => async () => {
    stopSetupCancellation()
    setupAbort.abort(new Error('dsh-dario-sidecar disposed'))
    handle.terminate()
    const exited = await handle.waitForExit(AbortSignal.timeout(TEARDOWN_WAIT_MS))
    if (!exited) ctx.logger.error('dsh-dario-sidecar: dario proxy tree did not exit within %sms', TEARDOWN_WAIT_MS)
    else ctx.logger.info('dsh-dario-sidecar: dario proxy stopped')
  }, 'dsh-dario-sidecar.lifecycle')
}
