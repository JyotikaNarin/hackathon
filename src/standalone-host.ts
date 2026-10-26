import type {AgentiaPluginHost, TableColumn} from '@copado/agentia-plugin-sdk'
import {SUPPORTED_HOST_API_VERSION} from '@copado/agentia-plugin-sdk'

const HOST_KEY = Symbol.for('copado.agentia.pluginHost')

export const STANDALONE_CLI_VERSION = 'standalone'

function wrap(value: string, width: number): string[] {
  const lines: string[] = []
  for (const paragraph of value.split('\n')) {
    let line = ''
    for (const word of paragraph.split(' ')) {
      if (line && line.length + word.length + 1 > width) {
        lines.push(line)
        line = word
      } else {
        line = line ? `${line} ${word}` : word
      }
    }

    lines.push(line)
  }

  return lines
}

/** Plain-text table with the same signature as `host.format.table`, for runs outside the Agentia CLI. */
function table(columns: readonly TableColumn[], rows: ReadonlyArray<Record<string, unknown>>): string {
  const cells = rows.map((row) => columns.map((column) => String(row[column.field] ?? '')))
  const widths = columns.map((column, index) => Math.max(column.header.length, ...cells.map((row) => row[index].length)))
  const fixed = widths.reduce((sum, width, index) => sum + (columns[index].wrap ? 0 : width + 2), 0)
  const terminal = process.stdout.columns ?? 120
  columns.forEach((column, index) => {
    if (column.wrap) widths[index] = Math.max(20, Math.min(widths[index], terminal - fixed - 2))
  })
  const render = (values: string[][]) => {
    const height = Math.max(...values.map((value) => value.length))
    return Array.from({length: height}, (_, line) => values.map((value, index) => (value[line] ?? '').padEnd(widths[index])).join('  ').trimEnd())
  }

  return [
    ...render(columns.map((column) => [column.header])),
    widths.map((width) => '─'.repeat(width)).join('  '),
    ...cells.flatMap((row) => render(row.map((value, index) => (columns[index].wrap ? wrap(value, widths[index]) : [value])))),
  ].join('\n')
}

function notAvailable(capability: string): Promise<never> {
  throw new Error(`${capability} needs the Agentia CLI with a Copado API key (agentia auth set --cicd <key>).`)
}

/**
 * Lets the plugin run as a plain CLI (`npx driftguard guard preflight ...`) on machines without Agentia or Copado access.
 * Copado-backed host methods report that they need the Agentia CLI; the Git, folder and org checks work the same.
 */
export function installStandaloneHost(): void {
  const registry = globalThis as unknown as Record<symbol, unknown>
  if (registry[HOST_KEY]) return
  // Only the namespaces DriftGuard touches; the command checks optional methods before calling them.
  const host = {
    apiVersion: SUPPORTED_HOST_API_VERSION,
    auth: {status: () => ({ai: {configured: false}, cicd: {configured: false}, crt: {configured: false}})},
    cliVersion: STANDALONE_CLI_VERSION,
    format: {table},
    getTransactionId: () => undefined,
    organization: {healthCheck: async () => notAvailable('The Copado health check')},
    runWithTransaction: <T>(_options: unknown, action: () => Promise<T>) => action(),
    work: {getWorkItem: async () => notAvailable('Reading a Copado user story')},
  }
  registry[HOST_KEY] = host as unknown as AgentiaPluginHost
}
