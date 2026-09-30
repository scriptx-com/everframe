#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { main } from './cli-main.js';

process.exitCode = main(process.argv.slice(2));
