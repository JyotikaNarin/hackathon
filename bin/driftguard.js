#!/usr/bin/env node
// Runs the plugin without the Agentia CLI, e.g. `node bin/driftguard.js guard preflight ...`.
// Inside Agentia, use `agentia guard preflight ...` instead (after `agentia plugins link .`).
import {execute} from '@oclif/core'

import {installStandaloneHost} from '../dist/index.js'

installStandaloneHost()
await execute({dir: import.meta.url})
