/**
 * The portal page: one HTML document with a small vanilla-JS app. Plain divs carry the text so
 * the accessibility tree reads as the recorded one (generic text, buttons, links); the data comes
 * from the portal JSON endpoints, called one after another so their order is stable.
 */

const CLIENT = String.raw`
(function () {
  var base = "/v1/billing_portal/sessions/" + document.body.dataset.session;
  var main = document.getElementById("main");
  var tip = document.getElementById("tip");
  var st = { subs: [], pms: [], plans: null, selected: null, preview: null, open: null };

  function get(path) {
    return fetch(base + path).then(function (r) { return r.json(); });
  }
  function post(path, body) {
    return fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then(function (r) { return r.json(); });
  }
  function el(tag, props) {
    var node = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) {
      if (k === "onclick") node.addEventListener("click", function (e) { e.preventDefault(); props[k](); });
      else if (k === "disabled") node.disabled = props[k];
      else node.setAttribute(k, props[k]);
    });
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c === null || c === undefined) continue;
      node.append(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return node;
  }
  function div() {
    return el.apply(null, ["div", null].concat([].slice.call(arguments)));
  }
  function svg(hidden) {
    var s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("width", "12");
    s.setAttribute("height", "12");
    s.setAttribute("viewBox", "0 0 12 12");
    if (hidden) s.setAttribute("aria-hidden", "true");
    var c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    c.setAttribute("cx", "6");
    c.setAttribute("cy", "6");
    c.setAttribute("r", "5");
    s.append(c);
    return s;
  }
  function button(name, onclick, disabled) {
    return el("button", { type: "button", onclick: onclick, disabled: !!disabled }, name);
  }
  function link(name, href, onclick) {
    return el("a", { href: href, onclick: onclick }, name);
  }
  function show(nodes) {
    tip.hidden = true;
    main.replaceChildren.apply(main, nodes.filter(function (n) { return n; }));
  }
  function sub() {
    return st.subs[0];
  }

  function loadHome(withSession) {
    // Leave the previous screen at once, as the real portal does, so nothing of it is captured.
    show([]);
    var first = withSession ? get("") : Promise.resolve(null);
    return first
      .then(function () { return get("/customer"); })
      .then(function () { return get("/subscriptions"); })
      .then(function (r) { st.subs = r.data; return get("/payment_methods"); })
      .then(function (r) { st.pms = r.data; st.open = null; renderHome(); });
  }

  function details(u) {
    var rows = [];
    u.groups.forEach(function (g) {
      rows.push(div(g.range));
      g.lines.forEach(function (l) { rows.push(div(div(l.label), div(l.amount))); });
    });
    rows.push(div(div("Subtotal"), div(u.subtotal)));
    u.discounts.forEach(function (d) { rows.push(div(div(d.label), div(d.amount))); });
    rows.push(div(div("Total"), div(u.total)));
    return el.apply(null, ["div", { class: "details" }].concat(rows));
  }

  function renderHome() {
    var s = sub();
    var nodes = [];
    if (s) {
      var u = s.upcoming;
      var open = st.open === null ? u.open : st.open;
      nodes.push(
        div("Current subscription"),
        s.cancels ? div("Cancels " + s.cancels) : null,
        div(s.plan),
        div(s.amount + " " + s.per),
        s.cancels
          ? div("Your service will end on " + s.next_billing_date + ".")
          : div("Your next billing date is " + s.next_billing_date + "."),
      );
      if (u.show && !s.cancels) {
        nodes.push(
          div("Your next estimated payment will be " + u.amount_due),
          button(open ? "Hide details" : "View details", function () {
            st.open = !open;
            renderHome();
          }),
          open ? details(u) : null,
        );
      }
      nodes.push(link("Update subscription", "#update", openPlans));
      if (s.cancels) nodes.push(link("Don't cancel subscription", "#renew", openRenew));
      else if (s.cancel_enabled) nodes.push(link("Cancel subscription", "#cancel", openCancel));
    }
    nodes.push(div("Payment method"));
    st.pms.forEach(function (p) {
      nodes.push(
        div(p.label),
        div("Expires " + p.expires),
        p.default ? div("Default") : null,
        button("Delete", function () {}, p.default),
      );
    });
    nodes.push(link("Add payment method", "#add-payment-method", function () {}));
    show(nodes);
  }

  function openPlans() {
    return get("/subscriptions/" + sub().id).then(function (r) {
      st.plans = r;
      st.selected = r.current_price;
      renderPlans();
    });
  }

  function crumbs(current) {
    var nodes = [button("Billing", function () { loadHome(false); })];
    if (current === "confirm") nodes.push(button("Subscriptions", openPlans));
    else nodes.push(div("Subscriptions"));
    return nodes;
  }

  function renderPlans() {
    var p = st.plans;
    var nodes = crumbs("plans").concat([div("Update your subscription")]);
    var chosen = null;
    p.plans.forEach(function (plan) {
      if (plan.price === st.selected) chosen = plan;
      nodes.push(
        plan.current ? div("Current subscription") : null,
        div(plan.name),
        div(plan.amount + " " + plan.per),
        plan.price === st.selected
          ? div("Selected")
          : button("Select", function () {
              st.selected = plan.price;
              renderPlans();
            }),
      );
    });
    nodes.push(
      div("Subtotal"),
      div(chosen ? chosen.amount + " " + chosen.per : ""),
      button("Continue", openConfirm, st.selected === p.current_price),
    );
    show(nodes);
  }

  function openConfirm() {
    var price = st.selected;
    return get("/subscriptions/" + sub().id)
      .then(function (r) { st.plans = r; return get("/customer"); })
      .then(function () {
        return get("/update_preview?subscription=" + encodeURIComponent(sub().id) +
          "&price=" + encodeURIComponent(price));
      })
      .then(function (r) { st.preview = r; renderConfirm(); });
  }

  function renderConfirm() {
    var p = st.preview;
    var icon = svg(true);
    icon.addEventListener("mouseenter", function () { tip.hidden = false; });
    icon.addEventListener("mouseleave", function () { tip.hidden = true; });
    var pay = el("button", { type: "button", onclick: subscribe }, el("span", null, "Subscribe and pay"), svg(false), svg(false));
    var card = st.pms.filter(function (m) { return m.default; })[0] || st.pms[0];
    show(crumbs("confirm").concat([
      div("Confirm"),
      div("Confirm your updates"),
      div(p.plan),
      div("What you'll pay " + p.interval + " starting " + p.starting),
      p.recurring_invoice.has_discount ? button("View details", function () {}) : null,
      el("div", null, el("span", null, p.recurring_invoice.total), icon),
      card ? link(card.label, "#payment-method", function () {}) : null,
      pay,
      button("Go back", openPlans),
    ]));
  }

  function actionButton(name, onclick) {
    return el("button", { type: "button", onclick: onclick }, el("span", null, name), svg(false), svg(false));
  }

  function openCancel() {
    var id = sub().id;
    return get("/subscriptions/" + id)
      .then(function () { return get("/subscriptions/" + id + "/retention_coupon"); })
      .then(function () {
        var s = sub();
        show([
          button("Billing", function () { loadHome(false); }),
          div("Cancel"),
          div("Review your changes"),
          div(s.plan),
          div(s.amount + " " + s.per),
          div("If you cancel this subscription, it will still be available until the end of your billing period on " + s.next_billing_date + "."),
          actionButton("Cancel subscription", function () {
            post("/subscriptions/" + id + "/cancel", {}).then(function () { return loadHome(false); });
          }),
          button("Go back", function () { loadHome(false); }),
        ]);
      });
  }

  function openRenew() {
    var id = sub().id;
    return get("/subscriptions/" + id).then(function () {
      var s = sub();
      show([
        button("Billing", function () { loadHome(false); }),
        div("Renew"),
        div("Renew your subscription"),
        div("Current subscription"),
        div(s.plan),
        div(s.amount + " " + s.per),
        div("This subscription will no longer be canceled. It will renew on " + s.next_billing_date + "."),
        actionButton("Renew subscription", function () {
          post("/subscriptions/" + id + "/reactivate", {}).then(function () { return loadHome(false); });
        }),
        button("Go back", function () { loadHome(false); }),
      ]);
    });
  }

  function subscribe() {
    return post("/subscriptions/" + sub().id, { price: st.selected }).then(function () {
      return loadHome(false);
    });
  }

  loadHome(true);
})();
`;

