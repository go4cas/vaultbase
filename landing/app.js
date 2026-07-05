/*
 * Cogworks landing — vanilla JS (no framework, no build step).
 * The machine is imperative SVG DOM (ported verbatim from the design prototype);
 * the cycling terminal and the "gears" spec-browser were React in the prototype
 * and are reimplemented here as plain DOM. Primary token = --pc (#B6D14A);
 * the SVG accent (`belt2`) is derived from it.
 */
(function () {
  "use strict";
  var NS = "http://www.w3.org/2000/svg";

  // ── state ──────────────────────────────────────────────────────────────
  var termView = 0, gearHover = null, gearPinned = null;
  var _termTimer = null;

  // ── gears data ─────────────────────────────────────────────────────────
  var _gears = null;
  function gearsData() {
    if (_gears) return _gears;
    var ic = {
      database: '<ellipse cx="12" cy="6" rx="7" ry="3"></ellipse><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6"></path><path d="M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"></path>',
      apis: '<polyline points="9 7 4 12 9 17"></polyline><polyline points="15 7 20 12 15 17"></polyline>',
      realtime: '<polyline points="3 12 8 12 10 7 14 17 16 12 21 12"></polyline>',
      queues: '<line x1="4" y1="7" x2="20" y2="7"></line><line x1="4" y1="12" x2="20" y2="12"></line><line x1="4" y1="17" x2="20" y2="17"></line><circle cx="9" cy="7" r="2"></circle><circle cx="15" cy="12" r="2"></circle><circle cx="8" cy="17" r="2"></circle>',
      search: '<circle cx="10" cy="10" r="6"></circle><line x1="15" y1="15" x2="20" y2="20"></line>',
      ai: '<path d="M12 4 13.8 10.2 20 12 13.8 13.8 12 20 10.2 13.8 4 12 10.2 10.2 Z"></path>',
      auth: '<rect x="5" y="11" width="14" height="9" rx="1.5"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path>',
      storage: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"></path>',
      files: '<path d="M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V8Z"></path><polyline points="14 3 14 8 19 8"></polyline>',
      functions: '<polygon points="13 2 4 14 11 14 9 22 20 10 13 10"></polygon>',
      security: '<path d="M12 3l7 3v5c0 4.4-3 7.6-7 8.6-4-1-7-4.2-7-8.6V6l7-3Z"></path><path d="M9 12l2 2 4-4"></path>',
      observability: '<path d="M4 18a8 8 0 0 1 16 0"></path><line x1="12" y1="18" x2="15.5" y2="12.5"></line><circle cx="12" cy="18" r="1.2"></circle>'
    };
    _gears = [
      { key: "database", icon: ic.database, title: "database", head: "Collections + real SQL", badge: "15 field types · 3 kinds", doc: "docs/data-model/", desc: "Every collection is a real SQLite table you can query, index, and migrate — not a bag of JSON. Typed fields with validation, relations, ALTER-style schema diffs when you edit, and a browser SQL runner.", specs: ["text · number · json", "relation · file · vector", "optimistic concurrency (ETag)", "schema editor + SQL runner"] },
      { key: "apis", icon: ic.apis, title: "apis", head: "Auto-generated REST", badge: "typed · filter / sort / expand", doc: "docs/rest-api/", desc: "Every collection ships a REST endpoint the moment you define it. Filter, sort, paginate, expand relations, and project fields — fully typed end-to-end from a generated SDK.", specs: ["filter · sort · paginate", "expand relations", "field projection", "generated typed SDK"] },
      { key: "realtime", icon: ic.realtime, title: "realtime", head: "Realtime streams", badge: "WebSocket + SSE", doc: "docs/realtime/", desc: "Subscribe to a record, a whole collection, or a wildcard for everything. Per-connection auth respects your API rules, SSE falls back where sockets can't reach, and reconnects replay what you missed.", specs: ["subscribe to records", "wildcard + filtered topics", "reconnect resume", "presence + auth-gated"] },
      { key: "jobs", icon: ic.queues, title: "jobs", head: "Jobs, cron & workflows", badge: "workers · scheduled · durable", doc: "docs/extensibility/", desc: "Background jobs, scheduled tasks, and code-first durable workflows run inside the same binary — no Redis, no external worker host. Push notifications ride the same durable queue.", specs: ["native job workers", "UTC cron + one-off", "retries · backoff · dead-letter", "durable step workflows"] },
      { key: "search", icon: ic.search, title: "search", head: "Full-text + vector", badge: "BM25 · nearVector", doc: "docs/rest-api/", desc: "Full-text ranking and vector similarity over the same tables your data already lives in. Add a vector field, embed on write, and query by nearest neighbour.", specs: ["full-text (BM25)", "vector field type", "nearVector queries", "swappable vector backend"] },
      { key: "ai", icon: ic.ai, title: "ai", head: "AI agents via MCP", badge: "first-party MCP server", doc: "docs/platform/", desc: "Cogworks speaks the Model Context Protocol out of the box. Any agent — Claude, Cursor, ChatGPT — can browse collections, query records, and run admin tasks, scope-gated and rate-limited.", specs: ["5 tools per collection", "scope-gated tokens", "read-only mode", "stdio + HTTP transports"] },
      { key: "auth", icon: ic.auth, title: "auth", head: "Auth, fully featured", badge: "OAuth2 · MFA · passkeys", doc: "docs/authentication/", desc: "Email + password, OAuth2, OTP and magic-link, MFA/TOTP, passkeys, and anonymous sessions — with JWTs, recovery codes, and no account-enumeration leaks.", specs: ["11 OAuth2 providers (PKCE)", "OTP · magic-link · MFA", "WebAuthn passkeys", "anonymous + impersonation"] },
      { key: "storage", icon: ic.storage, title: "storage", head: "Object storage", badge: "local · S3 · R2", doc: "docs/files/", desc: "Local filesystem by default, one-click S3/R2 presets when you grow. On-the-fly thumbnails, MIME + size validation, and rule-based, audited downloads.", specs: ["on-the-fly thumbnails", "per-field view rules", "one-time + IP-bound tokens", "audited downloads"] },
      { key: "files", icon: ic.files, title: "files", head: "File pipeline", badge: "upload · serve · transform", doc: "docs/files/", desc: "A typed file field that handles uploads, protected serving, and image transforms. Signed URLs, per-field rules, and transforms applied on the fly at request time.", specs: ["typed file fields", "signed download URLs", "on-the-fly transforms", "MIME + size validation"] },
      { key: "hooks", icon: ic.functions, title: "hooks", head: "Hooks on every event", badge: "hooks · routes · webhooks", doc: "docs/extensibility/", desc: "Six hook points around every CRUD event, custom HTTP routes, outbound HMAC-signed webhooks, and feature flags — all written in JavaScript in the admin UI. Save, and the next request runs the new code.", specs: ["before/after × CRUD hooks", "custom HTTP routes", "HMAC-signed webhooks", "feature flags + segments"] },
      { key: "security", icon: ic.security, title: "security", head: "Security & control", badge: "encryption · RBAC · audit", doc: "docs/platform/", desc: "Field-level AES-GCM encryption, operator roles (owner / developer / editor / viewer), an append-only audit log, per-IP and per-token rate limits, and one-command encryption-key rotation.", specs: ["encrypted fields (AES-GCM)", "operator roles (RBAC)", "append-only audit log", "encryption key rotation"] },
      { key: "observability", icon: ic.observability, title: "observability", head: "Ops & observability", badge: "metrics · tracing · health", doc: "docs/observability/", desc: "Prometheus metrics, OpenTelemetry trace export, liveness + readiness probes, a generated OpenAPI spec, consistent snapshot backups, and multi-core cluster mode — all built in.", specs: ["Prometheus metrics", "OpenTelemetry tracing", "health + readiness probes", "OpenAPI + cluster mode"] }
    ];
    return _gears;
  }

  function gearShown() {
    return gearPinned != null ? gearPinned : (gearHover != null ? gearHover : 0);
  }
  function toggleGear(i) {
    gearPinned = gearPinned === i ? null : i;
    applyGearState();
  }

  // ── gears UI (vanilla DOM) ─────────────────────────────────────────────
  var gearCards = [], gearDetailEl = null;

  function svgEl(w, h, stroke, sw, iconHtml) {
    var s = document.createElementNS(NS, "svg");
    s.setAttribute("width", w); s.setAttribute("height", h);
    s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("fill", "none");
    s.setAttribute("stroke", stroke); s.setAttribute("stroke-width", sw);
    s.setAttribute("stroke-linejoin", "round"); s.setAttribute("aria-hidden", "true");
    s.innerHTML = iconHtml;
    return s;
  }

  function buildGears() {
    var host = document.getElementById("gears");
    if (!host) return;
    host.innerHTML = "";
    gearCards = [];
    var gears = gearsData();
    var nav = document.createElement("div");
    nav.className = "cog-nav";
    nav.style.cssText = "display:flex;flex-direction:column;gap:8px;height:100%;overflow-y:auto;padding-right:6px";
    gears.forEach(function (g, i) {
      var card = document.createElement("div");
      card.setAttribute("role", "button");
      card.tabIndex = 0;
      card.setAttribute("aria-label", g.title + ": " + g.head);
      card.style.cssText = "display:flex;flex-direction:row;align-items:center;gap:11px;padding:11px 13px;border-radius:8px;cursor:pointer;outline:none;position:relative;flex-shrink:0";
      var icon = svgEl(19, 19, "#A9C0E2", 1.5, g.icon);
      icon.style.flex = "none"; icon.style.transition = "stroke .15s";
      var title = document.createElement("span");
      title.textContent = g.title;
      title.style.cssText = "flex:1;font-family:'Space Mono',monospace;font-size:12px;letter-spacing:.5px";
      var mark = document.createElement("span");
      mark.style.cssText = "flex:none";
      card.appendChild(icon); card.appendChild(title); card.appendChild(mark);
      card.addEventListener("mouseenter", function () { gearHover = i; applyGearState(); });
      card.addEventListener("focus", function () { gearHover = i; applyGearState(); });
      card.addEventListener("click", function () { toggleGear(i); });
      card.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleGear(i); }
      });
      gearCards.push({ el: card, icon: icon, title: title, mark: mark });
      nav.appendChild(card);
    });
    var detail = document.createElement("div");
    detail.className = "cog-detail";
    detail.style.cssText = "position:relative;border-radius:10px;overflow:hidden;height:100%;box-sizing:border-box;background:#0F2547;background-image:linear-gradient(rgba(232,239,249,.05) 1px,transparent 1px),linear-gradient(90deg,rgba(232,239,249,.05) 1px,transparent 1px);background-size:22px 22px;padding:24px 26px;transition:border-color .2s";
    gearDetailEl = detail;
    host.appendChild(nav); host.appendChild(detail);
    applyGearState();
  }

  function applyGearState() {
    var shown = gearShown();
    gearCards.forEach(function (c, i) {
      var active = i === shown, pinned = gearPinned === i;
      c.el.style.border = "1px solid " + (active ? "var(--pc)" : "#2A4A7D");
      c.el.style.background = active ? "rgba(182,209,74,.09)" : "rgba(15,37,71,.55)";
      c.el.style.transform = active ? "translateX(2px)" : "none";
      c.el.style.transition = "transform .15s, border-color .15s, background .15s";
      c.el.setAttribute("aria-pressed", pinned ? "true" : "false");
      c.icon.setAttribute("stroke", active ? "var(--pc)" : "#A9C0E2");
      c.title.style.color = active ? "#E8EFF9" : "#C4D3EA";
      if (pinned) {
        c.mark.textContent = "";
        c.mark.style.cssText = "flex:none;width:5px;height:5px;border-radius:50%;background:var(--pc)";
      } else {
        c.mark.style.cssText = "flex:none;font-family:'Space Mono',monospace;font-size:11px;color:" + (active ? "var(--pc)" : "#3E5C8C");
        c.mark.textContent = active ? "→" : "";
      }
    });
    renderDetail();
  }

  function renderDetail() {
    if (!gearDetailEl) return;
    var gears = gearsData(), shown = gearShown(), g = gears[shown], pinned = gearPinned === shown;
    var num = ("0" + (shown + 1)).slice(-2), tot = ("0" + gears.length).slice(-2);
    gearDetailEl.style.borderColor = pinned ? "var(--pc)" : "#2A4A7D";
    gearDetailEl.innerHTML = "";

    function rivet(pos) {
      var s = document.createElement("span");
      s.style.cssText = "position:absolute;width:4px;height:4px;border-radius:50%;background:#2A4A7D;" + pos;
      gearDetailEl.appendChild(s);
    }
    rivet("top:8px;left:8px"); rivet("top:8px;right:8px");
    rivet("bottom:8px;left:8px"); rivet("bottom:8px;right:8px");

    var hint = document.createElement("div");
    hint.style.cssText = "position:absolute;top:15px;right:24px;font-family:'Space Mono',monospace;font-size:10px;letter-spacing:.5px;color:#5E769B";
    hint.textContent = pinned ? "pinned · click to release" : "hover to inspect · click to pin";
    gearDetailEl.appendChild(hint);

    var inner = document.createElement("div");
    inner.className = "cog-detail-inner";
    inner.style.cssText = "display:grid;grid-template-columns:92px minmax(0,1fr);gap:26px;align-items:start;animation:viewin .35s ease both";

    var left = document.createElement("div");
    left.style.cssText = "display:flex;flex-direction:column;align-items:flex-start;gap:10px";
    var iconBox = document.createElement("div");
    iconBox.style.cssText = "width:64px;height:64px;border-radius:8px;border:1px solid #2A4A7D;display:flex;align-items:center;justify-content:center;background:rgba(15,37,71,.6);flex:none";
    var bigIcon = svgEl(30, 30, "var(--pc)", 1.4, g.icon);
    iconBox.appendChild(bigIcon);
    var pn = document.createElement("div");
    pn.style.cssText = "font-family:'Space Mono',monospace;font-size:9.5px;letter-spacing:1.5px;line-height:1.6;color:#6E86AB";
    var pna = document.createElement("div"); pna.textContent = "PART No.";
    var pnb = document.createElement("div"); pnb.style.color = "var(--pc)"; pnb.textContent = num + " / " + tot;
    pn.appendChild(pna); pn.appendChild(pnb);
    left.appendChild(iconBox); left.appendChild(pn);

    var right = document.createElement("div");
    right.style.cssText = "display:flex;flex-direction:column;gap:14px;min-width:0";
    var header = document.createElement("div");
    header.style.cssText = "display:flex;align-items:baseline;gap:12px;flex-wrap:wrap";
    var ti = document.createElement("div");
    ti.style.cssText = "font-family:'Chakra Petch',sans-serif;font-weight:600;font-size:20px;letter-spacing:.2px;color:#E8EFF9";
    ti.textContent = g.head;
    var bd = document.createElement("div");
    bd.style.cssText = "font-family:'Space Mono',monospace;font-size:10.5px;letter-spacing:.5px;color:var(--pc);border:1px solid rgba(182,209,74,.4);border-radius:5px;padding:4px 8px";
    bd.textContent = g.badge;
    header.appendChild(ti); header.appendChild(bd);
    var desc = document.createElement("p");
    desc.style.cssText = "margin:0;font-family:Barlow,sans-serif;font-size:14.5px;line-height:1.6;color:#C4D3EA;max-width:56ch";
    desc.textContent = g.desc;
    var rule = document.createElement("div");
    rule.style.cssText = "height:1px;background:#2A4A7D";
    var sp = document.createElement("div");
    sp.className = "cog-specs";
    sp.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:10px 24px";
    g.specs.forEach(function (spx) {
      var row = document.createElement("div");
      row.style.cssText = "display:flex;gap:8px;align-items:baseline;font-size:12.5px;line-height:1.4;color:#C4D3EA";
      var m = document.createElement("span");
      m.style.cssText = "color:var(--pc);font-family:'Space Mono',monospace;font-size:11px";
      m.textContent = "▸";
      var x = document.createElement("span"); x.textContent = spx;
      row.appendChild(m); row.appendChild(x); sp.appendChild(row);
    });
    right.appendChild(header); right.appendChild(desc); right.appendChild(rule); right.appendChild(sp);

    if (g.doc) {
      var docLink = document.createElement("a");
      docLink.className = "gear-doc-link";
      docLink.href = g.doc;
      docLink.textContent = "Read the " + g.title + " docs →";
      docLink.style.cssText = "margin-top:4px;font-family:'Space Mono',monospace;font-size:11.5px;letter-spacing:.3px;color:var(--pc);text-decoration:none";
      right.appendChild(docLink);
    }

    inner.appendChild(left); inner.appendChild(right);
    gearDetailEl.appendChild(inner);
  }

  // ── cycling terminal (vanilla DOM) ─────────────────────────────────────
  function termColors() {
    return { A: "var(--pc)", C: "#A9C0E2", M: "#9FB4D4", T: "#E8EFF9", G: "#6FBE8D", R: "#E8927C", GOLD: "#F5C87A" };
  }
  var _views = null;
  function termViews() {
    if (_views) return _views;
    var K = termColors();
    var pad = function (s, n) { s = String(s); return s + " ".repeat(Math.max(1, n - s.length)); };
    var rpad = function (s, n) { s = String(s); return " ".repeat(Math.max(0, n - s.length)) + s; };
    var prompt = function (cmd) { return [{ t: "$ ", c: K.A }, { t: "cogworks", c: K.C }, { t: " " + cmd, c: K.T }]; };
    var req = function (m, mc, path, st, ms) {
      var sc = st < 300 ? K.G : (st < 400 ? K.GOLD : K.R);
      return [{ t: pad(m, 7), c: mc }, { t: pad(path, 27), c: K.T }, { t: pad(st, 5), c: sc }, { t: rpad(ms, 6), c: K.M }];
    };
    var lg = function (ts, lvl, lc, msg) { return [{ t: ts + "  ", c: K.M }, { t: pad(lvl, 7), c: lc }, { t: msg, c: K.T }]; };
    var job = function (id, name, mark, mc, res) {
      var row = [{ t: "job#" + id + "  ", c: K.M }, { t: pad(name, 17), c: K.T }, { t: mark, c: mc }];
      if (res) row.push({ t: res, c: K.M });
      return row;
    };
    _views = [
      { mode: "cogworks · bootstrap", cursor: 7, lines: [
        prompt(""),
        [{ t: "starting server...", c: K.M }],
        [{ t: "✓ ", c: K.G }, { t: "database ready", c: K.T }],
        [{ t: "✓ ", c: K.G }, { t: "api running on :8090", c: K.T }],
        [{ t: "✓ ", c: K.G }, { t: "realtime listening", c: K.T }],
        [{ t: "✓ ", c: K.G }, { t: "queue worker online", c: K.T }],
        [{ t: "✓ ", c: K.G }, { t: "search index ready", c: K.T }],
        [{ t: "cogworks is running", c: K.A }]
      ] },
      { mode: "cogworks · api requests", cursor: -1, lines: [
        [{ t: "# access log", c: K.M }],
        req("GET", K.C, "/api/v1/posts", 200, "12ms"),
        req("POST", K.A, "/api/v1/auth/users/login", 200, "44ms"),
        req("GET", K.C, "/api/v1/posts/482", 200, "8ms"),
        req("PATCH", K.GOLD, "/api/v1/posts/482", 200, "19ms"),
        req("DELETE", K.R, "/api/v1/comments/91", 204, "6ms"),
        req("GET", K.C, "/api/v1/posts?search=gears", 200, "27ms")
      ] },
      { mode: "cogworks · log stream", cursor: -1, lines: [
        [{ t: "# server log", c: K.M }],
        lg("12:04:01", "info", K.C, "http listening on :8090"),
        lg("12:04:02", "info", K.C, "db pool ready (8 conns)"),
        lg("12:04:03", "warn", K.GOLD, "slow query 214ms  posts.search"),
        lg("12:04:04", "info", K.C, "cache warmed  1,204 keys"),
        lg("12:04:05", "error", K.R, "upstream timeout  webhook.send 1/3"),
        lg("12:04:06", "info", K.C, "webhook delivered  312ms")
      ] },
      { mode: "cogworks · queue workers", cursor: -1, lines: [
        [{ t: "# queue: default", c: K.M }],
        job("1284", "email.send", "✓ done   ", K.G, "82ms"),
        job("1285", "image.resize", "⟳ running", K.C, ""),
        job("1286", "webhook.deliver", "✓ done  ", K.G, "140ms"),
        job("1287", "report.build", "✓ done  ", K.G, "1.2s"),
        job("1288", "email.send", "↻ retry ", K.GOLD, "2/5"),
        [{ t: "5 workers · 0 stalled · 128 done/min", c: K.M }]
      ] },
      { mode: "cogworks · realtime events", cursor: -1, lines: [
        [{ t: "# realtime", c: K.M }],
        [{ t: "▲ ", c: K.C }, { t: pad("subscribe", 11), c: K.T }, { t: pad("posts", 14), c: K.C }, { t: "client a1f", c: K.M }],
        [{ t: "● ", c: K.A }, { t: pad("broadcast", 11), c: K.T }, { t: pad("post.created", 14), c: K.T }, { t: "→ 3 clients", c: K.M }],
        [{ t: "● ", c: K.A }, { t: pad("broadcast", 11), c: K.T }, { t: pad("post.updated", 14), c: K.T }, { t: "→ 3 clients", c: K.M }],
        [{ t: "▲ ", c: K.C }, { t: pad("subscribe", 11), c: K.T }, { t: pad("presence", 14), c: K.C }, { t: "client 9c2", c: K.M }],
        [{ t: "● ", c: K.G }, { t: pad("presence", 11), c: K.T }, { t: "2 online", c: K.T }],
        [{ t: "● ", c: K.A }, { t: pad("broadcast", 11), c: K.T }, { t: pad("comment.new", 14), c: K.T }, { t: "→ 5 clients", c: K.M }]
      ] }
    ];
    return _views;
  }

  function renderTerm() {
    var K = termColors();
    var views = termViews();
    if (termView >= views.length) termView = 0;
    var v = views[termView];
    var modeEl = document.getElementById("term-mode");
    if (modeEl) modeEl.textContent = v.mode;

    var dots = document.getElementById("term-dots");
    if (dots) {
      dots.innerHTML = "";
      dots.style.cssText = "margin-left:auto;display:flex;gap:5px;align-items:center";
      for (var i = 0; i < views.length; i++) {
        var d = document.createElement("span");
        d.style.cssText = "width:" + (i === termView ? "16px" : "6px") + ";height:6px;border-radius:3px;background:" + (i === termView ? "var(--pc)" : "rgba(169,192,226,.35)") + ";transition:width .3s, background .3s";
        dots.appendChild(d);
      }
    }

    var body = document.getElementById("term-body");
    if (!body) return;
    body.innerHTML = "";
    var wrap = document.createElement("div");
    wrap.style.cssText = "display:flex;flex-direction:column;gap:1px;animation:viewin .45s ease both";
    v.lines.forEach(function (segs, i) {
      var row = document.createElement("div");
      row.style.cssText = "opacity:0;white-space:pre;animation:tline .3s ease both " + (0.12 + i * 0.13).toFixed(2) + "s";
      segs.forEach(function (sg) {
        var s = document.createElement("span");
        s.style.color = sg.c || K.T;
        s.textContent = sg.t;
        row.appendChild(s);
      });
      if (v.cursor === i) {
        var cur = document.createElement("span");
        cur.style.cssText = "display:inline-block;width:8px;height:15px;background:" + K.C + ";vertical-align:-3px;margin-left:7px;animation:blink 1.1s steps(1) infinite";
        row.appendChild(cur);
      }
      wrap.appendChild(row);
    });
    body.appendChild(wrap);
  }

  function startTerm() {
    if (_termTimer) return;
    var n = termViews().length;
    _termTimer = setInterval(function () {
      termView = (termView + 1) % n;
      renderTerm();
    }, 4300);
  }

  // ── machine (imperative SVG — freeze + rAF drive) ──────────────────────
  function applyFreeze() {
    var base = (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    ["fig-d", "logo-d"].forEach(function (id) {
      var s = document.getElementById(id);
      var frozen = base || (s && s.__powerOff);
      if (s && s.pauseAnimations) { frozen ? s.pauseAnimations() : s.unpauseAnimations(); }
      if (s && s.__anim) { s.__anim.frozen = frozen; }
    });
  }

  function startLoop() {
    var last = null;
    function tick(ts) {
      requestAnimationFrame(tick);
      if (last === null) { last = ts; return; }
      var dt = Math.min(0.05, (ts - last) / 1000);
      last = ts;
      var svg = document.getElementById("fig-d");
      var A = svg && svg.__anim;
      if (!A || A.frozen) return;
      A.mult += (A.target - A.mult) * Math.min(1, dt * 3.5);
      A.items.forEach(function (it) {
        if (it.rate != null) {
          it.angle = (it.angle || 0) + it.rate * dt * A.mult;
          it.node.setAttribute("transform", "rotate(" + it.angle.toFixed(2) + ")");
        } else if (it.dashRate != null) {
          it.off = ((it.off || 0) - it.dashRate * dt * A.mult) % 19;
          it.node.setAttribute("stroke-dashoffset", it.off.toFixed(2));
        } else if (it.needle) {
          var deg = 120 + 45 * (A.mult - 1) + 3.5 * Math.sin(ts / 240) + 1.5 * Math.sin(ts / 97);
          it.node.setAttribute("transform", "rotate(" + deg.toFixed(2) + ")");
        } else if (it.flap) {
          var ga = (it.gear.angle || 0);
          var frac = (ga * it.Z / 360);
          frac = frac - Math.floor(frac);
          var kick = Math.sin(frac * Math.PI);
          it.node.setAttribute("transform", "rotate(" + (it.base + it.amp * kick).toFixed(2) + " " + it.px + " " + it.py + ")");
        } else if (it.pump) {
          var th = ((it.phase + (it.crank.angle || 0) + (it.aoff || 0)) * Math.PI) / 180;
          var px = it.cx + it.r * Math.cos(th), py = it.cy + it.r * Math.sin(th);
          var sl = it.cx + it.r * Math.cos(th) + Math.sqrt(it.L * it.L - Math.pow(it.r * Math.sin(th), 2));
          it.rodEl.setAttribute("x1", px.toFixed(2));
          it.rodEl.setAttribute("y1", py.toFixed(2));
          it.rodEl.setAttribute("x2", sl.toFixed(2));
          it.rodEl.setAttribute("y2", it.cy);
          it.pistEl.setAttribute("x", (sl - 3).toFixed(2));
          it.pinEl.setAttribute("cx", px.toFixed(2));
          it.pinEl.setAttribute("cy", py.toFixed(2));
        }
      });
    }
    requestAnimationFrame(tick);
  }

  function buildAll() {
    function el(name, attrs) {
      var e = document.createElementNS(NS, name);
      for (var k in attrs) e.setAttribute(k, attrs[k]);
      return e;
    }

    function gearPath(Z, m) {
      var pr = m * Z / 2, tip = pr + 0.9 * m, root = pr - 1.1 * m;
      var p = Math.PI * 2 / Z, d = "";
      for (var i = 0; i < Z; i++) {
        var A = i * p;
        var pts = [[root, A + 0.03 * p], [tip, A + 0.14 * p], [tip, A + 0.36 * p], [root, A + 0.47 * p]];
        for (var j = 0; j < 4; j++) {
          var r = pts[j][0], a = pts[j][1];
          d += (i === 0 && j === 0 ? "M" : "L") + (r * Math.cos(a)).toFixed(1) + "," + (r * Math.sin(a)).toFixed(1);
        }
      }
      return d + "Z";
    }

    function drawGear(svg, before, o) {
      var outer = el("g", { transform: "translate(" + o.x + " " + o.y + ") rotate(" + (o.phase || 0).toFixed(1) + ")" });
      var inner = el("g", {});
      inner.appendChild(el("path", { d: gearPath(o.Z, o.m), fill: "none", stroke: o.c, "stroke-width": o.w, "stroke-linejoin": "round" }));
      if (o.rim) inner.appendChild(el("circle", { r: o.rim, fill: "none", stroke: o.c, "stroke-width": o.w }));
      inner.appendChild(el("circle", { r: o.hub, fill: "none", stroke: o.c, "stroke-width": o.w }));
      if (o.spokesN) {
        var to = o.rim ? o.rim : (o.m * o.Z / 2 - 1.1 * o.m - 3);
        for (var s = 0; s < o.spokesN; s++) {
          var a = s * Math.PI * 2 / o.spokesN;
          inner.appendChild(el("line", {
            x1: (o.hub * Math.cos(a)).toFixed(1), y1: (o.hub * Math.sin(a)).toFixed(1),
            x2: (to * Math.cos(a)).toFixed(1), y2: (to * Math.sin(a)).toFixed(1),
            stroke: o.c, "stroke-width": o.w
          }));
        }
      }
      if (o.holes) {
        for (var hh = 0; hh < o.holes.n; hh++) {
          var ha = hh * Math.PI * 2 / o.holes.n;
          inner.appendChild(el("circle", {
            cx: (o.holes.at * Math.cos(ha)).toFixed(1), cy: (o.holes.at * Math.sin(ha)).toFixed(1),
            r: o.holes.r, fill: "none", stroke: o.c, "stroke-width": o.w
          }));
        }
      }
      inner.appendChild(el("circle", { r: 1.8, fill: o.c }));
      if (o.dur && o.anim) {
        o.anim.push({ node: inner, rate: o.dir * 360 / o.dur });
      } else if (o.dur) {
        inner.appendChild(el("animateTransform", {
          attributeName: "transform", type: "rotate",
          from: "0", to: String(o.dir * 360), dur: o.dur + "s", repeatCount: "indefinite"
        }));
      }
      outer.appendChild(inner);
      if (before) svg.insertBefore(outer, before); else svg.appendChild(outer);
      return o;
    }

    function mesh(svg, before, p, Z, angDeg, extra) {
      var t = angDeg * Math.PI / 180, dist = p.m * (p.Z + Z) / 2;
      var o = {
        Z: Z, m: p.m, anim: p.anim,
        x: +(p.x + dist * Math.cos(t)).toFixed(1),
        y: +(p.y + dist * Math.sin(t)).toFixed(1),
        dur: p.dur ? +(p.dur * Z / p.Z).toFixed(1) : 0, dir: -p.dir,
        phase: -p.phase * (p.Z / Z) + (1 + p.Z / Z) * angDeg + 180 / Z,
        c: p.c, w: p.w, hub: 6
      };
      for (var k in extra) o[k] = extra[k];
      return drawGear(svg, before, o);
    }

    function beltPath(x1, y1, r1, x2, y2, r2) {
      var a = Math.atan2(y2 - y1, x2 - x1), d = Math.hypot(x2 - x1, y2 - y1);
      var th = Math.acos((r1 - r2) / d), n1 = a + th, n2 = a - th, TWO = Math.PI * 2;
      function pt(x, y, r, n) { return (x + r * Math.cos(n)).toFixed(1) + "," + (y + r * Math.sin(n)).toFixed(1); }
      function arc(r, s, e, must) {
        function norm(v) { v = v % TWO; return v < 0 ? v + TWO : v; }
        var delta = norm(e - s), m = norm(must - s), sweep, large;
        if (m <= delta) { sweep = 1; large = delta > Math.PI ? 1 : 0; }
        else { sweep = 0; large = (TWO - delta) > Math.PI ? 1 : 0; }
        return "A" + r + " " + r + " 0 " + large + " " + sweep + " ";
      }
      return "M" + pt(x1, y1, r1, n1) + " L" + pt(x2, y2, r2, n1) + " " + arc(r2, n1, n2, a) + pt(x2, y2, r2, n2) +
             " L" + pt(x1, y1, r1, n2) + " " + arc(r1, n2, n1, a + Math.PI) + pt(x1, y1, r1, n1) + " Z";
    }

    function belt(group, x1, y1, r1, x2, y2, r2, color, dur, anim) {
      var p = el("path", { d: beltPath(x1, y1, r1, x2, y2, r2), fill: "none", stroke: color, "stroke-width": 2, "stroke-dasharray": "5 4.5" });
      if (anim) {
        anim.push({ node: p, dashRate: 19 / parseFloat(dur) });
      } else {
        p.appendChild(el("animate", { attributeName: "stroke-dashoffset", from: "0", to: "-19", dur: dur, repeatCount: "indefinite" }));
      }
      group.appendChild(p);
    }

    function pulley(group, bg, c, x, y, r, rin, dur, anim) {
      group.appendChild(el("circle", { cx: x, cy: y, r: r, fill: bg, stroke: c, "stroke-width": 1.2 }));
      group.appendChild(el("circle", { cx: x, cy: y, r: rin, fill: "none", stroke: c, "stroke-width": 1.2 }));
      var g = el("g", { transform: "translate(" + x + " " + y + ")" });
      var inner = el("g", {});
      inner.appendChild(el("line", { x1: -(r - 2), y1: 0, x2: r - 2, y2: 0, stroke: c, "stroke-width": 1.2 }));
      if (anim) {
        anim.push({ node: inner, rate: -360 / dur });
      } else {
        inner.appendChild(el("animateTransform", {
          attributeName: "transform", type: "rotate",
          from: "0", to: "-360", dur: dur + "s", repeatCount: "indefinite"
        }));
      }
      g.appendChild(inner);
      group.appendChild(g);
    }

    function frame(svg, c, boxed) {
      var g = el("g", { stroke: c, "stroke-width": 1, fill: "none" });
      if (!boxed) g.appendChild(el("line", { x1: 40, y1: 336, x2: 236, y2: 336 }));
      var hy = boxed ? 342 : 336;
      for (var x = 48; x <= 224; x += 16) {
        g.appendChild(el("line", { x1: x, y1: hy, x2: x - 7, y2: hy + 8 }));
      }
      g.appendChild(el("line", { x1: 86, y1: 268, x2: 86, y2: 336 }));
      g.appendChild(el("line", { x1: 98, y1: 268, x2: 98, y2: 336 }));
      g.appendChild(el("line", { x1: 191, y1: 318, x2: 207, y2: 318 }));
      g.appendChild(el("polyline", { points: "199,318 204,321 194,324 204,327 199,330" }));
      g.appendChild(el("rect", { x: 187, y: 330, width: 24, height: 6 }));
      if (boxed) {
        g.appendChild(el("rect", { x: 240, y: 48, width: 24, height: 5 }));
        g.appendChild(el("line", { x1: 248, y1: 53, x2: 248, y2: 84 }));
        g.appendChild(el("line", { x1: 256, y1: 53, x2: 256, y2: 84 }));
      } else {
        g.appendChild(el("line", { x1: 234, y1: 48, x2: 270, y2: 48 }));
        [238, 248, 258, 268].forEach(function (hx) {
          g.appendChild(el("line", { x1: hx, y1: 48, x2: hx - 6, y2: 42 }));
        });
        g.appendChild(el("line", { x1: 248, y1: 48, x2: 248, y2: 62 }));
        g.appendChild(el("line", { x1: 256, y1: 48, x2: 256, y2: 62 }));
      }
      svg.appendChild(g);
    }

    function caseBox(svg, C) {
      var g = el("g", { stroke: C.frame, "stroke-width": 1.2, fill: "none" });
      g.appendChild(el("path", { d: "M10,342 L10,48 Q10,42 16,42 L296,42 Q302,42 302,48 L302,302" }));
      g.appendChild(el("path", { d: "M16,336 L16,52 Q16,48 20,48 L292,48 Q296,48 296,52 L296,302" }));
      g.appendChild(el("line", { x1: 296, y1: 302, x2: 302, y2: 302 }));
      g.appendChild(el("line", { x1: 16, y1: 336, x2: 235, y2: 336 }));
      g.appendChild(el("line", { x1: 10, y1: 342, x2: 235, y2: 342 }));
      g.appendChild(el("line", { x1: 235, y1: 336, x2: 235, y2: 342 }));
      var hg = el("g", { stroke: C.frame, "stroke-width": 0.55 });
      var i;
      for (i = 26; i <= 286; i += 16) hg.appendChild(el("line", { x1: i, y1: 48, x2: i + 6, y2: 42 }));
      for (i = 56; i <= 328; i += 16) hg.appendChild(el("line", { x1: 16, y1: i, x2: 10, y2: i + 6 }));
      for (i = 56; i <= 294; i += 16) hg.appendChild(el("line", { x1: 296, y1: i, x2: 302, y2: i - 6 }));
      for (i = 28; i <= 228; i += 16) hg.appendChild(el("line", { x1: i, y1: 336, x2: i - 6, y2: 342 }));
      g.appendChild(hg);
      [[24, 56], [288, 56], [24, 328], [288, 294]].forEach(function (b) {
        g.appendChild(el("circle", { cx: b[0], cy: b[1], r: 2, "stroke-width": 0.8 }));
      });
      var bp = el("g", { transform: "translate(-80 230)" });
      function btxt(x, y, str, size, anchor, family, spacing) {
        var e = el("text", { x: x, y: y, "text-anchor": anchor || "start", fill: C.ink, "font-size": size, "letter-spacing": spacing != null ? spacing : 0.5, "font-family": family || "'IBM Plex Mono',monospace", stroke: "none" });
        e.textContent = str;
        return e;
      }
      bp.appendChild(el("rect", { x: 104, y: 54, width: 104, height: 46, rx: 4.5, fill: C.frame, "fill-opacity": 0.22, stroke: C.gear, "stroke-width": 2 }));
      bp.appendChild(el("rect", { x: 107, y: 57, width: 98, height: 40, rx: 1.5, fill: "none", stroke: C.frame, "stroke-width": 0.5 }));
      bp.appendChild(btxt(156, 70.5, "cogworks", 10.5, "middle", "Archivo,sans-serif", 1.2));
      bp.appendChild(el("line", { x1: 107, y1: 75, x2: 205, y2: 75, stroke: C.gear, "stroke-width": 0.6 }));
      bp.appendChild(btxt(114, 83.5, "mfg no. 8090", 5));
      bp.appendChild(btxt(198, 83.5, "ver 0.1.0", 5, "end"));
      bp.appendChild(el("line", { x1: 107, y1: 87.5, x2: 205, y2: 87.5, stroke: C.gear, "stroke-width": 0.6 }));
      bp.appendChild(btxt(114, 95.5, "single binary", 5));
      bp.appendChild(btxt(198, 95.5, "gears 12", 5, "end"));
      [[109.5, 60], [202.5, 60], [109.5, 94], [202.5, 94]].forEach(function (rv) {
        bp.appendChild(el("circle", { cx: rv[0], cy: rv[1], r: 1.3, fill: C.gear, stroke: "none" }));
        bp.appendChild(el("circle", { cx: rv[0], cy: rv[1], r: 2, fill: "none", stroke: C.gear, "stroke-width": 0.4 }));
      });
      g.appendChild(bp);
      svg.appendChild(g);
    }

    function gauge(svg, C, x, y, r, anim) {
      var g = el("g", {});
      g.appendChild(el("path", { d: "M" + x + "," + (y + r) + " L" + x + "," + (y + r + 38) + " Q" + x + "," + (y + r + 47) + " " + (x + 3) + "," + (y + r + 51), fill: "none", stroke: C.frame, "stroke-width": 1 }));
      g.appendChild(el("circle", { cx: x, cy: y, r: r, fill: C.bg, stroke: C.gear, "stroke-width": 1.2 }));
      g.appendChild(el("circle", { cx: x, cy: y, r: r - 3.5, fill: "none", stroke: C.frame, "stroke-width": 0.8 }));
      function pol(rad, deg) {
        var t = deg * Math.PI / 180;
        return [(x + rad * Math.cos(t)).toFixed(1), (y + rad * Math.sin(t)).toFixed(1)];
      }
      var z1 = pol(r - 6, 365), z2 = pol(r - 6, 405);
      g.appendChild(el("path", { d: "M" + z1.join(",") + " A" + (r - 6) + " " + (r - 6) + " 0 0 1 " + z2.join(","), fill: "none", stroke: C.belt2, "stroke-width": 2 }));
      for (var i = 0; i <= 9; i++) {
        var ang = 135 + i * 30, big = i % 3 === 0;
        var a1 = pol(r - 3.5, ang), a2 = pol(r - (big ? 9.5 : 7), ang);
        g.appendChild(el("line", { x1: a1[0], y1: a1[1], x2: a2[0], y2: a2[1], stroke: C.gear, "stroke-width": big ? 1.1 : 0.7 }));
      }
      var lbl = el("text", { x: x, y: y + r * 0.55, "text-anchor": "middle", fill: C.ink, "font-size": 7, "letter-spacing": 1, "font-family": "'IBM Plex Mono',monospace" });
      lbl.textContent = "rpm";
      g.appendChild(lbl);
      var ng = el("g", { transform: "translate(" + x + " " + y + ")" });
      var ni = el("g", {});
      var nd = el("line", { x1: 0, y1: 0, x2: ((r - 8) * Math.cos(135 * Math.PI / 180)).toFixed(1), y2: ((r - 8) * Math.sin(135 * Math.PI / 180)).toFixed(1), stroke: C.belt2, "stroke-width": 1.4, "stroke-linecap": "round" });
      ni.appendChild(nd);
      if (anim) {
        anim.push({ node: ni, needle: true });
      } else {
        ni.appendChild(el("animateTransform", {
          attributeName: "transform", type: "rotate",
          values: "0;212;198;224;205;216;208;212;0",
          keyTimes: "0;.16;.3;.44;.58;.7;.82;.94;1",
          dur: "11s", repeatCount: "indefinite"
        }));
      }
      ng.appendChild(ni);
      g.appendChild(ng);
      g.appendChild(el("circle", { cx: x, cy: y, r: 2, fill: C.gear }));
      svg.appendChild(g);
    }

    function led(svg, x, y, color, dur, offset, scale) {
      scale = scale || 1;
      var g = el("g", {});
      var halo = el("circle", { cx: x, cy: y, r: 3.6 * scale, fill: color, opacity: 0.22 });
      halo.appendChild(el("animate", { attributeName: "opacity", values: "0.3;0.3;0.04;0.3", keyTimes: "0;0.4;0.56;1", dur: dur + "s", begin: offset + "s", repeatCount: "indefinite" }));
      var core = el("circle", { cx: x, cy: y, r: 1.9 * scale, fill: color });
      core.appendChild(el("animate", { attributeName: "opacity", values: "1;1;0.18;1", keyTimes: "0;0.4;0.56;1", dur: dur + "s", begin: offset + "s", repeatCount: "indefinite" }));
      g.appendChild(halo);
      g.appendChild(core);
      svg.appendChild(g);
    }

    function controlUnit(svg, C, opt) {
      var w = opt.w, h = opt.h, x = opt.cx - w / 2, y = opt.top;
      var g = el("g", {});
      g.appendChild(el("line", { x1: opt.cx - 13, y1: y + h, x2: opt.cx - 13, y2: 42, stroke: C.frame, "stroke-width": 1 }));
      g.appendChild(el("line", { x1: opt.cx + 13, y1: y + h, x2: opt.cx + 13, y2: 42, stroke: C.frame, "stroke-width": 1 }));
      g.appendChild(el("rect", { x: x, y: y, width: w, height: h, rx: 4, fill: C.bg, stroke: C.frame, "stroke-width": 1.2 }));
      g.appendChild(el("rect", { x: x + 3, y: y + 3, width: w - 6, height: h - 6, rx: 2, fill: "none", stroke: C.frame, "stroke-width": 0.5, opacity: 0.55 }));
      g.appendChild(el("circle", { cx: x + 4.5, cy: y + 4.5, r: 1, fill: C.gear }));
      g.appendChild(el("circle", { cx: x + w - 4.5, cy: y + 4.5, r: 1, fill: C.gear }));
      var sled = el("circle", { cx: x + w - 8, cy: y + h - 6, r: 1.9, fill: C.belt2 });
      sled.appendChild(el("animate", { attributeName: "opacity", values: "1;1;0.2;1", keyTimes: "0;0.4;0.56;1", dur: (opt.kind === "mcp" ? "1.7s" : "2.3s"), begin: (opt.kind === "mcp" ? "0.3s" : "0s"), repeatCount: "indefinite" }));
      g.appendChild(sled);
      var sx = x + 6, sy = y + 5, sw = w - 12, sh = h - 17;
      g.appendChild(el("rect", { x: sx, y: sy, width: sw, height: sh, rx: 1.5, fill: "none", stroke: C.gear, "stroke-width": 0.9 }));
      if (opt.kind === "admin") {
        g.appendChild(el("line", { x1: sx + 3, y1: sy + 4.5, x2: sx + sw * 0.5, y2: sy + 4.5, stroke: C.gear, "stroke-width": 1 }));
        g.appendChild(el("line", { x1: sx + 3, y1: sy + 8.5, x2: sx + sw - 3, y2: sy + 8.5, stroke: C.frame, "stroke-width": 0.7 }));
        g.appendChild(el("line", { x1: sx + 3, y1: sy + 12, x2: sx + sw * 0.66, y2: sy + 12, stroke: C.frame, "stroke-width": 0.7 }));
        [0, 1, 2].forEach(function (i) {
          g.appendChild(el("line", { x1: sx + sw - 11 + i * 4, y1: sy + sh - 3, x2: sx + sw - 11 + i * 4, y2: sy + sh - 3 - (3.5 + i * 2), stroke: C.belt2, "stroke-width": 1.4 }));
        });
      } else {
        var mx = sx + sw * 0.42, my = sy + sh / 2;
        [[mx + sw * 0.34, my - 5], [mx + sw * 0.4, my], [mx + sw * 0.34, my + 5]].forEach(function (n) {
          g.appendChild(el("line", { x1: mx, y1: my, x2: n[0], y2: n[1], stroke: C.frame, "stroke-width": 0.7 }));
          g.appendChild(el("circle", { cx: n[0], cy: n[1], r: 1.5, fill: "none", stroke: C.gear, "stroke-width": 0.9 }));
        });
        g.appendChild(el("circle", { cx: mx, cy: my, r: 2.6, fill: "none", stroke: C.belt2, "stroke-width": 1.1 }));
        g.appendChild(el("circle", { cx: mx, cy: my, r: 0.9, fill: C.belt2 }));
      }
      var t = el("text", { x: opt.cx, y: y + h - 4.5, "text-anchor": "middle", fill: C.belt2, "font-size": 6.5, "letter-spacing": 1.5, "font-family": "'IBM Plex Mono',monospace" });
      t.textContent = opt.label;
      g.appendChild(t);
      svg.appendChild(g);
    }

    function powerLever(svg, C) {
      var px = 306, py = 150, len = 17, onDeg = -52, offDeg = 52;
      var g = el("g", {});
      g.setAttribute("style", "cursor:pointer");
      g.appendChild(el("line", { x1: 296, y1: 150, x2: 300, y2: 150, stroke: C.frame, "stroke-width": 1 }));
      g.appendChild(el("rect", { x: 299, y: 137, width: 13, height: 26, rx: 2, fill: C.bg, stroke: C.frame, "stroke-width": 1 }));
      g.appendChild(el("line", { x1: 309, y1: 140.5, x2: 312.5, y2: 140.5, stroke: C.gear, "stroke-width": 0.7 }));
      g.appendChild(el("line", { x1: 309, y1: 159.5, x2: 312.5, y2: 159.5, stroke: C.gear, "stroke-width": 0.7 }));
      var lbl = el("text", { x: 305.5, y: 172, "text-anchor": "middle", fill: C.ink, "font-size": 5, "letter-spacing": 0.5, "font-family": "'IBM Plex Mono',monospace" });
      lbl.textContent = "pwr";
      g.appendChild(lbl);
      g.appendChild(el("circle", { cx: px, cy: py, r: 2.4, fill: "none", stroke: C.gear, "stroke-width": 1 }));
      var hg = el("g", { transform: "rotate(" + onDeg + " " + px + " " + py + ")" });
      hg.appendChild(el("line", { x1: px, y1: py, x2: px + len, y2: py, stroke: C.belt2, "stroke-width": 2.2, "stroke-linecap": "round" }));
      var knob = el("circle", { cx: px + len, cy: py, r: 3.2, fill: C.bg, stroke: C.belt2, "stroke-width": 1.8 });
      hg.appendChild(knob);
      g.appendChild(hg);
      svg.appendChild(g);
      svg.__lever = { on: true };
      g.addEventListener("click", function () {
        var on = !svg.__lever.on;
        svg.__lever.on = on;
        hg.setAttribute("transform", "rotate(" + (on ? onDeg : offDeg) + " " + px + " " + py + ")");
        knob.setAttribute("stroke", on ? C.belt2 : "#7C8CA6");
        svg.__powerOff = !on;
        applyFreeze();
      });
    }

    function machine(id, C) {
      var svg = document.getElementById(id);
      if (!svg || svg.dataset.built) return;
      svg.dataset.built = "1";
      var anim = C.js ? [] : null;
      frame(svg, C.frame, C.boxed);
      if (C.boxed) caseBox(svg, C);
      var belts = el("g", {});
      svg.appendChild(belts);
      var G1 = drawGear(svg, belts, { Z: 36, m: 3.4, x: 92, y: 208, dur: 54, dir: 1, phase: 0, c: C.fly, w: 1.5, hub: 12, rim: 52, spokesN: 6, anim: anim });
      var G2 = mesh(svg, belts, G1, 18, -25, { hub: 5, c: C.gear, w: 1.2 });
      var G3 = mesh(svg, belts, G2, 12, 55, { hub: 4 });
      var g3item = anim ? anim[anim.length - 1] : null;
      var G4 = mesh(svg, belts, G3, 24, 95, { hub: 6, holes: { n: 5, r: 5.5, at: 24 } });
      var g4item = anim ? anim[anim.length - 1] : null;
      var pulleys = el("g", {});
      svg.appendChild(pulleys);
      pulley(pulleys, C.bg, C.pul, 175.2, 169.2, 10, 3.5, 27, anim);
      pulley(pulleys, C.bg, C.pul, 252, 100, 16, 4, 43.2, anim);
      pulley(pulleys, C.bg, C.pul, 150, 100, 14, 4, 38, anim);
      pulley(pulleys, C.bg, C.pul, 199.2, 272, 9, 3, 36, anim);
      pulley(pulleys, C.bg, C.pul, 272, 352, 9, 3, 36, anim);
      belt(belts, 175.2, 169.2, 10, 252, 100, 16, C.belt1, "1.6s", anim);
      belt(belts, 150, 100, 14, 252, 100, 16, C.belt1, "1.5s", anim);
      belt(belts, 199.2, 272, 9, 272, 352, 9, C.belt2, "1.3s", anim);
      var out = el("g", {});
      out.appendChild(el("line", { x1: 272, y1: 361, x2: 272, y2: 368, stroke: C.frame, "stroke-width": 1 }));
      out.appendChild(el("rect", { x: 224, y: 368, width: 96, height: 26, rx: 5, fill: C.bg, stroke: C.belt2, "stroke-width": 1.3 }));
      out.appendChild(el("rect", { x: 227.5, y: 371.5, width: 89, height: 19, rx: 3, fill: "none", stroke: C.belt2, "stroke-width": 0.6, opacity: 0.5 }));
      [[231.5, 375.5], [312.5, 375.5], [231.5, 386.5], [312.5, 386.5]].forEach(function (b) {
        out.appendChild(el("circle", { cx: b[0], cy: b[1], r: 1.1, fill: "none", stroke: C.belt2, "stroke-width": 0.7 }));
      });
      var t = el("text", { x: 272, y: 385, "text-anchor": "middle", fill: C.belt2, "font-size": 12, "letter-spacing": 2, "font-family": "'IBM Plex Mono',monospace" });
      t.textContent = "your app";
      out.appendChild(t);
      svg.appendChild(out);
      if (C.gauge) gauge(svg, C, 46, 88, 24, anim);
      if (C.control) {
        belt(belts, 84, 40, 4, 84, 157, 7, C.belt2, "1.6s", anim);
        belt(belts, 246, 40, 4, 252, 100, 16, C.belt2, "1.7s", anim);
        pulley(pulleys, C.bg, C.pul, 84, 40, 4, 1.6, 28, anim);
        pulley(pulleys, C.bg, C.pul, 84, 157, 7, 2.6, 30, anim);
        pulley(pulleys, C.bg, C.pul, 246, 40, 4, 1.6, 28, anim);
        [84, 246].forEach(function (bx) {
          svg.appendChild(el("rect", { x: bx - 5, y: 41, width: 10, height: 5, rx: 1, fill: C.bg, stroke: C.frame, "stroke-width": 1 }));
        });
        controlUnit(svg, C, { cx: 84, top: 2, w: 66, h: 32, label: "admin ui", kind: "admin" });
        controlUnit(svg, C, { cx: 246, top: 2, w: 66, h: 32, label: "mcp", kind: "mcp" });
        svg.appendChild(el("rect", { x: 104, y: 55, width: 56, height: 21, rx: 3, fill: C.bg, stroke: C.frame, "stroke-width": 0.9 }));
        svg.appendChild(el("rect", { x: 110, y: 59.5, width: 6, height: 12, rx: 2, fill: "none", stroke: C.gear, "stroke-width": 0.8 }));
        svg.appendChild(el("line", { x1: 113, y1: 66, x2: 113, y2: 61, stroke: C.belt2, "stroke-width": 1.6, "stroke-linecap": "round" }));
        svg.appendChild(el("circle", { cx: 113, cy: 60.5, r: 1.6, fill: C.belt2 }));
        svg.appendChild(el("rect", { x: 120, y: 59.5, width: 6, height: 12, rx: 2, fill: "none", stroke: C.gear, "stroke-width": 0.8 }));
        svg.appendChild(el("line", { x1: 123, y1: 65, x2: 123, y2: 70, stroke: "#7C8CA6", "stroke-width": 1.6, "stroke-linecap": "round" }));
        svg.appendChild(el("circle", { cx: 123, cy: 70.5, r: 1.6, fill: "#7C8CA6" }));
        svg.appendChild(el("circle", { cx: 145, cy: 65.5, r: 7, fill: "none", stroke: C.gear, "stroke-width": 0.9 }));
        [-60, 0, 60].forEach(function (a) { var tt = a * Math.PI / 180; svg.appendChild(el("line", { x1: (145 + 8.6 * Math.cos(tt)).toFixed(1), y1: (65.5 + 8.6 * Math.sin(tt)).toFixed(1), x2: (145 + 7 * Math.cos(tt)).toFixed(1), y2: (65.5 + 7 * Math.sin(tt)).toFixed(1), stroke: C.gear, "stroke-width": 0.7 })); });
        svg.appendChild(el("line", { x1: 145, y1: 65.5, x2: 140.6, y2: 62.5, stroke: C.belt2, "stroke-width": 1.4, "stroke-linecap": "round" }));
        svg.appendChild(el("circle", { cx: 145, cy: 65.5, r: 1.3, fill: C.belt2 }));
        svg.appendChild(el("rect", { x: 168, y: 58, width: 46, height: 15, rx: 2, fill: C.bg, stroke: C.frame, "stroke-width": 0.8 }));
        led(svg, 178, 65.5, "#6FBE8D", 2.3, 0, 1.3);
        led(svg, 191, 65.5, C.belt2, 1.6, 0.5, 1.3);
        led(svg, 204, 65.5, "#6FBE8D", 2.9, 1.1, 1.3);
        powerLever(svg, C);
      }
      if (C.pump && anim && g3item) {
        var pg = el("g", { transform: "rotate(-40 204.5 211)" });
        pg.appendChild(el("line", { x1: 238, y1: 201, x2: 278, y2: 201, stroke: C.frame, "stroke-width": 1.2 }));
        pg.appendChild(el("line", { x1: 238, y1: 221, x2: 278, y2: 221, stroke: C.frame, "stroke-width": 1.2 }));
        pg.appendChild(el("line", { x1: 278, y1: 201, x2: 278, y2: 221, stroke: C.frame, "stroke-width": 1.4 }));
        pg.appendChild(el("line", { x1: 278, y1: 205, x2: 283, y2: 205, stroke: C.frame, "stroke-width": 0.9 }));
        pg.appendChild(el("line", { x1: 278, y1: 211, x2: 284, y2: 211, stroke: C.frame, "stroke-width": 0.9 }));
        pg.appendChild(el("line", { x1: 278, y1: 217, x2: 283, y2: 217, stroke: C.frame, "stroke-width": 0.9 }));
        var rod = el("line", { stroke: C.fly, "stroke-width": 1.6, "stroke-linecap": "round" });
        var pist = el("rect", { y: 203.5, width: 12, height: 15, rx: 1.5, fill: C.bg, stroke: C.fly, "stroke-width": 1.6 });
        var pin = el("circle", { r: 2, fill: C.fly });
        pg.appendChild(rod);
        pg.appendChild(pist);
        pg.appendChild(pin);
        svg.appendChild(pg);
        anim.push({ pump: true, crank: g3item, phase: G3.phase, cx: 204.5, cy: 211, r: 11, L: 50, aoff: 40, rodEl: rod, pistEl: pist, pinEl: pin });
      }
      if (C.control && anim && g4item) {
        var fpx = 263, fpy = 272, flen = 22;
        var fg = el("g", { transform: "rotate(0 " + fpx + " " + fpy + ")" });
        fg.appendChild(el("line", { x1: fpx, y1: fpy, x2: fpx - flen, y2: fpy, stroke: C.gear, "stroke-width": 1.5, "stroke-linecap": "round" }));
        fg.appendChild(el("rect", { x: fpx - flen - 2, y: fpy - 6, width: 5.5, height: 12, rx: 1, fill: C.bg, stroke: C.belt2, "stroke-width": 1.3 }));
        svg.appendChild(fg);
        svg.appendChild(el("line", { x1: fpx + 7, y1: fpy, x2: fpx, y2: fpy, stroke: C.frame, "stroke-width": 1 }));
        svg.appendChild(el("circle", { cx: fpx, cy: fpy, r: 2.2, fill: C.bg, stroke: C.gear, "stroke-width": 1 }));
        anim.push({ flap: true, gear: g4item, Z: 24, node: fg, px: fpx, py: fpy, base: 0, amp: -9 });
      }
      if (anim) {
        svg.__anim = { items: anim, mult: 1.6, target: 1.6, frozen: false };
        svg.addEventListener("mouseenter", function () { svg.__anim.target = 5; });
        svg.addEventListener("mouseleave", function () { svg.__anim.target = 1.6; });
      }
    }

    function logo(id, c) {
      var svg = document.getElementById(id);
      if (!svg || svg.dataset.built) return;
      svg.dataset.built = "1";
      var G1 = drawGear(svg, null, { Z: 10, m: 2.2, x: -6, y: 1, dur: 26, dir: 1, phase: 0, c: c, w: 1.3, hub: 4, spokesN: 4 });
      mesh(svg, null, G1, 7, -28, { hub: 3, w: 1.3 });
    }

    // Cyanotype palette; belt2 = the primary token (#B6D14A).
    machine("fig-d", { frame: "#52709F", gear: "#A9C0E2", fly: "#FFFFFF", belt1: "#7E97BE", belt2: "#B6D14A", pul: "#A9C0E2", ink: "#E8EFF9", bg: "#17335C", gauge: true, js: true, boxed: true, pump: true, control: true });
    logo("logo-d", "#E8EFF9");
  }

  // ── boot ───────────────────────────────────────────────────────────────
  function boot() {
    buildAll();
    applyFreeze();
    startLoop();
    buildGears();
    renderTerm();
    startTerm();
    var mq = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)");
    if (mq && mq.addEventListener) mq.addEventListener("change", applyFreeze);
  }

  if (document.readyState !== "loading") boot();
  else document.addEventListener("DOMContentLoaded", boot);
})();
