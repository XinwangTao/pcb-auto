# -*- coding: utf-8 -*-
"""找出「模块级用到了但从未导入/赋值」的名字。

为什么需要它：`py_compile` 只查语法，NameError 要到运行时才炸。
今晚我两次把 `NODE = shutil.which(...)` 写进脚本却忘了 `import shutil`
—— 两次都是靠手工跑才发现的。这种错在 CI 上会表现成「量具返回非 0」，
而真正的原因藏在 stderr 深处，很容易被当成环境问题糊过去。

规则：只扫**模块作用域**。函数/类/lambda 内部整个跳过 —— 那里的名字是运行期
才求值的，静态判断必然误报（闭包、参数、global 都是例子）。
模块作用域包括 `if __name__ == "__main__":`、`for`、`with`、`try` 的花括号里，
所以这些控制流**内部的绑定也算绑定**。这一点第一版写错了，于是把自己的
`for _stream in (...)` 报成了未定义。
"""
import ast
import builtins
import io
import sys

BUILTINS = set(dir(builtins)) | {"__file__", "__name__", "__doc__", "__package__", "__spec__"}


class Scope:
    def __init__(self):
        self.bound = set()
        self.loads = []  # [(name, lineno)]

    def add_target(self, t):
        if isinstance(t, ast.Name):
            self.bound.add(t.id)
        elif isinstance(t, (ast.Tuple, ast.List)):
            for e in t.elts:
                self.add_target(e)
        elif isinstance(t, ast.Starred):
            self.add_target(t.value)

    def walk(self, node):
        """只走模块作用域；遇到函数/类/lambda 就停。"""
        if node is None:
            return
        # 作用域边界：不进函数体、类体、lambda 体
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
            # 但它的名字本身是绑定（装饰器与默认参数在模块作用域求值，也扫一下）
            if not isinstance(node, ast.Lambda):
                self.bound.add(node.name)
                for dec in getattr(node, "decorator_list", []):
                    self.walk(dec)
            # 只有函数/ lambda 才有 args；ClassDef 没有。
            args = getattr(node, "args", None)
            if args is not None:
                for default in list(getattr(args, "defaults", [])) + \
                        [x for x in getattr(args, "kw_defaults", []) if x is not None]:
                    self.walk(default)
            return

        if isinstance(node, ast.Name):
            if isinstance(node.ctx, ast.Load):
                self.loads.append((node.id, node.lineno))
            else:
                self.bound.add(node.id)
            return

        if isinstance(node, ast.Import):
            for a in node.names:
                self.bound.add(a.asname or a.name.split(".")[0])
            return
        if isinstance(node, ast.ImportFrom):
            for a in node.names:
                self.bound.add(a.asname or a.name)
            return

        # 各类绑定位置
        if isinstance(node, ast.ExceptHandler) and node.name:
            self.bound.add(node.name)
        if isinstance(node, ast.Global):
            for n in node.names:
                self.bound.add(n)

        for child in ast.iter_child_nodes(node):
            self.walk(child)


def check(path):
    try:
        src = io.open(path, encoding="utf-8").read()
    except OSError as e:
        return [f"{path}: 读不了：{e}"]
    try:
        tree = ast.parse(src, filename=path)
    except SyntaxError as e:
        return [f"{path}: 语法错：{e}"]

    sc = Scope()
    for node in tree.body:
        sc.walk(node)

    problems = []
    seen = set()
    for name, ln in sc.loads:
        if name in sc.bound or name in BUILTINS:
            continue
        if (name, ln) in seen:
            continue
        seen.add((name, ln))
        problems.append(f"{path}:{ln} 用了未定义的模块级名字 `{name}`")
    return problems


def main(paths):
    allp = []
    for p in paths:
        found = check(p)
        if found:
            allp.extend(found)
            for f in found:
                print(f"  [!] {f}")
        else:
            print(f"  [ok] {p}")
    if allp:
        print(f"\n  共 {len(allp)} 处问题")
        return 1
    return 0


if __name__ == "__main__":
    for _stream in (sys.stdout, sys.stderr):
        try:
            _stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    if len(sys.argv) < 2:
        sys.exit("用法：undefined-names.py <file.py> [...]")
    sys.exit(main(sys.argv[1:]))
