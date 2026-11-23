"use strict";

/* ATTIRE MART independent guest checkout.
   Prices are calculated again by serverless APIs; values in localStorage
   are a convenience only, never a payment or order source of truth. */
const GUEST_DETAILS_KEY = "am-guest-delivery-v1";
const GUEST_ORDERS_KEY = "am-guest-order-refs-v1";
const CHECKOUT_ATTEMPT_KEY = "am-checkout-attempt-v2";
let checkoutSubmitting = false;

function guestLoad(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || "null") || fallback; }
  catch { return fallback; }
}
function guestSave(key, data) {
  try { localStorage.setItem(key, JSON.stringify(data)); } catch {}
}
function guestInput(id, title, type, attributes, value, full) {
  return '<label class="field' + (full ? ' field-wide' : '') + '">' +
    '<span>' + esc(title) + '</span>' +
    '<input id="' + id + '" name="' + id + '" type="' + (type || "text") +
    '" value="' + esc(value || "") + '" ' + (attributes || "") + ' required></label>';
}
function guestCheckoutPage() {
  const lines = cartLines();
  if (!lines.length) {
    shell('<div class="container empty"><h1>Your bag is empty</h1><p>Add your favourite styles to place an order.</p>' +
      routeLink("/collections/all", "SHOP STYLES", "btn btn-primary") + '</div>', "Checkout");
    return;
  }
  const saved = guestLoad(GUEST_DETAILS_KEY, {});
  const total = lines.reduce((sum, l) => sum + Number(l.v.price) * l.qty, 0);
  const advance = Math.min(total, total < 700 ? 199 : 299);
  const methods = '<fieldset class="payment-choices"><legend>How would you like to pay?</legend>' +
    '<label class="payment-choice"><input type="radio" name="paymentMethod" value="prepaid" checked>' +
    '<span><strong>Pay online</strong><small>UPI, debit/credit cards and netbanking via PayU</small></span><b>' + money(total) + '</b></label>' +
    '<label class="payment-choice"><input type="radio" name="paymentMethod" value="cod">' +
    '<span><strong>Cash on Delivery</strong><small>Pay ' + money(advance) + ' advance to confirm your order. Remaining ' +
    money(total - advance) + ' at delivery.</small></span></label></fieldset>';
  const fields = '<div class="checkout-fields">' +
    guestInput("name", "Full name", "text", 'autocomplete="name" minlength="2" maxlength="100" placeholder="Your full name"', saved.name, true) +
    guestInput("email", "Email address", "email", 'autocomplete="email" maxlength="180" placeholder="name@example.com"', saved.email) +
    guestInput("phone", "Mobile number", "tel", 'autocomplete="tel" inputmode="numeric" pattern="[6-9][0-9]{9}" maxlength="10" placeholder="10-digit mobile"', saved.phone) +
    guestInput("address1", "House / flat, street address", "text", 'autocomplete="address-line1" minlength="8" maxlength="200" placeholder="House number, street, area"', saved.address1, true) +
    '<label class="field field-wide"><span>Landmark (optional)</span><input name="address2" type="text" maxlength="150" autocomplete="address-line2" placeholder="Near a known location" value="' + esc(saved.address2 || "") + '"></label>' +
    guestInput("city", "City", "text", 'autocomplete="address-level2" minlength="2" maxlength="80" placeholder="City"', saved.city) +
    guestInput("state", "State", "text", 'autocomplete="address-level1" minlength="2" maxlength="80" placeholder="State"', saved.state) +
    guestInput("pincode", "PIN code", "text", 'autocomplete="postal-code" inputmode="numeric" pattern="[1-9][0-9]{5}" maxlength="6" placeholder="6-digit PIN code"', saved.pincode) +
    '<div class="field"><span>Country</span><div class="readonly-country">India 🇮🇳</div></div>' +
    '</div>';
  const items = lines.map(l => '<div class="checkout-product">' +
    '<div class="checkout-product-pic">' + photo(l.v.image || firstImg(l.p), l.p.title) + '<em>' + l.qty + '</em></div>' +
    '<div class="checkout-product-copy"><strong>' + esc(l.p.title) + '</strong><small>' +
    esc(Object.entries(l.v.options || {}).map(x => x[1]).join(" · ")) + '</small>' +
    '<button type="button" class="checkout-remove-btn" data-checkout-remove="' + esc(l.v.id) +
    '" aria-label="Remove ' + esc(l.p.title) + ' from your order">Remove</button></div>' +
    '<b>' + money(Number(l.v.price) * l.qty) + '</b></div>').join("");
  const card = '<aside class="checkout-summary"><h2>Your order</h2>' + items +
    '<div class="checkout-totals"><div><span>Subtotal</span><b>' + money(total) + '</b></div>' +
    '<div><span>Shipping</span><b class="text-success">FREE</b></div>' +
    '<div class="checkout-total"><span>Total</span><b>' + money(total) + '</b></div>' +
    '<div class="checkout-pay-now"><span>Pay now</span><b id="checkout-pay-amount">' + money(total) + '</b></div></div>' +
    '<div class="checkout-trust"><span>✓ Secure payment</span><span>✓ Free shipping</span></div>' +
    '<p class="checkout-hint">Your order will be confirmed after PayU verifies your payment. COD orders require the advance shown at checkout.</p></aside>';
  const form = '<form id="guest-order-form" class="guest-checkout-form" novalidate>' +
    '<div class="checkout-step"><span>01</span><h2>Delivery details</h2></div>' +
    '<p class="checkout-intro">Enter your delivery address below.</p>' +
    fields +
    '<div class="checkout-step checkout-step-second"><span>02</span><h2>Payment</h2></div>' +
    methods +
    '<label class="checkout-check"><input type="checkbox" name="remember" checked><span>Remember delivery details on this device for faster checkout.</span></label>' +
    '<label class="checkout-check"><input type="checkbox" required name="policyConsent"><span>I agree to the ' +
    routeLink("/pages/terms-and-conditions", "Terms") + ', ' + routeLink("/pages/privacy-policy", "Privacy Policy") +
    ' and ' + routeLink("/pages/returns-refunds-cancellations", "Returns Policy") + '.</span></label>' +
    '<div id="checkout-error" role="alert" aria-live="polite"></div>' +
    '<button id="place-order-btn" type="submit" class="btn btn-primary btn-full checkout-place">PAY ' +
    money(total) + ' SECURELY WITH PAYU</button>' +
    '<p class="checkout-hint">Your card details, UPI PIN and OTP are entered only on PayU’s secure payment page, never here.</p>' +
    '</form>';
  shell('<div class="container checkout-wrap">' + crumbs([{text:"Bag",link:"/cart"},{text:"Checkout"}]) +
    '<div class="checkout-heading"><div><span class="eyebrow">ATTIRE MART</span>' +
    '<h1 class="page-heading">Checkout</h1></div></div>' +
    '<div class="checkout-layout"><div class="checkout-panel">' + form + '</div>' + card + '</div></div>', "Checkout");
  guestSetPayAmount();
}
function guestSetPayAmount() {
  const form = document.getElementById("guest-order-form");
  if (!form) return;
  const method = new FormData(form).get("paymentMethod");
  const total = cartLines().reduce((sum,l) => sum + l.qty * Number(l.v.price),0);
  const amount = method === "cod" ? Math.min(total, total < 700 ? 199 : 299) : total;
  const button = document.getElementById("place-order-btn");
  if (button && !button.disabled) button.textContent = 'PAY ' + money(amount) + ' SECURELY WITH PAYU';
  const label = document.getElementById("checkout-pay-amount");
  if (label) label.textContent = money(amount);
}
async function checkoutAttemptKey(payload){
 const fingerprintBytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify(payload)));
 const fingerprint=Array.from(new Uint8Array(fingerprintBytes),v=>v.toString(16).padStart(2,"0")).join("");
 let previous;
 try{previous=JSON.parse(sessionStorage.getItem(CHECKOUT_ATTEMPT_KEY)||"null")}catch{}
 if(previous?.fingerprint===fingerprint&&previous.status!=="finished"&&/^[a-f0-9]{32,64}$/.test(previous.key))return previous.key;
 const random=crypto.getRandomValues(new Uint8Array(24));
 const key=Array.from(random,b=>b.toString(16).padStart(2,"0")).join("");
 try{sessionStorage.setItem(CHECKOUT_ATTEMPT_KEY,JSON.stringify({fingerprint,key}))}catch{}
 return key;
}
function readCheckoutAttempt(){
 try{return JSON.parse(sessionStorage.getItem(CHECKOUT_ATTEMPT_KEY)||"null")}catch{return null}
}
function rememberCheckoutAttempt(txnId,key){
 const current=readCheckoutAttempt();
 if(current?.key===key){
  try{sessionStorage.setItem(CHECKOUT_ATTEMPT_KEY,JSON.stringify({...current,txnId,status:"pending"}))}catch{}
 }
}
function releaseCheckoutAttempt(txnId){
 const current=readCheckoutAttempt();
 if(current?.txnId===txnId)try{sessionStorage.removeItem(CHECKOUT_ATTEMPT_KEY)}catch{}
}
function sameCartSnapshot(current,snapshot){
 if(!Array.isArray(snapshot))return false;
 const sorted=items=>(items||[]).map(x=>({id:String(x.id),qty:Number(x.qty)}))
  .sort((a,b)=>a.id.localeCompare(b.id));
 return JSON.stringify(sorted(current))===JSON.stringify(sorted(snapshot));
}
async function guestSubmitOrder(form) {
  if(checkoutSubmitting)return;
  const error = document.getElementById("checkout-error");
  const button = document.getElementById("place-order-btn");
  error.textContent = "";
  if (!form.checkValidity()) {form.reportValidity();return;}
  const data = new FormData(form);
  if (data.get("policyConsent") !== "on") {
    error.textContent = "Please accept the store policies to continue."; return;
  }
  const customer = Object.fromEntries(["name","email","phone","address1","address2","city","state","pincode"]
    .map(field => [field, String(data.get(field) || "").trim()]));
  if (data.get("remember") === "on") guestSave(GUEST_DETAILS_KEY, customer);
  else localStorage.removeItem(GUEST_DETAILS_KEY);
  checkoutSubmitting = true;
  button.disabled = true;
  button.textContent = "PREPARING YOUR SECURE PAYMENT…";
  try {
    const payload={customer,paymentMethod:data.get("paymentMethod"),cart:state.cart.map(i=>({id:i.id,qty:i.qty}))};
    const attemptKey=await checkoutAttemptKey(payload);
    const resp = await fetch("/api/create-order", {
      method:"POST",headers:{"Content-Type":"application/json","Idempotency-Key":attemptKey},
      body:JSON.stringify(payload)
    });
    const result = await resp.json().catch(()=>({}));
    if (resp.status===409 && result.txnId && result.orderToken && result.status) {
      const refs=guestLoad(GUEST_ORDERS_KEY,[]);
      if(!refs.some(r=>r.txnId===result.txnId)){
       refs.unshift({txnId:result.txnId,orderToken:result.orderToken,createdAt:new Date().toISOString(),status:result.status});
       guestSave(GUEST_ORDERS_KEY,refs.slice(0,30));
      }
      rememberCheckoutAttempt(result.txnId,attemptKey);
      checkoutSubmitting=false;
      button.disabled=false;
      go("/order-status?txnid="+encodeURIComponent(result.txnId));
      return;
    }
    if (!resp.ok || !result.gateway || !result.fields) {
      throw Error(result.error || "Checkout is not ready. Please try again later.");
    }
    rememberCheckoutAttempt(result.txnId,attemptKey);
    const refs = guestLoad(GUEST_ORDERS_KEY, []).filter(r=>r?.txnId!==result.txnId);
    refs.unshift({
      txnId: result.txnId,
      orderToken: result.orderToken || "",
      cartSnapshot:payload.cart.map(i=>({id:String(i.id),qty:Number(i.qty)})),
      cartHandled:false,
      createdAt: new Date().toISOString(),
      status: "pending"
    });
    guestSave(GUEST_ORDERS_KEY, refs.slice(0, 30));
    if (!/^https:\/\/(?:test|secure)\.payu\.in\/_payment$/.test(result.gateway)) throw Error("Invalid payment gateway URL.");
    const payForm = document.createElement("form");
    payForm.method = "POST";
    payForm.action = result.gateway;
    payForm.style.display = "none";
    Object.entries(result.fields).forEach(([name,value]) => {
      const input=document.createElement("input");input.type="hidden";input.name=name;input.value=String(value);payForm.appendChild(input);
    });
    document.body.appendChild(payForm);
    payForm.submit();
  } catch (cause) {
    error.textContent = cause.message || "Payment service is unavailable right now.";
    button.disabled = false;
    checkoutSubmitting = false;
    guestSetPayAmount();
  }
}
async function guestOrderStatusPage() {
  const txnId = new URLSearchParams(location.search).get("txnid") || "";
  if (!/^AM[A-Za-z0-9_-]{10,60}$/.test(txnId)) {
    shell('<div class="container empty"><h1 class="page-heading">Find your order</h1><p>We could not find an order reference.</p>' +
      routeLink("/orders", "MY ORDERS", "btn btn-primary") + '</div>', "Order status");
    return;
  }
  shell('<div class="container guest-order-status"><div class="order-status-card">' +
    '<div class="status-symbol">◎</div><span class="eyebrow">ATTIRE MART</span>' +
    '<h1>Checking payment status</h1><p>Your payment will be confirmed by PayU. Do not pay again until we verify the result.</p>' +
    '<p class="order-reference">Reference: <strong>' + esc(txnId) + '</strong></p>' +
    '<div id="order-status-result" aria-live="polite">Checking the latest order status…</div>' +
    '<div class="status-actions">' + routeLink("/orders", "MY ORDERS", "btn btn-outline") +
    routeLink("/", "CONTINUE SHOPPING", "btn btn-primary") + '</div></div></div>', "Order status");
  const statusEl = document.getElementById("order-status-result");
  try {
    const refs = guestLoad(GUEST_ORDERS_KEY, []);
    const matched = refs.find(r => r && r.txnId === txnId);
    const headers = {};
    if (matched && matched.orderToken) {
      headers["X-Order-Token"] = matched.orderToken;
    }
    const resp = await fetch("/api/order-status?txnid=" + encodeURIComponent(txnId), {
      cache: "no-store",
      headers: headers
    });
    const data = await resp.json().catch(()=>({}));
    if (resp.status === 401 || resp.status === 403) {
      throw Error("For your privacy, order status can only be viewed from the browser session that placed the order. Please contact support@attiremart.shop with your reference.");
    }
    if (!resp.ok) throw Error(data.error || "Unable to check order status.");
    const good = data.status==="paid" || data.status==="cod_advance_paid";
    const terminal=good || data.status==="failed";
    if(terminal)releaseCheckoutAttempt(txnId);
    if(matched && data.status){
      matched.status=data.status;
      // Only remove the exact, unchanged basket for a newly paid order.
      // Checking a historical order can never erase a different shopping basket.
      if(good&&!matched.cartHandled&&Array.isArray(matched.cartSnapshot)){
       if(sameCartSnapshot(state.cart,matched.cartSnapshot)){
        state.cart=[];persist();
       }
       matched.cartHandled=true;
      }
      guestSave(GUEST_ORDERS_KEY,refs.slice(0,30));
    }
    let heading = good ? "Payment verified" : data.status === "failed" ? "Payment unsuccessful" : "Payment pending verification";
    statusEl.innerHTML = '<div class="order-status-pill ' + (good ? "status-ok" : "status-pending") + '">' + esc(heading) + '</div>' +
      '<p>' + (good ? (data.status==="cod_advance_paid" ? "Your COD advance has been received. The balance is due at delivery." : "Your payment has been received. We will process your order.") :
        data.status === "failed" ? "Your payment did not complete. If money was deducted, contact support with your order reference before trying again." :
        "We have not yet confirmed a successful transaction. Please check again shortly.") + '</p>' +
      (data.total ? '<p>Order total: <b>' + money(data.total) + '</b></p>' : "");
    if(!good && data.status!=="failed"){
      statusEl.innerHTML+='<button type="button" class="btn btn-outline" data-status-refresh>CHECK PAYMENT STATUS AGAIN</button>';
    }
   } catch(err) {
    statusEl.textContent = err.message || "Unable to get the latest payment status.";
  }
}
// Restore a usable checkout after a browser Back navigation from PayU.
window.addEventListener("pageshow",()=>{
 checkoutSubmitting=false;
 const button=document.getElementById("place-order-btn");
 if(button){button.disabled=false;guestSetPayAmount()}
});
function guestOrdersPage() {
  const refs = guestLoad(GUEST_ORDERS_KEY, []).filter(x => x && /^AM[A-Za-z0-9_-]{10,60}$/.test(x.txnId));
  const rows = refs.map(r => '<div class="recent-order"><div><strong>' + esc(r.txnId) +
    '</strong><small>' + esc(new Date(r.createdAt).toLocaleDateString("en-IN")) +
    '</small></div>' + routeLink("/order-status?txnid="+encodeURIComponent(r.txnId),"CHECK STATUS","btn btn-outline")+'</div>').join("");
  shell('<div class="container guest-orders"><h1 class="page-heading">Your orders</h1>' +
    '<p class="muted">Your recent order references are shown below.</p>' +
    (rows || '<div class="empty"><h2>No orders on this device</h2><p>Your checkout references will appear here.</p>' +
    routeLink("/collections/all","EXPLORE STYLES","btn btn-primary")+'</div>') +
    '<p class="checkout-hint">For order help contact support@attiremart.shop and share your order reference. Clearing browser storage also removes this local list.</p></div>',"Your orders");
}

