<!-- SPDX-License-Identifier: MIT -->

## 0.0.18

### Patch Changes

- Updated dependencies [9691527]
  - @everframe/react-native@1.5.0

## 0.0.17

### Patch Changes

- Updated dependencies [d0ed9cb]
- Updated dependencies [e63aae4]
  - @everframe/react-native@1.4.0

## 0.0.16

### Patch Changes

- Updated dependencies [2e34dd5]
  - @everframe/react-native@1.2.2

## 0.0.15

### Patch Changes

- Updated dependencies [ceb86ab]
- Updated dependencies [56a3a9f]
- Updated dependencies [01c173d]
  - @everframe/react-native@1.3.0

## 0.0.14

### Patch Changes

- be2860f: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  The iOS and tvOS SDK frameworks now ship their dSYMs, so crashes in apps that install the `Everframe` pod (including React Native and Expo apps) symbolicate the SDK's own frames. Every xcframework slice carries its dSYM; CocoaPods copies it into the build, where the app's symbol upload phase finds it. `EverframeProtocol` moves to its own `Everframe/Protocol` subspec, which `Everframe/Core` depends on, because CocoaPods copies a subspec's xcframeworks into one folder and the second one's dSYMs replaced the first one's. The release verifier rejects a CocoaPods archive with a slice that has none, the React Native example rebuilds a local SDK that predates them, and the Expo plugin's README says the SDK's dSYMs upload with the app's.

- Updated dependencies [e0c884b]
- Updated dependencies [1ea29ae]
- Updated dependencies [c6ecb05]
- Updated dependencies [0fd1ce9]
- Updated dependencies [afb5433]
- Updated dependencies [5ec828c]
  - @everframe/react-native@1.2.0

## 0.0.13

### Patch Changes

- Updated dependencies [93308e3]
- Updated dependencies [a5e45fd]
- Updated dependencies [18bcef7]
- Updated dependencies [7d000f6]
- Updated dependencies [551e3f7]
  - @everframe/react-native@1.1.0

## 0.0.12

### Patch Changes

- Updated dependencies [afb0687]
- Updated dependencies [ccc4581]
  - @everframe/react-native@0.10.0

## 0.0.11

### Patch Changes

- Updated dependencies [b375364]
  - @everframe/react-native@0.9.0
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# examples-react-native

## 0.0.10

### Patch Changes

- Updated dependencies [d0b05a4]
- Updated dependencies [061f83a]
- Updated dependencies [80ac7d9]
  - @traceitx/react-native@0.9.0

## 0.0.9

### Patch Changes

- Updated dependencies [bdd8ea3]
  - @traceitx/react-native@0.8.0

## 0.0.8

### Patch Changes

- Updated dependencies [b3f851e]
- Updated dependencies [4f4e48d]
  - @traceitx/react-native@0.7.0

## 0.0.7

### Patch Changes

- Updated dependencies [8159f83]
- Updated dependencies [19d6d10]
  - @traceitx/react-native@0.7.0

## 0.0.6

### Patch Changes

- @traceitx/react-native@0.6.4

## 0.0.5

### Patch Changes

- Updated dependencies [16e10a6]
  - @traceitx/react-native@0.6.2

## 0.0.4

### Patch Changes

- @traceitx/react-native@0.6.1

## 0.0.3

### Patch Changes

- Updated dependencies [d08a35f]
- Updated dependencies [4058cf9]
- Updated dependencies [7cb6d68]
  - @traceitx/react-native@0.5.0

## 0.0.2

### Patch Changes

- Updated dependencies [4299929]
  - @scriptx-com/traceitx-react-native@0.4.0

## 0.0.1

### Patch Changes

- Updated dependencies [68807ba]
  - @scriptx-com/traceitx-react-native@0.3.1
