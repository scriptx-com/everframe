// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#import "RnDevtoolsOrigin.h"
#import <objc/runtime.h>
#import <cstring>

// RN's developer menu is a generic UIAlertController. Attribute the actual
// controller owned by RCTDevMenu, never its title or any of its button labels.
static NSHashTable<id> *EFDevMenus;
static Ivar EFDevMenuActionSheet;
void EFInstallDevMenuOrigin(void) {
  Class cls = NSClassFromString(@"RCTDevMenu");
  Method method = cls ? class_getInstanceMethod(cls, NSSelectorFromString(@"show")) : NULL;
  Ivar actionSheet = cls ? class_getInstanceVariable(cls, "_actionSheet") : NULL;
  if (!method || !actionSheet || strcmp(ivar_getTypeEncoding(actionSheet), "@\"UIAlertController\"") != 0) return;
  EFDevMenus = [NSHashTable weakObjectsHashTable];
  EFDevMenuActionSheet = actionSheet;
  typedef void (*ShowFn)(id, SEL);
  ShowFn original = (ShowFn)method_getImplementation(method);
  method_setImplementation(method, imp_implementationWithBlock(^(id menu) {
    original(menu, NSSelectorFromString(@"show"));
    if (![NSThread isMainThread]) return;
    id controller = object_getIvar(menu, actionSheet);
    if ([controller isKindOfClass:UIViewController.class]) [EFDevMenus addObject:menu];
  }));
}
BOOL EFIsDevMenuView(UIView *view) {
  for (id menu in EFDevMenus) {
    id current = object_getIvar(menu, EFDevMenuActionSheet);
    if (![current isKindOfClass:UIViewController.class]) continue;
    UIViewController *controller = current;
    if (controller.isViewLoaded && [view isDescendantOfView:controller.view]) return YES;
  }
  return NO;
}

