// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { forwardRef, memo } from 'react';

const Foo = forwardRef((props, ref) => null);
const Bar = memo(() => null);
const Baz = memo(forwardRef((props, ref) => null));
function Comp() { return null; }

export { Foo, Bar, Baz, Comp };
