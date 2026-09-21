// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { Component } from 'react';
class Counter extends Component<{ initial: number }> {
  render() {
    return <div>{this.props.initial}</div>;
  }
}
export default Counter;
