// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
// PascalCase but returns non-JSX values — must NOT be tagged.
const Reducer = (state: { n: number }, action: { type: string }) => ({ ...state, n: state.n + 1 });
const Status = (n: number) => (n > 0 ? 'active' : 'inactive');
const Factory = () => {
  const helper = () => <div>nested JSX, not ours</div>;
  return helper;
};
export { Reducer, Status, Factory };