const STYLE = `
body { font-family: system-ui, sans-serif; display: flex; gap: 48px; margin: 32px; }
#side { width: 320px; }
#main { flex: 1; }
.details { margin: 8px 0; }
[role="tooltip"] { position: absolute; max-width: 280px; background: #fff; border: 1px solid #ccc; padding: 8px; }
iframe { display: block; width: 0; height: 0; border: 0; }
`;

const escape = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

export function portalHtml(session: string, account: string): string {
  const name = escape(account);
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${name}</title><style>${STYLE}</style></head>
<body data-session="${escape(session)}">
<div id="side">
<div>${name}</div>
<div>Sandbox</div>
<div>${name} partners with Stripe for simplified billing.</div>
<footer>
<a href="https://stripe.com">Powered by <svg role="img" aria-label="Stripe" width="33" height="15" viewBox="0 0 33 15"><rect width="33" height="15"></rect></svg></a>
<a href="https://stripe.com/legal/end-users">Terms</a>
<a href="https://stripe.com/privacy">Privacy</a>
</footer>
</div>
<div id="main"></div>
<div id="tip" role="tooltip" hidden>This estimate covers recurring charges. One-time adjustments, like prorations and credits, will appear on your final invoice.</div>
<iframe src="about:blank"></iframe>
<script>${CLIENT}</script>
</body>
</html>`;
}
