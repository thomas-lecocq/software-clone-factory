/**
 * The Customer Portal page: a static shell and a small client script that renders the six screens
 * (home, plan list, confirmation, cancel review, renew review, add payment method) from the
 * session's JSON endpoints, firing them in the order the real portal does.
 */
import { ACCOUNT_NAME } from "./objects.ts";

// Wall-clock artefacts of the recordings (2026): the portal prints a badge date without its year
// when it falls in the current year.
const CURRENT_YEAR = 2026;

const CSS = `
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { font-family: "Liberation Sans", Arial, sans-serif; color: #1a1b25; background: #fff;
  min-height: 800px; position: relative; -webkit-font-smoothing: antialiased; }
button { font: inherit; color: inherit; background: none; border: 0; padding: 0; margin: 0;
  cursor: pointer; text-align: left; }
a { color: inherit; text-decoration: none; }
svg { display: inline-block; vertical-align: middle; }
#side { position: absolute; left: 0; top: 0; width: 528px; height: 800px; background: #f6f8fa; }
#side .brand { position: absolute; left: 64px; top: 64px; height: 28px; white-space: nowrap; }
#side .logo { position: absolute; left: 0; top: 0; width: 28px; height: 28px; border-radius: 50%;
  background: #e3e8ee; }
#side .acct { position: absolute; left: 36px; top: 5px; display: inline-block; width: 259px;
  height: 18px; line-height: 18px; font-size: 15px; font-weight: 600; overflow: hidden; }
#side .sandbox { position: absolute; left: 303px; top: 4px; display: inline-block; width: 79px;
  height: 20px; line-height: 20px; font-size: 12px; font-weight: 600; text-align: center;
  border-radius: 4px; background: #ffde92; color: #a82c00; }
#side .intro { position: absolute; left: 64px; top: 174px; display: block; width: 279px;
  height: 92px; line-height: 23px; font-size: 18px; color: #414552; }
#side footer { position: absolute; left: 64px; top: 718px; width: 300px; }
#side .powered { position: absolute; left: 0; top: 2px; display: inline-block; width: 112px;
  height: 17px; line-height: 17px; font-size: 12px; color: #687385; white-space: nowrap; }
#side .powered svg { margin-left: 4px; vertical-align: top; }
#side .legal { position: absolute; left: 0; top: 27px; white-space: nowrap; }
#side .legal a { display: inline-block; height: 15px; line-height: 15px; font-size: 12px;
  color: #687385; }
#side .terms { position: absolute; left: 0; width: 35px; }
#side .privacy { position: absolute; left: 43px; width: 41px; }
#col { position: absolute; left: 592px; top: 0; width: 608px; padding-bottom: 64px; }
.up { text-transform: uppercase; }
.label { display: inline-block; height: 17px; line-height: 17px; font-size: 13.6px; font-weight: 600;
  color: #414552; }
.b { font-weight: 600; }
/* home */
.subsec { position: relative; }
.subsec .label { margin-top: 69px; }
.subsec .actions { position: absolute; left: 375px; top: 120px; width: 233px; }
.btn { display: block; width: 233px; height: 44px; line-height: 44px; margin-bottom: 12px;
  border: 1px solid #d5dbe1; border-radius: 6px; font-size: 16px; font-weight: 600;
  text-align: center; }
.pname { display: inline-block; height: 23px; line-height: 23px; font-size: 18.5px; font-weight: 600; }
.pprice { display: inline-block; height: 28px; line-height: 28px; font-size: 25.6px; }
.home .pname { margin-top: 46px; }
.home .badgewrap { display: block; margin-top: 30px; height: 28px; }
.home .badgewrap + .pname { margin-top: 8px; }
.badge { display: inline-block; height: 28px; padding: 6px 7px; border-radius: 4px;
  background: #e3e8ee; }
.badge > span.bt { display: inline-block; height: 16px; line-height: 16px; font-size: 13px;
  font-weight: 600; }
.home .pprice { margin-top: 11px; }
.line { display: inline-block; height: 17px; line-height: 17px; font-size: 14.5px; color: #414552; }
.home .next { margin-top: 11px; }
.home .ends { margin-top: 10px; padding-left: 22px; position: relative; }
.home .ends svg { position: absolute; left: 0; top: 1px; }
.home .est { margin-top: 15px; }
.lnk { display: inline-block; height: 20px; line-height: 20px; font-size: 14px; font-weight: 600;
  color: #635bff; margin-top: 6px; }
.lnk svg { margin-left: 6px; vertical-align: top; margin-top: 4px; }
.det { display: grid; width: max-content; grid-template-columns: auto auto; column-gap: 24px;
  min-width: 238px; margin: 38px 0 0 20px; padding-bottom: 34px; align-items: start; }
.det > span { display: inline-block; height: 17px; line-height: 17px; font-size: 14px;
  justify-self: start; }
.det > .amt { justify-self: end; text-align: right; }
.det > .grp { grid-column: 1 / span 2; height: 15px; line-height: 15px; font-size: 12px;
  font-weight: 600; color: #687385; text-transform: uppercase; }
.det > .first { margin-top: 16px; }
.det > .more { margin-top: 16px; }
.det > .sep { margin-top: 20px; }
.det > .grpnext { margin-top: 18px; }
.det > .bal { margin-top: 40px; }
.pmsec { margin-top: 88px; position: relative; }
.card { position: relative; height: 59px; margin-top: 18px; width: 464px; }
.card .brandicon { position: absolute; left: 0; top: 4px; }
.card .num { position: absolute; left: 40px; top: 0; display: inline-block; height: 18px;
  line-height: 18px; font-size: 17px; font-weight: 600; }
.card .exp { position: absolute; left: 40px; top: 20px; display: inline-block; height: 15px;
  line-height: 15px; font-size: 13px; color: #687385; }
.card .def { position: absolute; left: 341px; top: 8px; display: inline-block; height: 20px;
  line-height: 20px; font-size: 12px; font-weight: 600; padding: 0 7px; border-radius: 4px;
  background: #e3e8ee; }
.card .del { position: absolute; left: 440px; top: 12px; width: 12px; height: 12px; }
.addpm { display: inline-block; height: 24px; line-height: 24px; font-size: 16px; font-weight: 600;
  color: #635bff; }
.addpm svg { margin-right: 4px; vertical-align: top; margin-top: 4px; }
/* sub-screens */
.crumbs { margin-top: 69px; height: 17px; white-space: nowrap; position: relative; }
.crumbs > * { position: absolute; top: 0; }
.crumbs button { height: 16px; line-height: 16px; font-size: 14px; margin-top: 1px; color: #635bff;
  font-weight: 600; }
.crumbs span { display: inline-block; height: 17px; line-height: 17px; font-size: 14px;
  color: #414552; }
.title { display: inline-block; height: 38px; line-height: 38px; font-size: 31px; font-weight: 700;
  margin-top: 35px; }
.plans { display: flex; gap: 52px; margin-left: 2px; margin-top: 56px; }
.plan { width: 167px; position: relative; height: 194px; }
.plan .pill { position: absolute; left: 9px; top: 0; display: inline-block; height: 15px;
  line-height: 15px; font-size: 12px; font-weight: 600; }
.plan .nm { position: absolute; left: 0; top: 25px; width: 167px; height: 24px; line-height: 24px;
  font-size: 20px; font-weight: 600; }
.plan.cur .nm { top: 26px; }
.plan .pr { position: absolute; left: 0; top: 82px; display: block; width: 167px; height: 40px;
  line-height: 17px; font-size: 14px; color: #414552; }
.plan .pr > div { height: 23px; line-height: 23px; font-size: 20px; font-weight: 600;
  color: #1a1b25; }
.plan .sel { position: absolute; left: 0; top: 154px; width: 167px; height: 40px;
  line-height: 40px; text-align: center; border: 1px solid #d5dbe1; border-radius: 6px;
  font-size: 16px; font-weight: 600; }
.plan .chosen { position: absolute; left: 0; top: 165px; width: 167px; text-align: center;
  white-space: nowrap; }
.plan .chosen svg { vertical-align: top; margin-right: 8px; margin-top: 1px; }
.plan .chosen span { display: inline-block; height: 18px; line-height: 18px; font-size: 15px;
  font-weight: 600; }
.plan .qty { position: absolute; left: 0; top: 140px; width: 167px; font-size: 14px; }
.plan .qty input { width: 48px; height: 28px; text-align: center; font: inherit; }
.plan .qty button { width: 28px; height: 28px; border: 1px solid #d5dbe1; border-radius: 4px;
  text-align: center; }
.subtotal { position: relative; height: 23px; margin-top: 90px; }
.subtotal span { position: absolute; top: 0; display: inline-block; height: 23px; line-height: 23px;
  font-size: 19px; }
.subtotal .l { left: 0; font-weight: 600; }
.subtotal .r { right: 0; }
.continue { display: block; margin-left: 424px; margin-top: 33px; width: 184px; height: 40px;
  line-height: 40px; text-align: center; border-radius: 6px; background: #635bff; color: #fff;
  font-size: 16px; font-weight: 600; }
.continue:disabled { opacity: 0.5; cursor: default; }
.confirm { position: relative; width: 464px; margin-top: 25px; }
.confirm .pname { display: block; width: fit-content; }
.confirm .paywrap { display: block; width: 240px; line-height: 24px; font-size: 15.5px; margin-top: 9px;
  color: #414552; }
.confirm.hasvd { padding-bottom: 8px; }
.confirm.hasvd .paywrap { margin-top: 13px; }
.confirm.hasvd .right { top: 36px; }
.confirm .vd { display: block; width: fit-content; height: 16px; line-height: 16px; font-size: 14px;
  font-weight: 600; color: #635bff; margin-top: 8px; }
.confirm .right { position: absolute; right: 0; top: 32px; text-align: right; white-space: nowrap; }
.confirm .amt { display: inline-block; height: 24px; line-height: 24px; font-size: 18.5px;
  font-weight: 600; vertical-align: top; }
.confirm .info { margin-left: 4px; margin-top: 6px; vertical-align: top; }
.confirm .cardlink { display: inline-block; height: 16px; line-height: 16px; font-size: 14px;
  margin-top: 8px; margin-right: -1px; }
.confirm .cardlink svg { margin-right: 4px; vertical-align: top; margin-top: 3px; }
.wide { display: block; width: 464px; height: 44px; line-height: 44px; text-align: center;
  border-radius: 6px; font-size: 16px; font-weight: 600; }
.primary { background: #635bff; color: #fff; }
.danger { background: #df1b41; color: #fff; }
.secondary { border: 1px solid #d5dbe1; margin-top: 19px; }
.wide svg { display: none; }
.wide.primary svg, .wide.danger svg { display: inline-block; width: 0; height: 0; }
.review .pname { margin-top: 41px; }
.review .pprice { margin-top: 11px; }
.review .notewrap { display: block; width: 464px; line-height: 24px; font-size: 16.2px;
  margin-top: 14px; color: #414552; }
.review.renew .notewrap { margin-top: 22px; }
.review .wide.first { margin-top: 48px; }
.det > .strong { font-weight: 600; }
.renew .label { margin-top: 26px; }
.renew .pname { margin-top: 18px; }
.tip { position: absolute; left: 700px; top: 150px; width: 300px; padding: 8px; font-size: 13px;
  line-height: 18px; background: #fff; border: 1px solid #d5dbe1; border-radius: 6px; }
.addpm-form { width: 464px; }
#cardframe { display: none; margin-top: 30px; width: 464px; height: 120px; border: 0; }
#cardframe.on { display: block; }
.addpm-form label { display: block; margin-top: 16px; font-size: 14px; }
.blk { display: block; width: fit-content; }
.confirm + .wide { margin-top: 48px; }
#hc { position: absolute; left: 0; top: 0; width: 1px; height: 1px; border: 0; opacity: 0; }
`;

