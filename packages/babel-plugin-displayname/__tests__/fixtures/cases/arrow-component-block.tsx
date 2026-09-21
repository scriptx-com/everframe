// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
const Card = (props: { ok: boolean }) => {
  if (!props.ok) return null;
  return <section>{String(props.ok)}</section>;
};
export default Card;
