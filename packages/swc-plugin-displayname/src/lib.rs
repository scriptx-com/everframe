// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// References: hjkcai/swc-plugin-add-display-name (visitor pattern).
// SWC plugin compatibility: pin swc_core matching @swc/core >= 1.15.
// Build with --cfg=swc_ast_unknown for forward-compat Wasm.

use swc_core::ecma::ast::*;
use swc_core::ecma::visit::{VisitMut, VisitMutWith};
use swc_core::plugin::plugin_transform;
use swc_core::plugin::proxies::TransformPluginProgramMetadata;

const FACTORIES: &[&str] = &["forwardRef", "memo"];

pub struct DisplayNameVisitor {
    extra_factories: Vec<String>,
}

impl DisplayNameVisitor {
    fn is_react_factory(&self, expr: &Expr) -> bool {
        match expr {
            Expr::Call(c) => {
                let callee_name = match &c.callee {
                    Callee::Expr(e) => match &**e {
                        Expr::Ident(id) => Some(id.sym.to_string()),
                        Expr::Member(m) => match &m.prop {
                            MemberProp::Ident(id) => Some(id.sym.to_string()),
                            _ => None,
                        },
                        _ => None,
                    },
                    _ => None,
                };
                if let Some(name) = callee_name {
                    return FACTORIES.contains(&name.as_str())
                        || self.extra_factories.iter().any(|f| f == &name);
                }
                false
            }
            _ => false,
        }
    }
}

impl VisitMut for DisplayNameVisitor {
    fn visit_mut_module(&mut self, module: &mut Module) {
        let mut new_items: Vec<ModuleItem> = Vec::with_capacity(module.body.len() * 2);
        for item in module.body.drain(..) {
            let to_add: Vec<String> = match &item {
                ModuleItem::Stmt(Stmt::Decl(Decl::Var(var_decl))) => var_decl
                    .decls
                    .iter()
                    .filter_map(|decl| {
                        let name = match &decl.name {
                            Pat::Ident(BindingIdent { id, .. }) => id.sym.to_string(),
                            _ => return None,
                        };
                        let init = decl.init.as_deref()?;
                        if self.is_react_factory(init) {
                            Some(name)
                        } else {
                            None
                        }
                    })
                    .collect(),
                ModuleItem::Stmt(Stmt::Decl(Decl::Fn(fn_decl))) => {
                    let name = fn_decl.ident.sym.to_string();
                    if name.chars().next().map_or(false, |c| c.is_uppercase()) {
                        vec![name]
                    } else {
                        vec![]
                    }
                }
                _ => vec![],
            };
            new_items.push(item);
            for name in to_add {
                new_items.push(ModuleItem::Stmt(Stmt::Expr(ExprStmt {
                    span: Default::default(),
                    expr: Box::new(Expr::Assign(AssignExpr {
                        span: Default::default(),
                        op: AssignOp::Assign,
                        left: AssignTarget::Simple(SimpleAssignTarget::Member(MemberExpr {
                            span: Default::default(),
                            // Ident::new takes (sym, span, ctxt) from
                            // swc_ecma_ast 28 (swc_core 76); the two-argument
                            // form predates the SyntaxContext split. Default
                            // ctxt is correct here — this identifier is
                            // synthesised, not resolved, so it carries no
                            // hygiene information to preserve.
                            obj: Box::new(Expr::Ident(Ident::new(
                                name.clone().into(),
                                Default::default(),
                                Default::default(),
                            ))),
                            prop: MemberProp::Ident(IdentName::new(
                                "displayName".into(),
                                Default::default(),
                            )),
                        })),
                        right: Box::new(Expr::Lit(Lit::Str(Str {
                            span: Default::default(),
                            value: name.into(),
                            raw: None,
                        }))),
                    })),
                })));
            }
        }
        module.body = new_items;
        module.visit_mut_children_with(self);
    }
}

#[plugin_transform]
pub fn process_transform(
    mut program: Program,
    _metadata: TransformPluginProgramMetadata,
) -> Program {
    program.visit_mut_with(&mut DisplayNameVisitor {
        extra_factories: vec![],
    });
    program
}