const CLIENT = `
(function () {
  var SID = document.body.getAttribute('data-session');
  var API = '/v1/billing_portal/sessions/' + SID;
  var YEAR = ${String(CURRENT_YEAR)};
  var MS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var ML = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  var st = { screen: 'home', session: null, customer: null, subs: null, pms: null, detail: null,
    preview: null, sel: null, upOpen: null, qtyOpen: false, confOpen: false };
  var main = document.getElementById('main');
  var below = document.getElementById('below');
  var cardFrame = document.getElementById('cardframe');

  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function money(c) {
    var a = Math.abs(c);
    var w = Math.floor(a / 100).toString().replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',');
    return (c < 0 ? '-' : '') + '$' + w + '.' + ('0' + (a % 100)).slice(-2);
  }
  function dt(t) { return new Date(t * 1000); }
  function longDate(t) { var x = dt(t); return ML[x.getUTCMonth()] + ' ' + x.getUTCDate() + ', ' + x.getUTCFullYear(); }
  function short(t) { var x = dt(t); return MS[x.getUTCMonth()] + ' ' + x.getUTCDate(); }
  function badgeDate(t) { var x = dt(t); return x.getUTCFullYear() === YEAR ? short(t) : short(t) + ', ' + x.getUTCFullYear(); }
  function range(a, b) { return '<span>' + short(a) + '</span>-<span>' + short(b) + ', ' + dt(b).getUTCFullYear() + '</span>'; }
  function get(p) { return fetch(API + p).then(function (r) { return r.json(); }); }
  function post(p, body) {
    var o = { method: 'POST' };
    if (body !== null) { o.headers = { 'content-type': 'application/x-www-form-urlencoded' }; o.body = body; }
    return fetch(API + p, o).then(function (r) { return r.json(); });
  }
  function sub() { return st.subs && st.subs.data[0]; }
  function item(s) { return s.items[0]; }
  function qtyMode() { return st.session.configuration.allowed_updates.indexOf('quantity') >= 0; }
  function nameQ(name, q) { return esc(name) + (q > 1 ? '(\\u00d7' + q + ')' : ''); }
  var chev = '<svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12"><path d="M4 2l4 4-4 4" stroke="#687385" fill="none"/></svg>';
  var caret = '<svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12"><path d="M2 4l4 4 4-4" stroke="#635bff" fill="none"/></svg>';
  var icons = '<svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="#fff"/></svg><svg width="16" height="16" viewBox="0 0 16 16"><path d="M3 8l3 3 7-7" fill="none" stroke="#fff"/></svg>';

  async function loadHome(first, now) {
    if (now && st.subs) { st.screen = 'home'; st.upOpen = null; st.qtyOpen = false; render(); }
    if (first) st.session = await get('');
    var all = await Promise.all([get('/customer'), get('/subscriptions'), get('/payment_methods')]);
    st.customer = all[0]; st.subs = all[1]; st.pms = all[2];
    st.screen = 'home'; st.upOpen = null; st.qtyOpen = false;
    render();
  }
  async function loadPlans() {
    var s = sub();
    st.detail = await get('/subscriptions/' + s.id);
    var it = item(st.detail);
    st.sel = { price: it.price, quantity: it.quantity };
    st.screen = 'plans';
    render();
  }
  async function loadConfirm() {
    var s = sub();
    var it = item(s);
    st.detail = await get('/subscriptions/' + s.id);
    st.customer = await get('/customer');
    st.preview = await get('/update_preview?items[0][id]=' + encodeURIComponent(it.id) +
      '&items[0][price]=' + encodeURIComponent(st.sel.price) + '&items[0][quantity]=' + st.sel.quantity);
    st.screen = 'confirm'; st.confOpen = false;
    render();
  }
  async function loadCancel() {
    var s = sub();
    st.detail = await get('/subscriptions/' + s.id);
    await get('/subscriptions/' + s.id + '/retention_coupon');
    st.screen = 'cancel'; st.qtyOpen = false;
    render();
  }
  async function loadRenew() {
    var s = sub();
    st.detail = await get('/subscriptions/' + s.id);
    st.screen = 'renew'; st.qtyOpen = false;
    render();
  }

  function qtyDetails(it) {
    return '<div class="det"><span>' + esc(it.name) + '</span><span class="amt"></span>' +
      '<span>Qty ' + it.quantity + '</span><span class="amt">' + money(it.unit_amount * it.quantity) + '</span>' +
      '<span>' + money(it.unit_amount) + ' each</span><span class="amt"></span>' +
      '<span class="sep">Total</span><span class="amt sep">' + money(it.unit_amount * it.quantity) + '</span></div>';
  }
  function upDetails(up) {
    var h = '<div class="det">';
    var first = true;
    if (up.prorations.length > 0) {
      var p0 = up.prorations[0];
      h += '<span class="grp">' + range(p0.start, p0.end) + '</span>';
      up.prorations.forEach(function (l, i) {
        var c = i === 0 ? 'first' : 'more';
        h += '<span class="' + c + '">' + esc(l.label) + '</span><span class="amt ' + c + '">' + money(l.amount) + '</span>';
      });
      first = false;
    }
    if (up.renewal.length > 0) {
      var r0 = up.renewal[0];
      h += '<span class="grp' + (first ? '' : ' grpnext') + '">' + range(r0.start, r0.end) + '</span>';
      up.renewal.forEach(function (l, i) {
        var c = i === 0 ? 'first' : 'more';
        h += '<span class="' + c + '">' + esc(l.label) + '</span><span class="amt ' + c + '">' + money(l.amount) + '</span>';
      });
    }
    h += '<span class="sep">Subtotal</span><span class="amt sep">' + money(up.subtotal) + '</span>';
    up.discounts.forEach(function (d) {
      h += '<span class="sep">' + esc(d.label) + '</span><span class="amt sep">' + money(-d.amount) + '</span>';
    });
    h += '<span class="sep">Total</span><span class="amt sep">' + money(up.total) + '</span>';
    if (up.total < 0) {
      h += '<span class="bal">Account balance credit</span><span class="amt bal">' + money(-up.total) + '</span>';
      h += '<span class="sep strong">Next estimated payment</span><span class="amt sep strong">' + money(up.amount_due) + '</span>';
    }
    return h + '</div>';
  }

  function homeHtml() {
    var s = sub();
    var it = item(s);
    var cfg = st.session.configuration;
    var canceling = s.cancel_at !== null;
    var up = s.upcoming;
    var showUp = !canceling && up && (s.pending > 0 || up.has_discount);
    var upOpen = st.upOpen === null ? !!(up && up.has_discount) : st.upOpen;
    var h = '<div class="home"><div class="subsec">';
    h += '<span class="label up">Current subscription</span>';
    if (canceling) {
      h += '<div class="badgewrap"><span class="badge"><span class="bt">Cancels <span>' + badgeDate(s.cancel_at) + '</span></span></span></div>';
    }
    h += '<span class="pname blk">' + nameQ(it.name, it.quantity) + '</span>';
    h += '<span class="pprice blk">' + money(s.net) + ' per month</span>';
    var hasDet = false;
    if (it.quantity > 1) {
      var open = st.qtyOpen && !canceling;
      h += '<button class="lnk blk" data-act="qty">' + (open ? 'Hide details' : 'View details') + caret + '</button>';
      if (open) { h += qtyDetails(it); hasDet = true; }
    }
    if (canceling) {
      h += '<span class="line ends blk"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="#687385"/></svg><span>Your service will end on <span class="b">' + longDate(s.cancel_at) + '</span>.</span></span>';
    } else {
      h += '<span class="line next blk">Your next billing date is <span class="b">' + longDate(s.period_end) + '</span>.</span>';
    }
    if (showUp) {
      h += '<span class="line est blk">Your next estimated payment will be <span class="b">' + money(up.amount_due) + '</span></span>';
      h += '<button class="lnk blk" data-act="up">' + (upOpen ? 'Hide details' : 'View details') + caret + '</button>';
      if (upOpen) { h += upDetails(up); hasDet = true; }
    }
    h += '<div class="actions"><a class="btn" href="#update" data-act="update">Update subscription</a>';
    if (cfg.cancel_enabled) {
      h += canceling
        ? '<a class="btn" href="#renew" data-act="renew">Don\\'t cancel subscription</a>'
        : '<a class="btn" href="#cancel" data-act="cancel">Cancel subscription</a>';
    }
    h += '</div></div>';
    h += pmHtml(hasDet);
    return h + '</div>';
  }
  function pmHtml(afterDet) {
    var pm = st.pms.data[0];
    var h = '<div class="pmsec' + (afterDet ? ' after-det' : '') + '"><span class="label up">Payment method</span>';
    if (pm) {
      h += '<div class="card"><svg class="brandicon" aria-hidden="true" width="32" height="22" viewBox="0 0 32 22"><rect width="32" height="22" rx="3" fill="#1a1f71"/></svg>' +
        '<span class="num">Visa \\u2022\\u2022\\u2022\\u2022 ' + esc(pm.last4) + '</span>' +
        '<span class="exp">Expires ' + ('0' + pm.exp_month).slice(-2) + '/' + pm.exp_year + '</span>' +
        '<span class="def">Default</span>' +
        '<button class="del" aria-label="Delete" disabled><svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12"><path d="M2 3h8M4 3V2h4v1M3 3l1 8h4l1-8" fill="none" stroke="#687385"/></svg></button></div>';
    }
    h += '<a class="addpm" href="#add" data-act="addpm"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16"><path d="M8 2v12M2 8h12" stroke="#635bff" stroke-width="2"/></svg>Add payment method</a></div>';
    return h;
  }
  function crumbs(parts) {
    var h = '<div class="crumbs">';
    var x = 0;
    parts.forEach(function (p, i) {
      if (i > 0) { h += '<span style="left:' + (x + 12) + 'px;top:3px;height:12px">' + chev + '</span>'; x += 36; }
      if (p.act) h += '<button style="left:' + x + 'px" data-act="' + p.act + '">' + p.text + '</button>';
      else h += '<span style="left:' + x + 'px">' + p.text + '</span>';
      x += p.w;
    });
    return h + '</div>';
  }
  function plansHtml() {
    var d = st.detail;
    var cur = item(d);
    var qm = qtyMode();
    var selPlan = null;
    var h = crumbs([{ text: 'Billing', act: 'home', w: 40 }, { text: 'Subscriptions', w: 89 }]);
    h += '<span class="title blk">Update your subscription</span><div class="plans">';
    d.plans.forEach(function (p) {
      var isCur = p.price === cur.price;
      var isSel = p.price === st.sel.price;
      if (isSel) selPlan = p;
      h += '<div class="plan' + (isCur ? ' cur' : '') + '">';
      if (isCur) h += '<span class="pill">Current subscription</span>';
      h += '<div class="nm">' + esc(p.name) + '</div>';
      h += '<span class="pr"><div>' + money(p.unit_amount) + '</div>' + (qm ? 'each per month' : 'per month') + '</span>';
      if (isSel && qm) {
        h += '<div class="qty"><span>Quantity</span> <button data-act="dec"' + (st.sel.quantity <= 1 ? ' disabled' : '') + '>Decrease</button>' +
          '<input type="text" value="' + st.sel.quantity + '"><button data-act="inc">Increase</button></div>';
      } else if (isSel) {
        h += '<div class="chosen"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16"><path d="M3 8l3 3 7-7" fill="none" stroke="#635bff" stroke-width="2"/></svg><span>Selected</span></div>';
      } else {
        h += '<button class="sel" data-act="select" data-price="' + esc(p.price) + '">Select</button>';
      }
      h += '</div>';
    });
    h += '</div>';
    var total = selPlan ? selPlan.unit_amount * st.sel.quantity : 0;
    var same = st.sel.price === cur.price && st.sel.quantity === cur.quantity;
    h += '<div class="subtotal"><span class="l">Subtotal</span><span class="r">' + money(total) + ' per month</span></div>';
    h += '<button class="continue" data-act="continue"' + (same ? ' disabled' : '') + '>Continue</button>';
    return h;
  }
  function planOf(price) {
    var out = null;
    st.detail.plans.forEach(function (p) { if (p.price === price) out = p; });
    return out;
  }
  function confirmHtml() {
    var p = planOf(st.sel.price);
    var q = st.sel.quantity;
    var pv = st.preview;
    var pm = st.pms && st.pms.data[0];
    var h = crumbs([{ text: 'Billing', act: 'home', w: 40 }, { text: 'Subscriptions', act: 'plans', w: 91 }, { text: 'Confirm', w: 52 }]);
    var hasVd = pv.has_discount || q > 1;
    h += '<span class="title blk">Confirm your updates</span><div class="confirm' + (hasVd ? ' hasvd' : '') + '">';
    if (q > 1) {
      h += '<span class="pname">' + nameQ(p.name, q) + '</span> <span class="line">' + money(p.unit_amount) + ' each per month</span> <span class="line">' + money(p.unit_amount * q) + '</span>';
    } else {
      h += '<span class="pname">' + esc(p.name) + '</span>';
    }
    h += '<div class="paywrap"><span class="pay">What you\\'ll pay monthly starting <span class="b">' + longDate(pv.next_billing_date) + '</span></span></div>';
    if (hasVd) {
      h += '<button class="vd" data-act="conf">' + (st.confOpen ? 'Hide details' : 'View details') + '</button>';
    }
    h += '<div class="right"><span class="amt">' + money(pv.recurring_amount) + '</span>' +
      '<svg class="info" aria-hidden="true" width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="5.5" fill="none" stroke="#687385"/></svg><br>' +
      '<a class="cardlink" href="#pm"><svg aria-hidden="true" width="11" height="10" viewBox="0 0 11 10"><rect width="11" height="10" rx="2" fill="#1a1f71"/></svg>Visa \\u2022\\u2022\\u2022\\u2022 ' + esc(pm ? pm.last4 : '4242') + '</a></div>';
    h += '</div>';
    h += '<button class="wide primary" data-act="subscribe">Subscribe and pay' + icons + '</button>';
    h += '<button class="wide secondary" data-act="plans">Go back</button>';
    h += '<div class="tip" role="tooltip" style="display:none">This estimate covers recurring charges. One-time adjustments, like prorations and credits, will appear on your final invoice.</div>';
    return h;
  }
  function reviewHtml(kind) {
    var d = st.detail;
    var it = item(d);
    var renew = kind === 'renew';
    var h = crumbs([{ text: 'Billing', act: 'home', w: 40 }, { text: renew ? 'Renew' : 'Cancel', w: renew ? 43 : 44 }]);
    h += '<div class="review' + (renew ? ' renew' : '') + '">';
    h += '<span class="title blk">' + (renew ? 'Renew your subscription' : 'Review your changes') + '</span>';
    if (renew) h += '<span class="label up blk">Current subscription</span>';
    h += '<span class="pname blk">' + nameQ(it.name, it.quantity) + '</span>';
    h += '<span class="pprice blk">' + money(d.net) + ' per month</span>';
    if (it.quantity > 1) {
      h += '<button class="lnk blk" data-act="qty">' + (st.qtyOpen ? 'Hide details' : 'View details') + caret + '</button>';
      if (st.qtyOpen) h += qtyDetails(it);
    }
    var end = '<span class="b">' + longDate(d.period_end) + '</span>';
    h += renew
      ? '<div class="notewrap"><span class="note">This subscription will no longer be canceled. It will renew on ' + end + '.</span></div>'
      : '<div class="notewrap"><span class="note">If you cancel this subscription, it will still be available until the end of your billing period on ' + end + '.</span></div>';
    h += renew
      ? '<button class="wide primary first" data-act="reactivate">Renew subscription' + icons + '</button>'
      : '<button class="wide danger first" data-act="docancel">Cancel subscription' + icons + '</button>';
    h += '<button class="wide secondary" data-act="home">Go back</button>';
    return h + '</div>';
  }
  // The card form's frame is part of the page from the start and only shown here: a frame
  // attached after load keeps the page from ever being network-idle.
  function addPmHtml() {
    var h = crumbs([{ text: 'Billing', act: 'home', w: 40 }, { text: 'Payment method', w: 110 }]);
    return h + '<span class="title blk">Add payment method</span>';
  }
  function addPmBelow() {
    var h = '<div class="addpm-form"><label><input type="checkbox" checked><svg width="16" height="16" viewBox="0 0 16 16"><rect x="1" y="1" width="14" height="14" rx="3" fill="#635bff"/></svg> <span>Use as default payment method</span></label></div>';
    h += '<button class="wide primary" disabled style="margin-top:24px;opacity:.5">Add' + icons + '</button>';
    h += '<button class="wide secondary" data-act="noop">Go back</button>';
    return h;
  }
  function render() {
    var h = '';
    if (st.screen === 'home') h = homeHtml();
    else if (st.screen === 'plans') h = plansHtml();
    else if (st.screen === 'confirm') h = confirmHtml();
    else if (st.screen === 'cancel') h = reviewHtml('cancel');
    else if (st.screen === 'renew') h = reviewHtml('renew');
    else if (st.screen === 'addpm') h = addPmHtml();
    main.innerHTML = h;
    var card = st.screen === 'addpm';
    cardFrame.className = card ? 'on' : '';
    below.innerHTML = card ? addPmBelow() : '';
    var info = main.querySelector('.info');
    if (info) {
      info.addEventListener('mouseenter', function () { var t = main.querySelector('.tip'); if (t) t.style.display = 'block'; });
      info.addEventListener('mouseleave', function () { var t = main.querySelector('.tip'); if (t) t.style.display = 'none'; });
    }
  }
  function body() {
    var s = sub();
    var it = item(s);
    return 'recurring_items[0][id]=' + encodeURIComponent(it.id) + '&recurring_items[0][price]=' +
      encodeURIComponent(st.sel.price) + '&recurring_items[0][quantity]=' + st.sel.quantity;
  }
  async function act(a, el) {
    var s = sub();
    if (a === 'home') return loadHome(false, true);
    if (a === 'update' || a === 'plans') return loadPlans();
    if (a === 'cancel') return loadCancel();
    if (a === 'renew') return loadRenew();
    if (a === 'addpm') { st.screen = 'addpm'; return render(); }
    if (a === 'noop') return;
    if (a === 'up') { var up = s.upcoming; var open = st.upOpen === null ? !!(up && up.has_discount) : st.upOpen; st.upOpen = !open; return render(); }
    if (a === 'qty') { if (st.screen === 'home' && s.cancel_at !== null) return; st.qtyOpen = !st.qtyOpen; return render(); }
    if (a === 'conf') { st.confOpen = !st.confOpen; return render(); }
    if (a === 'select') {
      var price = el.getAttribute('data-price');
      var cur = item(st.detail);
      st.sel = price === cur.price ? { price: price, quantity: qtyMode() ? st.sel.quantity : cur.quantity } : { price: price, quantity: st.sel.quantity };
      return render();
    }
    if (a === 'dec') { if (st.sel.quantity > 1) st.sel.quantity -= 1; return render(); }
    if (a === 'inc') { st.sel.quantity += 1; return render(); }
    if (a === 'continue') return loadConfirm();
    if (a === 'subscribe') { await post('/subscriptions/' + s.id, body()); return loadHome(false); }
    if (a === 'docancel') { await post('/subscriptions/' + s.id + '/cancel', 'refund=false'); return loadHome(false); }
    if (a === 'reactivate') { await post('/subscriptions/' + s.id + '/reactivate', null); return loadHome(false); }
  }
  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
    if (!t) return;
    e.preventDefault();
    if (t.disabled) return;
    act(t.getAttribute('data-act'), t);
  });
  loadHome(true);
})();
`;

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const STRIPE_LOGO =
  '<svg role="img" aria-label="Stripe" width="33" height="14" viewBox="0 0 33 14"><rect width="33" height="14" rx="2" fill="#687385"/></svg>';

export function portalPage(sessionId: string): string {
  const name = esc(ACCOUNT_NAME);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${name}</title><style>${CSS}</style></head>
<body data-session="${esc(sessionId)}">
<div id="side">
<div class="brand"><span class="logo"></span><span class="acct">${name}</span> <span class="sandbox">Sandbox</span></div>
<span class="intro">${name} partners with Stripe for simplified billing.</span>
<footer><a class="powered" href="https://stripe.com">Powered by ${STRIPE_LOGO}</a><div class="legal"><a class="terms" href="https://stripe.com/legal/end-users">Terms</a> <a class="privacy" href="https://stripe.com/privacy">Privacy</a></div></footer>
</div>
<div id="col"><div id="main"></div><iframe id="cardframe" title="" src="about:blank"></iframe><div id="below"></div></div>
<iframe id="hc" title="" src="about:blank"></iframe>
<script>${CLIENT}</script>
</body></html>`;
}
