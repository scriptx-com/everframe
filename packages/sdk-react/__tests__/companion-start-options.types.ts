// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Compile-time guard, not a runtime test: checked by `tsc -p tsconfig.test.json`.
// Companion was removed, but code written against the old
// `companion.start()` options must keep compiling, including inline callbacks
// that read the old argument shapes and the namespace's type names.
import { companion } from '../src/index.js';

companion.start({
  onReportSubmit: (msg) => console.log(msg.title, msg.includes.network),
  onReportRequest: (correlationId, ws) => {
    ws.send({ type: 'report.cancelled', correlation_id: correlationId });
    ws.sendBinary(new ArrayBuffer(0));
  },
});

const onSubmit = (msg: companion.ReportSubmit): void => console.log(msg.description.text);
const onRequest = (_id: string, ws: companion.RelayWSClient): void => ws.stop();
const counts: companion.ReportCounts = { logs: 0, network: 0, uiTreeNodes: 0 };
const frame: companion.RelayMessage = { type: 'report.cancelled', correlation_id: 'c' };
const options: companion.CompanionStartOptions = {
  onReportSubmit: onSubmit,
  onReportRequest: onRequest,
  counts,
};
companion.start(options);
void frame;
