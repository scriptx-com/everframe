// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#import <XCTest/XCTest.h>
#import <objc/runtime.h>
#import "../Sources/RnDevtoolsOrigin.h"

// Matches RN CoreModules/RCTDevMenu.mm: show owns a generic UIAlertController
// in its _actionSheet ivar. No framework-specific view class or button text.
@interface EFOriginFixtureDevMenu : NSObject {
@public
  UIAlertController *_actionSheet;
}
@property(nonatomic) NSUInteger calls;
- (void)show;
@end
@implementation EFOriginFixtureDevMenu
- (void)show {
  self.calls += 1;
  _actionSheet = [UIAlertController alertControllerWithTitle:@"Unrelated title" message:nil preferredStyle:UIAlertControllerStyleAlert];
}
@end

@interface RnDevtoolsOriginTests : XCTestCase
@end
@implementation RnDevtoolsOriginTests
- (void)testExactMenuControllerIdentityWithoutLabelMatching {
  // The standalone UIKit harness has no RN. CocoaPods hosts already provide
  // RCTDevMenu; that concrete framework is exercised by device integration.
  XCTSkipIf(NSClassFromString(@"RCTDevMenu") != Nil, @"Standalone UIKit fixture requires an unregistered RCTDevMenu class name.");
  Class fixture = objc_allocateClassPair(EFOriginFixtureDevMenu.class, "RCTDevMenu", 0);
  objc_registerClassPair(fixture);
  EFInstallDevMenuOrigin();
  EFOriginFixtureDevMenu *menu = [fixture new];
  [menu show];
  XCTAssertEqual(menu.calls, 1u);
  UIView *host = menu->_actionSheet.view;
  UIButton *button = [UIButton new]; [button setTitle:@"Dismiss" forState:UIControlStateNormal]; [host addSubview:button];
  XCTAssertTrue(EFIsDevMenuView(button));
  UIButton *ordinary = [UIButton new]; [ordinary setTitle:@"Dismiss" forState:UIControlStateNormal];
  XCTAssertFalse(EFIsDevMenuView(ordinary));
  menu->_actionSheet = nil;
  XCTAssertFalse(EFIsDevMenuView(button));
}
@end