/* Removing an item updates the bag and recalculates the checkout immediately.
   Preserve in-progress form entries only in memory; never persist details
   without the existing remember-details consent. */
document.addEventListener("click", function(event) {
  const button = event.target.closest("[data-checkout-remove]");
  if (!button) return;
  event.preventDefault();
  const id = button.getAttribute("data-checkout-remove");
  if (!state.cart.some(item => String(item.id) === id)) return;
  const form = document.getElementById("guest-order-form");
  const entries = form ? [...form.elements].filter(el => el.name).map(el => ({
    name: el.name, value: el.value, type: el.type, checked: el.checked
  })) : [];
  state.cart = state.cart.filter(item => String(item.id) !== id);
  persist();
  render();
  const freshForm = document.getElementById("guest-order-form");
  if (!freshForm) return; // The last product was removed: show empty bag.
  for (const field of freshForm.elements) {
    if (!field.name) continue;
    const entry = entries.find(item => item.name === field.name &&
      !["radio", "checkbox"].includes(field.type) ||
      item.name === field.name && item.value === field.value &&
      ["radio", "checkbox"].includes(field.type));
    if (!entry) continue;
    if (field.type === "radio" || field.type === "checkbox") field.checked = entry.checked;
    else field.value = entry.value;
  }
  guestSetPayAmount();
});

document.addEventListener("click",function(e){
 const refresh=e.target.closest("[data-status-refresh]");
 if(refresh){e.preventDefault();guestOrderStatusPage()}
});
document.addEventListener("submit",function(e) {
  if(e.target && e.target.id==="guest-order-form"){e.preventDefault();guestSubmitOrder(e.target);}
});
document.addEventListener("change",function(e) {
  if(e.target && e.target.name==="paymentMethod") guestSetPayAmount();
});
