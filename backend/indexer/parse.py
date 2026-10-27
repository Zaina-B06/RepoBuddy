"""Parse one source file with tree-sitter.

Extracts, per file:
  - symbols:    functions, classes, methods (name, kind, start/end line, exported)
  - imports:    raw import specifiers (resolved to files later, in resolve.py)
  - routes:     backend route definitions (Express, FastAPI/Flask decorators, Django urls.py)
  - http_calls: frontend calls such as fetch('/api/x') and axios.get('/api/x')
Next.js file-based routes are derived from the file path in build.py, not here.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

import tree_sitter_javascript as tsjs
import tree_sitter_python as tspy
import tree_sitter_typescript as tsts
from tree_sitter import Language, Parser

_JS = Language(tsjs.language())
_TS = Language(tsts.language_typescript())
_TSX = Language(tsts.language_tsx())
_PY = Language(tspy.language())

LANG_BY_EXT = {
    ".py": ("python", _PY),
    ".js": ("javascript", _JS),
    ".jsx": ("javascript", _JS),
    ".mjs": ("javascript", _JS),
    ".cjs": ("javascript", _JS),
    ".ts": ("typescript", _TS),
    ".tsx": ("typescript", _TSX),
}

HTTP_METHODS = {"get", "post", "put", "patch", "delete", "head", "options", "all"}
PY_ROUTE_ATTRS = HTTP_METHODS | {"route", "api_route", "websocket"}
_HANDLER_TYPES = {"arrow_function", "function_expression", "function", "identifier", "member_expression",
                  "call_expression"}


@dataclass
class Symbol:
    name: str
    kind: str          # function | class | method
    start: int         # 1-based line numbers
    end: int
    exported: bool = False


@dataclass
class Import:
    spec: str                  # e.g. "./utils", "@/lib/db", ".models", "flask.app"
    line: int
    fallback: str | None = None  # python `from pkg import x`: try pkg.x, then pkg


@dataclass
class Route:
    method: str        # GET, POST, ... or ANY
    path: str          # as written, e.g. "/users/:id", "/items/{item_id}"
    line: int
    handler: str | None = None
    obj: str | None = None   # python: the router object the decorator belongs to


@dataclass
class HttpCall:
    method: str
    url: str           # template parts replaced with :param
    line: int


@dataclass
class Parsed:
    lang: str
    symbols: list[Symbol] = field(default_factory=list)
    imports: list[Import] = field(default_factory=list)
    routes: list[Route] = field(default_factory=list)
    http_calls: list[HttpCall] = field(default_factory=list)
    has_main_guard: bool = False


def _t(node, src: bytes) -> str:
    return src[node.start_byte:node.end_byte].decode("utf8", errors="replace")


def _js_string(node, src: bytes) -> str | None:
    """Literal value of a JS string or template string; ${...} becomes :param."""
    if node.type == "string":
        return _t(node, src)[1:-1]
    if node.type == "template_string":
        out = []
        for c in node.children:
            if c.type == "template_substitution":
                out.append(":param")
            elif c.type in ("string_fragment", "escape_sequence"):
                out.append(_t(c, src))
        if not out:  # older grammars keep the text inline
            raw = _t(node, src)[1:-1]
            return re.sub(r"\$\{[^}]*\}", ":param", raw)
        return "".join(out)
    return None


def _py_string(node, src: bytes) -> str | None:
    if node.type != "string":
        return None
    raw = _t(node, src)
    m = re.match(r"^[rRbBuUfF]{0,2}('''|\"\"\"|'|\")(.*)\1$", raw, re.S)
    return m.group(2) if m else None


def parse_file(ext: str, src: bytes) -> Parsed:
    lang, language = LANG_BY_EXT[ext]
    tree = Parser(language).parse(src)
    out = Parsed(lang=lang)
    if lang == "python":
        _walk_python(tree.root_node, src, out)
        _apply_router_prefixes(src, out)
        out.has_main_guard = b"__name__ == \"__main__\"" in src or b"__name__ == '__main__'" in src
    else:
        _walk_js(tree.root_node, src, out)
    return out


# ---------------------------------------------------------------- python

def _walk_python(root, src: bytes, out: Parsed) -> None:
    stack = [(root, None)]  # (node, enclosing class name)
    while stack:
        n, cls = stack.pop()
        t = n.type
        if t == "import_statement":
            for c in n.named_children:
                name = c.child_by_field_name("name") if c.type == "aliased_import" else c
                out.imports.append(Import(_t(name, src), n.start_point[0] + 1))
        elif t == "import_from_statement":
            mod = n.child_by_field_name("module_name")
            if mod is not None:
                base = _t(mod, src)
                names = [c.child_by_field_name("name") if c.type == "aliased_import" else c
                         for c in n.children_by_field_name("name")]
                if not names:
                    out.imports.append(Import(base, n.start_point[0] + 1))
                for nm in names:
                    sub = base + _t(nm, src) if base.endswith(".") else base + "." + _t(nm, src)
                    out.imports.append(Import(sub, n.start_point[0] + 1, fallback=base))
        elif t == "class_definition":
            name = _t(n.child_by_field_name("name"), src)
            out.symbols.append(Symbol(name, "class", n.start_point[0] + 1, n.end_point[0] + 1))
            for c in n.children:
                stack.append((c, name))
            continue
        elif t == "function_definition":
            name = _t(n.child_by_field_name("name"), src)
            out.symbols.append(Symbol(name, "method" if cls else "function",
                                      n.start_point[0] + 1, n.end_point[0] + 1))
        elif t == "decorated_definition":
            _python_route(n, src, out)
        elif t == "call":
            _django_path(n, src, out)
        for c in n.children:
            stack.append((c, cls if t != "function_definition" else None))


def _python_route(n, src: bytes, out: Parsed) -> None:
    """@app.get("/x"), @router.post(...), @app.route("/x", methods=["POST"]), @bp.route(...)"""
    definition = n.child_by_field_name("definition")
    handler = None
    if definition is not None and definition.child_by_field_name("name") is not None:
        handler = _t(definition.child_by_field_name("name"), src)
    for dec in n.children:
        if dec.type != "decorator":
            continue
        call = next((c for c in dec.named_children if c.type == "call"), None)
        if call is None:
            continue
        fn = call.child_by_field_name("function")
        if fn is None or fn.type != "attribute":
            continue
        attr = _t(fn.child_by_field_name("attribute"), src)
        if attr not in PY_ROUTE_ATTRS:
            continue
        args = call.child_by_field_name("arguments")
        if args is None:
            continue
        first = next((a for a in args.named_children if a.type == "string"), None)
        path = _py_string(first, src) if first is not None else None
        if not path or not path.startswith("/"):
            continue
        obj = fn.child_by_field_name("object")
        method = attr.upper() if attr in HTTP_METHODS else "GET"
        for kw in args.named_children:
            if kw.type == "keyword_argument" and _t(kw.child_by_field_name("name"), src) == "methods":
                found = re.findall(r"[A-Za-z]+", _t(kw.child_by_field_name("value"), src))
                if found:
                    method = ",".join(m.upper() for m in found)
        if attr in ("route", "api_route") and method == "GET" and "methods" not in _t(args, src):
            method = "GET"
        out.routes.append(Route(method, path, n.start_point[0] + 1, handler,
                                obj=_t(obj, src) if obj is not None else None))


_ROUTER_DEF = re.compile(r"^\s*(\w+)\s*=\s*(?:\w+\.)?(?:APIRouter|Blueprint)\((.*?)\)\s*$", re.M | re.S)


def _apply_router_prefixes(src: bytes, out: Parsed) -> None:
    """router = APIRouter(prefix="/items") / bp = Blueprint(..., url_prefix="/auth"): prefix its routes."""
    text = src.decode("utf8", errors="replace")
    prefixes = {}
    for m in _ROUTER_DEF.finditer(text):
        p = re.search(r"(?:url_)?prefix\s*=\s*[\"']([^\"']*)[\"']", m.group(2))
        if p:
            prefixes[m.group(1)] = p.group(1).rstrip("/")
    for r in out.routes:
        if r.obj in prefixes:
            r.path = prefixes[r.obj] + ("" if r.path == "/" else r.path) or "/"


def _django_path(n, src: bytes, out: Parsed) -> None:
    fn = n.child_by_field_name("function")
    if fn is None or fn.type != "identifier" or _t(fn, src) not in ("path", "re_path"):
        return
    args = n.child_by_field_name("arguments")
    if args is None or not args.named_children:
        return
    first = args.named_children[0]
    path = _py_string(first, src)
    if path is None:
        return
    handler = _t(args.named_children[1], src) if len(args.named_children) > 1 else None
    out.routes.append(Route("ANY", "/" + path.lstrip("^/"), n.start_point[0] + 1, handler))


# ---------------------------------------------------------------- javascript / typescript

def _walk_js(root, src: bytes, out: Parsed) -> None:
    stack = [(root, None)]
    while stack:
        n, cls = stack.pop()
        t = n.type
        exported = n.parent is not None and n.parent.type == "export_statement"
        if t in ("import_statement", "export_statement"):
            s = n.child_by_field_name("source")
            if s is not None:
                out.imports.append(Import(_t(s, src).strip("'\"`"), n.start_point[0] + 1))
        elif t in ("function_declaration", "generator_function_declaration"):
            name = n.child_by_field_name("name")
            if name is not None:
                out.symbols.append(Symbol(_t(name, src), "function", n.start_point[0] + 1,
                                          n.end_point[0] + 1, exported))
        elif t in ("class_declaration", "abstract_class_declaration"):
            name = n.child_by_field_name("name")
            cname = _t(name, src) if name is not None else None
            if cname:
                out.symbols.append(Symbol(cname, "class", n.start_point[0] + 1,
                                          n.end_point[0] + 1, exported))
            for c in n.children:
                stack.append((c, cname))
            continue
        elif t == "method_definition":
            name = n.child_by_field_name("name")
            if name is not None:
                out.symbols.append(Symbol(_t(name, src), "method", n.start_point[0] + 1,
                                          n.end_point[0] + 1))
        elif t == "variable_declarator":
            val = n.child_by_field_name("value")
            name = n.child_by_field_name("name")
            if val is not None and name is not None and val.type in (
                    "arrow_function", "function_expression", "function"):
                decl = n.parent
                exp = decl is not None and decl.parent is not None and decl.parent.type == "export_statement"
                out.symbols.append(Symbol(_t(name, src), "function", n.start_point[0] + 1,
                                          n.end_point[0] + 1, exp))
        elif t == "call_expression":
            _js_call(n, src, out)
        for c in n.children:
            stack.append((c, cls))


def _js_call(n, src: bytes, out: Parsed) -> None:
    fn = n.child_by_field_name("function")
    args = n.child_by_field_name("arguments")
    if fn is None or args is None:
        return
    first = args.named_children[0] if args.named_children else None
    fname = _t(fn, src)
    line = n.start_point[0] + 1

    # require('x') / dynamic import('x')
    if fname in ("require", "import") and first is not None and first.type == "string":
        out.imports.append(Import(_t(first, src).strip("'\"`"), line))
        return

    value = _js_string(first, src) if first is not None else None

    # fetch('/api/x') / axios.get('/api/x') / axios('/api/x')
    if fname == "fetch" or fname == "axios" or fname.startswith("axios."):
        url = _clean_url(value)
        if url:
            method = fname.split(".", 1)[1].upper() if "." in fname else _fetch_method(args, src)
            out.http_calls.append(HttpCall(method if method.lower() in HTTP_METHODS else "GET", url, line))
        return

    # obj.get('/x', ...): an Express route if a handler follows, otherwise an HTTP client call
    # such as api.get('/users') on an axios instance.
    if fn.type == "member_expression":
        prop = fn.child_by_field_name("property")
        if prop is None or _t(prop, src) not in HTTP_METHODS or not value or not value.startswith("/"):
            return
        method = _t(prop, src).upper()
        rest = args.named_children[1:]
        if rest and rest[-1].type in _HANDLER_TYPES:
            handler = _t(rest[-1], src)
            out.routes.append(Route(method, value, line, handler if len(handler) <= 60 else None))
        else:
            url = _clean_url(value)
            if url:
                out.http_calls.append(HttpCall(method, url, line))


def _fetch_method(args, src: bytes) -> str:
    text = _t(args, src)
    m = re.search(r"method\s*:\s*['\"`](\w+)['\"`]", text)
    return m.group(1).upper() if m else "GET"


def _clean_url(value: str | None) -> str | None:
    if not value:
        return None
    value = re.sub(r"^https?://[^/]+", "", value)        # drop origin
    value = re.sub(r"^:param(?=/)", "", value)          # `${API_BASE}/users`
    value = value.split("?")[0].split("#")[0]
    return value if value.startswith("/") and len(value) > 1 else None
