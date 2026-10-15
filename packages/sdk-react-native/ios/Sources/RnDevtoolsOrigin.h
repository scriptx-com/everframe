// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#import <UIKit/UIKit.h>

/// Framework support only; all calls after installation run on the UI thread.
FOUNDATION_EXPORT void EFInstallDevMenuOrigin(void);
FOUNDATION_EXPORT BOOL EFIsDevMenuView(UIView *view);
