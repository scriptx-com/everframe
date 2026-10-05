// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
const { withEverframe } = require('@everframe/expo');

/** Adds the native upload step only when an app id is configured, keeping the example credential-free. */
module.exports = (config) =>
  process.env.EVERFRAME_APP_ID ? withEverframe(config, { appId: process.env.EVERFRAME_APP_ID }) : config;
